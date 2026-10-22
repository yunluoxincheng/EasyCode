import type { ToolCallBlock, Usage } from './types.js';
import type { BackgroundTaskInfo } from './tasks.js';
import type { TestRunSummary } from './test-runner.js';

/** 引擎 → UI 的单向事件流（传输层无关：IPC / 进程内 / CLI 终端皆可承载） */
export type AgentEvent =
  /** 全局 MCP 目录失效通知，不携带配置或凭据，sessionId 为空。 */
  | { type: 'mcp_catalog_changed' }
  /** 每轮模型回复开始（UI 据此开启新的助手消息气泡） */
  | { type: 'assistant_start' }
  | { type: 'text_delta'; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  /** 仅提示模型正在生成调用，不含参数，不进入审批或执行。 */
  | { type: 'tool_call_preparing'; callId: string; name: string }
  | { type: 'tool_call_start'; call: ToolCallBlock }
  /** 已通过守卫/审批并取得执行锁，实际工具函数即将运行。 */
  | { type: 'tool_execution_start'; callId: string }
  | {
      type: 'tool_result';
      callId: string;
      toolName: string;
      content: string;
      isError: boolean;
      durationMs: number;
      timing?: { approvalMs: number; executionMs?: number };
      /**
       * 是否被批准执行（TODOS #47）：`false` 表示被用户拒绝或被权限规则拒绝。
       * UI 必须据此渲染「拒绝」状态，**不得**通过匹配中文提示文本判断执行结果。
       */
      approved?: boolean;
    }
  | {
      type: 'approval_request';
      requestId: string;
      toolName: string;
      input: unknown;
      /** 触发原因说明（如命中的权限规则，TODOS #47） */
      reason?: string;
    }
  | { type: 'approval_resolved'; requestId: string; approved: boolean }
  | {
      type: 'step_end';
      usage?: Usage;
      /** 本会话累计（输入/输出/步数/缓存命中），由引擎累计 */
      sessionUsage?: { input: number; output: number; steps: number; cached?: number };
    }
  | {
      type: 'context_compacted';
      beforeTokens?: number;
      afterTokens?: number;
      summary: string;
    }
  | {
      /**
       * 测试自愈循环单轮开始（TODOS #39）：进入回合时间线渲染 <TestRunCard>，
       * 不参与模型上下文，也不占用工具调用 ID
       */
      type: 'test_run_start';
      round: number;
      maxRounds: number;
      command: string;
      /** 测试命令探测来源说明（如 package.json / 设置页自定义 / 项目配置） */
      source: string;
      /** 可选的聚焦目标（/test-loop 参数） */
      focus?: string;
    }
  | {
      /** 测试自愈循环单轮结束：结果摘要 + 输出尾部（供卡片展开查看） */
      type: 'test_run_result';
      round: number;
      command: string;
      ok: boolean;
      exitCode: number | null;
      durationMs: number;
      summary: TestRunSummary;
      outputTail: string;
    }
  | {
      /** 测试自愈循环收敛：passed=全绿 / max_rounds=轮次耗尽 / aborted=用户中止 / error=异常 */
      type: 'test_loop_done';
      ok: boolean;
      rounds: number;
      reason: 'passed' | 'max_rounds' | 'aborted' | 'error';
      message?: string;
    }
  | {
      /** 后台任务状态变化（TODOS #37）：不进入回合时间线，仅驱动底部任务条与预览面板 */
      type: 'background_task';
      action: 'started' | 'exited' | 'stopped' | 'recovered' | 'stop_failed' | 'removed';
      task: BackgroundTaskInfo;
    }
  | { type: 'error'; message: string }
  | { type: 'done'; reason: 'completed' | 'aborted' | 'error' };

/** UI → 引擎 */
export type ClientMessage =
  | { type: 'user_message'; text: string }
  | { type: 'approval_response'; requestId: string; approved: boolean }
  | { type: 'abort' };

/** 极简强类型事件发射器（避免依赖 node:events，保证浏览器可运行） */
export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(value: T): void {
    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch {
        // 监听器异常不阻断事件流
      }
    }
  }
}
