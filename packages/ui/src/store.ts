import type { AgentEvent, ApprovalMode, SessionData, SessionMeta, Usage, TodoItem } from '@easycode/core';
import { providerLabel, type ProjectEntry, type Settings } from '@easycode/engine';
import type { AgentClient } from './client.js';

export type ViewBlock = { type: 'text' | 'thinking'; text: string };
export type ViewName = 'chat' | 'settings';
export type SettingsSection = 'models' | 'websearch' | 'general' | 'reflex' | 'about';

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
  status: 'pending' | 'approved' | 'denied';
};
export type ErrorItem = { kind: 'error'; id: string; message: string };

/** 回合内条目：过程性内容（思考/工具/审批/错误），与顶层用户消息、回合容器相区分 */
export type TurnEntry = AssistantItem | ToolItem | ApprovalItem | ErrorItem;

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
}

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
  gitModalOpen = false;

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

  /** 调度合并通知：在高频流式 delta 时将多帧合并为单次 RAF / 50ms 刷新，消灭每秒几十次的全树重渲 */
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
  }

  async selectSession(id: string): Promise<void> {
    const seq = ++this.selectSeq;
    this.flushPendingNotify();

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
  /** 贴底跟随：true=位于底部跟随输出；用户上翻后为 false，停止跟随 */
  atBottom = true;

  setAtBottom(v: boolean): void {
    if (this.atBottom !== v) {
      this.atBottom = v;
      this.notify(false);
    }
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
      if (this.activeId === id) this.syncActiveState(state);
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
    if (this.autoScrollOn) this.scrollTick++;
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
      if (this.activeId === id) this.syncActiveState(state);
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
      }
    }
    await this.client.abort(id);
    this.notify(true);
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
            tool.status = event.isError ? 'error' : event.content.includes('用户拒绝') ? 'denied' : 'ok';
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
        this.pushToTurnInState(state, {
          kind: 'approval',
          id: this.nextId(),
          requestId: event.requestId,
          name: event.toolName,
          input: event.input,
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
        const turn = state.currentTurn;
        if (turn) {
          const approval = turn.items.find(
            (i): i is ApprovalItem => i.kind === 'approval' && i.requestId === event.requestId,
          );
          if (approval) approval.status = event.approved ? 'approved' : 'denied';
        }
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
        } else {
          state.running = false;
          state.status = 'idle';
        }
        if (isActive) {
          this.syncActiveState(state);
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

  private pushToTurnInState(state: SessionViewState, item: TurnEntry): void {
    if (state.currentTurn) {
      state.currentTurn.items.push(item);
      state.turnItemSet.add(item);
    } else {
      state.items.push(item);
    }
  }
}
