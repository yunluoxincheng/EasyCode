/**
 * @easycode/core 决策策略接口规范 (DecisionPolicy)
 * 纯 TypeScript 接口，零外部运行时依赖。
 * 用于支持端侧微型决策模型（如 Reflex）、启发式规则路由器或影子模式观测器。
 */

export interface DecisionCandidate {
  id: string;
  text: string;
}

export interface DecisionRequest {
  /** 决策指令/任务描述 */
  instruction: string;
  state: {
    /** 状态摘要 */
    summary: string;
    /** 任务总体目标 */
    goal?: string;
    /** 近期操作历史 */
    history?: string[];
  };
  /** 动态候选集 */
  candidates: DecisionCandidate[];
  /** 决策任务族标识 */
  taskFamily?: 'reasoning_effort' | 'recovery' | 'safety' | 'context_management' | string;
  metadata?: Record<string, unknown>;
}

export interface DecisionResult {
  /** 模型选出的最优候选 ID */
  selectedId: string;
  /** 最优候选文本 */
  selectedText: string;
  /** 校准后置信度 (0 ~ 1) */
  confidence: number;
  /** 是否建议降级/转交主模型 (置信度不足或不确定度高) */
  defer: boolean;
  /** 各候选归一化概率分布 */
  scores: Record<string, number>;
  /** 端侧决策耗时 (毫秒) */
  latencyMs: number;
  /** 导出模型的标识；用于区分不同权重产生的影子预测 */
  modelVersion?: string;
}

export interface DecisionActualAction {
  /** 无法无歧义映射到候选项时留空，不能猜测 */
  selectedId?: string;
  description: string;
}

export interface DecisionOutcome {
  status: 'success' | 'failure' | 'unknown';
  evidence: string;
}

export interface DecisionReview {
  selectedId?: string;
  defer: boolean;
  reviewedAt: string;
  basis: 'human';
}

/** 单条决策审计记录；预测、实际行为和人工标签来源彼此独立。 */
export interface DecisionRecord {
  id: string;
  timestamp: string;
  turnId?: string;
  workspaceRoot: string;
  sessionId: string;
  sessionTitle: string;
  taskFamily: 'reasoning_effort' | 'recovery' | 'safety' | 'context_management' | string;
  instruction: string;
  state: {
    summary: string;
    goal?: string;
    history?: string[];
  };
  candidates: DecisionCandidate[];
  prediction?: DecisionResult;
  predictionStatus?: 'pending' | 'ready' | 'failed';
  actualAction?: DecisionActualAction;
  /** Reflex 预测与实际动作是否一致 */
  agreement?: boolean;
  outcome?: DecisionOutcome;
  review?: DecisionReview;
  metadata?: Record<string, unknown>;
}

/** 决策统计摘要指标 */
export interface DecisionStats {
  totalDecisions: number;
  avgLatencyMs: number;
  deferRate: number;
  agreementRate: number;
  validPredictions?: number;
  comparableDecisions?: number;
  /** 基于无可辩驳证据链自动筛选出的合格训练样本数 */
  qualifiedSamples?: number;
  reviewedSamples?: number;
  unresolvedDecisions?: number;
  writeFailures?: number;
  taskFamilyDistribution: Record<string, number>;
  confidenceBuckets: {
    low: number;      // [0, 0.4)
    medium: number;   // [0.4, 0.7)
    high: number;     // [0.7, 0.9)
    topTier: number;  // [0.9, 1.0]
  };
}

/** 会话级决策摘要条目 */
export interface SessionDecisionSummary {
  sessionId: string;
  sessionTitle: string;
  totalDecisions: number;
  agreementRate: number;
  comparableDecisions?: number;
  qualifiedSamples?: number;
  reviewedSamples?: number;
  lastTimestamp: string;
  records: DecisionRecord[];
}

/** 项目级两级聚合树 */
export interface ProjectDecisionTree {
  workspaceRoot: string;
  projectName: string;
  totalDecisions: number;
  sessions: SessionDecisionSummary[];
}

/** 核心决策策略接口 */
export interface DecisionPolicy {
  decide(req: DecisionRequest): Promise<DecisionResult>;
  observe?(req: DecisionRequest): DecisionObservation;
}

export interface DecisionObservation {
  actual(action: DecisionActualAction): void;
  outcome(outcome: DecisionOutcome): void;
}

/** 兼容纯 DecisionPolicy 实现，观测失败不影响 Agent 主循环。 */
export function startDecisionObservation(
  policy: DecisionPolicy | undefined,
  req: DecisionRequest,
): DecisionObservation | undefined {
  if (!policy) return undefined;
  try {
    if (policy.observe) return policy.observe(req);
    void policy.decide(req).catch(() => {});
  } catch {
    // 旁路失败不改变真实执行。
  }
  return undefined;
}

/**
 * 默认空实现：当无可用策略时使用
 * 零耗时、安全回退、默认选择首项并标记 defer
 */
export class NoopDecisionPolicy implements DecisionPolicy {
  async decide(req: DecisionRequest): Promise<DecisionResult> {
    const first = req.candidates[0] ?? { id: 'none', text: 'No candidates provided' };
    const scores: Record<string, number> = {};
    for (const c of req.candidates) {
      scores[c.id] = 1.0 / (req.candidates.length || 1);
    }
    return {
      selectedId: first.id,
      selectedText: first.text,
      confidence: 0,
      defer: true,
      scores,
      latencyMs: 0,
    };
  }
}
