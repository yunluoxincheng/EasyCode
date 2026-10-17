import type {
  AgentEvent,
  ApprovalMode,
  SessionData,
  SessionMeta,
  Usage,
  TodoItem,
  BackgroundTaskInfo,
  TestRunSummary,
} from '@easycode/core';
import {
  providerLabel,
  type ProjectEntry,
  type Settings,
  type TurnCheckpointSummary,
  type RunTestLoopRequest,
} from '@easycode/engine';
import type { AgentClient } from './client.js';

export type ViewBlock = { type: 'text' | 'thinking'; text: string };
export type ViewName = 'chat' | 'settings';
export type SettingsSection =
  | 'models'
  | 'websearch'
  | 'general'
  | 'permissions'
  | 'testloop'
  | 'reflex'
  | 'about';

export type UserItem = { kind: 'user'; id: string; text: string; ts?: number; msgId?: string };
export type AssistantItem = { kind: 'assistant'; id: string; blocks: ViewBlock[] };
export type ToolItem = {
  kind: 'tool';
  id: string;
  callId: string;
  name: string;
  input: unknown;
  status: 'running' | 'ok' | 'error' | 'denied';
  result?: string;
  durationMs?: number;
  startedAt?: number;
};
export type ApprovalItem = {
  kind: 'approval';
  id: string;
  requestId: string;
  name: string;
  input: unknown;
  /** 触发原因（如命中的权限规则，TODOS #47） */
  reason?: string;
  status: 'pending' | 'approved' | 'denied';
};
export type ErrorItem = { kind: 'error'; id: string; message: string };
/** 测试自愈循环单轮结果卡片（TODOS #39） */
export type TestRunItem = {
  kind: 'testrun';
  id: string;
  round: number;
  maxRounds: number;
  command: string;
  source: string;
  focus?: string;
  status: 'running' | 'passed' | 'failed';
  exitCode?: number | null;
  durationMs?: number;
  summary?: TestRunSummary;
  outputTail?: string;
};

/** 回合内条目：过程性内容（思考/工具/审批/错误/测试轮次），与顶层用户消息、回合容器相区分 */
export type TurnEntry =
  | AssistantItem
  | ToolItem
  | ApprovalItem
  | ErrorItem
  | TestRunItem;

/** 一个回合：一次发送的完整执行（思考 + 工具调用 + 中间说明 + 最终回答） */
export type TurnItem = {
  kind: 'turn';
  id: string;
  startedAt: number;
  durationMs?: number;
  /** 折叠时只显示最终结果；运行中默认展开 */
  collapsed: boolean;
  items: TurnEntry[];
};

/** 顶层时间线条目：用户消息、回合容器，以及回合聚合前的兜底平铺条目 */
export type TranscriptItem = UserItem | TurnItem | TurnEntry;

/** 会话运行态状态：idle=空闲, running=正在执行, waiting=等待审批, error=出错 */
export type SessionRunStatus = 'idle' | 'running' | 'waiting' | 'error';

/** 会话视图状态池化项（TODOS #29）：隔离存储每个会话的时间线、运行态与任务清单 */
export interface SessionViewState {
  items: TranscriptItem[];
  currentTurn: TurnItem | null;
  currentAssistant: AssistantItem | null;
  turnItemSet: WeakSet<object>;
  activeTodos: TodoItem[];
  sessionUsage: { input: number; output: number; steps: number; cached: number };
  lastUsage: Usage | null;
  running: boolean;
  status: SessionRunStatus;
  /** 会话绑定的后台任务（TODOS #37）：事件驱动 + 轮询刷新 */
  bgTasks: BackgroundTaskInfo[];
  /** 会话绑定的回合级代码改动快照（TODOS #36） */
  checkpoints: TurnCheckpointSummary[];
}

/** 预览面板视口档位（TODOS #44） */
export type PreviewViewport = 'desktop' | 'tablet' | 'mobile';

export interface ModelSwitchPending {
  sessionId: string;
  providerId: string;
  providerLabel: string;
  model: string;
  targetWindow: number;
  currentTokens: number;
}

/**
 * 应用状态仓库（框架无关，React 通过 useSyncExternalStore 订阅）。
 * AgentEvent 流是唯一的事实来源：事件驱动地增量更新时间线。
 */
export class AppStore {
  sessions: SessionMeta[] = [];
  activeId: string | null = null;
  items: TranscriptItem[] = [];
  running = false;
  mode: ApprovalMode = 'ask';
  settings: Settings | null = null;
  demoMode = false;
  lastUsage: Usage | null = null;
  /** 当前会话活跃的任务清单（由 todo_write 驱动） */
  activeTodos: TodoItem[] = [];
  sessionUsage: { input: number; output: number; steps: number; cached: number } = {
    input: 0,
    output: 0,
    steps: 0,
    cached: 0,
  };
  toast: string | null = null;
  view: ViewName = 'chat';
  settingsSection: SettingsSection = 'models';
  sidebarCollapsed = false;
  activeProjectId: string | null = null;
  createProjectOpen = false;
  projectSwitcherOpen = false;
  projectSearch = '';
  pendingModelSwitch: ModelSwitchPending | null = null;
  /** Git 改动审查全尺寸弹窗状态（TODOS #34） */
  /** Git 改动审查全尺寸弹窗状态（TODOS #34） */
  gitModalOpen = false;
  /** 活动会话的回合改动快照摘要（TODOS #36） */
  checkpoints: TurnCheckpointSummary[] = [];
  /** 回合撤销确认弹窗当前打开的目标 turnId（TODOS #36，null=关闭） */
  turnUndoModalTurnId: string | null = null;
  /** 工作区轻量文件预览弹窗当前打开的相对路径（TODOS #38，null=关闭） */
  filePreviewPath: string | null = null;
  /** 工作区文件树刷新信号（TODOS #38） */
  fileTreeRefreshTick = 0;
  /** Composer 外部插入文本信号（TODOS #38：从文件树或代码预览框选插入引用） */
  composerInsertTick = 0;
  composerInsertText = '';

  /** 活动会话的后台任务视图（TODOS #37），与 activeSession 的池化状态同步 */
  bgTasks: BackgroundTaskInfo[] = [];
  /** 终端日志抽屉（TODOS #37）：打开时展示指定任务（null = 第一个任务） */
  taskDrawerOpen = false;
  taskDrawerTaskId: string | null = null;
  /** 内嵌预览面板（TODOS #44） */
  previewOpen = false;
  previewUrl: string | null = null;
  previewTaskId: string | null = null;
  previewViewport: PreviewViewport = 'desktop';
  /** 跟随刷新：后台任务有新输出行时自动轻刷新预览（HMR 失效兜底） */
  previewFollow = true;
  previewWidth = 520;
  private bgPollTimer: ReturnType<typeof setInterval> | null = null;

  private listeners = new Set<() => void>();
  private seq = 0;
  private selectSeq = 0;
  /** 会话视图状态池（TODOS #29）：按 sessionId 隔离维护时间线、运行状态与任务清单 */
  private sessionStates = new Map<string, SessionViewState>();
  /** 快照版本号：每次 notify 递增，供 useSyncExternalStore 感知变化 */
  version = 0;
  /** 结构版本号：仅在会话切换、消息/卡片增删、回合折叠展开等结构性变更时递增，用于解耦高频流式与重度 DOM 测量 */
  structureVersion = 0;

