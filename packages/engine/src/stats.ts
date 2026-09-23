import type { Host } from '@easycode/core';
import type {
  DecisionRecord,
  DecisionStats,
  ProjectDecisionTree,
  SessionDecisionSummary,
} from '@easycode/core';

/**
 * 决策统计与日志归档管理器 (DecisionStatsManager)
 * 职责：
 * 1. 追加归档决策日志至 ${dataDir}/reflex_decisions/${sessionId}.jsonl
 * 2. 计算跨项目、跨会话的多维效能与置信度统计指标
 * 3. 组织以「项目 (workspaceRoot) -> 会话 (sessionId) -> 决策记录」为层级的三级树
 * 4. 导出完全兼容 Reflex V1 训练管线规范的 .jsonl 数据集
 */
export class DecisionStatsManager {
  constructor(private readonly host: Host) {}

  private dir(): string {
    return this.host.paths.join(this.host.env.dataDir(), 'reflex_decisions');
  }

  private sessionFile(sessionId: string): string {
    return this.host.paths.join(this.dir(), `${sessionId}.jsonl`);
  }

  /**
   * 追加写入单条决策记录（Append-only，无锁极速落盘）
   */
  async recordDecision(record: DecisionRecord): Promise<void> {
    try {
      const dir = this.dir();
      await this.host.fs.mkdir(dir, { recursive: true });
      const line = JSON.stringify(record) + '\n';
      const file = this.sessionFile(record.sessionId);
      let existing = '';
      try {
        existing = await this.host.fs.readFile(file);
      } catch {
        existing = '';
      }
      await this.host.fs.writeFile(file, existing + line);
    } catch {
      // 容错：写日志失败不抛给上层业务
    }
  }

  /**
   * 当会话删除时同步清理对应的决策日志
   */
  async deleteSessionRecords(sessionId: string): Promise<void> {
    try {
      const file = this.sessionFile(sessionId);
      const stat = await this.host.fs.stat(file);
      if (stat) {
        await this.host.fs.unlink?.(file);
      }
    } catch {
      // 忽略文件不存在或删除失败
    }
  }

