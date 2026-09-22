import type { AgentEvent, ApprovalMode, SessionData, SessionMeta, Usage, TodoItem } from '@easycode/core';
import { providerLabel, type ProjectEntry, type Settings } from '@easycode/engine';
import type { AgentClient } from './client.js';

export type ViewBlock = { type: 'text' | 'thinking'; text: string };
export type ViewName = 'chat' | 'settings';
export type SettingsSection = 'models' | 'websearch' | 'general' | 'about';

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

  private listeners = new Set<() => void>();
  private seq = 0;
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
    // 此前放在 init() 且不退订，StrictMode 双挂载会注册两份监听，每个事件处理两遍
    // （表现为工具卡片成对出现、文本增量重复追加），仅 dev 构建可见。
    this.client.onEvent(({ sessionId, event }) => {
      if (sessionId === this.activeId) this.handleEvent(event);
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

  async selectSession(id: string): Promise<void> {
    if (this.running) return;
    this.activeId = id;
    this.view = 'chat';
    this.lastUsage = null;
    this.currentTurn = null;
    const data = await this.client.getSession(id);
    this.items = this.itemsFromSession(data);
    this.activeTodos = data.todos ?? this.extractTodosFromSession(data);
    // 同步该会话实际的审批模式到输入区（新会话用设置默认值）
    try {
      this.mode = await this.client.getApprovalMode(id);
    } catch {
      /* 会话可能刚被删除 */
    }
    this.notify(true);
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
    if (this.running && id === this.activeId) return;
    await this.client.deleteSession(id);
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.activeId === id) {
      this.activeId = null;
      this.items = [];
      if (this.sessions.length > 0) await this.selectSession(this.sessions[0].id);
    }
    this.notify(true);
  }

  /** 从指定节点分叉（Fork）出新会话并自动切换进入 */
  async forkSession(anchor?: { kind: 'beforeUser' | 'afterTurn'; itemId: string }): Promise<void> {
    if (!this.activeId || this.running) return;
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
    if (!this.activeId || this.running || !text.trim()) return;
    this.running = true;
    this.items.push({ kind: 'user', id: this.nextId(), text: text.trim(), ts: Date.now() });
    const turn: TurnItem = {
      kind: 'turn',
      id: this.nextId(),
      startedAt: Date.now(),
      collapsed: false,
      items: [],
    };
    this.items.push(turn);
    this.currentTurn = turn;
    if (this.autoScrollOn) {
      this.scrollTick++;
      this.atBottom = true;
    }
    this.notify(true);
    try {
      await this.client.sendMessage(this.activeId, text.trim());
    } catch (err) {
      const errorItem: ErrorItem = {
        kind: 'error',
        id: this.nextId(),
        message: err instanceof Error ? err.message : String(err),
      };
      if (this.currentTurn) this.currentTurn.items.push(errorItem);
      else this.items.push(errorItem);
      this.running = false;
      this.notify(true);
    }
  }

  /** 编辑最近一条用户消息并重新生成：UI 截断该消息之后的内容，新建回合容器承接流式事件 */
  async editAndResend(userItemId: string, text: string): Promise<void> {
    if (!this.activeId || this.running || !text.trim()) return;
    const idx = this.items.findIndex((i) => i.id === userItemId);
    if (idx === -1) return;
    this.items = this.items
      .slice(0, idx + 1)
      .map((i) => (i.id === userItemId && i.kind === 'user' ? { ...i, text: text.trim() } : i));
    const turn: TurnItem = {
      kind: 'turn',
      id: this.nextId(),
      startedAt: Date.now(),
      collapsed: false,
      items: [],
    };
    this.items.push(turn);
    this.currentTurn = turn;
    this.running = true;
    if (this.autoScrollOn) this.scrollTick++;
    this.notify(true);
    try {
      await this.client.editLastUserMessage(this.activeId, text);
    } catch (err) {
      const errorItem: ErrorItem = {
        kind: 'error',
        id: this.nextId(),
        message: err instanceof Error ? err.message : String(err),
      };
      if (this.currentTurn) this.currentTurn.items.push(errorItem);
      else this.items.push(errorItem);
      this.running = false;
      this.notify(true);
    }
  }

  async respondApproval(requestId: string, approved: boolean): Promise<void> {
    if (!this.activeId) return;
    this.client.respondApproval(this.activeId, requestId, approved);
  }

  async stop(): Promise<void> {
    if (!this.activeId) return;
    await this.client.abort(this.activeId);
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
  private sendDesktopNotification(hadError: boolean): void {
    if (document.hasFocus()) return;
    if (this.settings?.desktopNotify === false) return;
    const session = this.activeSession;
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

  /** 事件产生的条目进入当前回合 */
  private pushToTurn(item: TurnEntry): void {
    if (this.currentTurn) {
      this.currentTurn.items.push(item);
      this.turnItemSet.add(item);
    } else {
      this.items.push(item);
    }
  }

  private findInTurn<T extends TurnEntry>(pred: (i: TurnEntry) => i is T): T | undefined {
    return (this.currentTurn?.items ?? []).find(pred);
  }

  handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'assistant_start':
        this.flushPendingNotify();
        // 开启新的助手消息（懒创建：第一个 delta 到达时再显示，避免空泡）
        this.currentAssistant = { kind: 'assistant', id: this.nextId(), blocks: [] };
        this.notify(true);
        break;
      case 'text_delta': {
        const item = this.ensureAssistant();
        this.appendToBlock(item, 'text', event.delta);
        this.scheduleNotify();
        break;
      }
      case 'reasoning_delta': {
        const item = this.ensureAssistant();
        this.appendToBlock(item, 'thinking', event.delta);
        this.scheduleNotify();
        break;
      }
      case 'tool_call_start': {
        this.flushPendingNotify();
        this.flushAssistant();
        if (event.call.name === 'todo_write') {
          const input = event.call.input as { todos?: TodoItem[] } | undefined;
          if (Array.isArray(input?.todos)) {
            this.activeTodos = input.todos;
          }
        }
        this.pushToTurn({
          kind: 'tool',
          id: this.nextId(),
          callId: event.call.id,
          name: event.call.name,
          input: event.call.input,
          status: 'running',
          startedAt: Date.now(),
        });
        this.notify(true);
        break;
      }
      case 'tool_result': {
        this.flushPendingNotify();
        // 同一回合可能出现相同 callId 的并行调用：优先匹配仍在运行的那张卡片
        const tool =
          this.findInTurn(
            (i): i is ToolItem => i.kind === 'tool' && i.callId === event.callId && i.status === 'running',
          ) ??
          this.findInTurn((i): i is ToolItem => i.kind === 'tool' && i.callId === event.callId);
        if (tool) {
          tool.status = event.isError ? 'error' : event.content.includes('用户拒绝') ? 'denied' : 'ok';
          tool.result = event.content;
          tool.durationMs = event.durationMs;
          if (tool.name === 'todo_write' && !event.isError) {
            const input = tool.input as { todos?: TodoItem[] } | undefined;
            if (Array.isArray(input?.todos)) {
              this.activeTodos = input.todos;
            }
          }
        }
        this.notify(true);
        break;
      }
      case 'approval_request':
        this.flushPendingNotify();
        this.flushAssistant();
        this.pushToTurn({
          kind: 'approval',
          id: this.nextId(),
          requestId: event.requestId,
          name: event.toolName,
          input: event.input,
          status: 'pending',
        });
        this.notify(true);
        break;
      case 'approval_resolved': {
        this.flushPendingNotify();
        const approval = this.findInTurn(
          (i): i is ApprovalItem =>
            i.kind === 'approval' && i.requestId === event.requestId,
        );
        if (approval) approval.status = event.approved ? 'approved' : 'denied';
        this.notify(true);
        break;
      }
      case 'step_end':
        this.lastUsage = event.usage ?? null;
        if (event.sessionUsage) {
          this.sessionUsage = {
            input: event.sessionUsage.input,
            output: event.sessionUsage.output,
            steps: event.sessionUsage.steps,
            cached: event.sessionUsage.cached ?? 0,
          };
        }
        this.notify(false);
        break;
      case 'error':
        this.flushPendingNotify();
        this.flushAssistant();
        this.pushToTurn({ kind: 'error', id: this.nextId(), message: event.message });
        this.notify(true);
        break;
      case 'done':
        this.flushPendingNotify();
        this.flushAssistant();
        if (this.currentTurn) {
          this.currentTurn.durationMs = Date.now() - this.currentTurn.startedAt;
          this.currentTurn.collapsed = true;
          // 回合内出现过错误条目则通知文案区分（loop 保证 error 后必发 done，不会双发）
          const hadError = this.currentTurn.items.some((i) => i.kind === 'error');
          this.currentTurn = null;
          this.running = false;
          this.sendDesktopNotification(hadError);
        } else {
          this.running = false;
        }
        this.notify(true);
        break;
    }
  }

  private currentAssistant: AssistantItem | null = null;

  private ensureAssistant(): AssistantItem {
    if (!this.currentAssistant) {
      this.currentAssistant = { kind: 'assistant', id: this.nextId(), blocks: [] };
    }
    return this.currentAssistant;
  }

  private appendToBlock(
    item: AssistantItem,
    type: 'text' | 'thinking',
    delta: string,
  ): void {
    const last = item.blocks.at(-1);
    if (last && last.type === type) last.text += delta;
    else item.blocks.push({ type, text: delta });
    // 首个内容到达时入列（WeakSet O(1) 判定，避免 N 次数组线性扫描）
    if (this.currentTurn && !this.turnItemSet.has(item)) {
      this.currentTurn.items.push(item);
      this.turnItemSet.add(item);
    }
  }

  /** 当前流式助手消息落盘成普通条目 */
  private flushAssistant(): void {
    if (this.currentAssistant && this.currentAssistant.blocks.length > 0) {
      if (this.currentTurn && !this.turnItemSet.has(this.currentAssistant)) {
        this.currentTurn.items.push(this.currentAssistant);
        this.turnItemSet.add(this.currentAssistant);
      }
    }
    this.currentAssistant = null;
  }
}
