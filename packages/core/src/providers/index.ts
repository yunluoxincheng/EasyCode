import type { AssistantBlock, ChatMessage, ToolCallBlock, Usage } from '../types.js';
import type { ToolSpec } from '../tools/index.js';

/** 发送给 Provider 的请求（内部格式） */
export interface StreamRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  system?: string;
  temperature?: number;
  /** 思考强度（minimal/low/medium/high/max）；'' 或缺省 = 跟随供应商默认。是否生效取决于供应商 */
  reasoningEffort?: string;
}

/** 文本/思考及工具生成元数据实时流出；可执行的完整工具调用仅在轮次结束后经 blocks 返回。 */
export type ProviderEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  /** 仅生成状态；不包含参数，不能触发审批或执行。 */
  | { type: 'tool_call_preparing'; callId: string; name: string; argumentChars?: number; argumentsComplete?: boolean };

export interface TurnResult {
  blocks: AssistantBlock[];
  usage?: Usage;
  stopReason?: string;
}

export interface StreamContext {
  signal: AbortSignal;
  /** 可选的单次响应字节预算；子任务用它限制工具参数等尚未产出事件的缓冲。 */
  maxResponseBytes?: number;
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