  /**
   * 读取全部决策记录（支持按项目或按会话过滤）
   */
  async loadRecords(filter?: { workspaceRoot?: string; sessionId?: string }): Promise<DecisionRecord[]> {
    const records: DecisionRecord[] = [];
    const dir = this.dir();
    const stat = await this.host.fs.stat(dir);
    if (!stat || !stat.isDirectory) {
      return records;
    }

    let files: string[] = [];
    if (filter?.sessionId) {
      files = [`${filter.sessionId}.jsonl`];
    } else {
      const entries = await this.host.fs.readdir(dir);
      files = entries.filter((e) => e.name.endsWith('.jsonl')).map((e) => e.name);
    }

    for (const filename of files) {
      const filePath = this.host.paths.join(dir, filename);
      try {
        const content = await this.host.fs.readFile(filePath);
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const rec = JSON.parse(trimmed) as DecisionRecord;
            if (filter?.workspaceRoot && rec.workspaceRoot !== filter.workspaceRoot) {
              continue;
            }
            records.push(rec);
          } catch {
            // 跳过损坏行
          }
        }
      } catch {
        // 读取单个会话文件失败跳过
      }
    }

    return records;
  }

  /**
   * 聚合统计核心指标
   */
  async getStats(filter?: { workspaceRoot?: string; sessionId?: string }): Promise<DecisionStats> {
    const records = await this.loadRecords(filter);
    const total = records.length;
    if (total === 0) {
      return {
        totalDecisions: 0,
        avgLatencyMs: 0,
        deferRate: 0,
        agreementRate: 0,
        taskFamilyDistribution: {},
        confidenceBuckets: { low: 0, medium: 0, high: 0, topTier: 0 },
      };
    }

    let sumLatency = 0;
    let deferCount = 0;
    let agreementCount = 0;
    let agreementEligible = 0;

    const taskFamilyDist: Record<string, number> = {};
    const buckets = { low: 0, medium: 0, high: 0, topTier: 0 };

    for (const r of records) {
      sumLatency += r.prediction?.latencyMs ?? 0;
      if (r.prediction?.defer) deferCount++;

      if (r.agreement !== undefined) {
        agreementEligible++;
        if (r.agreement) agreementCount++;
      }

      const fam = r.taskFamily || 'other';
      taskFamilyDist[fam] = (taskFamilyDist[fam] || 0) + 1;

      const conf = r.prediction?.confidence ?? 0;
      if (conf < 0.4) buckets.low++;
      else if (conf < 0.7) buckets.medium++;
      else if (conf < 0.9) buckets.high++;
      else buckets.topTier++;
    }

    return {
      totalDecisions: total,
      avgLatencyMs: Math.round((sumLatency / total) * 10) / 10,
      deferRate: Math.round((deferCount / total) * 1000) / 1000,
      agreementRate:
        agreementEligible > 0 ? Math.round((agreementCount / agreementEligible) * 1000) / 1000 : 1.0,
      taskFamilyDistribution: taskFamilyDist,
      confidenceBuckets: buckets,
    };
  }

  /**
   * 构建「项目 (workspaceRoot) -> 会话 (sessionId) -> 决策记录」三级折叠树
   */
  async getDecisionTree(): Promise<ProjectDecisionTree[]> {
    const records = await this.loadRecords();
    const projectMap = new Map<string, Map<string, DecisionRecord[]>>();
    const sessionTitleMap = new Map<string, string>();

    for (const r of records) {
      const ws = r.workspaceRoot || '未绑定项目';
      if (!projectMap.has(ws)) {
        projectMap.set(ws, new Map());
      }
      const sMap = projectMap.get(ws)!;
      if (!sMap.has(r.sessionId)) {
        sMap.set(r.sessionId, []);
      }
      sMap.get(r.sessionId)!.push(r);
      if (r.sessionTitle) {
        sessionTitleMap.set(r.sessionId, r.sessionTitle);
      }
    }

    const tree: ProjectDecisionTree[] = [];
    for (const [ws, sMap] of projectMap.entries()) {
      const sessions: SessionDecisionSummary[] = [];
      let projectDecisions = 0;

      for (const [sid, recs] of sMap.entries()) {
        recs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        projectDecisions += recs.length;

        let agreeCount = 0;
        let agreeTotal = 0;
        for (const rc of recs) {
          if (rc.agreement !== undefined) {
            agreeTotal++;
            if (rc.agreement) agreeCount++;
          }
        }

        sessions.push({
          sessionId: sid,
          sessionTitle: sessionTitleMap.get(sid) || recs[0]?.sessionTitle || '会话',
          totalDecisions: recs.length,
          agreementRate: agreeTotal > 0 ? Math.round((agreeCount / agreeTotal) * 100) / 100 : 1.0,
          lastTimestamp: recs[0]?.timestamp || '',
          records: recs,
        });
      }

      sessions.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
      const parts = ws.replace(/\\/g, '/').split('/').filter(Boolean);
      const projectName = parts[parts.length - 1] || ws;

      tree.push({
        workspaceRoot: ws,
        projectName,
        totalDecisions: projectDecisions,
        sessions,
      });
    }

    tree.sort((a, b) => b.totalDecisions - a.totalDecisions);
    return tree;
  }

  /**
   * 导出完全兼容 Reflex V1 训练集规范的 JSONL 文本 (prototype.jsonl 格式)
   */
  async exportDataset(filter?: { workspaceRoot?: string; sessionId?: string }): Promise<string> {
    const records = await this.loadRecords(filter);
    const lines: string[] = [];

    for (const r of records) {
      // 确定最佳目标动作 ID
      let selectedId = r.actualAction?.selectedId;
      if (!selectedId && r.prediction?.selectedId && !r.prediction.defer) {
        selectedId = r.prediction.selectedId;
      }
      if (!selectedId) {
        selectedId = r.candidates[0]?.id ?? 'none';
      }

      const item = {
        id: r.id,
        schema_version: 1,
        decision: {
          instruction: r.instruction,
          mode: 'select_one',
        },
        state: {
          goal: r.state.goal || 'Advance the agent task efficiently and reliably.',
          summary: r.state.summary,
          history: r.state.history || [],
          metadata: {
            domain: 'coding',
            task_family: r.taskFamily,
          },
        },
        candidates: r.candidates.map((c) => ({ id: c.id, text: c.text })),
        target: {
          selected: [selectedId],
          defer: r.prediction?.defer ?? false,
        },
        source: {
          type: 'online_shadow_mode',
          sessionId: r.sessionId,
          workspaceRoot: r.workspaceRoot,
        },
        metadata: {
          sessionId: r.sessionId,
          timestamp: r.timestamp,
          confidence: r.prediction?.confidence,
          latencyMs: r.prediction?.latencyMs,
          outcome: r.outcome,
        },
      };

      lines.push(JSON.stringify(item));
    }

    return lines.join('\n');
  }
}
