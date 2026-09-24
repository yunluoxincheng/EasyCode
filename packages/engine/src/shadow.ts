import type {
  DecisionPolicy,
  DecisionRequest,
  DecisionResult,
  DecisionRecord,
  DecisionObservation,
  DecisionActualAction,
  DecisionOutcome,
} from '@easycode/core';
import type { DecisionStatsManager } from './stats.js';

export interface ShadowContextInfo {
  sessionId: string;
  sessionTitle: string;
  workspaceRoot: string;
  turnId: string;
}

function redact(text: string, maxLength: number): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]')
    .slice(0, maxLength);
}

/** 深度递归脱敏对象，过滤密码、Token、私钥等任何敏感键值，杜绝落盘泄露 */
function redactObject(val: unknown, depth = 0): unknown {
  if (depth > 4) return '[TRUNCATED]';
  if (typeof val === 'string') return redact(val, 300);
  if (typeof val === 'number' || typeof val === 'boolean' || val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.slice(0, 10).map((item) => redactObject(item, depth + 1));
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (/password|token|key|secret|auth|credential|cookie|cert/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactObject(v, depth + 1);
      }
    }
    return out;
  }
  return String(val).slice(0, 100);
}

/**
 * 影子模式决策策略 (ShadowDecisionPolicy)
 * 职责：
 * 1. 代理调用底层真实决策策略（如 LocalOnnxPolicy、MockPolicy 或 NoopPolicy）
 * 2. 捕获决策输入、输出、耗时与置信度
 * 3. 异步、非阻塞落盘 DecisionRecord，完全不拖慢或中断 Agent 正常运转
 */
export class ShadowDecisionPolicy implements DecisionPolicy {
  private readonly pending = new Set<Promise<void>>();
  constructor(
    private readonly inner: DecisionPolicy,
    private readonly statsManager: DecisionStatsManager,
    private readonly ctx: ShadowContextInfo,
  ) {}

  /** 仅用于纯策略兼容；Agent 运行时使用 observe 关联后续真实行为。 */
  decide(req: DecisionRequest): Promise<DecisionResult> {
    return this.inner.decide(req);
  }

  observe(req: DecisionRequest): DecisionObservation {
    // 模型收到的文本与落盘文本一致，敏感串在本地推理前即被遮蔽。
    const safeReq: DecisionRequest = {
      instruction: redact(req.instruction, 300),
      state: {
        summary: redact(req.state.summary, 400),
        goal: req.state.goal ? redact(req.state.goal, 200) : undefined,
        history: req.state.history?.slice(-5).map((h) => redact(h, 100)),
      },
      candidates: req.candidates.map((c) => ({ id: c.id, text: redact(c.text, 300) })),
      taskFamily: req.taskFamily,
    };
    const record: DecisionRecord = {
      id: `dec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      turnId: this.ctx.turnId,
      workspaceRoot: this.ctx.workspaceRoot,
      sessionId: this.ctx.sessionId,
      sessionTitle: this.ctx.sessionTitle,
      taskFamily: safeReq.taskFamily || 'other',
      instruction: safeReq.instruction,
      state: safeReq.state,
      candidates: safeReq.candidates,
      predictionStatus: 'pending',
      metadata: req.metadata ? (redactObject(req.metadata) as Record<string, unknown>) : undefined,
    };
    void this.statsManager.appendEvent(this.ctx.sessionId, { kind: 'requested', record }).catch(() => {});

    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      // 首次加载需下载 80MB 权重与分词器并编译 WASM，冷启动放宽至 30s，避免首轮误判超时
      timer = setTimeout(() => reject(new Error('Reflex inference timeout')), 30000);
    });
    const prediction = Promise.resolve().then(() => this.inner.decide(safeReq));
    const task = Promise.race([prediction, timeout]).then((result) => {
      const selected = safeReq.candidates.find((c) => c.id === result.selectedId);
      const scores = safeReq.candidates.map((c) => result.scores?.[c.id]);
      const scoreSum = scores.reduce<number>((sum, score) => sum + (score ?? 0), 0);
      if (!selected || result.selectedText !== selected.text ||
          typeof result.defer !== 'boolean' ||
          !Number.isFinite(result.confidence) || result.confidence <= 0 || result.confidence > 1 ||
          !Number.isFinite(result.latencyMs) || result.latencyMs <= 0 ||
          scores.some((score) => !Number.isFinite(score) || score! < 0 || score! > 1) ||
          Math.abs(scoreSum - 1) > 0.02 ||
          Math.abs(result.confidence - (result.scores?.[result.selectedId] ?? 0)) > 0.02) {
        throw new Error('Reflex returned no valid prediction');
      }
      return this.statsManager.appendEvent(this.ctx.sessionId, {
        kind: 'predicted', id: record.id, prediction: result,
      });
    }).catch(() => {
      void this.statsManager.appendEvent(this.ctx.sessionId, {
        kind: 'prediction_failed', id: record.id,
      }).catch(() => {});
    }).finally(() => clearTimeout(timer));
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));

    let actualRecorded = false;
    return {
      actual: (action: DecisionActualAction) => {
        if (actualRecorded) return;
        actualRecorded = true;
        const safeAction = {
          selectedId: safeReq.candidates.some((c) => c.id === action.selectedId)
            ? action.selectedId : undefined,
          description: redact(action.description, 200),
        };
        void this.statsManager.appendEvent(this.ctx.sessionId, {
          kind: 'actual', id: record.id, action: safeAction,
        }).catch(() => {});
      },
      outcome: (outcome: DecisionOutcome) => {
        void this.statsManager.appendEvent(this.ctx.sessionId, {
          kind: 'outcome', id: record.id,
          outcome: { status: outcome.status, evidence: redact(outcome.evidence, 200) },
        }).catch(() => {});
      },
    };
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
    await this.statsManager.flush(this.ctx.sessionId);
  }
}