  private rafId: number | null = null;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private turnItemSet = new WeakSet<object>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): number => this.version;

  private inited = false;

  constructor(readonly client: AgentClient) {
    // 事件订阅放构造函数：store 是页面级单例，只订阅一次。
    // 多会话并发支持：全量事件均分流派发至对应的 SessionViewState，后台会话静默累积进度
    this.client.onEvent(({ sessionId, event }) => {
      this.handleSessionEvent(sessionId, event);
    });
  }

  /**
   * 调度合并通知：在高频流式 delta 时将多帧合并为单次 RAF / 50ms 刷新，消灭每秒几十次的全树重渲。
   * delta 在事件回调里即时合入 state，这里只合并「渲染」——不存在待渲染数据积压，
   * 勿在此添加基于积压的强制同步刷新：主线程饱和或窗口隐藏时只会增加无谓渲染（TODOS #45 审查结论）。
   */
  scheduleNotify(): void {
    if (this.rafId !== null || this.timerId !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this.notify(false);
      });
    } else {
      this.timerId = setTimeout(() => {
        this.timerId = null;
        this.notify(false);
      }, 50);
    }
  }

  /** 立即刷新任何待处理的批处理更新 */
  flushPendingNotify(): void {
    if (this.rafId !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  notify(structural = false): void {
    this.flushPendingNotify();
    if (structural) {
      this.structureVersion++;
    }
    this.version++;
    for (const l of this.listeners) l();
  }

  private nextId(): string {
    return `i${this.seq++}`;
  }

  get activeSession(): SessionMeta | undefined {
    return this.sessions.find((s) => s.id === this.activeId);
  }

  /** activeSession 的别名快捷访问 */
  get session(): SessionMeta | undefined {
    return this.activeSession;
  }

  /** 自动滚底开关（未配置视为开启） */
  get autoScrollOn(): boolean {
    return this.settings?.autoScroll !== false;
  }

  /** 当前活动回合正在执行中的工具（若有） */
  get activeTool(): ToolItem | null {
    if (!this.running || !this.currentTurn) return null;
    for (let i = this.currentTurn.items.length - 1; i >= 0; i--) {
      const item = this.currentTurn.items[i];
      if (item.kind === 'tool' && item.status === 'running') {
        return item;
      }
    }
    return null;
  }

  /** 当前是否有待审批项 */
  get pendingApproval(): ApprovalItem | null {
    if (!this.running || !this.currentTurn) return null;
    for (let i = this.currentTurn.items.length - 1; i >= 0; i--) {
      const item = this.currentTurn.items[i];
      if (item.kind === 'approval' && item.status === 'pending') {
        return item;
      }
    }
    return null;
  }

  /** 获取指定会话当前的实时运行状态（用于侧栏状态指示灯） */
  getSessionStatus(id: string): SessionRunStatus {
    return this.sessionStates.get(id)?.status ?? 'idle';
  }

  /** 是否有任意后台会话正在执行任务 */
  get hasBackgroundRunning(): boolean {
    for (const [id, state] of this.sessionStates.entries()) {
      if (id !== this.activeId && state.running) return true;
    }
    return false;
  }

  get activeProject(): ProjectEntry | null {
    return this.settings?.projects.find((p) => p.id === this.activeProjectId) ?? null;
  }

  setActiveProject(id: string | null): void {
    this.activeProjectId = id;
    this.notify();
  }

  openCreateProject(): void {
    this.createProjectOpen = true;
    this.notify();
  }

  closeCreateProject(): void {
    this.createProjectOpen = false;
    this.notify();
  }

  toggleProjectSwitcher(): void {
    this.projectSwitcherOpen = !this.projectSwitcherOpen;
    this.projectSearch = '';
    this.notify();
  }

  setProjectSearch(v: string): void {
    this.projectSearch = v;
    this.notify();
  }

  /** 从系统文件夹选择器挑一个文件夹：登记为项目并绑定到当前会话 */
  async bindProjectFromPicker(id: string): Promise<void> {
    const dir = await this.client.pickWorkspace();
    if (!dir) return;
    await this.createProject('', dir);
    const meta = await this.client.setSessionWorkspace(id, dir);
    this.sessions = this.sessions.map((s) => (s.id === id ? meta : s));
    this.notify();
  }

  /** 创建项目（同文件夹复用已有项目） */
  async createProject(name: string, folder: string): Promise<ProjectEntry> {
    const cur = this.settings?.projects ?? [];
    const existing = cur.find((p) => p.folder === folder);
    if (existing) {
      this.setActiveProject(existing.id);
      return existing;
    }
    const entry: ProjectEntry = {
      id: `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim() || folder.split(/[\/]/).filter(Boolean).pop() || folder,
      folder,
    };
    await this.saveSettings({ projects: [...cur, entry] });
    this.setActiveProject(entry.id);
    return entry;
  }

  /** 重命名项目别名 */
  async renameProject(id: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    const cur = this.settings?.projects ?? [];
    const updated = cur.map((p) => (p.id === id ? { ...p, name: trimmed } : p));
    await this.saveSettings({ projects: updated });
    this.notify();
  }

  /** 从项目列表中移除（仅移除配置，不删除本地实际目录） */
  async deleteProject(id: string): Promise<void> {
    const cur = this.settings?.projects ?? [];
    const updated = cur.filter((p) => p.id !== id);
    if (this.activeProjectId === id) {
      this.activeProjectId = null;
    }
    await this.saveSettings({ projects: updated });
    this.notify();
  }

  /** 检查指定项目/文件夹分组是否处于折叠状态 */
  isProjectFolded(key: string): boolean {
    return (this.settings?.collapsedProjects ?? []).includes(key);
  }

  /** 切换项目/文件夹分组的折叠状态（并持久化） */
  async toggleProjectFold(key: string): Promise<void> {
    const cur = this.settings?.collapsedProjects ?? [];
    const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
    await this.saveSettings({ collapsedProjects: next });
    this.notify();
  }

  /* ---------------- 初始化与加载 ---------------- */

  async init(): Promise<void> {
    if (this.inited) return; // StrictMode 双挂载防重入
    this.inited = true;
    this.demoMode = !('easycode' in window) && !('__TAURI_INTERNALS__' in window);
    this.sessions = await this.client.listSessions();
    if (this.sessions.length > 0) {
      await this.selectSession(this.sessions[0].id);
    }
    this.notify();
  }

  async loadSessions(): Promise<void> {
    this.sessions = await this.client.listSessions();
    this.notify(true);
  }

  /** 获取或创建指定会话的池化状态 */
  getOrCreateSessionState(id: string): SessionViewState {
    let state = this.sessionStates.get(id);
    if (!state) {
      state = {
        items: [],
        currentTurn: null,
        currentAssistant: null,
        turnItemSet: new WeakSet(),
        activeTodos: [],
        sessionUsage: { input: 0, output: 0, steps: 0, cached: 0 },
        lastUsage: null,
        running: false,
        status: 'idle',
        bgTasks: [],
        checkpoints: [],
      };
      this.sessionStates.set(id, state);
    }
    return state;
  }

  /** 同步激活会话的展示字段 */
  private syncActiveState(state: SessionViewState): void {
    this.items = state.items;
    this.currentTurn = state.currentTurn;
    this.activeTodos = state.activeTodos;
    this.sessionUsage = state.sessionUsage;
    this.lastUsage = state.lastUsage;
    this.running = state.running;
    this.running = state.running;
    this.bgTasks = state.bgTasks;
    this.checkpoints = state.checkpoints;
  }

  async selectSession(id: string): Promise<void> {
    const seq = ++this.selectSeq;
    this.flushPendingNotify();
    // 切换会话即重建视图：内层视窗贴底状态回归默认锁定（新渲染的 live 回合默认贴底跟随）
    this.turnAtBottom = true;

    // 1. 若目标会话已在状态池中，立即切换呈现（0ms 零白屏、切回运行态即时可见）
    let state = this.sessionStates.get(id);
    if (state) {
      this.activeId = id;
      this.syncActiveState(state);
      this.view = 'chat';
      this.notify(true);
    }

    try {
      const data = await this.client.getSession(id);
      if (seq !== this.selectSeq) return; // 已有新的切换请求，防乱序覆盖

      // 若之前没有池化状态，从客户端载入历史初始化
      if (!state) {
        state = {
          items: this.itemsFromSession(data),
          currentTurn: null,
          currentAssistant: null,
          turnItemSet: new WeakSet(),
          activeTodos: data.todos ?? this.extractTodosFromSession(data),
          sessionUsage: {
            input: data.usage?.input ?? 0,
            output: data.usage?.output ?? 0,
            steps: data.usage?.steps ?? 0,
            cached: data.usage?.cached ?? 0,
          },
          lastUsage: null,
          running: false,
          status: 'idle',
          bgTasks: [],
        checkpoints: [],
        };
        this.sessionStates.set(id, state);
      } else if (!state.running && state.items.length === 0 && data.messages.length > 0) {
        state.items = this.itemsFromSession(data);
        state.activeTodos = data.todos ?? this.extractTodosFromSession(data);
      }

      this.activeId = id;
      this.syncActiveState(state);

      // 同步该会话实际的审批模式到输入区（新会话用设置默认值）
      try {
        const mode = await this.client.getApprovalMode(id);
        if (seq !== this.selectSeq) return;
        this.mode = mode;
      } catch {
        /* 会话可能刚被删除 */
      }
      this.view = 'chat';
      this.notify(true);
      // TODOS #37：切会话后拉取该会话的后台任务列表（接管恢复任务、点亮任务条）
      // TODOS #37：切会话后拉取该会话的后台任务列表（接管恢复任务、点亮任务条）
      void this.refreshBackgroundTasks();
      // TODOS #36：切会话后拉取该会话的回合代码改动快照
      void this.refreshCheckpoints(id);
    } catch (err) {
      if (seq !== this.selectSeq) return;
      this.showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  }

  /** 显示名（用户设置的名称优先于 id，如 CPA） */
  providerLabelOf(id: string): string {
    return providerLabel(id, this.settings?.providers[id]);
  }

  /** 会话级 Provider + 模型切换 */
  async setSessionProvider(id: string, providerId: string, model?: string): Promise<void> {
    const meta = await this.client.setSessionProvider(id, providerId, model);
    this.sessions = this.sessions.map((s) => (s.id === id ? meta : s));
    this.notify();
  }

  openModelSwitchGuard(pending: ModelSwitchPending): void {
    this.pendingModelSwitch = pending;
    this.notify(true);
  }

  closeModelSwitchGuard(): void {
    this.pendingModelSwitch = null;
    this.notify(true);
  }

  /** 在当前会话裁剪早期历史（保留最近 keepRecentTurns 轮和最新待办），并切换至目标模型 */
  async trimSessionAndSwitch(pending: ModelSwitchPending, keepRecentTurns = 2): Promise<void> {
    this.pendingModelSwitch = null;
    await this.client.trimSessionHistory(pending.sessionId, keepRecentTurns);
    await this.client.setSessionProvider(pending.sessionId, pending.providerId, pending.model);
    await this.selectSession(pending.sessionId);
    this.showToast(`已精简历史并切换至 ${pending.model || '默认'}`);
  }

  /** 主动压缩当前会话上下文（TODOS #31）：修剪旧工具长输出并归档早期历史 */
  async compressContext(keepRecentTurns = 2): Promise<void> {
    if (!this.activeId || this.running) return;
    try {
      await this.client.trimSessionHistory(this.activeId, keepRecentTurns);
      await this.selectSession(this.activeId);
      this.showToast('✓ 上下文已智能压缩，已腾出 Token 空间');
    } catch (err) {
      this.showToast(`压缩失败: ${err instanceof Error ? err.message : String(err)}`, 'err');
    }
  }

  /**
   * 启动测试自愈循环（TODOS #39）：运行测试 → 失败自动修复 → 重跑，直至全绿或轮次耗尽。
   * 过程与结果由 test_run_* 事件驱动渲染 <TestRunCard>，此处只负责发起与错误提示。
   */
  async runTestLoop(options?: RunTestLoopRequest): Promise<void> {
    const id = this.activeId;
    if (!id) return;
    const state = this.getOrCreateSessionState(id);
    if (state.running || this.running) {
      this.showToast('会话正在运行中，请先等待完成或停止', 'err');
      return;
    }
    if (!this.client.runTestLoop) {
      this.showToast('当前宿主不支持测试自愈循环', 'err');
      return;
    }
    try {
      const result = await this.client.runTestLoop(id, options);
      if (result.reason === 'aborted' && result.message) {
        this.showToast(result.message);
      }
      // 修复回合可能改动了文件，刷新快照与文件树（同 done 事件处理）
      void this.refreshCheckpoints(id);
      this.fileTreeRefreshTick++;
    } catch (err) {
      this.showToast(
        err instanceof Error ? err.message : '测试自愈循环启动失败',
        'err',
      );
    }
  }

  /** 从当前会话分叉出新会话，在新会话上精简并切换为目标模型，保留原会话完整历史 */
  async forkSessionAndSwitch(pending: ModelSwitchPending, keepRecentTurns = 2): Promise<void> {
    this.pendingModelSwitch = null;
    const newMeta = await this.client.forkSession(pending.sessionId);
    await this.client.trimSessionHistory(newMeta.id, keepRecentTurns);
    await this.client.setSessionProvider(newMeta.id, pending.providerId, pending.model);
    this.sessions = await this.client.listSessions();
    await this.selectSession(newMeta.id);
    this.showToast(`已分叉出新分支并切换至 ${pending.model || '默认'}`);
  }

  /** 会话级模型覆盖（'' = 供应商默认） */
  async setSessionModel(id: string, model: string): Promise<void> {
    const meta = await this.client.setSessionModel(id, model);
    this.sessions = this.sessions.map((s) => (s.id === id ? meta : s));
    this.notify();
  }

  /** 会话级思考强度（'' = 供应商默认） */
  async setSessionEffort(id: string, effort: string): Promise<void> {
    const meta = await this.client.setSessionEffort(id, effort);
    this.sessions = this.sessions.map((s) => (s.id === id ? meta : s));
    this.notify();
  }

  /** 为会话绑定/更换工作区 */
  async bindWorkspace(id: string, workspace: string): Promise<void> {
    const meta = await this.client.setSessionWorkspace(id, workspace);
    this.sessions = this.sessions.map((s) => (s.id === id ? meta : s));
    this.notify();
  }

  /* ---------------- 视图切换 ---------------- */

  openSettings(section: SettingsSection = this.settingsSection): void {
    this.settingsSection = section;
    this.view = 'settings';
    void this.loadSettings();
    this.notify();
  }

  openChat(): void {
    this.view = 'chat';
    if (!this.running) {
      this.turnAtBottom = true;
    }
    this.notify();
  }

  toggleSidebar(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    this.notify();
  }

  openGitModal(): void {
    this.gitModalOpen = true;
    this.notify();
  }

  closeGitModal(): void {
    this.gitModalOpen = false;
    this.notify();
  }

  /* ---------------- 回合级代码改动快照与一键回退 (TODOS #36) ---------------- */

  /** 刷新指定会话（默认活动会话）的回合代码改动快照列表 */
  async refreshCheckpoints(sessionId = this.activeId): Promise<void> {
    if (!sessionId || !this.client.listTurnCheckpoints) return;
    try {
      const list = await this.client.listTurnCheckpoints(sessionId);
      const state = this.sessionStates.get(sessionId);
      if (state) state.checkpoints = list;
      if (sessionId === this.activeId) {
        this.checkpoints = list;
        this.notify(false);
      }
    } catch {
      // 忽略快照拉取异常
    }
  }

  /** 根据 UI TurnItem 查找关联的回合代码改动快照（严格通过实际执行的写文件 toolCallIds 匹配，P2 #6） */
  getTurnCheckpointForTurn(turn: TurnItem): TurnCheckpointSummary | undefined {
    if (this.checkpoints.length === 0) return undefined;
    const callIds = new Set<string>();
    for (const it of turn.items) {
      if (it.kind === 'tool' && it.callId) {
        callIds.add(it.callId);
      }
    }
    if (callIds.size === 0) return undefined;
    return this.checkpoints.find((c) => c.toolCallIds.some((id) => callIds.has(id)));
  }

  /** 呼出回合撤销确认弹窗（turnId 缺省或为 'latest' 时默认定位最近一个包含代码改动的回合） */
  openTurnUndoModal(turnId = 'latest'): void {
    if (!this.activeId) return;
    if (this.running) {
      this.showToast('会话正在运行中，请先等待完成或点击停止', 'err');
      return;
    }
    if (turnId === 'latest') {
      const latestUnreverted = [...this.checkpoints].reverse().find((c) => !c.revertedAt);
      const fallback = this.checkpoints[this.checkpoints.length - 1];
      const target = latestUnreverted ?? fallback;
      if (!target) {
        this.showToast('当前会话暂无可撤销的代码改动回合', 'err');
        return;
      }
      this.turnUndoModalTurnId = target.turnId;
    } else {
      this.turnUndoModalTurnId = turnId;
    }
    this.notify(true);
  }

  closeTurnUndoModal(): void {
    this.turnUndoModalTurnId = null;
    this.notify(true);
  }

  /** 执行回合快照回退并刷新会话时间线（支持 CAS 冲突返回供弹窗二次确认，P1 #3） */
  async executeTurnUndo(
    turnId: string,
    optionsOrPaths?:
      | { paths?: string[]; force?: boolean; expectedFingerprints?: Record<string, string> }
      | string[],
  ): Promise<{ ok: boolean; conflict?: boolean; error?: string }> {
    if (!this.activeId || !this.client.revertTurnCheckpoint) {
      return { ok: false, error: '当前环境不支持快照回退' };
    }
    try {
      const res = await this.client.revertTurnCheckpoint(this.activeId, turnId, optionsOrPaths);
      const state = this.sessionStates.get(this.activeId);
      if (state) {
        state.checkpoints = res.checkpoints;
        state.items = this.itemsFromSession(res.session);
      }
      this.checkpoints = res.checkpoints;
      if (state) this.syncActiveState(state);
      this.turnUndoModalTurnId = null;
      this.fileTreeRefreshTick++;
      this.showToast(
        `[ OK ] 已撤销第 ${res.turnNumber} 回合的文件变更（共 ${res.revertedPaths.length} 个文件）`,
      );
      this.notify(true);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isConflict = msg.includes('[CONFLICT]') || msg.includes('已被修改');
      this.showToast(msg.replace(/^\[CONFLICT\]\s*/, ''), 'err');
      return { ok: false, conflict: isConflict, error: msg.replace(/^\[CONFLICT\]\s*/, '') };
    }
  }

  /* ---------------- 工作区文件树与代码预览引用 (TODOS #38) ---------------- */

  openFilePreview(relPath: string): void {
    this.filePreviewPath = relPath;
    this.notify(true);
  }

  closeFilePreview(): void {
    this.filePreviewPath = null;
    this.notify(true);
  }

  /** 向 Composer 输入框插入路径或 @file:start-end 引用 */
  insertIntoComposer(snippet: string): void {
    this.composerInsertText = snippet;
    this.composerInsertTick++;
    this.notify(false);
  }

  /** 消费并清理 Composer 插入指令（防止进入设置页再返回聊天页重新挂载时重复执行旧插入请求） */
  consumeComposerInsert(tick?: number): string {
    if (tick !== undefined && tick !== this.composerInsertTick) return '';
    const snippet = this.composerInsertText;
    if (!snippet) return '';
    this.composerInsertText = '';
    return snippet;
  }

  private _noopAfterCloseGitModal(): void {
    this.gitModalOpen = false;
    this.notify();
  }

  private itemsFromSession(data: SessionData): TranscriptItem[] {
    const items: TranscriptItem[] = [];
    const toolById = new Map<string, ToolItem>();
    let turn: TurnItem | null = null;
    let firstTs: number | undefined;
    let lastTs: number | undefined;
    const toTs = (iso?: string): number | undefined => (iso ? Date.parse(iso) : undefined);

    const closeTurn = (): void => {
      if (turn) {
        if (firstTs != null && lastTs != null && lastTs >= firstTs) {
          turn.durationMs = lastTs - firstTs;
        }
        turn = null;
        firstTs = undefined;
        lastTs = undefined;
      }
    };
    const ensureTurn = (ts?: number): TurnItem => {
      if (!turn) {
        turn = { kind: 'turn', id: this.nextId(), startedAt: ts ?? Date.now(), collapsed: true, items: [] };
        items.push(turn);
      }
      if (ts != null) {
        firstTs = firstTs ?? ts;
        lastTs = ts;
      }
      return turn;
    };

    for (const msg of data.messages) {
      if (msg.role === 'user') {
        closeTurn();
        items.push({
          kind: 'user',
          id: this.nextId(),
          text: msg.content,
          ts: toTs(msg.createdAt),
          msgId: msg.id,
        });
        continue;
      }
      const t = ensureTurn(toTs(msg.createdAt));
      if (msg.role === 'assistant') {
        const view: ViewBlock[] = [];
        const toolItems: ToolItem[] = [];
        for (const block of msg.blocks) {
          if (block.type === 'text') view.push({ type: 'text', text: block.text });
          else if (block.type === 'thinking') view.push({ type: 'thinking', text: block.text });
          else if (block.type === 'tool_call') {
            const item: ToolItem = {
              kind: 'tool',
              id: this.nextId(),
              callId: block.id,
              name: block.name,
              input: block.input,
              status: 'running',
            };
            toolById.set(block.id, item);
            toolItems.push(item);
          }
        }
        // 助手文本在前，工具卡片随后（与实时事件顺序一致）
        if (view.length > 0) {
          t.items.push({ kind: 'assistant', id: this.nextId(), blocks: view });
        }
        t.items.push(...toolItems);
      } else {
        const tool = toolById.get(msg.toolCallId);
        if (tool) {
          tool.status = msg.isError ? 'error' : msg.content.includes('用户拒绝') ? 'denied' : 'ok';
          tool.result = msg.content;
        }
        lastTs = toTs(msg.createdAt) ?? lastTs;
      }
    }
    closeTurn();
    return items;
  }

  private extractTodosFromSession(data: SessionData): TodoItem[] {
    for (let i = data.messages.length - 1; i >= 0; i--) {
      const msg = data.messages[i];
      if (msg.role === 'assistant') {
        for (let j = msg.blocks.length - 1; j >= 0; j--) {
          const block = msg.blocks[j];
          if (block.type === 'tool_call' && block.name === 'todo_write') {
            const input = block.input as { todos?: TodoItem[] } | undefined;
            if (Array.isArray(input?.todos)) {
              return input.todos;
            }
          }
        }
      }
    }
    return [];
  }

  /* ---------------- 操作 ---------------- */

  /** 直接创建并进入新会话：绑定了项目则落在项目文件夹，否则纯对话 */
  async newSession(): Promise<void> {
    const folder = this.activeProject?.folder ?? '';
    const meta = await this.client.createSession({
      workspaceRoot: folder,
      providerId: this.settings?.defaultProvider ?? 'zhipu',
    });
    this.sessions = [meta, ...this.sessions];
    await this.selectSession(meta.id);
  }

  /** 重命名会话 */
  async renameSession(id: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) return;
    const current = this.sessions.find((s) => s.id === id);
    if (current && current.title === trimmed) return;
    const meta = await this.client.renameSession(id, trimmed);
    this.sessions = this.sessions.map((s) => (s.id === id ? meta : s));
    this.notify(true);
  }

  async deleteSession(id: string): Promise<void> {
    const state = this.sessionStates.get(id);
    if (state?.running) return;
    await this.client.deleteSession(id);
    this.sessionStates.delete(id);
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.activeId === id) {
      this.activeId = null;
      this.items = [];
      this.currentTurn = null;
      this.activeTodos = [];
      this.running = false;
      this.turnAtBottom = true;
      this.bgTasks = [];
      // 抽屉/预览锚定在被删会话的任务上，一并关闭
      this.taskDrawerOpen = false;
      this.taskDrawerTaskId = null;
      this.previewOpen = false;
      this.previewOpen = false;
      this.previewTaskId = null;
      this.checkpoints = [];
      this.turnUndoModalTurnId = null;
      this.filePreviewPath = null;
      if (this.sessions.length > 0) await this.selectSession(this.sessions[0].id);
    }
    this.notify(true);
  }

  /** 从指定节点分叉（Fork）出新会话并自动切换进入 */
  async forkSession(anchor?: { kind: 'beforeUser' | 'afterTurn'; itemId: string }): Promise<void> {
    if (!this.activeId) return;
    const curState = this.sessionStates.get(this.activeId);
    if (curState?.running) return;
    let beforeUserIndex: number | undefined;
    let upToMessageId: string | undefined;

    if (anchor) {
      if (anchor.kind === 'beforeUser') {
        let uIdx = 0;
        for (const it of this.items) {
          if (it.kind === 'user') {
            if (it.id === anchor.itemId) {
              beforeUserIndex = uIdx;
              upToMessageId = it.msgId;
              break;
            }
            uIdx++;
          }
        }
      } else if (anchor.kind === 'afterTurn') {
        let uIdx = 0;
        for (let i = 0; i < this.items.length; i++) {
          const it = this.items[i];
          if (it.kind === 'user') {
            uIdx++;
          } else if (it.kind === 'turn' && it.id === anchor.itemId) {
            beforeUserIndex = uIdx;
            break;
          }
        }
      }
    }

    try {
      const meta = await this.client.forkSession(this.activeId, { beforeUserIndex, upToMessageId });
      this.sessions = [meta, ...this.sessions];
      await this.selectSession(meta.id);
      this.showToast('已成功分叉出新会话');
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  }

  /** 发送时递增，驱动会话区滚动到底部 */
  scrollTick = 0;
  /**
   * 外层主视口贴底锁定（TODOS #46）：true=视口贴底跟随最新输出；
   * 用户主动上翻翻看历史即解除锁定（false），进入自由阅读模式。
   */
  atBottom = true;
  /**
   * 活动回合内部视窗（.turn-body）贴底锁定（TODOS #46）：与外层状态相互独立——
   * 用户可能在外层贴底的同时于内层视窗上翻，「↓ 回到底部」按钮需任一视口离开底部即出现。
   * 仅由 live 回合的内层滚动/滚轮事件驱动；无 live 回合时恒为 true。
   */
  turnAtBottom = true;
  /** 「回到底部」联动信号（TODOS #46）：递增驱动活动回合内部视窗同步贴底并恢复跟随 */
  jumpTick = 0;

  setAtBottom(v: boolean): void {
    if (this.atBottom !== v) {
      this.atBottom = v;
      this.notify(false);
    }
  }

  setTurnAtBottom(v: boolean): void {
    if (this.turnAtBottom !== v) {
      this.turnAtBottom = v;
      this.notify(false);
    }
  }

  /** 一键回到底部（TODOS #46）：外层视口贴底 + 联动信号通知活动回合内部视窗同步贴底并重新锁定跟随 */
  jumpToBottom(): void {
    this.jumpTick++;
    this.atBottom = true;
    this.turnAtBottom = true;
    this.notify(false);
  }

  async send(text: string): Promise<void> {
    const id = this.activeId;
    if (!id || this.running || !text.trim()) return;
    const state = this.getOrCreateSessionState(id);
    state.running = true;
    state.status = 'running';
    this.running = true;
    state.items.push({ kind: 'user', id: this.nextId(), text: text.trim(), ts: Date.now() });
    const turn: TurnItem = {
      kind: 'turn',
      id: this.nextId(),
      startedAt: Date.now(),
      collapsed: false,
      items: [],
    };
    state.items.push(turn);
    state.currentTurn = turn;
    this.syncActiveState(state);
    this.turnAtBottom = true;
    if (this.autoScrollOn) {
      this.scrollTick++;
      this.atBottom = true;
    }
    this.notify(true);
    try {
      await this.client.sendMessage(id, text.trim());
    } catch (err) {
      const errorItem: ErrorItem = {
        kind: 'error',
        id: this.nextId(),
        message: err instanceof Error ? err.message : String(err),
      };
      if (state.currentTurn) state.currentTurn.items.push(errorItem);
      else state.items.push(errorItem);
      state.running = false;
      state.status = 'error';
      if (this.activeId === id) {
        this.syncActiveState(state);
        this.turnAtBottom = true;
      }
      this.notify(true);
    }
  }

  /** 编辑最近一条用户消息并重新生成：UI 截断该消息之后的内容，新建回合容器承接流式事件 */
  async editAndResend(userItemId: string, text: string): Promise<void> {
    const id = this.activeId;
    if (!id || this.running || !text.trim()) return;
    const state = this.getOrCreateSessionState(id);
    const idx = state.items.findIndex((i) => i.id === userItemId);
    if (idx === -1) return;
    state.items = state.items
      .slice(0, idx + 1)
      .map((i) => (i.id === userItemId && i.kind === 'user' ? { ...i, text: text.trim() } : i));
    // P2 #6：截断后续回合时，立即从前端视图状态移除属于被截断回合的快照
    const retainedCallIds = new Set<string>();
    for (const it of state.items) {
      if (it.kind === 'turn') {
        for (const sub of it.items) {
          if (sub.kind === 'tool' && sub.callId) retainedCallIds.add(sub.callId);
        }
      }
    }
    state.checkpoints = state.checkpoints.filter((c) =>
      c.toolCallIds.some((cid) => retainedCallIds.has(cid)),
    );
    const turn: TurnItem = {
      kind: 'turn',
      id: this.nextId(),
      startedAt: Date.now(),
      collapsed: false,
      items: [],
    };
    state.items.push(turn);
    state.currentTurn = turn;
    state.running = true;
    state.status = 'running';
    this.syncActiveState(state);
    this.turnAtBottom = true;
    if (this.autoScrollOn) {
      this.scrollTick++;
      this.atBottom = true;
    }
    this.notify(true);
    try {
      await this.client.editLastUserMessage(id, text);
    } catch (err) {
      const errorItem: ErrorItem = {
        kind: 'error',
        id: this.nextId(),
        message: err instanceof Error ? err.message : String(err),
      };
      if (state.currentTurn) state.currentTurn.items.push(errorItem);
      else state.items.push(errorItem);
      state.running = false;
      state.status = 'error';
      if (this.activeId === id) {
        this.syncActiveState(state);
        this.turnAtBottom = true;
      }
      this.notify(true);
    }
  }

  async respondApproval(requestId: string, approved: boolean): Promise<void> {
    if (!this.activeId) return;
    this.client.respondApproval(this.activeId, requestId, approved);
  }

  async stop(): Promise<void> {
    if (!this.activeId) return;
    await this.stopSession(this.activeId);
  }

  async stopSession(id: string): Promise<void> {
    const state = this.sessionStates.get(id);
    if (state) {
      state.running = false;
      state.status = 'idle';
      if (id === this.activeId) {
        this.syncActiveState(state);
        this.turnAtBottom = true;
      }
    }
    await this.client.abort(id);
    this.notify(true);
  }

  /* ---------------- 后台任务与内嵌预览 (TODOS #37 / #44) ---------------- */

  /** 按需启动后台任务轮询：有运行中任务、抽屉或预览打开时每 2.5s 刷新一次 */
  ensureBgPolling(): void {
    if (this.bgPollTimer !== null) return;
    this.bgPollTimer = setInterval(() => {
      void this.pollBackgroundTasks();
    }, 2500);
  }

  private maybeStopBgPolling(): void {
    if (this.bgPollTimer === null) return;
    const hasRunning = this.bgTasks.some((t) => t.status === 'running');
    if (!hasRunning && !this.taskDrawerOpen && !this.previewOpen) {
      clearInterval(this.bgPollTimer);
      this.bgPollTimer = null;
    }
  }

  private polling = false;

  private async pollBackgroundTasks(): Promise<void> {
    const id = this.activeId;
    if (!id || this.polling || !this.client.listBackgroundTasks) {
      this.maybeStopBgPolling();
      return;
    }
    this.polling = true;
    try {
      const list = await this.client.listBackgroundTasks(id);
      const state = this.sessionStates.get(id);
      if (state) state.bgTasks = list;
      if (id === this.activeId) {
        this.bgTasks = list;
      }
      this.notify(false);
    } catch {
      // 轮询失败静默（会话可能刚删除）
    } finally {
      this.polling = false;
      this.maybeStopBgPolling();
    }
  }

  /** 事件驱动兜底：会话切换 / 应用启动后主动刷一次任务列表（并接管恢复任务） */
  async refreshBackgroundTasks(): Promise<void> {
    if (!this.activeId || !this.client.listBackgroundTasks) return;
    this.ensureBgPolling();
    await this.pollBackgroundTasks();
  }

  toggleTaskDrawer(taskId?: string | null): void {
    if (this.taskDrawerOpen && (taskId === undefined || taskId === this.taskDrawerTaskId)) {
      this.taskDrawerOpen = false;
      this.taskDrawerTaskId = null;
    } else {
      this.taskDrawerOpen = true;
      this.taskDrawerTaskId = taskId ?? this.bgTasks[0]?.id ?? null;
    }
    this.notify(true);
  }

  async stopTask(taskId: string): Promise<void> {
    if (!this.activeId || !this.client.stopBackgroundTask) return;
    try {
      await this.client.stopBackgroundTask(this.activeId, taskId);
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : String(err), 'err');
    }
    await this.refreshBackgroundTasks();
  }

  async restartTask(taskId: string): Promise<BackgroundTaskInfo | null> {
    if (!this.activeId || !this.client.restartBackgroundTask) return null;
    try {
      const task = await this.client.restartBackgroundTask(this.activeId, taskId);
      // 日志抽屉 / 预览面板锚点跟进新任务，避免停留在已停止的旧任务上
      if (this.taskDrawerTaskId === taskId) this.taskDrawerTaskId = task.id;
      if (this.previewTaskId === taskId) this.previewTaskId = task.id;
      await this.refreshBackgroundTasks();
      this.showToast('✓ 后台任务已重新启动');
      return task;
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : String(err), 'err');
      return null;
    }
  }

  /** 在侧边预览面板打开后台任务的服务地址（TODOS #44） */
  openPreviewForTask(taskId: string): void {
    const task = this.bgTasks.find((t) => t.id === taskId);
    const url = task?.primaryUrl;
    if (!url) {
      this.showToast('该任务尚未捕获到服务地址', 'err');
      return;
    }
    this.previewUrl = url;
    this.previewTaskId = taskId;
    this.previewOpen = true;
    this.ensureBgPolling();
    this.notify(true);
  }

  openPreview(url: string): void {
    this.previewUrl = url;
    this.previewTaskId = this.bgTasks.find(
      (t) => t.status === 'running' && t.primaryUrl === url,
    )?.id ?? null;
    this.previewOpen = true;
    this.ensureBgPolling();
    this.notify(true);
  }

  closePreview(): void {
    this.previewOpen = false;
    this.previewTaskId = null;
    this.notify(true);
  }

  setPreviewUrl(url: string): void {
    const trimmed = url.trim();
    if (!trimmed) return;
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    this.previewUrl = normalized;
    this.previewTaskId = this.bgTasks.find(
      (t) => t.primaryUrl === normalized || t.urls.includes(normalized),
    )?.id ?? null;
    this.notify(true);
  }

  setPreviewViewport(v: PreviewViewport): void {
    this.previewViewport = v;
    this.notify();
  }

  togglePreviewFollow(): void {
    this.previewFollow = !this.previewFollow;
    this.notify();
  }

  setPreviewWidth(w: number): void {
    this.previewWidth = Math.min(Math.max(w, 300), Math.floor(window.innerWidth * 0.7));
    this.notify();
  }

  openExternalUrl(url: string): void {
    void this.client
      .openUrl?.(url)
      .catch((err) => this.showToast(err instanceof Error ? err.message : String(err), 'err'));
  }

  get previewTask(): BackgroundTaskInfo | null {
    return (this.previewTaskId ? this.bgTasks.find((t) => t.id === this.previewTaskId) : null) ?? null;
  }

  /** 展开/折叠一个回合 */
  toggleTurn(turnId: string): void {
    const turn = this.items.find(
      (i): i is TurnItem => i.kind === 'turn' && i.id === turnId,
    );
    if (turn) {
      turn.collapsed = !turn.collapsed;
      this.notify(true);
    }
  }

  async setMode(mode: ApprovalMode): Promise<void> {
    this.mode = mode;
    if (this.activeId) await this.client.setApprovalMode(this.activeId, mode);
    this.notify();
  }

  async loadSettings(): Promise<Settings> {
    this.settings = await this.client.getSettings();
    this.notify();
    return this.settings;
  }

  async saveSettings(patch: Partial<Settings>): Promise<void> {
    this.settings = await this.client.updateSettings(patch);
    this.notify();
  }

  /**
   * 接受引擎返回的最新设置（如信任授权后由引擎写回）。
   * 授权类操作的唯一事实来源是引擎，UI 只负责回读，不自行推导。
   */
  applySettings(next: Settings): void {
    this.settings = next;
    this.notify();
  }

  /** 用系统文件管理器打开路径 */
  openPath(path: string): void {
    void this.client.openPath(path).catch(() => {/* 静默：路径可能不存在 */});
  }

  /** 按设置的默认方式打开工作区（explorer / vscode） */
  openWorkspace(path: string): void {
    if ((this.settings?.openWorkspaceWith ?? 'explorer') === 'vscode') {
      void this.openInVscode(path);
    } else {
      this.openPath(path);
    }
  }

  /** 用 VS Code 打开目录；未安装时 toast 提示 */
  async openInVscode(path: string): Promise<void> {
    try {
      await this.client.openInVscode(path);
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  }

  /** Agent 回合结束后发桌面通知（窗口在后台且设置开启时才发，出错时文案区分） */
  private sendDesktopNotification(hadError: boolean, sessionId?: string): void {
    if (document.hasFocus()) return;
    if (this.settings?.desktopNotify === false) return;
    const session = this.sessions.find((s) => s.id === (sessionId ?? this.activeId));
    const title = session?.title ?? (hadError ? '任务出错' : '任务完成');
    void this.client
      .notify(hadError ? 'EasyCode — 任务出错' : 'EasyCode — Agent 完成', title)
      .catch(() => {/* 通知失败不影响主流程 */});
  }

  toastKind: 'ok' | 'err' = 'ok';
  showToast(message: string, kind: 'ok' | 'err' = 'ok'): void {
    this.toastKind = kind;
    this.toast = message;
    this.notify();
    setTimeout(() => {
      if (this.toast === message) {
        this.toast = null;
        this.notify();
      }
    }, 3000);
  }

  /* ---------------- 事件归约 ---------------- */

  currentTurn: TurnItem | null = null;

  handleEvent(event: AgentEvent): void {
    if (this.activeId) {
      this.handleSessionEvent(this.activeId, event);
    }
  }

  private handleSessionEvent(sessionId: string, event: AgentEvent): void {
    const state = this.getOrCreateSessionState(sessionId);
    const isActive = sessionId === this.activeId;

    switch (event.type) {
      case 'assistant_start':
        if (isActive) this.flushPendingNotify();
        state.running = true;
        state.status = 'running';
        this.flushAssistantInState(state);
        state.currentAssistant = { kind: 'assistant', id: this.nextId(), blocks: [] };
        if (isActive) {
          this.syncActiveState(state);
          this.notify(true);
        } else {
          this.notify(false);
        }
        break;

      case 'text_delta': {
        const item = this.ensureAssistantInState(state);
        this.appendToBlockInState(state, item, 'text', event.delta);
        if (isActive) {
          this.scheduleNotify();
        }
        break;
      }

      case 'reasoning_delta': {
        const item = this.ensureAssistantInState(state);
        this.appendToBlockInState(state, item, 'thinking', event.delta);
        if (isActive) {
          this.scheduleNotify();
        }
        break;
      }

      case 'tool_call_start': {
        if (isActive) this.flushPendingNotify();
        this.flushAssistantInState(state);
        if (event.call.name === 'todo_write') {
          const input = event.call.input as { todos?: TodoItem[] } | undefined;
          if (Array.isArray(input?.todos)) {
            state.activeTodos = input.todos;
          }
        }
        this.pushToTurnInState(state, {
          kind: 'tool',
          id: this.nextId(),
          callId: event.call.id,
          name: event.call.name,
          input: event.call.input,
          status: 'running',
          startedAt: Date.now(),
        });
        if (isActive) {
          this.syncActiveState(state);
          this.notify(true);
        }
        break;
      }

      case 'tool_result': {
        if (isActive) this.flushPendingNotify();
        const turn = state.currentTurn;
        if (turn) {
          const tool =
            turn.items.find(
              (i): i is ToolItem => i.kind === 'tool' && i.callId === event.callId && i.status === 'running',
            ) ??
            turn.items.find((i): i is ToolItem => i.kind === 'tool' && i.callId === event.callId);
          if (tool) {
            // 结构化优先：权限规则拒绝 / 用户拒绝都以 approved=false 表达，
            // 不再依赖匹配中文提示文本（文本一改就会把拒绝误判成成功）
            tool.status = event.isError
              ? 'error'
              : event.approved === false || event.content.includes('用户拒绝')
                ? 'denied'
                : 'ok';
            tool.result = event.content;
            tool.durationMs = event.durationMs;
            if (tool.name === 'todo_write' && !event.isError) {
              const input = tool.input as { todos?: TodoItem[] } | undefined;
              if (Array.isArray(input?.todos)) {
                state.activeTodos = input.todos;
              }
            }
          }
        }
        if (isActive) {
          this.syncActiveState(state);
          this.notify(true);
        }
        break;
      }

      case 'approval_request': {
        if (isActive) this.flushPendingNotify();
        this.flushAssistantInState(state);
        state.status = 'waiting';
        // 测试自愈循环（TODOS #39）的审批发生在任何测试事件之前：必须先建立回合容器，
        // 否则审批卡片落到顶层，与随后的测试轮次/修复过程分离成两条时间线，
        // 且 approval_resolved 找不到它（卡片永远停在「等待批准」）
        if (event.toolName === 'test_loop') this.ensureWritableTurnInState(state);
        this.pushToTurnInState(state, {
          kind: 'approval',
          id: this.nextId(),
          requestId: event.requestId,
          name: event.toolName,
          input: event.input,
          reason: event.reason,
          status: 'pending',
        });
        if (isActive) {
          this.syncActiveState(state);
          this.notify(true);
        } else {
          const sessionTitle = this.sessions.find((s) => s.id === sessionId)?.title || '后台会话';
          this.showToast(`[${sessionTitle}] 等待审批: ${event.toolName}`);
          this.notify(false);
        }
        break;
      }

      case 'approval_resolved': {
        if (isActive) this.flushPendingNotify();
        // 同时兼容回合内与顶层条目：旧会话或异常时序下审批卡片可能不在当前回合里，
        // 只查 currentTurn 会让卡片永远停在「等待批准」
        const approval =
          state.currentTurn?.items.find(
            (i): i is ApprovalItem => i.kind === 'approval' && i.requestId === event.requestId,
          ) ??
          state.items.find(
            (i): i is ApprovalItem => i.kind === 'approval' && i.requestId === event.requestId,
          );
        if (approval) approval.status = event.approved ? 'approved' : 'denied';
        if (state.running) {
          state.status = 'running';
        }
        if (isActive) {
          this.syncActiveState(state);
          this.notify(true);
        } else {
          this.notify(false);
        }
        break;
      }

      case 'step_end':
        state.lastUsage = event.usage ?? null;
        if (event.sessionUsage) {
          state.sessionUsage = {
            input: event.sessionUsage.input,
            output: event.sessionUsage.output,
            steps: event.sessionUsage.steps,
            cached: event.sessionUsage.cached ?? 0,
          };
        }
        if (isActive) {
          this.syncActiveState(state);
          this.notify(false);
        }
        break;

      case 'context_compacted':
        if (isActive) {
          this.flushPendingNotify();
          this.showToast(`[系统] ${event.summary}`);
          void this.selectSession(sessionId);
        }
        break;

      case 'background_task': {
        // TODOS #37：后台任务状态变化——不进回合时间线，只更新任务条/抽屉/预览的数据源
        const tasks = state.bgTasks;
        const idx = tasks.findIndex((t) => t.id === event.task.id);
        if (idx === -1) {
          tasks.push(event.task);
        } else {
          tasks[idx] = event.task;
        }
        if (isActive) {
          this.bgTasks = [...tasks];
          this.ensureBgPolling();
          this.notify(false);
        } else if (event.action === 'started') {
          const sessionTitle = this.sessions.find((s) => s.id === sessionId)?.title || '后台会话';
          this.showToast(`[${sessionTitle}] 启动后台任务: ${event.task.command.slice(0, 40)}`);
          this.notify(false);
        }
        break;
      }

      case 'test_run_start': {
        // TODOS #39：测试自愈循环单轮开始——进入回合时间线，不占用工具卡片
        if (isActive) this.flushPendingNotify();
        this.flushAssistantInState(state);
        // 显式保证可写回合存在：/test-loop 不经 send() 启动，没有回合容器时条目会丢失
        this.ensureWritableTurnInState(state);
        this.pushToTurnInState(state, {
          kind: 'testrun',
          id: this.nextId(),
          round: event.round,
          maxRounds: event.maxRounds,
          command: event.command,
          source: event.source,
          focus: event.focus,
          status: 'running',
        });
        if (isActive) {
          this.syncActiveState(state);
          this.turnAtBottom = true;
          this.notify(true);
        } else {
          this.notify(false);
        }
        break;
      }

      case 'test_run_result': {
        if (isActive) this.flushPendingNotify();
        const item = this.findTestRunItemInState(state, event.round);
        if (item) {
          item.status = event.ok ? 'passed' : 'failed';
          item.exitCode = event.exitCode;
          item.durationMs = event.durationMs;
          item.summary = event.summary;
          item.outputTail = event.outputTail;
        }
        if (isActive) {
          this.syncActiveState(state);
          this.notify(true);
        }
        break;
      }

      case 'test_loop_done': {
        if (isActive) this.flushPendingNotify();
        // 循环收敛：折叠本轮自愈回合并复位运行态（最后一轮测试后可能没有后续 done 事件）
        const hadError = state.currentTurn?.items.some((i) => i.kind === 'error') ?? false;
        if (hadError) state.status = 'error';
        this.closeTurnInState(state);
        if (isActive) {
          this.syncActiveState(state);
          this.turnAtBottom = true;
          void this.refreshCheckpoints(sessionId);
          this.fileTreeRefreshTick++;
          this.notify(true);
          if (event.reason === 'passed') {
            this.showToast(`✓ 测试自愈完成：第 ${event.rounds} 轮全部通过`);
          } else if (event.reason === 'max_rounds') {
            this.showToast(`测试仍有失败：已达 ${event.rounds} 轮自愈上限，请人工介入`, 'err');
          } else if (event.reason === 'error') {
            this.showToast(event.message ?? '测试自愈循环异常中断', 'err');
          } else if (event.message) {
            this.showToast(event.message);
          }
        } else if (event.reason === 'passed') {
          const sessionTitle = this.sessions.find((s) => s.id === sessionId)?.title || '后台会话';
          this.showToast(`[${sessionTitle}] 测试自愈完成（${event.rounds} 轮）`);
          this.notify(false);
        }
        break;
      }

      case 'error':
        if (isActive) this.flushPendingNotify();
        this.flushAssistantInState(state);
        this.pushToTurnInState(state, { kind: 'error', id: this.nextId(), message: event.message });
        state.status = 'error';
        if (isActive) {
          this.syncActiveState(state);
          this.notify(true);
        } else {
          this.notify(false);
        }
        break;

      case 'done':
        if (isActive) this.flushPendingNotify();
        this.flushAssistantInState(state);
        if (state.currentTurn) {
          state.currentTurn.durationMs = Date.now() - state.currentTurn.startedAt;
          state.currentTurn.collapsed = true;
          const hadError = state.currentTurn.items.some((i) => i.kind === 'error');
          state.currentTurn = null;
          state.running = false;
          state.status = hadError ? 'error' : 'idle';
          this.sendDesktopNotification(hadError, sessionId);
          void this.refreshCheckpoints(sessionId);
          this.fileTreeRefreshTick++;
        } else {
          state.running = false;
          state.status = 'idle';
        }
        if (isActive) {
          this.syncActiveState(state);
          this.turnAtBottom = true;
          this.notify(true);
        } else {
          const sessionTitle = this.sessions.find((s) => s.id === sessionId)?.title || '后台会话';
          this.showToast(`[${sessionTitle}] 任务执行完成`);
          this.notify(false);
        }
        break;
    }
  }

  private ensureAssistantInState(state: SessionViewState): AssistantItem {
    if (!state.currentAssistant) {
      state.currentAssistant = { kind: 'assistant', id: this.nextId(), blocks: [] };
    }
    return state.currentAssistant;
  }

  private appendToBlockInState(
    state: SessionViewState,
    item: AssistantItem,
    type: 'text' | 'thinking',
    delta: string,
  ): void {
    const last = item.blocks.at(-1);
    if (last && last.type === type) last.text += delta;
    else item.blocks.push({ type, text: delta });
    if (state.currentTurn && !state.turnItemSet.has(item)) {
      state.currentTurn.items.push(item);
      state.turnItemSet.add(item);
    }
  }

  private flushAssistantInState(state: SessionViewState): void {
    if (state.currentAssistant && state.currentAssistant.blocks.length > 0) {
      if (state.currentTurn && !state.turnItemSet.has(state.currentAssistant)) {
        state.currentTurn.items.push(state.currentAssistant);
        state.turnItemSet.add(state.currentAssistant);
      }
    }
    state.currentAssistant = null;
  }

  /**
   * 确保存在一个「可写入」的回合容器（TODOS #39）。
   * 测试自愈循环不是经 send() 启动的，没有 user 消息也就没有回合容器；
   * 若条目直接落到顶层，会被 Transcript 的回合聚合渲染过滤掉（历史缺陷：界面全空）。
   * 因此测试轮次与随后的修复过程必须挂进一个显式回合。
   */
  private ensureWritableTurnInState(state: SessionViewState): TurnItem {
    if (state.currentTurn && state.currentTurn.durationMs === undefined) {
      return state.currentTurn;
    }
    const turn: TurnItem = {
      kind: 'turn',
      id: this.nextId(),
      startedAt: Date.now(),
      collapsed: false,
      items: [],
    };
    state.items.push(turn);
    state.currentTurn = turn;
    state.running = true;
    state.status = 'running';
    return turn;
  }

  /** 折叠并关闭当前回合（测试自愈循环收敛时复用 done 的收尾语义） */
  private closeTurnInState(state: SessionViewState): void {
    const turn = state.currentTurn;
    if (!turn) return;
    this.flushAssistantInState(state);
    turn.durationMs = Date.now() - turn.startedAt;
    turn.collapsed = true;
    state.currentTurn = null;
    state.running = false;
    if (state.status !== 'error') state.status = 'idle';
  }

  private pushToTurnInState(state: SessionViewState, item: TurnEntry): void {
    if (state.currentTurn) {
      state.currentTurn.items.push(item);
      state.turnItemSet.add(item);
    } else {
      state.items.push(item);
    }
  }

  /** 定位指定轮次的测试卡片（先查回合内条目，再查顶层条目） */
  private findTestRunItemInState(
    state: SessionViewState,
    round: number,
  ): TestRunItem | undefined {
    for (let i = state.items.length - 1; i >= 0; i--) {
      const entry = state.items[i];
      if (entry.kind === 'testrun' && entry.round === round) return entry;
      if (entry.kind === 'turn') {
        for (let j = entry.items.length - 1; j >= 0; j--) {
          const sub = entry.items[j];
          if (sub.kind === 'testrun' && sub.round === round) return sub;
        }
      }
    }
    return undefined;
  }
}
