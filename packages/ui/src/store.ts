import type { AgentEvent, ApprovalMode, SessionData, SessionMeta, Usage } from '@easycode/core';
import { providerLabel, type ProjectEntry, type Settings } from '@easycode/engine';
import type { AgentClient } from './client.js';

export type ViewBlock = { type: 'text' | 'thinking'; text: string };
export type ViewName = 'chat' | 'settings';
export type SettingsSection = 'models' | 'websearch' | 'general' | 'about';

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; blocks: ViewBlock[] }
  | {
      kind: 'tool';
      id: string;
      callId: string;
      name: string;
      input: unknown;
      status: 'running' | 'ok' | 'error' | 'denied';
      result?: string;
      durationMs?: number;
    }
  | {
      kind: 'approval';
      id: string;
      requestId: string;
      name: string;
      input: unknown;
      status: 'pending' | 'approved' | 'denied';
    }
  | { kind: 'error'; id: string; message: string };

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
  updatePanelOpen = false;

  private listeners = new Set<() => void>();
  private seq = 0;
  /** 快照版本号：每次 notify 递增，供 useSyncExternalStore 感知变化 */
  version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): number => this.version;

  constructor(readonly client: AgentClient) {}

  notify(): void {
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

  /* ---------------- 初始化与加载 ---------------- */

  async init(): Promise<void> {
    this.demoMode = !('easycode' in window) && !('__TAURI_INTERNALS__' in window);
    this.client.onEvent(({ sessionId, event }) => {
      if (sessionId === this.activeId) this.handleEvent(event);
    });
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
    const data = await this.client.getSession(id);
    this.items = this.itemsFromSession(data);
    // 同步该会话实际的审批模式到输入区（新会话用设置默认值）
    try {
      this.mode = await this.client.getApprovalMode(id);
    } catch {
      /* 会话可能刚被删除 */
    }
    this.notify();
  }

  /** 显示名（用户设置的名称优先于 id，如 CPA） */
  providerLabelOf(id: string): string {
    return providerLabel(id, this.settings?.providers[id]);
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
    const toolById = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>();
    for (const msg of data.messages) {
      if (msg.role === 'user') {
        items.push({ kind: 'user', id: this.nextId(), text: msg.content });
      } else if (msg.role === 'assistant') {
        const view: ViewBlock[] = [];
        const toolItems: Extract<TranscriptItem, { kind: 'tool' }>[] = [];
        for (const block of msg.blocks) {
          if (block.type === 'text') view.push({ type: 'text', text: block.text });
          else if (block.type === 'thinking') view.push({ type: 'thinking', text: block.text });
          else if (block.type === 'tool_call') {
            const item: Extract<TranscriptItem, { kind: 'tool' }> = {
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
          items.push({ kind: 'assistant', id: this.nextId(), blocks: view });
        }
        items.push(...toolItems);
      } else {
        const tool = toolById.get(msg.toolCallId);
        if (tool) {
          tool.status = msg.isError ? 'error' : msg.content.includes('用户拒绝') ? 'denied' : 'ok';
          tool.result = msg.content;
        }
      }
    }
    return items;
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

  async deleteSession(id: string): Promise<void> {
    if (this.running && id === this.activeId) return;
    await this.client.deleteSession(id);
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.activeId === id) {
      this.activeId = null;
      this.items = [];
      if (this.sessions.length > 0) await this.selectSession(this.sessions[0].id);
    }
    this.notify();
  }

  async send(text: string): Promise<void> {
    if (!this.activeId || this.running || !text.trim()) return;
    this.running = true;
    this.items.push({ kind: 'user', id: this.nextId(), text: text.trim() });
    this.notify();
    try {
      await this.client.sendMessage(this.activeId, text.trim());
    } catch (err) {
      this.items.push({
        kind: 'error',
        id: this.nextId(),
        message: err instanceof Error ? err.message : String(err),
      });
      this.running = false;
      this.notify();
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

  showToast(message: string): void {
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

  handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'assistant_start':
        // 开启新的助手消息（懒创建：第一个 delta 到达时再显示，避免空泡）
        this.currentAssistant = { kind: 'assistant', id: this.nextId(), blocks: [] };
        break;
      case 'text_delta': {
        const item = this.ensureAssistant();
        this.appendToBlock(item, 'text', event.delta);
        break;
      }
      case 'reasoning_delta': {
        const item = this.ensureAssistant();
        this.appendToBlock(item, 'thinking', event.delta);
        break;
      }
      case 'tool_call_start':
        this.flushAssistant();
        this.items.push({
          kind: 'tool',
          id: this.nextId(),
          callId: event.call.id,
          name: event.call.name,
          input: event.call.input,
          status: 'running',
        });
        break;
      case 'tool_result': {
        const tool = this.items.find(
          (i): i is Extract<TranscriptItem, { kind: 'tool' }> =>
            i.kind === 'tool' && i.callId === event.callId,
        );
        if (tool) {
          tool.status = event.isError ? 'error' : event.content.includes('用户拒绝') ? 'denied' : 'ok';
          tool.result = event.content;
          tool.durationMs = event.durationMs;
        }
        break;
      }
      case 'approval_request':
        this.flushAssistant();
        this.items.push({
          kind: 'approval',
          id: this.nextId(),
          requestId: event.requestId,
          name: event.toolName,
          input: event.input,
          status: 'pending',
        });
        break;
      case 'approval_resolved': {
        const approval = this.items.find(
          (i): i is Extract<TranscriptItem, { kind: 'approval' }> =>
            i.kind === 'approval' && i.requestId === event.requestId,
        );
        if (approval) approval.status = event.approved ? 'approved' : 'denied';
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
        break;
      case 'error':
        this.flushAssistant();
        this.items.push({ kind: 'error', id: this.nextId(), message: event.message });
        break;
      case 'done':
        this.flushAssistant();
        this.running = false;
        break;
    }
    this.notify();
  }

  private currentAssistant: Extract<TranscriptItem, { kind: 'assistant' }> | null = null;

  private ensureAssistant(): Extract<TranscriptItem, { kind: 'assistant' }> {
    if (!this.currentAssistant) {
      this.currentAssistant = { kind: 'assistant', id: this.nextId(), blocks: [] };
    }
    return this.currentAssistant;
  }

  private appendToBlock(
    item: Extract<TranscriptItem, { kind: 'assistant' }>,
    type: 'text' | 'thinking',
    delta: string,
  ): void {
    const last = item.blocks.at(-1);
    if (last && last.type === type) last.text += delta;
    else item.blocks.push({ type, text: delta });
    // 首个内容到达时入列
    if (!this.items.includes(item)) this.items.push(item);
  }

  /** 当前流式助手消息落盘成普通条目 */
  private flushAssistant(): void {
    if (this.currentAssistant && this.currentAssistant.blocks.length > 0) {
      if (!this.items.includes(this.currentAssistant)) this.items.push(this.currentAssistant);
    }
    this.currentAssistant = null;
  }
}
