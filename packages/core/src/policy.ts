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
}

/** 单条已完成的决策审计记录（用于日志归档、统计聚合与微调数据反哺） */
export interface DecisionRecord {
  id: string;
  timestamp: string;
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
  prediction: DecisionResult;
  actualAction?: {
    selectedId?: string;
    description: string;
  };
  /** Reflex 预测与实际动作是否一致 */
  agreement?: boolean;
  /** 后续动作执行 outcome 结果 */
  outcome?: 'success' | 'failure';
}

/** 决策统计摘要指标 */
export interface DecisionStats {
  totalDecisions: number;
  avgLatencyMs: number;
  deferRate: number;
  agreementRate: number;
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
