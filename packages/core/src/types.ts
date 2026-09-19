/** 消息与内容的统一内部格式。各 Provider 适配器负责与协议线格式互转。 */

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ThinkingBlock {
  type: 'thinking';
  text: string;
}
export interface ToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  input: unknown;
}
export type AssistantBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export interface UserMessage {
  role: 'user';
  content: string;
}
export interface AssistantMessage {
  role: 'assistant';
  blocks: AssistantBlock[];
}
export interface ToolResultMessage {
  role: 'tool_result';
  toolCallId: string;
  toolName: string;
  content: string;
  isError?: boolean;
}
export type ChatMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface SessionMeta {
  id: string;
  title: string;
  workspaceRoot: string;
  providerId: string;
  model: string;
  /** 思考强度；'' = 跟随供应商默认。生效与否取决于供应商是否支持 reasoning_effort */
  reasoningEffort?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionData {
  meta: SessionMeta;
  messages: ChatMessage[];
}

/** 会话审批模式：ask=写文件/执行命令需人工批准；yolo=自动放行 */
export type ApprovalMode = 'ask' | 'yolo';
