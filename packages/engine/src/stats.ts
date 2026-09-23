import type { Host } from '@easycode/core';
import type {
  DecisionRecord,
  DecisionResult,
  DecisionActualAction,
  DecisionOutcome,
  DecisionReview,
  DecisionStats,
  ProjectDecisionTree,
  SessionDecisionSummary,
} from '@easycode/core';

export type DecisionLogEvent =
  | { kind: 'requested'; record: DecisionRecord }
  | { kind: 'snapshot'; record: DecisionRecord }
  | { kind: 'predicted'; id: string; prediction: DecisionResult }
  | { kind: 'prediction_failed'; id: string }
  | { kind: 'actual'; id: string; action: DecisionActualAction }
  | { kind: 'outcome'; id: string; outcome: DecisionOutcome }
  | { kind: 'reviewed'; id: string; review: DecisionReview };

/**
 * 决策统计与日志归档管理器 (DecisionStatsManager)
 * 职责：
 * 1. 追加归档决策日志至 ${dataDir}/reflex_decisions/${sessionId}.jsonl
 * 2. 计算跨项目、跨会话的多维效能与置信度统计指标
 * 3. 组织以「项目 (workspaceRoot) -> 会话 (sessionId) -> 决策记录」为层级的三级树
 * 4. 导出完全兼容 Reflex V1 训练管线规范的 .jsonl 数据集
 */
export class DecisionStatsManager {
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly deletedSessions = new Set<string>();
  private writeFailures = 0;

  constructor(private readonly host: Host) {}

  private dir(): string {
    return this.host.paths.join(this.host.env.dataDir(), 'reflex_decisions');
  }

  private sessionFile(sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session ID');
    return this.host.paths.join(this.dir(), `${sessionId}.jsonl`);
  }

