import {
  AgentEvent,
  ApprovalManager,
  UserQuestionManager,
  AnthropicProvider,
  ResponsesProvider,
  ChatMessage,
  Emitter,
  Host,
  MockProvider,
  OpenAICompatibleProvider,
  Provider,
  SessionData,
  SessionMeta,
  runAgentLoop,
  type LoopResult,
  createBuiltinTools,
  runWebSearch,
  listFilesRecursively,
  compactHistoryMessages,
  getGitStatus,
  getGitDiff,
  stageGitFiles,
  discardGitChanges,
  splitUnifiedDiff,
  type ApprovalMode,
  type TodoItem,
  type UserAnswer,
  type UserQuestionRequest,
  type GitStatusSummary,
  type GitFileChange,
  type GitDiffResult,
  type GitDiffOptions,
  NoopDecisionPolicy,
  type DecisionPolicy,
  type DecisionStats,
  type ProjectDecisionTree,
  BackgroundTaskManager,
  type BackgroundTaskInfo,
  type SpawnedProcessInfo,
  resolveWorkspacePath,
  resolveCodeRangeMentions,
  parseCodeRangeMentions,
  detectTestCommand,
  describeCommandParseRisk,
  describePermissionRule,
  evaluatePermission,
  resolveApprovalRequirement,
  resolveRealPathInWorkspace,
  type PermissionRule,
  type PermissionRuleSource,
  type TestCommandDetection,
} from '@easycode/core';
import { Settings, DEFAULT_SETTINGS, PROVIDER_PRESETS } from './settings.js';
import type { ModelTestResult, ProviderEntry, ProviderModel, ProviderModelInfo } from './settings.js';
import { loadModelDirectory, resolveModelMeta } from './model-catalog.js';
import { buildSystemPrompt } from './prompts.js';
import { Mutex, WorkspaceLockManager } from './workspace-lock.js';
import { SettingsSecrets } from './settings-secrets.js';
import { McpManager, validateMcpServers } from './mcp.js';
import { DecisionStatsManager } from './stats.js';
import { ShadowDecisionPolicy } from './shadow.js';
import { runTestLoop, type TestLoopResult } from './test-loop.js';
import {
  CheckpointManager,
  type TurnCheckpointSummary,
  type TurnUndoPreview,
  type TurnUndoFilePreview,
  type RevertTurnOptions,
} from './checkpoints.js';

export type { TurnCheckpointSummary, TurnUndoPreview, TurnUndoFilePreview, RevertTurnOptions, TestLoopResult };

/** 回合快照回退执行结果（TODOS #36） */
export interface TurnUndoResult {
  turnId: string;
  turnNumber: number;
  revertedPaths: string[];
  checkpoints: TurnCheckpointSummary[];
  session: SessionData;
}

/** 工作区文件轻量预览结果（TODOS #38） */
export interface WorkspaceFilePreview {
  path: string;
  content: string;
  totalLines: number;
  size: number;
  truncated: boolean;
}

/** 测试自愈循环启动参数（TODOS #39） */
export interface RunTestLoopRequest {
  /** 显式指定测试命令（覆盖自动探测与设置项） */
  command?: string;
  /** 最大自愈轮次（1~5，默认取设置或 3） */
  maxRounds?: number;
  /** 聚焦目标（/test-loop 参数），仅注入修复提示词，不改变测试命令 */
  focus?: string;
}

export interface CreateSessionOptions {
  /** 可选：不填则创建纯对话会话，之后可随时绑定 */
  workspaceRoot?: string;
  providerId: string;
  model?: string;
  title?: string;
}

/** 工作区项目规范文件信息（TODOS #33） */
export interface ProjectRuleInfo {
  path: string;
  content: string;
  exists: boolean;
}

/** 自定义 Prompt 指令信息（TODOS #32） */
export interface CustomPromptInfo {
  id: string;
  name: string;
  description: string;
  template: string;
}

export type { GitStatusSummary, GitFileChange, GitDiffResult, GitDiffOptions };
export { splitUnifiedDiff };

interface SessionRuntime {
  data: SessionData;
  approval: ApprovalManager;
  questions?: UserQuestionManager;
  controller?: AbortController;
  /** 当前顶层操作（含落盘）的收尾确认；停止不能只等 abort 信号发出。 */
  settled?: Promise<void>;
  running: boolean;
  /** 测试自愈循环执行中（TODOS #39）：与 running 一同阻止并发发送 */
  busy?: boolean;
  /**
   * 抑制常规 `done` 事件（TODOS #39 第三轮复审 P2）。
   *
   * 测试自愈循环的修复回合是一次**内部** Agent 回合：它结束后外层循环还要继续跑测试。
   * 若照常发 `done`，前端会立即关闭当前回合、恢复 idle，并可能弹出「任务完成」通知，
   * 而实际上自愈尚未结束——表现为一个任务被拆成多段 UI 回合、未完成就先提示完成。
   * 因此修复回合期间置位本标记，由外层 `test_loop_done` 掌握最终结束语义。
   */
  suppressDone?: boolean;
  /**
   * 已从会话表删除（PR #9 第七轮复审 P2）。
   *
   * 删除发生在测试循环启动早期时，循环仍持有原 rt 对象，退出时还会调用
   * `persistSession(rt)` —— 若不拦，已删除的会话文件会被重新写回磁盘（会话「复活」）。
   */
  deleted?: boolean;
  /** 在途落盘任务：删除会话时必须等**全部**落定，否则较早写入完成时会把文件重新创建 */
  persisting?: Set<Promise<void>>;
  /** 落盘串行链尾：同一会话的写入排队，避免旧快照晚于新快照落盘 */
  persistQueue?: Promise<void>;
}

export interface SessionEventPayload {
  sessionId: string;
  event: AgentEvent;
}

/**
 * 会话服务：组装 core（循环/工具/Provider）与注入的 Host，
 * 负责会话生命周期、设置、持久化与事件分发。
 * 运行环境不可知 —— Electron 主进程、CLI、浏览器演示模式共用。
 */
export class AgentServer {
  private sessions = new Map<string, SessionRuntime>();
  private readonly events = new Emitter<SessionEventPayload>();
  private readonly workspaceLocks = new WorkspaceLockManager();
  /**
   * 会话级「运行上下文操作」互斥锁（PR #9 第三轮复审 P1）。
   *
   * 仅靠入口处 `isSessionBusy()` 检查存在 TOCTOU：某操作通过检查后停在异步等待
   * （如 `host.fs.stat()` / 快照查询），期间测试自愈循环启动进入 busy，
   * 该操作随后仍会完成，导致会话上下文中途被改。
   *
   * 约定：所有会改写运行上下文或磁盘文件的操作，都在**临界区内**重新检查 busy，
   * 而不是只在入口检查一次；`runTestLoop` 只在临界区内完成「检查 + 置 busy」，
   * 之后立即释放，避免长时间占锁阻塞交互。
   */
  private readonly sessionOpLocks = new Map<string, Mutex>();
  /** 会话绑定的后台任务池（TODOS #37）：懒创建，会话删除/应用退出统一清场 */
  private readonly bgManagers = new Map<string, BackgroundTaskManager>();
  private readonly decisionStats: DecisionStatsManager;
  private readonly checkpoints: CheckpointManager;
  private reflexPolicy: DecisionPolicy = new NoopDecisionPolicy();
  private settings: Settings = structuredClone(DEFAULT_SETTINGS);
  private settingsLoaded = false;
  private settingsLoading?: Promise<void>;
  private readonly settingsLock = new Mutex();
  private readonly settingsSecrets: SettingsSecrets;
  private readonly mcp: McpManager;
  private readonly transientApiKeys = new Map<string, string>();
  /**
   * 词法工作区键 → 已解析的物理身份（`realpath` 归一化结果）。
   *
   * `isProjectTrusted()` 是同步接口（UI 与多处裁决都要即时判断），而物理身份
   * 解析是异步的，因此由授予信任、裁决入口等异步路径刷新此缓存，同步查询只读缓存。
   */
  private readonly workspaceIdentities = new Map<string, string>();

  constructor(private readonly host: Host) {
    this.settingsSecrets = new SettingsSecrets(host);
    this.mcp = new McpManager(host, (id) => this.settingsLock.withLock(async () => {
      const config = this.settings.mcpServers?.[id];
      if (!config) throw new Error('未配置的 MCP 服务');
      return this.settingsSecrets.mcpConfig(config);
    }), () => this.events.emit({ sessionId: '', event: { type: 'mcp_catalog_changed' } }));
    this.decisionStats = new DecisionStatsManager(host);
    this.checkpoints = new CheckpointManager(host);
  }

  /** 注入端侧真实决策推理策略（如 WebOnnxPolicy 或 LocalOnnxPolicy） */
  setReflexPolicy(policy: DecisionPolicy): void {
    this.reflexPolicy = policy;
  }

  private resolveReflexPolicy(): DecisionPolicy {
    return this.reflexPolicy;
  }

  /* -------------------- 事件订阅 -------------------- */

  onEvent(listener: (payload: SessionEventPayload) => void): () => void {
    return this.events.subscribe(listener);
  }

  /* -------------------- 会话管理 -------------------- */

  async createSession(options: CreateSessionOptions): Promise<SessionMeta> {
    await this.ensureSettings();
    const entry = this.settings.providers[options.providerId];
    if (!entry) {
      throw new Error(`未配置的模型服务: ${options.providerId}，请在设置中检查`);
    }
    const enabledModels = (entry.models ?? [])
      .filter((m) => m.enabled !== false)
      .map((m) => m.name);
    if (entry.kind !== 'mock' && enabledModels.length === 0) {
      throw new Error('该模型服务还没有启用的模型，请先在设置中添加');
    }
    const model = options.model ?? enabledModels[0] ?? 'mock-1';
    const workspace = options.workspaceRoot?.trim() ?? '';
    if (workspace) {
      const stat = await this.host.fs.stat(workspace);
      if (!stat || !stat.isDirectory) {
        throw new Error(`工作区不存在或不是目录: ${workspace}`);
      }
    }
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id: `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title: options.title?.trim() || '新会话',
      workspaceRoot: workspace,
      providerId: options.providerId,
      model,
      createdAt: now,
      updatedAt: now,
    };
    const runtime: SessionRuntime = {
      data: { meta, messages: [] },
      approval: new ApprovalManager(this.emitterFor(meta.id), this.settings.defaultApprovalMode),
      running: false,
    };
    this.sessions.set(meta.id, runtime);
    await this.persistSession(runtime);
    return meta;
  }

  /**
   * 从指定会话分叉（Fork）出新会话：
   * - 继承原会话的工作区绑定、模型服务、模型覆盖与思考档位；
   * - 截取指定点以前的消息历史并深拷贝；
   * - 继承该时间点的任务清单，重置 Token 计费统计；
   * - 新会话标题默认追加「（分支）」后缀。
   */
  async forkSession(
    sessionId: string,
    options?: { upToMessageId?: string; beforeUserIndex?: number },
  ): Promise<SessionMeta> {
    await this.ensureSettings();
    const rt = this.requireSession(sessionId);
    // 分叉读取并克隆历史：必须与测试循环互斥，否则可能克隆到执行中的不一致状态
    return this.withSessionOpLock(
      sessionId,
      '原会话正在运行中，请等待完成或停止后再分叉',
      () => this.forkSessionLocked(rt, options),
    );
  }

  private async forkSessionLocked(
    rt: SessionRuntime,
    options?: { upToMessageId?: string; beforeUserIndex?: number },
  ): Promise<SessionMeta> {
    // UI 锚点来自完整时间线，不能用已压缩上下文的用户序号定位。
    const source = rt.data.history ?? rt.data.messages;
    let slicedMessages: ChatMessage[] = [];
    if (options?.beforeUserIndex !== undefined) {
      const targetUserIndex = options.beforeUserIndex;
      if (targetUserIndex <= 0) {
        slicedMessages = [];
      } else {
        let userCount = 0;
        let cutIdx = source.length;
        for (let i = 0; i < source.length; i++) {
          if (source[i].role === 'user') {
            if (userCount === targetUserIndex) {
              cutIdx = i;
              break;
            }
            userCount++;
          }
        }
        slicedMessages = source.slice(0, cutIdx);
      }
    } else if (options?.upToMessageId) {
      const targetId = options.upToMessageId;
      const idx = source.findIndex((m) => m.id === targetId);
      if (idx === -1) {
        slicedMessages = source.slice();
      } else {
        let endIdx = idx + 1;
        while (endIdx < source.length && source[endIdx].role === 'tool_result') {
          endIdx++;
        }
        slicedMessages = source.slice(0, endIdx);
      }
    } else {
      slicedMessages = source.slice();
    }

    const clonedMessages = structuredClone(slicedMessages);
    // 完整时间线只用于锚点定位/展示；分叉仍保留父会话的压缩边界。
    // 指定历史锚点时从截取前缀重建，不能继承包含锚点之后事实的旧摘要。
    const forkContext = rt.data.history
      ? options?.beforeUserIndex !== undefined || options?.upToMessageId
        ? compactHistoryMessages(structuredClone(clonedMessages), { keepRecentTurns: 2 }).messages
        : structuredClone(rt.data.messages)
      : clonedMessages;
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id: `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title: `${rt.data.meta.title || '新会话'}（分支）`,
      workspaceRoot: rt.data.meta.workspaceRoot,
      providerId: rt.data.meta.providerId,
      model: rt.data.meta.model,
      reasoningEffort: rt.data.meta.reasoningEffort,
      createdAt: now,
      updatedAt: now,
    };

