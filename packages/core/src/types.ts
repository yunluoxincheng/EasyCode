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
  /** 会话内唯一标识（UI 锚点/编辑定位用） */
  id?: string;
  /** ISO 时间戳 */
  createdAt?: string;
}
export interface AssistantMessage {
  role: 'assistant';
  blocks: AssistantBlock[];
  id?: string;
  createdAt?: string;
}
export interface ToolResultMessage {
  role: 'tool_result';
  toolCallId: string;
  toolName: string;
  content: string;
  isError?: boolean;
  id?: string;
  createdAt?: string;
}
export type ChatMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  /** 命中提示缓存的输入 token 数（占输入的子集） */
  cachedTokens?: number;
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

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export type TodoPriority = 'high' | 'medium' | 'low';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  priority?: TodoPriority;
}

export interface SessionData {
  meta: SessionMeta;
  messages: ChatMessage[];
  /** 会话累计 token 用量与步数（引擎累计并持久化） */
  usage?: { input: number; output: number; steps: number; cached?: number };
  /** 当前任务清单（由 todo_write 工具维护） */
  todos?: TodoItem[];
}

/** 会话审批模式：ask=写文件/执行命令需人工批准；yolo=自动放行 */
export type ApprovalMode = 'ask' | 'yolo';
