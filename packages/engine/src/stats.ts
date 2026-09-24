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

export interface AutoLabelResult {
  target: {
    selected: string[];
    defer: boolean;
  };
  labelBasis: string;
}

/**
 * 有证据的自动标注规则引擎：
 * 绝不能直接拿 Reflex 预测、Agent 动作、推理档位配置或审批模式直接当作 target！
 * 必须结合任务族语义、可观测动作事实、后续执行结果以及整次回合状态多重证据进行判定。
 * 无法形成可验证因果证据的，返回 null（严格排除，不导出伪标签）。
 */
export function deriveGroundTruthTarget(r: DecisionRecord): AutoLabelResult | null {
  if (!r.turnId) return null;
  if (!r.instruction?.trim() || !r.state?.summary?.trim() || !Array.isArray(r.candidates)) {
    return null;
  }
  if (r.candidates.length < 2 || r.candidates.length > 32) return null;
  const candidateIds = r.candidates.map((c) => c.id);
  if (new Set(candidateIds).size !== candidateIds.length) return null;
  if (r.candidates.some((c) => !c.id || !c.text?.trim())) return null;

  // 人工显式审核标签具有最高证据效力
  if (r.review?.basis === 'human') {
    if (!r.review.defer && (!r.review.selectedId || !candidateIds.includes(r.review.selectedId))) return null;
    if (r.review.defer && r.review.selectedId) return null;
    return {
      target: {
        selected: r.review.defer || !r.review.selectedId ? [] : [r.review.selectedId],
        defer: r.review.defer,
      },
      labelBasis: 'human_review',
    };
  }

  // 1. 任务族：tool_routing（工具路由前瞻预测）
  // 证据规则：Agent 在该步的后续真实行为以及该工具的执行结果（outcome）
  if (r.taskFamily === 'tool_routing') {
    const act = r.actualAction?.selectedId;
    const outcome = r.outcome?.status;

    // 情况 A：Agent 选择了 stop_respond（直接回复用户，未调用工具）
    // 证据：Agent 在本步没有发起任何工具调用，且整轮执行正常（outcome 不是 failure）
    if (act === 'stop_respond') {
      if (outcome === 'failure') return null;
      return {
        target: { selected: ['stop_respond'], defer: false },
        labelBasis: 'verified_turn_completion_without_tools',
      };
    }

    // 情况 B：Agent 实际调用了工具
    // 证据：该工具执行必须被事实证明是成功的（outcome.status === 'success'，如退出码 0、读写成功）
    // 排除条件：如果工具执行失败（outcome === 'failure'，如命令非零退出、文件不存在）或者未执行/被拒绝，
    // 绝对不能将此错误工具选为正样本！
    if (act && candidateIds.includes(act)) {
      if (outcome === 'success') {
        return {
          target: { selected: [act], defer: false },
          labelBasis: 'verified_tool_execution_success',
        };
      }
      return null;
    }
    return null;
  }

  // 2. 任务族：recovery（工具错误自愈策略）
  // 证据规则：发生错误后，随后的自愈工具调用（actualAction）是否成功修复并推进了任务（outcome === 'success'）
  if (r.taskFamily === 'recovery') {
    const act = r.actualAction?.selectedId;
    const outcome = r.outcome?.status;
    if (act && candidateIds.includes(act) && outcome === 'success') {
      return {
        target: { selected: [act], defer: false },
        labelBasis: 'recovery_action_verified_success',
      };
    }
    return null;
  }

  // 3. 任务族：context_management（上下文修剪决策）
  // 证据规则：基于实际输入 Token 使用率（ratio）与上下文管理操作事实
  if (r.taskFamily === 'context_management') {
    const ratio = typeof r.metadata?.ratio === 'number' ? r.metadata.ratio : undefined;
    const act = r.actualAction?.selectedId;

    if (ratio !== undefined && ratio <= 0.50 && act === 'keep') {
      return {
        target: { selected: ['keep'], defer: false },
        labelBasis: 'context_verified_safe_ratio',
      };
    }
    if (ratio !== undefined && ratio >= 0.85 && act === 'compact_all') {
      return {
        target: { selected: ['compact_all'], defer: false },
        labelBasis: 'context_compacted_and_sustained',
      };
    }
    if (act === 'prune_tools') {
      return {
        target: { selected: ['prune_tools'], defer: false },
        labelBasis: 'context_tools_pruned_successfully',
      };
    }
    return null;
  }

  // 4. 任务族：reasoning_effort（推理深度动态决策）
  // 证据规则：绝不拿用户设置的偏好当 target！以当前回合整体事实达成的客观计算复杂度为准
  if (r.taskFamily === 'reasoning_effort') {
    const evidence = r.outcome?.evidence;
    const status = r.outcome?.status;
    if (status !== 'success' || !evidence) return null;

    const matchSteps = /turnSteps:(\d+)/.exec(evidence);
    if (!matchSteps) return null;
    const steps = parseInt(matchSteps[1], 10);
    if (Number.isNaN(steps)) return null;

    if (steps <= 1) {
      return {
        target: { selected: ['fast'], defer: false },
        labelBasis: 'turn_objective_low_complexity',
      };
    }
    if (steps >= 4) {
      return {
        target: { selected: ['high'], defer: false },
        labelBasis: 'turn_objective_high_complexity',
      };
    }
    if (steps >= 2 && steps <= 3) {
      return {
        target: { selected: ['medium'], defer: false },
        labelBasis: 'turn_objective_medium_complexity',
      };
    }
    return null;
  }

  // 5. 任务族：safety（敏感操作安全风控）
  // 排除条件：在没有代码 AST 沙箱安全证明的情况下，审批模式（ask/yolo）不能作为安全真值。
  // 为杜绝伪标签，未经验证的 safety 记录严格排除！
  if (r.taskFamily === 'safety') {
    return null;
  }

  return null;
}

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
    let qualifiedSamples = 0;
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
      if (deriveGroundTruthTarget(r) !== null) qualifiedSamples++;
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
      qualifiedSamples,
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
          qualifiedSamples: recs.filter((r) => deriveGroundTruthTarget(r) !== null).length,
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

  /** 人工审核是训练标签的可选权威来源之一，供开发者精细覆盖。 */
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
   * 导出完全兼容 Reflex V1 训练集规范的合格微调数据集。
   * 基于严格的客观证据链自动标注与筛选，无法可靠判定的记录不导出，绝不生成伪标签。
   */
  async exportDataset(filter?: {
    workspaceRoot?: string;
    sessionId?: string;
  }): Promise<string> {
    const records = await this.loadRecords(filter);
    const lines: string[] = [];

    for (const r of records) {
      const autoLabel = deriveGroundTruthTarget(r);
      if (!autoLabel) continue;

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
        target: autoLabel.target,
        source: {
          type: 'online_shadow_auto_label',
          label_basis: autoLabel.labelBasis,
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

      lines.push(JSON.stringify(item));
    }

    return lines.join('\n');
  }
}