    const latestTodos = extractLatestTodos(clonedMessages);
    const newRuntime: SessionRuntime = {
      data: {
        meta,
        messages: forkContext,
        history: rt.data.history ? clonedMessages : undefined,
        todos: latestTodos ? structuredClone(latestTodos) : undefined,
      },
      approval: new ApprovalManager(this.emitterFor(meta.id), this.settings.defaultApprovalMode),
      running: false,
    };

    this.sessions.set(meta.id, newRuntime);
    await this.persistSession(newRuntime);
    return meta;
  }

  /**
   * 精简/压缩会话历史（TODOS #30 & #31）：
   * 保留最近若干轮关键交互（默认保留最后 2 轮完整用户回合）与最新待办清单，
   * 提炼关键文件、命令与任务进度，折叠旧工具长输出并注入高密度阶段记忆说明，腾出足够的 Token 空间。
   */
  async trimSessionHistory(id: string, keepRecentTurns = 2): Promise<SessionData> {
    await this.ensureSettings();
    const rt = this.requireSession(id);
    // 压缩会改写历史消息（会话运行上下文），与测试循环互斥
    return this.withSessionOpLock(id, '会话正在运行中，请先等待完成或点击停止', async () => {
      if (rt.data.messages.length === 0) return rt.data;

      this.ensureMessageIds(rt);
      const history = structuredClone(rt.data.history ?? rt.data.messages);

      // compactHistoryMessages 即使 compacted=false，也可能原地裁剪工具输出。
      // 在副本上计算，并按消息的实际变化统一提交归档，避免丢原文或漏落盘。
      const candidate = structuredClone(rt.data.messages);
      const compRes = compactHistoryMessages(candidate, {
        keepRecentTurns,
        pruneTools: true,
      });

      if (JSON.stringify(compRes.messages) !== JSON.stringify(rt.data.messages)) {
        rt.data.history = history;
        rt.data.messages = compRes.messages;
        const latestTodos = extractLatestTodos(rt.data.messages);
        if (latestTodos) {
          rt.data.todos = structuredClone(latestTodos);
        }
        rt.data.meta.updatedAt = new Date().toISOString();
        await this.persistSession(rt);
      }
      return rt.data;
    });
  }

  async listSessions(): Promise<SessionMeta[]> {
    // 冷启动恢复会话时会用 settings.defaultApprovalMode 等默认值构造运行时，
    // 必须先加载设置：否则历史会话的审批模式会退回 DEFAULT_SETTINGS（ask），
    // 导致用户配置的 yolo 在重启后失效、测试自愈卡在审批上（PR #9 第三轮复审发现）
    await this.ensureSettings();
    const metas = [...this.sessions.values()].map((rt) => rt.data.meta);
    if (metas.length > 0) return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    // 冷启动：从磁盘恢复
    const dir = this.sessionsDir();
    try {
      const entries = await this.host.fs.readdir(dir);
      for (const entry of entries) {
        if (entry.isDirectory || !entry.name.endsWith('.json')) continue;
        try {
          const raw = await this.host.fs.readFile(this.host.paths.join(dir, entry.name));
          const data = JSON.parse(raw) as SessionData;
          if (data?.meta?.id) {
            this.sessions.set(data.meta.id, {
              data,
              approval: new ApprovalManager(
                this.emitterFor(data.meta.id),
                this.settings.defaultApprovalMode,
              ),
              running: false,
            });
          }
        } catch {
          // 单个会话文件损坏不影响其余
        }
      }
    } catch {
      return [];
    }
    return [...this.sessions.values()]
      .map((rt) => rt.data.meta)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getSession(id: string): Promise<SessionData> {
    const rt = this.requireSession(id);
    this.ensureMessageIds(rt);
    return rt.data;
  }

  private ensureMessageIds(rt: SessionRuntime): void {
    for (const messages of [rt.data.messages, rt.data.history ?? []]) {
      for (const message of messages) {
        message.id ??= `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      }
    }
  }

  async deleteSession(id: string): Promise<void> {
    const rt = this.sessions.get(id);
    if (rt) {
      // 删除标记必须先于 abort 落下：会话删除后，任何仍在运行的异步流程
      // （测试循环、修复回合）都不得把它重新持久化回来（PR #9 第七轮复审 P2）。
      // persistSession 见到该标记直接放弃写入。
      rt.deleted = true;
    }
    // abort 会中止 controller；测试循环启动早期就已挂上 controller，
    // 因此「探测命令 / 审批」阶段被删除同样能收到中止信号。
    this.abort(id);
    this.sessions.delete(id);
    if (rt?.persisting) {
      // 等**所有**在途落盘落定（不能只等最后一个：串行链上较早的任务完成时
      // 可能晚于 unlink，把已删除的文件重新创建出来）。deleted 标记已置位，
      // 排队中的任务轮到时也会自行放弃，因此这里不会无限等待。
      for (;;) {
        const pending = rt.persisting;
        if (!pending || pending.size === 0) break;
        await Promise.allSettled([...pending]);
      }
    }
    // 会话删除同步终止其后台任务，杜绝僵尸进程与孤儿端口（TODOS #37）。
    // 仍有清理失败（存活）任务时保留 manager —— 引用已从会话表摘除，
    // 供应用退出 stopAllBackgroundTasks 兜底再清一次
    const bg = this.bgManagers.get(id);
    if (bg) {
      await bg.disposeAll();
      if (bg.runningCount() === 0) {
        this.bgManagers.delete(id);
      }
    }
    try {
      await this.host.fs.unlink?.(this.sessionFile(id));
      await this.decisionStats.deleteSessionRecords(id);
      await this.checkpoints.deleteSessionCheckpoints(id);
    } catch {
      // 忽略
    }
  }

  /** 更新会话标题 */
  async renameSession(id: string, title: string): Promise<SessionMeta> {
    const rt = this.requireSession(id);
    rt.data.meta.title = title.trim() || rt.data.meta.title;
    rt.data.meta.updatedAt = new Date().toISOString();
    await this.persistSession(rt);
    return rt.data.meta;
  }

  /* -------------------- 运行控制 -------------------- */

  async sendMessage(id: string, text: string): Promise<void> {
    const rt = this.requireSession(id);
    const content = text.trim();
    if (!content) throw new Error('消息为空');
    await this.runUserOperation(rt, () => {
      if (rt.data.messages.length === 0) {
        rt.data.meta.title = content.slice(0, 30) + (content.length > 30 ? '…' : '');
      }
      const message: ChatMessage = {
        role: 'user',
        content,
        id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
      };
      rt.data.messages.push(message);
      rt.data.history?.push(structuredClone(message));
      rt.data.meta.updatedAt = new Date().toISOString();
      this.emitterFor(id)({ type: 'user_message_committed', messageId: message.id! });
    });
  }

  /** 编辑最近一条用户消息：替换文本、丢弃其后的内容并重新生成 */
  async editLastUserMessage(id: string, text: string): Promise<void> {
    const rt = this.requireSession(id);
    this.ensureMessageIds(rt);
    const message = [...(rt.data.history ?? rt.data.messages)].reverse().find((m) => m.role === 'user');
    if (!message?.id) throw new Error('会话中没有用户消息');
    await this.editUserMessage(id, message.id, text);
  }

  /** 按持久消息 ID 编辑，原会话截断后续历史；不隐式撤销磁盘文件或停止独立服务。 */
  async editUserMessage(id: string, messageId: string, text: string): Promise<void> {
    const rt = this.requireSession(id);
    const content = text.trim();
    if (!content) throw new Error('消息为空');
    await this.runUserOperation(rt, async (signal) => {
      const source = rt.data.history ?? rt.data.messages;
      const idx = source.findIndex((m) => m.role === 'user' && m.id === messageId);
      if (idx < 0) throw new Error('原消息已失效，请重新加载会话后再编辑');
      const newUserMsgId = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const discardedSlice = source.slice(idx);
      const removedUserIds: string[] = [];
      const removedToolCallIds: string[] = [];
      for (const m of discardedSlice) {
        if (m.role === 'user' && m.id) {
          removedUserIds.push(m.id);
        } else if (m.role === 'assistant') {
          for (const b of m.blocks) {
            if (b.type === 'tool_call' && b.id) {
              removedToolCallIds.push(b.id);
            }
          }
        }
      }
      const messages = structuredClone(source.slice(0, idx));
      messages.push({
        role: 'user',
        content,
        id: newUserMsgId,
        createdAt: new Date().toISOString(),
      });
      const previous = rt.data;
      const next: SessionData = {
        ...previous,
        meta: { ...previous.meta, updatedAt: new Date().toISOString() },
        history: previous.history ? structuredClone(messages) : undefined,
        messages: previous.history
          ? compactHistoryMessages(structuredClone(messages), { keepRecentTurns: 2 }).messages
          : messages,
        todos: extractLatestTodos(messages) ?? [],
      };
      // 裁剪与历史写入期间保持互斥；写入失败同时恢复原历史和快照，禁止半提交后继续生成。
      await this.checkpoints.pruneCheckpointsByIds(id, removedUserIds, removedToolCallIds, async () => {
        rt.data = next;
        try {
          await this.persistSession(rt, true);
        } catch (error) {
          rt.data = previous;
          throw error;
        }
      });
      rt.approval.denyAll();
      rt.questions?.cancelAll();
      this.emitterFor(id)({ type: 'history_replaced', messages, contextMessages: rt.data.messages, todos: rt.data.todos ?? [] });
      signal.throwIfAborted();
    });
  }

  private async runUserOperation(
    rt: SessionRuntime,
    prepare: (signal: AbortSignal) => void | Promise<void>,
  ): Promise<void> {
    if (rt.running || rt.busy) throw new Error('会话正在运行中，请先等待完成或点击停止');
    rt.running = true;
    const controller = new AbortController();
    rt.controller = controller;
    let resolve!: () => void;
    const settled = new Promise<void>((done) => { resolve = done; });
    rt.settled = settled;
    let reason: LoopResult['reason'] = 'error';
    try {
      await this.sessionOpLock(rt.data.meta.id).withLock(async () => {
        controller.signal.throwIfAborted();
        await prepare(controller.signal);
      });
      controller.signal.throwIfAborted();
      reason = (await this.runTurn(rt, controller)).reason;
    } catch (error) {
      if (controller.signal.aborted && error instanceof DOMException && error.name === 'AbortError') {
        reason = 'aborted';
        await this.persistSession(rt);
      } else {
        throw error;
      }
    } finally {
      if (controller.signal.aborted && reason !== 'error') reason = 'aborted';
      rt.questions?.cancelAll();
      rt.running = false;
      if (rt.controller === controller) rt.controller = undefined;
      if (rt.settled === settled) rt.settled = undefined;
      // 终止事件在所有历史/快照落盘之后，前端才能安全接受下一条消息。
      if (!rt.deleted) this.emitterFor(rt.data.meta.id)({ type: 'done', reason });
      resolve();
    }
  }

  /**
   * 执行一轮 Agent（消息由调用方先行构造；负责运行态与持久化）。
   * 返回循环的终止原因：调用方（如测试自愈循环）需要据此区分成功、失败与中止，
   * 不能只看事件流——事件只表达过程，不表达「这一回合是否真的完成任务」。
   */
  private async runTurn(rt: SessionRuntime, controller?: AbortController): Promise<LoopResult> {
    const id = rt.data.meta.id;
    this.ensureMessageIds(rt);
    this.syncHistory(rt);
    const lastUserMessage = [...rt.data.messages].reverse().find((m) => m.role === 'user');
    rt.running = true;
    // 测试自愈循环（TODOS #39）在修复回合中复用循环持有的 controller：
    // 否则用户点停止只会打断修复回合，循环的 signal 依然存活，下一轮测试会继续跑起来。
    // 复用时本方法**不拥有**该 controller，收尾阶段不得解除注册（见 finally）。
    const inheritedController = controller ?? (rt.busy && rt.controller ? rt.controller : undefined);
    const turnController = inheritedController ?? new AbortController();
    rt.controller = turnController;
    let loopResult: LoopResult | undefined;
    let shadowPolicy: ShadowDecisionPolicy | undefined;
    const cleanUserMap = new Map<
      string,
      { content: string; createdAt?: string; rangeContext?: string }
    >();
    let wireMessages: ChatMessage[] | undefined;
    try {
      // 快照序号分配与回合开启都可能抛错（磁盘/持久化异常），
      // 必须放在 try 内，否则 rt.running 会永久保持 true（PR #9 复审 P2）
      const userMessagesCount = rt.data.messages.filter((m) => m.role === 'user').length;
      const turnNumber = await this.checkpoints.allocateTurnNumber(
        id,
        rt.data.meta.turnSeq,
        Math.max(1, userMessagesCount),
      );
      rt.data.meta.turnSeq = turnNumber;
      if (lastUserMessage && !lastUserMessage.id) {
        lastUserMessage.id = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      }
      const turnTracker = this.checkpoints.beginTurn({
        sessionId: id,
        workspaceRoot: rt.data.meta.workspaceRoot,
        turnNumber,
        userMessageId: lastUserMessage?.id ?? `u_${turnNumber}`,
      });
      const entry = this.settings.providers[rt.data.meta.providerId];
      const firstEnabled = (entry?.models ?? []).find((m) => m.enabled !== false)?.name ?? 'default';
      const model = rt.data.meta.model || firstEnabled;
      const modelInfo = (entry?.models ?? []).find((m) => m.name === model);
      const caps = modelInfo?.capabilities ?? ['system'];
      const contextWindow = modelInfo?.contextWindow ?? entry?.contextWindow ?? 1_000_000;
      const compactionCfg = this.settings.contextCompaction;
      const autoCompact = compactionCfg?.autoCompact !== false;
      const compactThreshold = compactionCfg?.threshold ?? 0.85;
      // 联网搜索分流：总开关关闭=全部不搜索；有原生工具的走原生，否则走内置 web_search()
      const searchOn = caps.includes('websearch') && this.settings.webSearch?.enabled === true;
      const useNativeSearch = searchOn && supportsNativeWebSearch(model, entry.kind);
      const provider = await this.createProvider(rt.data.meta.providerId, model, useNativeSearch);
      const webSearchCfg = searchOn && !useNativeSearch
        ? await this.settingsLock.withLock(() => this.settingsSecrets.webSearch(this.settings.webSearch))
        : undefined;
      const builtinTools = createBuiltinTools(
        searchOn && !useNativeSearch && webSearchCfg && validWebSearchBackend(webSearchCfg)
          ? {
              webSearch: {
                backend: webSearchCfg.backend,
                searxngUrl: webSearchCfg.searxngUrl,
                tavilyApiKey: webSearchCfg.tavilyApiKey,
                maxResults: webSearchCfg.maxResults,
              },
            }
          : undefined,
      );
      // 权限规则（TODOS #47）：全局设置 + 项目级 .easycode/permissions.json 并集
      this.mcp.sync(this.settings.mcpServers ?? {});
      await this.mcp.register(builtinTools, turnController.signal);
      const permissionRules = await this.resolvePermissionRules(rt.data.meta.workspaceRoot);
      // 对话中系统消息：模型配置关闭时把系统提示词并入首条用户消息
      // 提取工作区规则与全局偏好并注入系统提示词（天然抗上下文压缩，TODOS #33）
      const projectRules = rt.data.meta.workspaceRoot
        ? await this.getProjectRules(rt.data.meta.workspaceRoot)
        : null;
      const systemPrompt = buildSystemPrompt(this.host, rt.data.meta.workspaceRoot, {
        webSearch: searchOn,
        rules: {
          projectRules,
          globalRules: this.settings.globalRules,
        },
      });
      // TODOS #38 (P2 #7 修复)：代码行范围引用仅在消息首次发送时解析并固化至 msg.rangeContext，
      // 后续轮次直接复用发送时的静态切片快照，杜绝跨轮次重复磁盘读取与历史上下文漂移
      let baseMessages: ChatMessage[] = rt.data.messages;
      const cloned: ChatMessage[] = [];
      let anyEnriched = false;
      for (const msg of rt.data.messages) {
        if (msg.role === 'user') {
          if (!msg.id) {
            msg.id = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
          }
          if (msg.rangeContext === undefined) {
            if (rt.data.meta.workspaceRoot && parseCodeRangeMentions(msg.content).length > 0) {
              const { enrichedText, snippets } = await resolveCodeRangeMentions(
                this.host,
                rt.data.meta.workspaceRoot,
                msg.content,
              );
              msg.rangeContext = snippets.length > 0 ? enrichedText.slice(msg.content.length) : '';
            } else {
              msg.rangeContext = '';
            }
          }
          cleanUserMap.set(msg.id, {
            content: msg.content,
            createdAt: msg.createdAt,
            rangeContext: msg.rangeContext,
          });
          if (msg.rangeContext) {
            cloned.push({ ...msg, content: `${msg.content}${msg.rangeContext}` });
            anyEnriched = true;
            continue;
          }
        }
        cloned.push(msg);
      }
      if (anyEnriched) baseMessages = cloned;
      wireMessages = (!systemPrompt || caps.includes('system'))
          ? baseMessages
          : mergeSystemIntoUser(baseMessages, systemPrompt);

      const cleanMessage = (message: ChatMessage): ChatMessage => {
        const copy = structuredClone(message);
        if (copy.role === 'user' && copy.id && cleanUserMap.has(copy.id)) {
          Object.assign(copy, cleanUserMap.get(copy.id));
        }
        return copy;
      };

      // 工作区物理身份（消解符号链接别名）——锁键与别名登记都以此为准，
      // 保证同一物理目录的不同写法共享同一把锁（PR #9 第五轮复审 P2）
      const workspaceIdentity = await this.resolveWorkspaceIdentity(
        rt.data.meta.workspaceRoot ?? '',
      );

      // 装配微型决策策略（TODOS #40：Shadow Mode 旁路观测）
      // 门控：仅当用户开启 reflexShadowMode 开关时挂载，关闭时 policy 为 undefined（零 CPU 额外计算、零日志写入）
      const policy = this.settings.reflexShadowMode
        ? (shadowPolicy = new ShadowDecisionPolicy(
            this.resolveReflexPolicy(),
            this.decisionStats,
            {
              sessionId: rt.data.meta.id,
              sessionTitle: rt.data.meta.title,
              workspaceRoot: rt.data.meta.workspaceRoot,
              turnId: `${id}_${lastUserMessage?.id ?? Date.now().toString(36)}`,
            },
          ))
        : undefined;

      loopResult = await runAgentLoop({
        provider,
        tools: builtinTools,
        host: this.host,
        workspace: rt.data.meta.workspaceRoot,
        systemPrompt: caps.includes('system') ? systemPrompt : '',
        messages: wireMessages,
        signal: turnController.signal,
        approval: rt.approval,
        questions: this.questionsFor(rt),
        policy,
        permissionRules,
        onBeforeCompaction: () => {
          rt.data.history ??= wireMessages!.map(cleanMessage);
        },
        onMessage: (message) => {
          rt.data.history?.push(cleanMessage(message));
        },
        backgroundTasks: await this.bgManagerFor(id),
        onFileChange: async (change) => {
          if (rt.data.meta.workspaceRoot) {
            this.workspaceFilesCache.delete(rt.data.meta.workspaceRoot);
          }
          await turnTracker.recordFileChange(change);
        },
        emit: (event) => {
          if (event.type === 'context_compacted') {
            this.emitterFor(id)({ ...event, messages: wireMessages!.map(cleanMessage) });
            return;
          }
          if (event.type === 'step_end') {
            // 累计会话用量并随事件下发（持久化在会话文件中）
            const u = rt.data.usage ?? { input: 0, output: 0, steps: 0 };
            u.input += event.usage?.inputTokens ?? 0;
            u.output += event.usage?.outputTokens ?? 0;
            u.cached = (u.cached ?? 0) + (event.usage?.cachedTokens ?? 0);
            u.steps += 1;
            rt.data.usage = u;
            this.emitterFor(id)({
              ...event,
              sessionUsage: {
                input: u.input,
                output: u.output,
                steps: u.steps,
                cached: u.cached ?? 0,
              },
            });
            return;
          }
          // 内部修复回合不向外发 done：外层 test_loop_done 才是真正的结束语义。
          // 否则前端会提前关闭回合、误报「任务完成」，且自愈中途误发桌面通知
          // （PR #9 第三轮复审 P2）
          if (event.type === 'done') return;
          this.emitterFor(id)(event);
        },
        reasoningEffort: rt.data.meta.reasoningEffort ?? '',
        shell: this.settings.shell ?? 'auto',
        maxSteps: this.settings.maxSteps ?? 200,
        contextWindow: autoCompact ? contextWindow : undefined,
        autoCompactThreshold: compactThreshold,
        workspaceLock: rt.data.meta.workspaceRoot
          ? this.workspaceLocks.getLock(workspaceIdentity)
          : undefined,
      });
      if (loopResult.reason === 'error' && loopResult.errorMessage) {
        this.events.emit({ sessionId: id, event: { type: 'error', message: loopResult.errorMessage } });
      }
    } finally {
      await shadowPolicy?.drain();
      if (wireMessages && wireMessages !== rt.data.messages) {
        rt.data.messages = wireMessages;
      }
      if (cleanUserMap.size > 0) {
        for (const msg of rt.data.messages) {
          if (msg.role === 'user' && msg.id && cleanUserMap.has(msg.id)) {
            const clean = cleanUserMap.get(msg.id)!;
            msg.content = clean.content;
            if (clean.createdAt !== undefined) msg.createdAt = clean.createdAt;
            if (clean.rangeContext !== undefined) msg.rangeContext = clean.rangeContext;
          }
        }
      }
      rt.data.meta.updatedAt = new Date().toISOString();
      const latestTodos = extractLatestTodos(rt.data.messages);
      if (latestTodos) {
        rt.data.todos = latestTodos;
      }
      await this.persistSession(rt);
      if (!controller) rt.running = false;
      // controller 的释放在持久化**之后**，且只释放本方法自己创建的那个：      // 若在 persistSession 之前就注销（或误释放外层循环的 controller），
      // 用户恰好在落盘等待期间点停止时 abort() 会找不到 controller，
      // 循环 signal 不受影响，恢复后又继续跑下一轮测试（PR #9 第七轮复审 P2）。
      // 继承自测试循环的 controller 由循环的 finally 统一释放。
      if (!inheritedController && rt.controller === turnController) {
        rt.controller = undefined;
      }
    }
    // 理论上 finally 前一定已赋值；兜底按失败返回，避免调用方误判成功
    return loopResult ?? { reason: 'error', errorMessage: '回合未产生结果' };
  }

  respondApproval(id: string, requestId: string, approved: boolean): void {
    this.requireSession(id).approval.resolve(requestId, approved);
  }

  private questionsFor(rt: SessionRuntime): UserQuestionManager {
    return rt.questions ??= new UserQuestionManager((event) => {
      if (!rt.deleted) this.emitterFor(rt.data.meta.id)(event);
    });
  }

  getPendingQuestion(id: string): UserQuestionRequest | null {
    return this.requireSession(id).questions?.getPending() ?? null;
  }

  respondQuestion(id: string, requestId: string, answers: UserAnswer[]): void {
    const manager = this.requireSession(id).questions;
    if (!manager) throw new Error('问题已过期');
    manager.respond(requestId, answers);
  }

  async cancelQuestion(id: string, requestId: string): Promise<void> {
    const rt = this.requireSession(id);
    if (!rt.questions?.cancel(requestId)) throw new Error('问题已过期，未停止当前的新回合');
    await this.abort(id);
  }

  async abort(id: string): Promise<void> {
    const rt = this.sessions.get(id);
    if (!rt) return;
    rt.approval.denyAll();
    rt.questions?.cancelAll();
    rt.controller?.abort();
    await rt.settled;
  }

  isRunning(id: string): boolean {
    return this.sessions.get(id)?.running ?? false;
  }

  /**
   * 会话是否处于「不可安全变更运行上下文」的状态。
   *
   * 注意不能只看 `running`：测试自愈循环在两次测试之间 `running === false`
   * 但 `busy === true`，此时切换工作区会让后续修复回合改到另一个项目，
   * 而下一轮测试仍在原项目执行（PR #9 复审 P1）。所有影响运行上下文或
   * 文件状态的操作都必须用这一个判据。
   */
  isSessionBusy(id: string): boolean {
    const rt = this.sessions.get(id);
    return !!rt && (rt.running || rt.busy === true);
  }

  /** 取会话级执行互斥锁（同一会话的上下文变更串行化） */
  private sessionOpLock(id: string): Mutex {
    let lock = this.sessionOpLocks.get(id);
    if (!lock) {
      lock = new Mutex();
      this.sessionOpLocks.set(id, lock);
    }
    return lock;
  }

  /**
   * 解析工作区的**物理身份**并把别名登记给锁管理器，返回该身份。
   *
   * `/tmp/project` 与 `/tmp/project-link` 是同一目录；若锁只按字符串分槽，
   * 两个会话绑定不同写法就会各拿一把锁，工作区互斥失效（PR #9 第五轮复审 P2）。
   * 解析失败时退回词法路径——锁仍能保护同一写法的并发，只是不合并别名。
   */
  async resolveWorkspaceIdentity(workspaceRoot: string): Promise<string> {
    const root = workspaceRoot?.trim();
    if (!root) return '';
    const lexical = this.host.paths.resolve(root);
    let identity = lexical;
    try {
      const real = await this.host.fs.realpath?.(lexical);
      if (real) identity = real;
    } catch {
      // 解析失败（权限不足 / 循环链接）不阻断主流程，退回词法身份
    }
    this.workspaceLocks.registerAlias(root, identity);
    this.workspaceLocks.registerAlias(lexical, identity);
    return identity;
  }

  /**
   * 在执行期互斥中执行「会改写运行上下文或磁盘文件」的操作：
   * 临界区内**重新**检查 busy，消除「入口检查通过 → 异步等待期间循环启动」的 TOCTOU。
   * `busyMessage` 为拒绝时的提示文案。
   */
  private async withSessionOpLock<T>(
    id: string,
    busyMessage: string,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    return this.sessionOpLock(id).withLock(async () => {
      if (this.isSessionBusy(id)) throw new Error(busyMessage);
      return fn();
    });
  }

  setApprovalMode(id: string, mode: ApprovalMode): void {
    this.requireSession(id).approval.setMode(mode);
  }

  getApprovalMode(id: string): ApprovalMode {
    return this.requireSession(id).approval.modeValue;
  }

  /** 会话级模型覆盖（'' = 跟随供应商默认，即第一个启用模型） */
  async setSessionModel(id: string, model: string): Promise<SessionMeta> {
    const rt = this.requireSession(id);
    await this.withSessionOpLock(id, '会话运行中，暂不能切换模型', () => {
      rt.data.meta.model = model.trim();
      rt.data.meta.updatedAt = new Date().toISOString();
    });
    await this.persistSession(rt);
    return rt.data.meta;
  }

  /** 会话级 Provider 切换（同时重置模型为该 Provider 第一个启用模型） */
  async setSessionProvider(id: string, providerId: string, model?: string): Promise<SessionMeta> {
    await this.ensureSettings();
    const rt = this.requireSession(id);
    const entry = this.settings.providers[providerId];
    if (!entry) throw new Error(`未配置的模型服务: ${providerId}`);
    const enabledModels = (entry.models ?? []).filter((m) => m.enabled !== false).map((m) => m.name);
    await this.withSessionOpLock(id, '会话运行中，暂不能切换模型服务', () => {
      rt.data.meta.providerId = providerId;
      rt.data.meta.model = model?.trim() ?? enabledModels[0] ?? '';
      rt.data.meta.reasoningEffort = '';
      rt.data.meta.updatedAt = new Date().toISOString();
    });
    await this.persistSession(rt);
    return rt.data.meta;
  }

  /** 会话级思考强度（'' = 跟随供应商默认） */
  async setSessionEffort(id: string, effort: string): Promise<SessionMeta> {
    const rt = this.requireSession(id);
    rt.data.meta.reasoningEffort = effort.trim();
    rt.data.meta.updatedAt = new Date().toISOString();
    await this.persistSession(rt);
    return rt.data.meta;
  }

  /** 绑定/更换会话的工作区（传空串表示解绑，纯对话） */
  async setSessionWorkspace(id: string, workspace: string): Promise<SessionMeta> {
    const rt = this.requireSession(id);
    const ws = workspace.trim();
    // 目标目录校验放在锁外：它是纯读取，且可能较慢（网络盘）
    if (ws) {
      const stat = await this.host.fs.stat(ws);
      if (!stat || !stat.isDirectory) {
        throw new Error(`工作区不存在或不是目录: ${ws}`);
      }
    }
    // 真正的「检查 + 写入」必须在同一临界区内：入口检查（上方无）与写入之间的
    // 任何 await 都可能被测试循环插队（PR #9 第三轮复审 P1 TOCTOU）
    await this.withSessionOpLock(id, '会话运行中，暂不能更换工作区', () => {
      rt.data.meta.workspaceRoot = ws;
      rt.data.meta.updatedAt = new Date().toISOString();
    });
    await this.persistSession(rt);
    return rt.data.meta;
  }

  /* -------------------- 设置 -------------------- */

  async getSettings(): Promise<Settings> {
    await this.ensureSettings();
    return this.settingsLock.withLock(() => this.settingsSecrets.publicView(this.settings));
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    await this.ensureSettings();
    // 入队前复制，调用方后续修改草稿不影响已提交的更新。
    const submitted = structuredClone(patch);
    return this.settingsLock.withLock(async () => {
      const next = this.settingsSecrets.merge(this.settings, submitted);
      this.settings = await this.settingsSecrets.save(next, this.settings, this.settingsFile());
      this.mcp.sync(this.settings.mcpServers ?? {});
      return this.settingsSecrets.publicView(this.settings);
    });
  }

  /** CLI 的 --api-key / 环境变量仅在本进程使用，不进入设置文件。 */
  setTransientProviderApiKey(providerId: string, apiKey: string): void {
    this.transientApiKeys.set(providerId, apiKey);
  }

  async getMcpServers() {
    await this.ensureSettings();
    this.mcp.sync(this.settings.mcpServers ?? {});
    return this.mcp.statuses();
  }

  async retryMcpServer(id: string): Promise<void> {
    await this.ensureSettings();
    this.mcp.sync(this.settings.mcpServers ?? {});
    await this.mcp.retry(id);
  }

  async getMcpCommands() {
    await this.getMcpServers();
    return this.mcp.commands();
  }

  async getMcpPrompt(server: string, name: string, args: Record<string, string>, token: string): Promise<string> {
    await this.ensureSettings();
    return this.mcp.prompt(server, name, args, token);
  }

  async getMcpTools() {
    await this.getMcpServers();
    const registry = createBuiltinTools();
    await this.mcp.register(registry);
    return registry.listSpecs().filter((tool) => tool.name.startsWith('mcp__'));
  }

  private async providerEntry(providerId: string): Promise<ProviderEntry> {
    return this.settingsLock.withLock(async () => {
      const entry = this.settings.providers[providerId];
      if (!entry) throw new Error(`未配置的模型服务: ${providerId}`);
      const transient = this.transientApiKeys.get(providerId);
      return transient !== undefined ? { ...entry, apiKey: transient } : this.settingsSecrets.provider(entry);
    });
  }

  /* -------------------- 内部 -------------------- */

  /**
   * 获取（或懒创建）会话绑定的后台任务管理器（TODOS #37）。
   * 首次创建时从宿主恢复接管仍存活的进程（WebView 重载后的孤儿任务归属回原会话）。
   */
  private async bgManagerFor(sessionId: string): Promise<BackgroundTaskManager> {
    let manager = this.bgManagers.get(sessionId);
    if (!manager) {
      manager = new BackgroundTaskManager(this.host, {
        scope: sessionId,
        onEvent: (event) => this.events.emit({ sessionId, event }),
      });
      this.bgManagers.set(sessionId, manager);
      try {
        const spawned = await this.host.process.listSpawned?.();
        if (spawned?.length) manager.adopt(spawned as SpawnedProcessInfo[]);
      } catch {
        // 宿主不支持恢复接管时忽略
      }
    }
    return manager;
  }

  /* -------------------- 后台任务与端口探测 (TODOS #37) -------------------- */

  /** 列出会话的后台任务（含主服务地址的端口探活刷新） */
  async listBackgroundTasks(sessionId: string): Promise<BackgroundTaskInfo[]> {
    const manager = await this.bgManagerFor(sessionId);
    const list = manager.list();
    // 仅对运行中且有服务地址的任务做探活（manager 内部有 TTL 缓存，轮询无压力）
    for (const task of list) {
      if (task.status === 'running' && task.primaryUrl) {
        await manager.probe(task.id);
      }
    }
    return manager.list();
  }

  /** 读取后台任务日志尾部 */
  async getTaskLogs(sessionId: string, taskId: string, tailLines?: number): Promise<string> {
    const manager = await this.bgManagerFor(sessionId);
    const text = manager.logs(taskId, tailLines);
    if (text === undefined) throw new Error(`后台任务不存在: ${taskId}`);
    return text;
  }

  /** 停止后台任务（Windows 树杀整棵进程树） */
  async stopBackgroundTask(sessionId: string, taskId: string): Promise<BackgroundTaskInfo | null> {
    const manager = await this.bgManagerFor(sessionId);
    return manager.stop(taskId);
  }

  async removeBackgroundTask(sessionId: string, taskId: string): Promise<boolean> {
    this.requireSession(sessionId);
    const manager = await this.bgManagerFor(sessionId);
    return manager.remove(taskId);
  }

  async clearFinishedBackgroundTasks(sessionId: string): Promise<string[]> {
    this.requireSession(sessionId);
    const manager = await this.bgManagerFor(sessionId);
    return manager.clearFinished();
  }

  /** 重启后台任务：以原命令、原工作目录与原 shell 重新拉起（停止旧进程后启动新任务） */
  async restartBackgroundTask(sessionId: string, taskId: string): Promise<BackgroundTaskInfo> {
    const manager = await this.bgManagerFor(sessionId);
    return manager.restart(taskId);
  }

  /** 终止所有会话的全部后台任务（应用退出时调用）。跨会话并行执行，总耗时以单任务为准 */
  async stopAllBackgroundTasks(): Promise<void> {
    await Promise.all(
      [this.mcp.dispose(), ...[...this.bgManagers.values()].map((manager) =>
        manager.disposeAll().catch(() => {
          // 单会话清理失败不影响其余会话
        }),
      )],
    );
  }

  private async createProvider(providerId: string, model: string, nativeWebSearch: boolean): Promise<Provider> {
    const entry = await this.providerEntry(providerId);
    if (!entry) throw new Error(`未配置的 Provider: ${providerId}，请在设置中检查`);
    switch (entry.kind) {
      case 'mock':
        return new MockProvider(providerId);
      case 'anthropic':
        return new AnthropicProvider(providerId, { ...entry, model, nativeWebSearch });
      case 'responses':
        return new ResponsesProvider(providerId, { ...entry, model, nativeWebSearch });
      case 'openai-compatible':
      default:
        return new OpenAICompatibleProvider(providerId, { ...entry, model, nativeWebSearch });
    }
  }

  /** 从供应商 API 拉取可用模型及元数据（OpenAI 兼容 /models、Anthropic /v1/models） */
  async listProviderModels(providerId: string): Promise<ProviderModelInfo[]> {
    await this.ensureSettings();
    const entry = await this.providerEntry(providerId);
    if (!entry) throw new Error(`未配置的模型服务: ${providerId}`);
    if (entry.kind === 'mock') return [{ name: 'mock-1' }];
    if (!entry.baseURL) throw new Error('请先填写 Base URL');
    if (!entry.apiKey) throw new Error('请先填写 API Key');
    const base = entry.baseURL.replace(/\/$/, '');
    const url = entry.kind === 'anthropic' ? `${base}/v1/models` : `${base}/models`;
    const headers: Record<string, string> =
      entry.kind === 'anthropic'
        ? { 'x-api-key': entry.apiKey ?? '', 'anthropic-version': '2023-06-01' }
        : { authorization: `Bearer ${entry.apiKey ?? ''}` };
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`获取模型列表失败: HTTP ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as
      | { data?: unknown }
      | unknown[];
    const rawList: unknown[] = Array.isArray(data) ? data : (Array.isArray(data.data) ? data.data : []);
    const infos: ProviderModelInfo[] = [];
    for (const item of rawList) {
      if (typeof item === 'string') {
        infos.push({ name: item });
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const m = item as Record<string, unknown> & { id?: unknown };
      if (typeof m.id !== 'string' || !m.id) continue;
      infos.push({ name: m.id, ...detectModelMeta(m) });
    }
    infos.sort((a, b) => a.name.localeCompare(b.name));
    if (infos.length === 0) throw new Error('供应商返回了空的模型列表');
    // 元数据缺失时逐层补齐：models.dev 在线目录 → 内置规格目录 → 名称启发式
    const directory = await loadModelDirectory(this.host).catch(() => null);
    const webSearchEnabled = this.settings.webSearch?.enabled === true;
    return infos.map((info) => {
      const resolved = resolveModelMeta(info, directory);
      // 全局联网搜索开启时，自动获取的模型默认具备联网搜索能力
      // （运行时分流：有原生工具的走原生，其余走内置 web_search()）
      if (webSearchEnabled && !resolved.capabilities?.includes('websearch')) {
        resolved.capabilities = ['structured', 'websearch', 'system'].filter(
          (c) => c === 'websearch' || resolved.capabilities?.includes(c),
        );
      }
      return resolved;
    });
  }

  /**
   * 单模型连通性测试：发送一条最小的真实请求，验证 Key/模型/网络全链路。
   * 仅以 HTTP 状态判定连通（推理模型的空回复也算连通）。
   */
  async testProviderModel(providerId: string, model: string): Promise<ModelTestResult> {
    await this.ensureSettings();
    const entry = await this.providerEntry(providerId);
    if (!entry) throw new Error(`未配置的模型服务: ${providerId}`);
    if (entry.kind === 'mock') return { ok: true, latencyMs: 0 };
    if (!entry.baseURL) throw new Error('请先填写 Base URL');
    if (!entry.apiKey) throw new Error('请先填写 API Key');
    const base = entry.baseURL.replace(/\/$/, '');
    let url: string;
    let headers: Record<string, string>;
    let body: Record<string, unknown>;
    if (entry.kind === 'anthropic') {
      url = `${base}/v1/messages`;
      headers = {
        'content-type': 'application/json',
        'x-api-key': entry.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      };
      body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
    } else if (entry.kind === 'responses') {
      url = `${base}/responses`;
      headers = { 'content-type': 'application/json', authorization: `Bearer ${entry.apiKey ?? ''}` };
      // 与 ResponsesProvider 的正式请求同构：input 必须是数组形态，部分网关不接受纯字符串
      body = {
        model,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
        max_output_tokens: 16,
      };
    } else {
      url = `${base}/chat/completions`;
      headers = { 'content-type': 'application/json', authorization: `Bearer ${entry.apiKey ?? ''}` };
      body = {
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 32,
        stream: false,
      };
    }
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        let detail = '';
        try {
          detail = (await res.text()).slice(0, 200);
        } catch {
          // 忽略读取失败
        }
        return {
          ok: false,
          latencyMs: Date.now() - started,
          error: `HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
        };
      }
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.name === 'AbortError'
            ? '请求超时（20s）'
            : err.message
          : String(err);
      return { ok: false, latencyMs: Date.now() - started, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 联网搜索连通性测试：用当前已保存的配置真实搜索一次 */
  async testWebSearch(): Promise<{
    ok: boolean;
    latencyMs: number;
    resultCount?: number;
    error?: string;
  }> {
    let ws: Settings['webSearch'];
    try {
      await this.ensureSettings();
      ws = await this.settingsLock.withLock(() => this.settingsSecrets.webSearch(this.settings.webSearch));
    } catch (err) {
      return {
        ok: false,
        latencyMs: 0,
        error: err instanceof Error ? err.message : '无法读取联网搜索配置或密钥',
      };
    }
    if (!ws?.enabled) return { ok: false, latencyMs: 0, error: '联网搜索未开启' };
    if (!validWebSearchBackend(ws)) return { ok: false, latencyMs: 0, error: '搜索后端配置不完整' };
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const hits = await runWebSearch(
        {
          backend: ws.backend,
          searxngUrl: ws.searxngUrl,
          tavilyApiKey: ws.tavilyApiKey,
          maxResults: ws.maxResults,
        },
        'EasyCode 联网搜索测试',
        ctrl.signal,
      );
      return { ok: true, latencyMs: Date.now() - started, resultCount: hits.length };
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.name === 'AbortError'
            ? '请求超时（20s）'
            : err.message
          : String(err);
      return { ok: false, latencyMs: Date.now() - started, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  private emitterFor(sessionId: string) {
    return (event: AgentEvent) => this.events.emit({ sessionId, event });
  }

  private requireSession(id: string): SessionRuntime {
    const rt = this.sessions.get(id);
    if (!rt) throw new Error(`会话不存在: ${id}`);
    return rt;
  }

  private sessionsDir(): string {
    return this.host.paths.join(this.host.env.dataDir(), 'sessions');
  }

  private sessionFile(id: string): string {
    return this.host.paths.join(this.sessionsDir(), `${id}.json`);
  }

  private settingsFile(): string {
    return this.host.paths.join(this.host.env.dataDir(), 'settings.json');
  }

  private async persistSession(rt: SessionRuntime, atomic = false): Promise<void> {
    // 已删除的会话不得被仍在收尾的异步流程写回磁盘（会话「复活」防护）
    if (rt.deleted) return;
    this.syncHistory(rt);
    // 串行化同一会话的落盘：
    // ① 并发写入会让旧快照晚于新快照落盘（后写入的其实是更早的状态）；
    // ② 若用单个字段记录「在途任务」，第二个任务会覆盖第一个的引用，
    //    删除时只能等到最后一个，被覆盖的早期任务仍会在删除后把文件写回来
    //    （PR #9 第八轮复审 P2）。
    const previous = rt.persistQueue ?? Promise.resolve();
    const task = previous
      .catch(() => {
        // 前一次失败不能阻断后续写入
      })
      .then(async () => {
        // 轮到本次执行时可能已被删除：再次确认，避免排队期间会话被删还写回
        if (rt.deleted) return;
        await this.host.fs.mkdir(this.sessionsDir(), { recursive: true });
        const file = this.sessionFile(rt.data.meta.id);
        const content = JSON.stringify(rt.data);
        if (atomic) {
          const temporary = `${file}.edit.tmp`;
          try {
            await this.host.fs.writeFile(temporary, content);
            await this.host.fs.rename(temporary, file);
          } finally {
            // 只清理本次编辑的单个暂存文件，失败不能覆盖原始错误。
            try { await this.host.fs.unlink?.(temporary); } catch { /* 已提交或无法清理 */ }
          }
        } else {
          await this.host.fs.writeFile(file, content);
        }
      });
    rt.persistQueue = task;
    const pending = rt.persisting ?? (rt.persisting = new Set());
    pending.add(task);
    try {
      await task;
    } finally {
      pending.delete(task);
      if (rt.persistQueue === task) rt.persistQueue = undefined;
    }
  }

  private syncHistory(rt: SessionRuntime): void {
    if (!rt.data.history) return;
    const retained = new Set(rt.data.history.map((message) => message.id));
    for (const message of rt.data.messages) {
      if (message.id && !message.id.endsWith('_compact') && !retained.has(message.id)) {
        rt.data.history.push(structuredClone(message));
        retained.add(message.id);
      }
    }
  }

  private async ensureSettings(): Promise<void> {
    if (this.settingsLoaded) return;
    if (!this.settingsLoading) {
      this.settingsLoading = this.loadSettings().finally(() => { this.settingsLoading = undefined; });
    }
    await this.settingsLoading;
  }

  private async loadSettings(): Promise<void> {
    // 仅明确不存在时使用默认值；损坏或读取失败不得被自动迁移覆盖。
    const stat = await this.host.fs.stat(this.settingsFile());
    try {
      this.settings = stat
        ? this.migrateSettings(JSON.parse(await this.host.fs.readFile(this.settingsFile())) as Settings)
        : structuredClone(DEFAULT_SETTINGS);
      validateMcpServers(this.settings.mcpServers ?? {});
    } catch {
      throw new Error('无法读取设置文件，请检查文件权限或恢复有效配置；原文件未修改');
    }
    this.settings = await this.settingsSecrets.cleanup(this.settings, this.settingsFile());
    if (this.settingsSecrets.needsMigration(this.settings)) {
      try {
        this.settings = await this.settingsSecrets.save(this.settings, this.settings, this.settingsFile());
      } catch {
        this.settingsSecrets.warning = '旧密钥尚未迁移，原配置已保留并可继续使用。请解锁系统凭据存储后重新保存设置';
      }
    }
    this.settingsLoaded = true;
    this.mcp.sync(this.settings.mcpServers ?? {});
  }

  /** 旧版设置迁移：剔除演示供应商与 legacy 单模型字段（模型列表一律从空开始），并补齐新增预设 */
  private migrateSettings(stored: Settings): Settings {
    const providers: Record<string, ProviderEntry> = {};
    const source: Record<string, ProviderEntry> = { ...stored.providers };
    delete source.demo; // 演示供应商已从内置预设移除
    for (const [id, legacy] of Object.entries(source)) {
      const p = legacy as ProviderEntry & { model?: string };
      // models 列表正常保留（自动获取/手动添加的结果）；仅丢弃 legacy 的单 model 字段
      const models = Array.isArray(p.models) ? p.models : [];
      const { model: _m, ...rest } = p;
      providers[id] = { ...rest, models };
    }
    // 补齐新增内置预设（不覆盖用户已配置的）
    for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
      if (!providers[id]) providers[id] = structuredClone(preset);
    }
    const defaultProvider =
      stored.defaultProvider && providers[stored.defaultProvider]
        ? stored.defaultProvider
        : Object.keys(providers)[0] ?? DEFAULT_SETTINGS.defaultProvider;
    return { ...DEFAULT_SETTINGS, ...stored, providers, defaultProvider };
  }

  /** 工作区文件列表短时缓存（3秒 TTL），避免连续敲击字符时频繁扫描磁盘 */
  private workspaceFilesCache = new Map<string, { files: string[]; expiresAt: number }>();

  /**
   * 列出工作区文件列表，支持 query 模糊过滤（供 Composer @文件 快捷补全）
   */
  async listWorkspaceFiles(sessionId: string, query?: string, limit = 25): Promise<string[]> {
    const session = this.sessions.get(sessionId);
    const root = session?.data.meta.workspaceRoot;
    if (!root) return [];

    const now = Date.now();
    let allFiles: string[] = [];
    const cached = this.workspaceFilesCache.get(root);
    if (cached && cached.expiresAt > now) {
      allFiles = cached.files;
    } else {
      try {
        const stat = await this.host.fs.stat(root);
        if (!stat || !stat.isDirectory) return [];
        allFiles = await listFilesRecursively(this.host, root, { limit: 1500 });
        this.workspaceFilesCache.set(root, { files: allFiles, expiresAt: now + 3000 });
      } catch {
        return [];
      }
    }

    const q = (query ?? '').trim().toLowerCase();
    if (!q) {
      return allFiles.slice(0, limit);
    }

    // 模糊过滤：优先匹配文件名开头，其次匹配文件名包含，再次匹配全路径包含
    const scored: Array<{ path: string; score: number }> = [];
    for (const p of allFiles) {
      const lower = p.toLowerCase();
      const lastSlash = lower.lastIndexOf('/');
      const fileName = lastSlash === -1 ? lower : lower.slice(lastSlash + 1);

      if (fileName.startsWith(q)) {
        scored.push({ path: p, score: 100 });
      } else if (fileName.includes(q)) {
        scored.push({ path: p, score: 80 });
      } else if (lower.includes(q)) {
        scored.push({ path: p, score: 50 });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
    return scored.slice(0, limit).map((s) => s.path);
  }

  /* -------------------- 项目规则系统 (TODOS #33) -------------------- */

  private projectRulesCache = new Map<string, { rule: ProjectRuleInfo | null; expiresAt: number }>();

  /**
   * 探测并读取工作区项目规范文件
   * 优先级：.easycoderules > AGENTS.md > CLAUDE.md > .cursorrules > .easycode/rules.md
   */
  async getProjectRules(workspaceRoot: string): Promise<ProjectRuleInfo | null> {
    const root = workspaceRoot?.trim();
    if (!root) return null;

    const now = Date.now();
    const cached = this.projectRulesCache.get(root);
    if (cached && cached.expiresAt > now) {
      return cached.rule;
    }

    const candidates = [
      '.easycoderules',
      'AGENTS.md',
      'CLAUDE.md',
      '.cursorrules',
      this.host.paths.join('.easycode', 'rules.md'),
    ];

    for (const rel of candidates) {
      try {
        // 自动加载的项目规范会拼进**系统提示词**并发往模型服务，比用户主动引用
        // 更危险：克隆仓库里 `AGENTS.md -> /home/user/private.txt` 无需要用户操作
        // 就会被读取上传（PR #9 第六轮复审 P1）。因此与文件预览 / @file 引用一样，
        // 先取真实目标，越界或无法确认则跳过该候选。
        const guard = await resolveRealPathInWorkspace(
          this.host,
          root,
          rel,
          this.host.paths,
        );
        if (!guard.ok) continue;
        const stat = await this.host.fs.stat(guard.value.realPath);
        if (stat && !stat.isDirectory) {
          const content = await this.host.fs.readFile(guard.value.realPath);
          if (content.trim()) {
            const rule: ProjectRuleInfo = {
              path: rel.replace(/\\/g, '/'),
              content,
              exists: true,
            };
            this.projectRulesCache.set(root, { rule, expiresAt: now + 3000 });
            return rule;
          }
        }
      } catch {
        // 忽略单个文件的读取错误，继续向下探测
      }
    }

    this.projectRulesCache.set(root, { rule: null, expiresAt: now + 3000 });
    return null;
  }

  /**
   * 初始化项目规则文件（默认生成 .easycoderules 骨架）
   */
  async initProjectRules(workspaceRoot: string): Promise<ProjectRuleInfo> {
    const root = workspaceRoot?.trim();
    if (!root) throw new Error('当前未绑定工作区，无法初始化项目规则');

    const existing = await this.getProjectRules(root);
    if (existing) return existing;

    const defaultTemplate = `# 项目行为规范 (.easycoderules)

## 1. 技术栈与架构约定
- 保持架构清晰，遵循项目现有的目录规范与分层设计。
- 优先复用现存公共模块与依赖，严禁随意引入冗余第三方库。

## 2. 编码与修改纪律
- 先读后改：修改代码前必须完整阅读目标文件及周边引用。
- 精确替换：优先使用 edit_file 进行局部替换，保持原代码风格与注释习惯。
- 简洁严谨：代码注释与回复一律使用中文，解释清晰、避免废话。

## 3. 验证与测试规范
- 修改核心逻辑后必须运行测试脚本或类型检查，确保单测与构建全绿。
`;

    const targetPath = this.host.paths.join(root, '.easycoderules');
    await this.host.fs.writeFile(targetPath, defaultTemplate);
    this.projectRulesCache.delete(root);
    return {
      path: '.easycoderules',
      content: defaultTemplate,
      exists: true,
    };
  }

  /** 会话级获取项目规范 */
  async getSessionProjectRules(sessionId: string): Promise<ProjectRuleInfo | null> {
    const session = this.sessions.get(sessionId);
    const root = session?.data.meta.workspaceRoot;
    if (!root) return null;
    return this.getProjectRules(root);
  }

  /** 会话级初始化项目规范 */
  async initSessionProjectRules(sessionId: string): Promise<ProjectRuleInfo> {
    const session = this.sessions.get(sessionId);
    const root = session?.data.meta.workspaceRoot;
    if (!root) throw new Error('当前会话未绑定工作区，无法初始化项目规范');
    return this.initProjectRules(root);
  }

  /* -------------------- 自定义 Prompt 扩展 (TODOS #32) -------------------- */

  private customPromptsCache = new Map<string, { prompts: CustomPromptInfo[]; expiresAt: number }>();

  /**
   * 读取工作区 .easycode/prompts/*.md 下的自定义指令模板
   */
  async listCustomPrompts(workspaceRoot: string): Promise<CustomPromptInfo[]> {
    const root = workspaceRoot?.trim();
    if (!root) return [];

    const now = Date.now();
    const cached = this.customPromptsCache.get(root);
    if (cached && cached.expiresAt > now) {
      return cached.prompts;
    }

    const promptsDir = this.host.paths.join(root, '.easycode', 'prompts');
    try {
      const stat = await this.host.fs.stat(promptsDir);
      if (!stat || !stat.isDirectory) {
        this.customPromptsCache.set(root, { prompts: [], expiresAt: now + 3000 });
        return [];
      }
      const entries = await this.host.fs.readdir(promptsDir);
      const mdFiles = entries
        .filter((e) => !e.isDirectory && e.name.endsWith('.md'))
        .map((e) => e.name)
        .sort();

      const list: CustomPromptInfo[] = [];
      for (const fileName of mdFiles) {
        try {
          // 自定义指令模板同样会进入模型上下文，与项目规则一样走真实路径守卫，
          // 避免工作区内 `.easycode/prompts/x.md -> 工作区外` 泄露外部内容。
          // 注意：host.paths.join 生成的是绝对路径，这里必须直接给绝对路径
          // （守卫会解析真实目标并折算回工作区相对路径）
          const guard = await resolveRealPathInWorkspace(
            this.host,
            root,
            this.host.paths.join(root, '.easycode', 'prompts', fileName),
            this.host.paths,
          );
          if (!guard.ok) continue;
          const content = await this.host.fs.readFile(guard.value.realPath);
          const id = fileName.slice(0, -3);
          const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          let desc = '自定义指令';
          if (lines.length > 0) {
            const first = lines[0].replace(/^#+\s*/, '').trim();
            desc = first.slice(0, 32);
          }
          list.push({
            id,
            name: `/${id}`,
            description: desc,
            template: content.trim(),
          });
        } catch {
          // 忽略单个文件读取异常
        }
      }
      this.customPromptsCache.set(root, { prompts: list, expiresAt: now + 3000 });
      return list;
    } catch {
      this.customPromptsCache.set(root, { prompts: [], expiresAt: now + 3000 });
      return [];
    }
  }

  /** 会话级列出自定义指令 */
  async listSessionCustomPrompts(sessionId: string): Promise<CustomPromptInfo[]> {
    const session = this.sessions.get(sessionId);
    const root = session?.data.meta.workspaceRoot;
    if (!root) return [];
    return this.listCustomPrompts(root);
  }

  /* -------------------- 工作区 Git 状态与检视 (TODOS #34) -------------------- */

  /** 获取会话工作区的 Git 状态摘要 */
  async getGitStatus(sessionId: string): Promise<GitStatusSummary> {
    const session = this.sessions.get(sessionId);
    const root = session?.data.meta.workspaceRoot;
    if (!root) {
      return {
        isGit: false,
        branch: '',
        clean: true,
        ahead: 0,
        behind: 0,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        totalChanges: 0,
        insertions: 0,
        deletions: 0,
        files: [],
      };
    }
    return getGitStatus(this.host, root);
  }

  /** 获取会话工作区的 Git 差异 */
  async getGitDiff(
    sessionId: string,
    options?: GitDiffOptions,
  ): Promise<GitDiffResult> {
    const session = this.sessions.get(sessionId);
    const root = session?.data.meta.workspaceRoot;
    if (!root) return { diff: '' };
    return getGitDiff(this.host, root, options);
  }

  /** 暂存文件 (git add) */
  async stageGitFiles(sessionId: string, paths?: string[]): Promise<{ ok: boolean; error?: string }> {
    const session = this.sessions.get(sessionId);
    const root = session?.data.meta.workspaceRoot;
    if (!root) return { ok: false, error: '未绑定工作区' };
    return stageGitFiles(this.host, root, paths);
  }

  /** 放弃修改 (git checkout / git clean) */
  async discardGitChanges(sessionId: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
    const session = this.sessions.get(sessionId);
    const root = session?.data.meta.workspaceRoot;
    if (!root) return { ok: false, error: '未绑定工作区' };
    return discardGitChanges(this.host, root, paths);
  }

  /* -------------------- Reflex 微模型决策与统计 (TODOS #40) -------------------- */

  /** 获取微模型决策统计指标 */
  async getDecisionStats(filter?: { workspaceRoot?: string; sessionId?: string }): Promise<DecisionStats> {
    return this.decisionStats.getStats(filter);
  }

  /** 获取项目->会话分级决策树 */
  async getDecisionTree(): Promise<ProjectDecisionTree[]> {
    return this.decisionStats.getDecisionTree();
  }

  /** 导出完全兼容 Reflex V1 训练集规范的合格微调数据集 JSONL */
  async exportDecisionDataset(filter?: {
    workspaceRoot?: string;
    sessionId?: string;
  }): Promise<string> {
    return this.decisionStats.exportDataset(filter);
  }

  async reviewDecision(
    sessionId: string,
    recordId: string,
    label: { selectedId?: string; defer: boolean },
  ): Promise<void> {
    return this.decisionStats.reviewDecision(sessionId, recordId, label);
  }

  /* -------------------- 工具权限规则 (TODOS #47) -------------------- */

  private projectPermissionsCache = new Map<
    string,
    { rules: PermissionRule[]; expiresAt: number }
  >();

  /** 读取项目级权限规则 `.easycode/permissions.json`（3 秒 TTL；非法条目跳过而非整份失效） */
  async loadProjectPermissions(workspaceRoot: string): Promise<PermissionRule[]> {
    const root = workspaceRoot?.trim();
    if (!root) return [];
    const now = Date.now();
    const cached = this.projectPermissionsCache.get(root);
    if (cached && cached.expiresAt > now) return cached.rules;
    let rules: PermissionRule[] = [];
    try {
      const file = this.host.paths.join(root, '.easycode', 'permissions.json');
      const stat = await this.host.fs.stat(file);
      if (stat && !stat.isDirectory) {
        rules = parsePermissionRules(await this.host.fs.readFile(file), 'project');
      }
    } catch {
      rules = [];
    }
    this.projectPermissionsCache.set(root, { rules, expiresAt: now + 3000 });
    return rules;
  }

  /**
   * 工作区规范化键：用于信任白名单比对，避免「只凭目录名或未规范化字符串」授权。
   * Windows 大小写不敏感，统一小写；分隔符由宿主 paths.resolve 归一。
   *
   * 注意：这只是**词法**键，用于给物理身份缓存索引；信任判定本身走物理身份
   * （见 `resolveTrustIdentity` / `isProjectTrusted`）。
   */
  private workspaceTrustKey(workspaceRoot: string): string {
    const root = workspaceRoot?.trim();
    if (!root) return '';
    let resolved: string;
    try {
      resolved = this.host.paths.resolve(root);
    } catch {
      return '';
    }
    // 必须与物理身份键走同一套归一化（分隔符 + Windows 大小写），
    // 否则缓存索引与白名单比对会因 `\` vs `/` 而永不相等
    return this.normalizeTrustKey(resolved);
  }

  /** 归一化一条已解析的绝对路径，用作物理信任键 */
  private normalizeTrustKey(absolutePath: string): string {
    const trimmed = absolutePath?.trim();
    if (!trimmed) return '';
    const normalized = trimmed.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    return this.host.paths.sep === '\\' ? normalized.toLowerCase() : normalized;
  }

  /**
   * 解析工作区的**物理身份**（消解符号链接）并写入缓存。
   *
   * 信任必须绑定物理项目而非词法别名：`ws-link -> projectA` 被授权后，
   * 若链接改指 `projectB`，词法键不变但已不是同一个项目——按词法比对会把
   * 给 A 的免审批权限转移给 B（PR #9 第八轮复审 P1）。
   * 解析失败（宿主无 realpath / 权限不足）时退回词法路径，此时只承认
   * 与词法键完全一致的记录，不放宽到「同名前缀」比较。
   */
  private async resolveTrustIdentity(
    workspaceRoot: string,
  ): Promise<{ lexical: string; identity: string; stored: string } | null> {
    const root = workspaceRoot?.trim();
    if (!root) return null;
    let stored: string;
    try {
      stored = this.host.paths.resolve(root);
    } catch {
      return null;
    }
    const lexical = this.normalizeTrustKey(stored);
    if (!lexical) return null;
    let identity = lexical;
    try {
      const real = await this.host.fs.realpath?.(stored);
      if (real) {
        stored = real;
        identity = this.normalizeTrustKey(real);
      }
    } catch {
      // 解析失败：退回词法身份
    }
    // 每次解析都覆盖缓存：符号链接改指后必须让旧身份失效
    this.workspaceIdentities.set(lexical, identity);
    if (identity !== lexical) this.workspaceIdentities.set(identity, identity);
    return { lexical, identity, stored };
  }

  /**
   * 指定工作区是否已被用户显式信任（可启用项目级 allow 规则）。
   *
   * 这是**同步**查询，只读已解析的物理身份缓存；符号链接改指后必须由异步入口
   * （`getProjectTrust` / `resolvePermissionRules` / `setProjectTrust`）刷新。
   * 内部裁决路径（`resolvePermissionRules`）总是先刷新再调用，因此不会用过期身份放行；
   * 面向用户的查询请用 `getProjectTrust`。
   */
  isProjectTrusted(workspaceRoot: string): boolean {
    const key = this.workspaceTrustKey(workspaceRoot);
    if (!key) return false;
    const entries = new Set(
      (this.settings.permissions?.trustedWorkspaces ?? [])
        .map((entry) => this.normalizeTrustKey(entry))
        .filter(Boolean),
    );
    if (entries.size === 0) return false;
    // 优先按**物理身份**比对：符号链接改指后词法路径不变，只有物理目标能分辨
    // 「授权给哪个项目」（PR #9 第八轮复审 P1）
    const identity = this.workspaceIdentities.get(key);
    if (identity) return entries.has(identity);
    // 尚未解析过物理身份：只接受与词法键完全一致的记录（本身就是物理路径的情形），
    // 无法确认身份时不放行，绝不退化成「看起来信任过就算信任」
    return entries.has(key);
  }

  /** 授予/撤销某个工作区的项目级 allow 信任（写回本地设置，绝不写入项目仓库） */
  async setProjectTrust(workspaceRoot: string, trusted: boolean): Promise<Settings> {
    await this.ensureSettings();
    const keys = await this.resolveTrustIdentity(workspaceRoot);
    if (!keys) throw new Error('工作区路径无效，无法设置信任');
    const current = this.settings.permissions?.trustedWorkspaces ?? [];
    // 旧记录可能是词法路径（升级前写入的），两种写法一并清理，避免重复累积
    const kept = current.filter((entry) => {
      const normalized = this.normalizeTrustKey(entry);
      return normalized !== keys.identity && normalized !== keys.lexical;
    });
    const next = trusted ? [...kept, keys.stored] : kept;
    return this.updateSettings({
      permissions: {
        enabled: this.settings.permissions?.enabled !== false,
        rules: this.settings.permissions?.rules ?? [],
        trustedWorkspaces: next,
      },
    });
  }

  /**
   * 合成参与裁决的权限规则：总开关关闭时返回 undefined（彻底回到 ask / yolo 语义）；
   * 全局规则标注 `source: 'global'`，项目规则由 loadProjectPermissions 标注。
   *
   * **信任边界**：项目级 `deny` / `ask` 默认生效（只会收紧权限），但项目级 `allow`
   * 只在用户显式信任该工作区时参与裁决——工作区代码属低信任输入，
   * 不能通过仓库内配置自行取消用户的审批保护。
   */
  async resolvePermissionRules(workspaceRoot: string): Promise<PermissionRule[] | undefined> {
    if (this.settings.permissions?.enabled === false) return undefined;
    // 裁决前刷新物理身份：符号链接改指后必须重新解析，否则会把给旧项目的授权
    // 继承给新目标（PR #9 第八轮复审 P1）。isProjectTrusted 本身保持同步，
    // 由这里（以及授予信任时）负责把身份写入缓存。
    await this.resolveTrustIdentity(workspaceRoot);
    const globalRules = (this.settings.permissions?.rules ?? [])
      .map((rule) => normalizePermissionRule(rule, 'global'))
      .filter((rule): rule is PermissionRule => rule !== null);
    const projectTrusted = this.isProjectTrusted(workspaceRoot);
    const projectRules = (await this.loadProjectPermissions(workspaceRoot)).filter(
      (rule) => projectTrusted || rule.decision !== 'allow',
    );
    const rules = [...globalRules, ...projectRules];
    return rules.length > 0 ? rules : undefined;
  }

  /**
   * 异步查询信任状态：先刷新工作区物理身份再判定。
   *
   * UI 与任何面向用户的「是否已信任」查询都应走这里——符号链接可能已被改指，
   * 只读缓存的同步版本会给出过期答案（PR #9 第八轮复审 P1）。
   */
  async getProjectTrust(workspaceRoot: string): Promise<boolean> {
    await this.ensureSettings();
    await this.resolveTrustIdentity(workspaceRoot);
    return this.isProjectTrusted(workspaceRoot);
  }

  /** 项目级配置里被信任策略忽略的 allow 规则条数（供 UI 提示，不参与裁决） */
  async countIgnoredProjectAllowRules(workspaceRoot: string): Promise<number> {
    if (this.settings.permissions?.enabled === false) return 0;
    // 同样先刷新物理身份，避免用过期信任状态计算提示数量
    await this.resolveTrustIdentity(workspaceRoot);
    if (this.isProjectTrusted(workspaceRoot)) return 0;
    const projectRules = await this.loadProjectPermissions(workspaceRoot);
    return projectRules.filter((rule) => rule.decision === 'allow').length;
  }

  /* -------------------- 测试自愈循环 (TODOS #39) -------------------- */

  /** 读取项目级测试配置 `.easycode/test.json`（{ command?, maxRounds? }） */
  private async readProjectTestConfig(
    root: string,
  ): Promise<{ command?: string; maxRounds?: number } | null> {
    try {
      const file = this.host.paths.join(root, '.easycode', 'test.json');
      const stat = await this.host.fs.stat(file);
      if (!stat || stat.isDirectory) return null;
      const data = JSON.parse(await this.host.fs.readFile(file)) as Record<string, unknown>;
      const command = typeof data.command === 'string' ? data.command.trim() : '';
      const maxRounds =
        typeof data.maxRounds === 'number' && Number.isFinite(data.maxRounds)
          ? data.maxRounds
          : undefined;
      return { command: command || undefined, maxRounds };
    } catch {
      return null;
    }
  }

  /** 探测会话工作区将要执行的测试命令（命令优先级：设置项 > 项目配置 > 项目类型自动探测） */
  async detectSessionTestCommand(sessionId: string): Promise<TestCommandDetection | null> {
    await this.ensureSettings();
    const rt = this.requireSession(sessionId);
    const root = rt.data.meta.workspaceRoot?.trim();
    if (!root) return null;
    const project = await this.readProjectTestConfig(root);
    return detectTestCommand(
      this.host,
      root,
      this.settings.testLoop?.command?.trim() || project?.command,
    );
  }

  /**
   * 启动一次测试自愈循环：运行测试 → 失败则驱动 Agent 修复 → 重跑，直至全绿或轮次耗尽。
   * 测试命令整体只审批一次（ask 模式），循环内的修复回合仍走常规工具审批与权限规则。
   */
  async runTestLoop(sessionId: string, options?: RunTestLoopRequest): Promise<TestLoopResult> {
    await this.ensureSettings();
    const rt = this.requireSession(sessionId);
    const controller = new AbortController();
    let resolve!: () => void;
    const settled = new Promise<void>((done) => { resolve = done; });
    // 占位必须与检查处于同一临界区：否则「检查通过 → 异步探测命令期间」
    // 另一个上下文操作（如工作区切换）可能插入（PR #9 第三轮复审 TOCTOU）
    await this.withSessionOpLock(sessionId, '会话正在运行中，请先等待完成或点击停止', () => {
      rt.busy = true;
      rt.controller = controller;
      rt.settled = settled;
    });
    // 占位后立刻挂上 controller：从这一刻起到循环结束，用户点停止与
    // deleteSession 都必须能中止本循环。若等到审批通过后才挂，
    // 「探测命令 / 等待审批」这段窗口里的停止就是空操作
    // （PR #9 第七轮复审 P2）。
    rt.controller = controller;
    // 只要本次调用已经让前端进入运行态（发出了审批请求或启动了循环），
    // 就必须在退出时补发终止事件，否则 UI 会永久停在 running（复审 P1）。
    let uiEngaged = false;
    let doneEmitted = false;
    let terminalEvent: AgentEvent | undefined;
    let pendingErrorMessage = '测试自愈循环异常中断';
    const emit = (event: AgentEvent): void => {
      if (event.type === 'test_loop_done') {
        doneEmitted = true;
        terminalEvent = event;
        return;
      }
      this.emitterFor(sessionId)(event);
    };
    try {
      const root = rt.data.meta.workspaceRoot?.trim();
      if (!root) throw new Error('当前会话未绑定工作区，无法运行测试');

      const project = await this.readProjectTestConfig(root);
      const detection = await detectTestCommand(
        this.host,
        root,
        options?.command?.trim() || this.settings.testLoop?.command?.trim() || project?.command,
      );
      if (!detection) {
        throw new Error(
          '未探测到测试命令：请在设置页「测试自愈」中填写自定义命令，或在项目根目录添加 .easycode/test.json',
        );
      }
      const maxRounds = clampInt(
        options?.maxRounds ?? project?.maxRounds ?? this.settings.testLoop?.maxRounds ?? 3,
        1,
        5,
      );
      const timeoutMs = clampInt(this.settings.testLoop?.timeoutMs ?? 600_000, 10_000, 1_800_000);

      // 探测/读配置期间可能已被停止或删除会话：此时 signal 已中止，
      // 直接收敛，不要继续走审批与测试执行
      if (controller.signal.aborted) {
        return { ok: false, rounds: 0, reason: 'aborted', message: '测试自愈循环已中止' };
      }

      // 测试命令同样要过权限规则：该命令可能来自仓库内的 package.json / .easycode/test.json，
      // 属于不可信输入，绝不能让 deny 规则被「换个执行入口」绕过
      const permissionRules = await this.resolvePermissionRules(root);
      // 加载规则是异步的，期间用户可能已经点了停止：必须复核，否则紧接着会
      // 新建一个审批请求并永久挂起（PR #9 第八轮复审 P2）
      if (controller.signal.aborted) {
        return { ok: false, rounds: 0, reason: 'aborted', message: '测试自愈循环已中止' };
      }
      const verdict = evaluatePermission(
        permissionRules,
        'run_command',
        { command: detection.command },
        root,
        this.host.paths,
      );
      if (verdict?.decision === 'deny') {
        throw new Error(`测试命令被权限规则拒绝：${describePermissionRule(verdict.rule)}`);
      }

      // 与常规工具调用共用同一套裁决语义（resolveApprovalRequirement）：
      // allow → 免审批（即使在 ask 模式）；ask → 强制审批（即使在 yolo 模式）；无命中 → 跟随会话模式
      // 测试命令含无法可靠解析的结构时按保守策略强制审批（与 executeTool 同一语义）
      const requirement = resolveApprovalRequirement(verdict, true, {
        parseRisk: describeCommandParseRisk(detection.command),
      });
      let approved = true;
      if (requirement.needApproval) {
        // 审批请求一旦发出，UI 就会建立运行态回合
        uiEngaged = true;
        // 单次审批覆盖整轮循环：确认一次即可，后续重跑与修复回合不再重复弹窗
        approved = await rt.approval.request(
          'test_loop',
          {
            command: detection.command,
            framework: detection.framework,
            source: detection.source,
            maxRounds,
          },
          {
            force: requirement.force,
            reason: requirement.reason ?? '测试自愈循环',
            // 审批监听同一个中止信号：即使停止发生在规则加载与弹窗之间，
            // 也能立即按拒绝收敛，而不是留下一个悬挂的审批请求
            signal: controller.signal,
          },
        );
      }
      if (!approved) {
        // 必须显式发终止事件：前端已因审批请求进入 running，
        // 只返回 aborted 会让会话永久卡在运行态（复审 P1）
        const message = '用户取消了测试自愈循环';
        emit({ type: 'test_loop_done', ok: false, rounds: 0, reason: 'aborted', message });
        return { ok: false, rounds: 0, reason: 'aborted', message };
      }
      rt.controller = controller;
      uiEngaged = true;
      return await runTestLoop({
        command: detection.command,
        commandSource: detection.source,
        maxRounds,
        focus: options?.focus,
        signal: controller.signal,
        emit,
        runTests: async () => {
          const started = Date.now();
          // 与普通敏感工具共享工作区互斥（PR #9 第四轮复审 P2）：
          // 会话级 sessionOpLock 只能保护同一会话，无法阻止两个会话同时操作同一工作区。
          // 锁粒度限定为「执行一次测试命令」，绝不能包住整个自愈循环——
          // 中间的修复回合还要获取同一把锁执行 edit_file 等敏感工具，会死锁。
          const run = () =>
            this.host.process.run(detection.command, {
              cwd: root,
              timeoutMs,
              shell: this.settings.shell ?? 'auto',
              signal: controller.signal,
            });
          // 用物理身份取锁：同一工作区的不同写法（别名路径）必须共享同一把锁
          const res = await this.workspaceLocks.withLock(
            await this.resolveWorkspaceIdentity(root),
            run,
            controller.signal,
          );
          const output = [res.stdout, res.stderr]
            .filter((part) => typeof part === 'string' && part.trim().length > 0)
            .join('\n');
          return { exitCode: res.code, output, durationMs: Date.now() - started };
        },
        repair: async (prompt) => {
          // 工作区在循环期间必须固定：一旦被切走，修复回合会去改另一个项目的文件，
          // 而下一轮测试仍在原项目执行（复审 P1）。正常情况下 setSessionWorkspace
          // 已被 busy 拦截，这里是拒绝静默漂移的最后一道防线。
          const currentRoot = rt.data.meta.workspaceRoot?.trim();
          if (currentRoot !== root) {
            return {
              ok: false,
              message: `测试循环期间会话工作区发生变化（${root} → ${currentRoot || '未绑定'}），已中止以免修改错误项目`,
            };
          }
          rt.data.messages.push({
            role: 'user',
            content: prompt,
            id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            createdAt: new Date().toISOString(),
          });
          // 修复回合是**内部**回合：抑制常规 done，由外层 test_loop_done 收敛 UI
          // （否则前端会提前结束回合并误报任务完成，PR #9 第三轮复审 P2）
          rt.suppressDone = true;
          let turn: LoopResult;
          try {
            // 修复回合的结果必须回传给循环：error / aborted 都要收敛循环，
            // 否则「修复没成功也继续重跑测试」会白白烧掉剩余轮次
            turn = await this.runTurn(rt);
          } finally {
            rt.suppressDone = false;
            // runTurn 结束会复位运行态；循环期间保持 busy 阻止并发发送，并把中止信号接管回循环
            rt.running = false;
            rt.controller = controller;
          }
          if (turn.reason === 'aborted') return { ok: false, aborted: true };
          if (turn.reason === 'error') {
            return { ok: false, message: turn.errorMessage ?? '修复回合执行失败' };
          }
          return { ok: true };
        },
        readDiff: async () => {
          try {
            const diff = await getGitDiff(this.host, root);
            return diff.diff?.trim() ? diff.diff : undefined;
          } catch {
            return undefined;
          }
        },
      });
    } finally {
      // 兜底收敛：任何已让前端进入运行态的路径（含初始化失败、异常）都必须有终止事件，
      // 否则 UI 会永久停留在 running 并阻断后续发送
      if (uiEngaged && !doneEmitted) {
        emit({
          type: 'test_loop_done',
          ok: false,
          rounds: 0,
          reason: controller.signal.aborted ? 'aborted' : 'error',
          message: controller.signal.aborted ? '测试自愈循环已中止' : pendingErrorMessage,
        });
      }
      rt.data.meta.updatedAt = new Date().toISOString();
      try {
        await this.persistSession(rt);
      } finally {
        rt.busy = false;
        if (rt.controller === controller) rt.controller = undefined;
        if (rt.settled === settled) rt.settled = undefined;
        if (terminalEvent && !rt.deleted) this.emitterFor(sessionId)(terminalEvent);
        resolve();
      }
    }
  }

  /* -------------------- 回合级代码改动快照与一键回退 (TODOS #36) -------------------- */

  /** 列出会话内所有包含代码改动的回合快照摘要 */
  async listTurnCheckpoints(sessionId: string): Promise<TurnCheckpointSummary[]> {
    this.requireSession(sessionId);
    return this.checkpoints.listCheckpoints(sessionId);
  }

  /** 生成回合撤销预览与冲突检测报告（供 <TurnUndoModal> 渲染对比 Diff 与冲突告警） */
  async previewTurnUndo(sessionId: string, turnId?: string): Promise<TurnUndoPreview> {
    this.requireSession(sessionId);
    return this.checkpoints.previewUndo(sessionId, turnId);
  }

  /**
   * 撤销指定回合（或最近一个改动回合）的代码修改，将文件恢复至该回合修改前状态，
   * 并自动向当前会话追加一条系统回退通知消息。
   */
  async revertTurnCheckpoint(
    sessionId: string,
    turnId?: string,
    optionsOrPaths?: RevertTurnOptions | string[],
  ): Promise<TurnUndoResult> {
    const rt = this.requireSession(sessionId);
    // 快照回退会改写磁盘文件。仅入口检查存在 TOCTOU：检查通过后还要 await 快照查询，
    // 期间测试循环可能启动，回退仍会执行（PR #9 第三轮复审 P1）。
    // 因此整个「查询 + 回退 + 追加通知」都在执行期互斥内完成，临界区再复核 busy。
    return this.withSessionOpLock(sessionId, '会话正在运行中，请先等待完成或点击停止', async () => {
      // P1 #1：先解析目标快照，严格按快照记录的 workspaceRoot 加锁并失效缓存
      const targetRecord = await this.checkpoints.getTargetRecord(sessionId, turnId);
      const targetWorkspace = targetRecord.workspaceRoot?.trim();
      const doRevert = () =>
        this.checkpoints.revertTurn(sessionId, targetRecord.turnId, optionsOrPaths);
      const { record, revertedPaths } = targetWorkspace
        ? await this.workspaceLocks
            .getLock(await this.resolveWorkspaceIdentity(targetWorkspace))
            .withLock(doRevert)
        : await doRevert();

      if (targetWorkspace) {
        this.workspaceFilesCache.delete(targetWorkspace);
      }
      if (rt.data.meta.workspaceRoot && rt.data.meta.workspaceRoot !== targetWorkspace) {
        this.workspaceFilesCache.delete(rt.data.meta.workspaceRoot);
      }

      const pathListStr = revertedPaths.map((p) => `\`${p}\``).join('、');
      const noticeText = `> **[系统通知 · 快照回退]** 已撤销第 ${record.turnNumber} 回合的文件变更（恢复至修改前状态）：${pathListStr}`;
      const lastMsg = rt.data.messages[rt.data.messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.blocks.push({
          type: 'text',
          text: `\n\n${noticeText}`,
        });
        const archived = rt.data.history?.find((message) => message.id === lastMsg.id);
        if (archived?.role === 'assistant') {
          archived.blocks.push({ type: 'text', text: `\n\n${noticeText}` });
        }
      } else {
        rt.data.messages.push({
          role: 'assistant',
          blocks: [{ type: 'text', text: noticeText }],
          id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          createdAt: new Date().toISOString(),
        });
      }

      rt.data.meta.updatedAt = new Date().toISOString();
      await this.persistSession(rt);
      const checkpoints = await this.checkpoints.listCheckpoints(sessionId);
      return {
        turnId: record.turnId,
        turnNumber: record.turnNumber,
        revertedPaths,
        checkpoints,
        session: rt.data,
      };
    });
  }

  /* -------------------- 工作区文件轻量预览 (TODOS #38) -------------------- */

  /** 读取工作区指定相对路径文件内容（供工作区文件树单击预览与行范围框选引用） */
  async readWorkspaceFile(sessionId: string, relPath: string): Promise<WorkspaceFilePreview> {
    const rt = this.requireSession(sessionId);
    const root = rt.data.meta.workspaceRoot?.trim();
    if (!root) throw new Error('当前会话未绑定工作区');
    const cleanRel = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
    // 预览入口同样必须落在工作区内（PR #9 第五轮复审 P1）：
    // 克隆仓库里 `notes.md -> /home/user/private.txt` 外观与普通文件无异，
    // 单靠词法检查会让用户在文件树里点开就直接泄露工作区外内容。
    const guard = await resolveRealPathInWorkspace(this.host, root, cleanRel, this.host.paths);
    if (!guard.ok) throw new Error(guard.message);
    const abs = guard.value.realPath;
    const stat = await this.host.fs.stat(abs);
    if (!stat) throw new Error(`文件不存在: ${cleanRel}`);
    if (stat.isDirectory) throw new Error(`目标是目录，无法作为文件预览: ${cleanRel}`);
    const maxFileBytes = 2 * 1024 * 1024;
    if (stat.size > maxFileBytes) {
      throw new Error(
        `文件体积过大 (${(stat.size / 1024 / 1024).toFixed(2)} MB > 2 MB)，请使用外部编辑器打开: ${cleanRel}`,
      );
    }
    let raw = await this.host.fs.readFile(abs);
    if (raw.includes('\u0000')) {
      throw new Error(`疑似二进制文件，无法以文本预览: ${cleanRel}`);
    }
    const maxBytes = 128 * 1024;
    let truncated = false;
    if (raw.length > maxBytes) {
      raw = raw.slice(0, maxBytes);
      truncated = true;
    }
    const content = raw.replace(/\r\n/g, '\n');
    const totalLines = content.split('\n').length;
    return {
      path: cleanRel,
      content,
      totalLines,
      size: stat.size,
      truncated,
    };
  }

  private _noopReviewEnd(): void {
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** 整数钳制（含默认值兜底，用于轮次与超时等必须落在安全区间的配置） */
function clampInt(value: unknown, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : min;
  return Math.min(Math.max(n, min), max);
}

/**
 * 归一化单条权限规则（TODOS #47）：非法条目返回 null 由调用方跳过，
 * 绝不因一条坏规则让整份配置失效。
 */
export function normalizePermissionRule(
  item: unknown,
  source: PermissionRuleSource,
): PermissionRule | null {
  if (!item || typeof item !== 'object') return null;
  const raw = item as Record<string, unknown>;
  const tool = typeof raw.tool === 'string' ? raw.tool.trim() : '';
  if (!tool) return null;
  const decision = raw.decision;
  if (decision !== 'allow' && decision !== 'ask' && decision !== 'deny') return null;
  const rule: PermissionRule = { tool, decision, source };
  if (typeof raw.pattern === 'string' && raw.pattern.trim()) {
    rule.pattern = raw.pattern.trim();
  }
  if (typeof raw.note === 'string' && raw.note.trim()) {
    rule.note = raw.note.trim();
  }
  return rule;
}

/**
 * 解析权限规则内容：兼容 `{ "rules": [...] }` 与直接数组两种写法；
 * JSON 损坏或结构不符时返回空数组（调用方据此退化为无规则）。
 */
export function parsePermissionRules(
  raw: string,
  source: PermissionRuleSource,
): PermissionRule[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : (data as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(list)) return [];
  const out: PermissionRule[] = [];
  for (const item of list) {
    const rule = normalizePermissionRule(item, source);
    if (rule) out.push(rule);
  }
  return out;
}

/** 关闭"对话中系统消息"时：把系统提示词并入首条用户消息（不改动存储的会话数组） */
function mergeSystemIntoUser(messages: ChatMessage[], system: string): ChatMessage[] {
  const idx = messages.findIndex((m) => m.role === 'user');
  if (idx === -1) return messages;
  const first = messages[idx];
  const out = [...messages];
  if (first.role === 'user') {
    out[idx] = { ...first, content: `${system}\n\n---\n\n${first.content}` };
  }
  return out;
}

/** 模型有官方原生联网搜索且当前 API 格式支持该工具类型（其余模型走内置 web_search()） */
export function supportsNativeWebSearch(modelName: string, kind: ProviderEntry['kind']): boolean {
  if (kind === 'responses') return /^(gpt-|codex-|chatgpt-|o[34](-|$))/i.test(modelName);
  if (kind === 'anthropic') return /^claude-/i.test(modelName);
  return false;
}

/** 从会话消息列表中提取最新的 todo_write 任务清单快照 */
function extractLatestTodos(messages: ChatMessage[]): TodoItem[] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      for (const block of msg.blocks) {
        if (block.type === 'tool_call' && block.name === 'todo_write') {
          const input = block.input as { todos?: TodoItem[] } | undefined;
          if (Array.isArray(input?.todos)) {
            return input.todos;
          }
        }
      }
    }
  }
  return undefined;
}

