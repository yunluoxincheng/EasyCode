import type {
  DecisionPolicy,
  DecisionRequest,
  DecisionResult,
  DecisionRecord,
} from '@easycode/core';
import type { DecisionStatsManager } from './stats.js';

export interface ShadowContextInfo {
  sessionId: string;
  sessionTitle: string;
  workspaceRoot: string;
}

/**
 * 影子模式决策策略 (ShadowDecisionPolicy)
 * 职责：
 * 1. 代理调用底层真实决策策略（如 LocalOnnxPolicy、MockPolicy 或 NoopPolicy）
 * 2. 捕获决策输入、输出、耗时与置信度
 * 3. 异步、非阻塞落盘 DecisionRecord，完全不拖慢或中断 Agent 正常运转
 */
export class ShadowDecisionPolicy implements DecisionPolicy {
  constructor(
    private readonly inner: DecisionPolicy,
    private readonly statsManager: DecisionStatsManager,
    private readonly ctx: ShadowContextInfo,
  ) {}

  async decide(req: DecisionRequest): Promise<DecisionResult> {
    const started = Date.now();
    let result: DecisionResult;
    try {
      result = await this.inner.decide(req);
    } catch {
      // 降级保护：内部决策失败时安全返回 Noop 结果
      const first = req.candidates[0] ?? { id: 'none', text: 'None' };
      result = {
        selectedId: first.id,
        selectedText: first.text,
        confidence: 0,
        defer: true,
        scores: {},
        latencyMs: Date.now() - started,
      };
    }

    // 组装审计记录并异步落盘
    const record: DecisionRecord = {
      id: `dec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      workspaceRoot: this.ctx.workspaceRoot,
      sessionId: this.ctx.sessionId,
      sessionTitle: this.ctx.sessionTitle,
      taskFamily: req.taskFamily || 'other',
      instruction: req.instruction,
      state: {
        summary: req.state.summary,
        goal: req.state.goal,
        history: req.state.history,
      },
      candidates: req.candidates,
      prediction: result,
      agreement: !result.defer,
    };

    // 纯旁路异步写入，不 await，不捕获向上抛出
    void this.statsManager.recordDecision(record).catch(() => {});

    return result;
  }
}
