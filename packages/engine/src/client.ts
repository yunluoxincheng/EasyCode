import type { AgentEvent, SessionData, SessionMeta, ApprovalMode } from '@easycode/core';
import type { ModelTestResult, ProviderModelInfo, Settings } from './settings.js';

/**
 * UI 与引擎之间的传输抽象：
 * - Electron → IpcAgentClient（主进程 AgentServer）
 * - Tauri → TauriClient（WebView 内 AgentServer + Rust 宿主能力）
 * - 浏览器演示 → DemoAgentClient（进程内 MemoryHost + MockProvider）
 * 定义在 engine 层，使各宿主实现无需反向依赖 UI。
 */
export interface AgentClient {
  listSessions(): Promise<SessionMeta[]>;
  createSession(options: {
    workspaceRoot: string;
    providerId: string;
    model?: string;
    title?: string;
  }): Promise<SessionMeta>;
  deleteSession(id: string): Promise<void>;
  renameSession(id: string, title: string): Promise<SessionMeta>;
  getSession(id: string): Promise<SessionData>;
  sendMessage(id: string, text: string): Promise<void>;
  respondApproval(id: string, requestId: string, approved: boolean): Promise<void>;
  abort(id: string): Promise<void>;
  setApprovalMode(id: string, mode: ApprovalMode): Promise<void>;
  getApprovalMode(id: string): Promise<ApprovalMode>;
  /** 会话级模型覆盖；'' = 跟随供应商默认 */
  setSessionModel(id: string, model: string): Promise<SessionMeta>;
  /** 会话级思考强度；'' = 跟随供应商默认 */
  setSessionEffort(id: string, effort: string): Promise<SessionMeta>;
  /** 绑定/更换会话工作区；空串 = 解绑为纯对话 */
  setSessionWorkspace(id: string, workspace: string): Promise<SessionMeta>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  /** 从供应商 API 拉取可用模型及元数据（OpenAI 兼容 /models、Anthropic /v1/models） */
  listProviderModels(providerId: string): Promise<ProviderModelInfo[]>;
  /** 单模型连通性测试：最小真实请求，返回延迟或错误 */
  testProviderModel(providerId: string, model: string): Promise<ModelTestResult>;
  /** 联网搜索连通性测试：用已保存配置真实搜索一次 */
  testWebSearch(): Promise<{ ok: boolean; latencyMs: number; resultCount?: number; error?: string }>;
  pickWorkspace(): Promise<string | null>;
  onEvent(listener: (payload: { sessionId: string; event: AgentEvent }) => void): () => void;
}