  /** 每个会话串行追加事件；失败可统计，不能覆盖先前日志。 */
  appendEvent(sessionId: string, event: DecisionLogEvent): Promise<void> {
    if (this.deletedSessions.has(sessionId)) return Promise.resolve();
    const previous = this.writeQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await this.host.fs.mkdir(this.dir(), { recursive: true });
      await this.host.fs.appendFile(this.sessionFile(sessionId), JSON.stringify(event) + '\n');
    });
    this.writeQueues.set(sessionId, next);
    void next.catch(() => { this.writeFailures++; });
    return next;
  }

  /** 兼容旧调用方；新旁路应使用多阶段事件。 */
  recordDecision(record: DecisionRecord): Promise<void> {
    return this.appendEvent(record.sessionId, { kind: 'snapshot', record });
  }

  async flush(sessionId?: string): Promise<void> {
    const pending = sessionId
      ? [this.writeQueues.get(sessionId)]
      : [...this.writeQueues.values()];
    await Promise.allSettled(pending.filter((p): p is Promise<void> => p !== undefined));
  }

  /**
   * 当会话删除时同步清理对应的决策日志
   */
  async deleteSessionRecords(sessionId: string): Promise<void> {
    try {
      this.deletedSessions.add(sessionId);
      await this.flush(sessionId);
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
    if (filter?.sessionId) this.sessionFile(filter.sessionId);
    await this.flush(filter?.sessionId);
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
        const byId = new Map<string, DecisionRecord>();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const entry = JSON.parse(trimmed) as DecisionLogEvent | DecisionRecord;
            if ('kind' in entry) {
              if (entry.kind === 'requested' || entry.kind === 'snapshot') {
                byId.set(entry.record.id, {
                  ...entry.record,
                  predictionStatus: entry.kind === 'requested' ? 'pending' : 'ready',
                });
                continue;
              }
              const rec = byId.get(entry.id);
              if (!rec) continue;
              if (entry.kind === 'predicted') {
                rec.prediction = entry.prediction;
                rec.predictionStatus = 'ready';
              } else if (entry.kind === 'prediction_failed') {
                rec.predictionStatus = 'failed';
              } else if (entry.kind === 'actual') {
                rec.actualAction = entry.action;
              } else if (entry.kind === 'outcome') {
                rec.outcome = entry.outcome;
              } else if (entry.kind === 'reviewed') {
                rec.review = entry.review;
              }
            } else if (entry && typeof entry.id === 'string') {
              // 无 turnId 的旧版日志曾把非 defer 直接记为 agreement，且可能写入伪降级结果。
              // 只展示历史内容，不计入有效预测或一致率，也不允许进入训练集。
              byId.set(entry.id, {
                ...entry,
                predictionStatus: entry.turnId && entry.prediction ? 'ready' : 'failed',
              });
            }
          } catch {
            // 跳过损坏行
          }
        }
        for (const rec of byId.values()) {
          rec.agreement = rec.turnId && rec.predictionStatus === 'ready' &&
            rec.actualAction?.selectedId !== undefined &&
            rec.candidates.some((c) => c.id === rec.actualAction?.selectedId)
              ? rec.prediction?.selectedId === rec.actualAction.selectedId
              : undefined;
          if (!filter?.workspaceRoot || rec.workspaceRoot === filter.workspaceRoot) records.push(rec);
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
        validPredictions: 0,
        comparableDecisions: 0,
        reviewedSamples: 0,
        unresolvedDecisions: 0,
        writeFailures: this.writeFailures,
        taskFamilyDistribution: {},
        confidenceBuckets: { low: 0, medium: 0, high: 0, topTier: 0 },
      };
    }

    let sumLatency = 0;
    let validPredictions = 0;
    let deferCount = 0;
    let agreementCount = 0;
    let agreementEligible = 0;
    let reviewedSamples = 0;
    let unresolvedDecisions = 0;

    const taskFamilyDist: Record<string, number> = {};
    const buckets = { low: 0, medium: 0, high: 0, topTier: 0 };

    for (const r of records) {
      if (r.predictionStatus === 'ready' && r.prediction) {
        validPredictions++;
        sumLatency += r.prediction.latencyMs;
        if (r.prediction.defer) deferCount++;
      }
      if (r.review?.basis === 'human') reviewedSamples++;
      if (!r.actualAction?.selectedId) unresolvedDecisions++;

      if (r.agreement !== undefined) {
        agreementEligible++;
        if (r.agreement) agreementCount++;
      }

      const fam = r.taskFamily || 'other';
      taskFamilyDist[fam] = (taskFamilyDist[fam] || 0) + 1;

      if (r.predictionStatus === 'ready' && r.prediction) {
        const conf = r.prediction.confidence;
        if (conf < 0.4) buckets.low++;
        else if (conf < 0.7) buckets.medium++;
        else if (conf < 0.9) buckets.high++;
        else buckets.topTier++;
      }
    }

    return {
      totalDecisions: total,
      avgLatencyMs: validPredictions ? Math.round((sumLatency / validPredictions) * 10) / 10 : 0,
      deferRate: validPredictions ? Math.round((deferCount / validPredictions) * 1000) / 1000 : 0,
      agreementRate:
        agreementEligible > 0 ? Math.round((agreementCount / agreementEligible) * 1000) / 1000 : 0,
      validPredictions,
      comparableDecisions: agreementEligible,
      reviewedSamples,
      unresolvedDecisions,
      writeFailures: this.writeFailures,
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
          agreementRate: agreeTotal > 0 ? Math.round((agreeCount / agreeTotal) * 100) / 100 : 0,
          comparableDecisions: agreeTotal,
          reviewedSamples: recs.filter((r) => r.review?.basis === 'human').length,
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

  /** 人工审核是训练标签的唯一来源，真实动作仅供对照，预测绝不自标注。 */
  async reviewDecision(
    sessionId: string,
    recordId: string,
    label: { selectedId?: string; defer: boolean },
  ): Promise<void> {
    const record = (await this.loadRecords({ sessionId })).find((r) => r.id === recordId);
    if (!record || record.sessionId !== sessionId || !record.turnId) {
      throw new Error('找不到可审核的新版本决策记录');
    }
    if (!label || typeof label.defer !== 'boolean') throw new Error('defer 必须是布尔值');
    if (label.defer && label.selectedId) throw new Error('defer 标签不能同时选择候选项');
    if (!label.defer && !record.candidates.some((c) => c.id === label.selectedId)) {
      throw new Error('训练标签必须选择当前候选集中的一项');
    }
    const review: DecisionReview = {
      selectedId: label.defer ? undefined : label.selectedId,
      defer: label.defer,
      reviewedAt: new Date().toISOString(),
      basis: 'human',
    };
    await this.appendEvent(sessionId, { kind: 'reviewed', id: recordId, review });
  }

  /**
   * 导出符合 Reflex V1 结构的微调数据集。
   * 默认严格模式：仅导出人工审核通过的样本（basis: 'human'），避免自标注污染。
   * 若指定 includeUnreviewed: true，则允许导出带 Agent 实际观察动作的完整轨迹数据（用于离线分析与对照）。
   */
  async exportDataset(filter?: {
    workspaceRoot?: string;
    sessionId?: string;
    includeUnreviewed?: boolean;
  }): Promise<string> {
    const records = await this.loadRecords(filter);
    const lines: string[] = [];

    for (const r of records) {
      if (!r.turnId) continue;
      if (!r.instruction.trim() || !r.state.summary.trim() ||
          r.candidates.length < 2 || r.candidates.length > 32) continue;
      const ids = r.candidates.map((c) => c.id);
      if (new Set(ids).size !== ids.length || r.candidates.some((c) => !c.id || !c.text.trim())) continue;

      const review = r.review;
      const isHuman = review?.basis === 'human';

      if (!isHuman && !filter?.includeUnreviewed) continue;

      let target: { selected: string[]; defer: boolean } | undefined;

      if (isHuman) {
        if (!review.defer && (!review.selectedId || !ids.includes(review.selectedId))) continue;
        if (review.defer && review.selectedId) continue;
        target = {
          selected: review.defer || !review.selectedId ? [] : [review.selectedId],
          defer: review.defer,
        };
      }

      const item: Record<string, unknown> = {
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
        source: {
          type: isHuman ? 'online_shadow_human_review' : 'online_shadow_trajectory',
          label_basis: isHuman ? 'human' : 'unlabeled_observation',
          reviewed_at: review?.reviewedAt,
        },
        split_group: `online:${r.turnId}`,
        metadata: {
          timestamp: r.timestamp,
          sessionId: r.sessionId,
          model_version: r.prediction?.modelVersion,
          observed_action: r.actualAction?.selectedId,
          observed_outcome: r.outcome?.status,
        },
      };

      // 仅人工审核过的样本才允许写入监督训练目标 target，严防未审核实际动作/模型预测自污染
      if (target) {
        item.target = target;
      } else {
        item.observed = {
          action: r.actualAction,
          outcome: r.outcome,
          prediction: r.prediction,
        };
      }

      lines.push(JSON.stringify(item));
    }

    return lines.join('\n');
  }
}
