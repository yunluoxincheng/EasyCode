import type { AgentEvent, SessionData, SessionMeta, ApprovalMode } from '@easycode/core';
import type { ModelTestResult, ProviderModelInfo, Settings, ShellInfo } from './settings.js';

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
  /** 从指定节点分叉出新会话（继承配置、无损克隆截取历史） */
  forkSession(
    id: string,
    options?: { upToMessageId?: string; beforeUserIndex?: number },
  ): Promise<SessionMeta>;
  /** 精简会话历史：保留最近若干轮关键交互与最新待办清单，裁剪早期冗长历史 */
  trimSessionHistory(id: string, keepRecentTurns?: number): Promise<SessionData>;
  deleteSession(id: string): Promise<void>;
  renameSession(id: string, title: string): Promise<SessionMeta>;
  getSession(id: string): Promise<SessionData>;
  sendMessage(id: string, text: string): Promise<void>;
  /** 编辑最近一条用户消息并重新生成（截断其后内容） */
  editLastUserMessage(id: string, text: string): Promise<void>;
  respondApproval(id: string, requestId: string, approved: boolean): Promise<void>;
  abort(id: string): Promise<void>;
  setApprovalMode(id: string, mode: ApprovalMode): Promise<void>;
  getApprovalMode(id: string): Promise<ApprovalMode>;
  /** 会话级模型覆盖；'' = 跟随供应商默认 */
  setSessionModel(id: string, model: string): Promise<SessionMeta>;
  /** 会话级 Provider 切换（同时重置模型） */
  setSessionProvider(id: string, providerId: string, model?: string): Promise<SessionMeta>;
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
  /** 会话级工作区打开（由宿主用系统文件管理器打开指定路径） */
  openPath(path: string): Promise<void>;
  /** 用 VS Code 打开目录（宿主探测 code 命令，未安装时抛错） */
  openInVscode(path: string): Promise<void>;
  /** 发送系统通知（由宿主用原生通知中心发送） */
  notify(title: string, body: string): Promise<void>;
  /** 探测系统可用的命令行终端 Shell 列表（由宿主探测） */
  detectShells?(): Promise<ShellInfo[]>;
  /** 列出工作区文件列表（支持 query 模糊过滤，供 @文件 快捷引用） */
  listWorkspaceFiles(id: string, query?: string): Promise<string[]>;
  pickWorkspace(): Promise<string | null>;
  onEvent(listener: (payload: { sessionId: string; event: AgentEvent }) => void): () => void;
}