/** 联网搜索后端配置是否齐全 */
export function validWebSearchBackend(ws: Settings['webSearch']): boolean {
  if (!ws?.enabled) return false;
  if (ws.backend === 'tavily') return ws.tavilyApiKey !== undefined
    ? !!ws.tavilyApiKey.trim() : !!(ws.tavilyApiKeyRef || ws.hasTavilyApiKey);
  if (ws.backend === 'custom') return !!ws.customUrl?.trim();
  return !!ws.searxngUrl?.trim();
}

/**
 * 从 /models 条目探测上下文窗口 / 最大输出 / 视觉能力。
 * 各供应商字段名不一（OpenRouter: context_length、Groq: context_window、
 * vLLM: max_model_len、xAI 等），尽量兼容；探测不到就不填，由默认值兜底。
 */
function detectModelMeta(item: Record<string, unknown>): Omit<ProviderModelInfo, 'name'> {
  const o = item as {
    context_length?: unknown;
    context_window?: unknown;
    max_model_len?: unknown;
    context_size?: unknown;
    max_context_length?: unknown;
    top_provider?: { context_length?: unknown; max_completion_tokens?: unknown };
    max_output_tokens?: unknown;
    max_completion_tokens?: unknown;
    max_tokens?: unknown;
    architecture?: { input_modalities?: unknown };
    input_modalities?: unknown;
    modalities?: unknown;
    vision?: unknown;
    capabilities?: { vision?: unknown };
  };
  const contextWindow =
    num(o.context_length) ??
    num(o.context_window) ??
    num(o.max_model_len) ??
    num(o.context_size) ??
    num(o.max_context_length) ??
    num(o.top_provider?.context_length);
  const maxOutputTokens =
    num(o.max_output_tokens) ??
    num(o.max_completion_tokens) ??
    num(o.max_tokens) ??
    num(o.top_provider?.max_completion_tokens);
  const mods = o.architecture?.input_modalities ?? o.input_modalities ?? o.modalities;
  const vision =
    (Array.isArray(mods) &&
      mods.some((x) => typeof x === 'string' && /image|vision/i.test(x))) ||
    o.vision === true ||
    o.capabilities?.vision === true;
  const meta: Omit<ProviderModelInfo, 'name'> = {};
  if (contextWindow !== undefined) meta.contextWindow = contextWindow;
  if (maxOutputTokens !== undefined) meta.maxOutputTokens = maxOutputTokens;
  if (vision) meta.vision = true;
  return meta;
}
