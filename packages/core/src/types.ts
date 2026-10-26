/** 消息与内容的统一内部格式。各 Provider 适配器负责与协议线格式互转。 */
import type { DelegatedTaskRecord } from './delegation.js';

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
  /** 发送时固化的 @file:start-end 代码行范围切片快照（TODOS #38：防历史上下文漂移与重复磁盘读取） */
  rangeContext?: string;
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
  /** 实际执行许可；旧历史缺省时未知，不能据此确认工具执行成功。 */
  approved?: boolean;
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
  /** 会话级单调递增回合序号（不受上下文压缩裁剪消息影响，TODOS #36） */
  turnSeq?: number;
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
  /** 有界的子任务过程，仅供回看，不进入 Provider 消息。 */
  delegatedTasks?: DelegatedTaskRecord[];
  meta: SessionMeta;
  messages: ChatMessage[];
  /** 压缩前的原始时间线，仅供展示/编辑；模型请求始终使用 messages。旧版本丢弃的历史无法恢复。 */
  history?: ChatMessage[];
  /** 会话累计 token 用量与步数（引擎累计并持久化） */
  usage?: { input: number; output: number; steps: number; cached?: number };
  /** 当前任务清单（由 todo_write 工具维护） */
  todos?: TodoItem[];
  /** 会话单调递增的回合执行计数器（不受上下文压缩或历史裁剪影响，TODOS #36） */
  turnCounter?: number;
}

/** 会话审批模式：ask=写文件/执行命令需人工批准；yolo=自动放行 */
export type ApprovalMode = 'ask' | 'yolo';
