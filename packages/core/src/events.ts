import type { ToolCallBlock, Usage } from './types.js';

/** 引擎 → UI 的单向事件流（传输层无关：IPC / 进程内 / CLI 终端皆可承载） */
export type AgentEvent =
  /** 每轮模型回复开始（UI 据此开启新的助手消息气泡） */
  | { type: 'assistant_start' }
  | { type: 'text_delta'; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool_call_start'; call: ToolCallBlock }
  | {
      type: 'tool_result';
      callId: string;
      toolName: string;
      content: string;
      isError: boolean;
      durationMs: number;
    }
  | { type: 'approval_request'; requestId: string; toolName: string; input: unknown }
  | { type: 'approval_resolved'; requestId: string; approved: boolean }
  | {
      type: 'step_end';
      usage?: Usage;
      /** 本会话累计（输入/输出/步数/缓存命中），由引擎累计 */
      sessionUsage?: { input: number; output: number; steps: number; cached?: number };
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
