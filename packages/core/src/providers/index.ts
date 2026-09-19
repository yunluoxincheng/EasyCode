import type { AssistantBlock, ChatMessage, ToolCallBlock, Usage } from '../types.js';
import type { ToolSpec } from '../tools/index.js';

/** 发送给 Provider 的请求（内部格式） */
export interface StreamRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  system?: string;
  temperature?: number;
}

/** Provider 流式回调事件（文本/思考实时流出；工具调用在轮次结束后经 blocks 返回） */
export type ProviderEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'reasoning_delta'; delta: string };

export interface TurnResult {
  blocks: AssistantBlock[];
  usage?: Usage;
  stopReason?: string;
}

export interface StreamContext {
  signal: AbortSignal;
  emit(event: ProviderEvent): void;
}

/**
 * Provider 适配器接口：扩展点之二。
 * 新增模型服务 = 实现该接口并在工厂注册，agent 循环与 UI 零改动。
 */
export interface Provider {
  readonly id: string;
  stream(request: StreamRequest, ctx: StreamContext): Promise<TurnResult>;
}

/** 按顺序抽取 tool_call 块（供循环执行） */
export function extractToolCalls(blocks: AssistantBlock[]): ToolCallBlock[] {
  return blocks.filter((b): b is ToolCallBlock => b.type === 'tool_call');
}
