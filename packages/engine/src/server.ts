import {
  AgentEvent,
  ApprovalManager,
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
  createBuiltinTools,
  type ApprovalMode,
} from '@easycode/core';
import { Settings, DEFAULT_SETTINGS, PROVIDER_PRESETS } from './settings.js';
import type { ProviderEntry, ProviderModel } from './settings.js';
import { buildSystemPrompt } from './prompts.js';

export interface CreateSessionOptions {
  /** 可选：不填则创建纯对话会话，之后可随时绑定 */
  workspaceRoot?: string;
  providerId: string;
  model?: string;
  title?: string;
}

interface SessionRuntime {
  data: SessionData;
  approval: ApprovalManager;
  controller?: AbortController;
  running: boolean;
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
  private settings: Settings = structuredClone(DEFAULT_SETTINGS);
  private settingsLoaded = false;

  constructor(private readonly host: Host) {}

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

  async listSessions(): Promise<SessionMeta[]> {
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
    return rt.data;
  }

  async deleteSession(id: string): Promise<void> {
    this.abort(id);
    this.sessions.delete(id);
    try {
      await this.host.fs.unlink?.(this.sessionFile(id));
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
    if (rt.running) throw new Error('会话正在运行中，请先等待完成或点击停止');
    const content = text.trim();
    if (!content) throw new Error('消息为空');
    if (rt.data.messages.length === 0) {
      rt.data.meta.title = content.slice(0, 30) + (content.length > 30 ? '…' : '');
    }
    rt.data.messages.push({ role: 'user', content });
    rt.data.meta.updatedAt = new Date().toISOString();

    rt.running = true;
    rt.controller = new AbortController();
    try {
      const entry = this.settings.providers[rt.data.meta.providerId];
      const firstEnabled = (entry?.models ?? []).find((m) => m.enabled !== false)?.name ?? 'default';
      const provider = this.createProvider(
        rt.data.meta.providerId,
        rt.data.meta.model || firstEnabled,
      );
      const result = await runAgentLoop({
        provider,
        tools: createBuiltinTools(),
        host: this.host,
        workspace: rt.data.meta.workspaceRoot,
        systemPrompt: buildSystemPrompt(this.host, rt.data.meta.workspaceRoot),
        messages: rt.data.messages,
        signal: rt.controller.signal,
        approval: rt.approval,
        emit: this.emitterFor(id),
        reasoningEffort: rt.data.meta.reasoningEffort ?? '',
      });
      if (result.reason === 'error' && result.errorMessage) {
        this.events.emit({ sessionId: id, event: { type: 'error', message: result.errorMessage } });
      }
    } finally {
      rt.running = false;
      rt.controller = undefined;
      rt.data.meta.updatedAt = new Date().toISOString();
      await this.persistSession(rt);
    }
  }

  respondApproval(id: string, requestId: string, approved: boolean): void {
    this.requireSession(id).approval.resolve(requestId, approved);
  }

  abort(id: string): void {
    const rt = this.sessions.get(id);
    if (!rt) return;
    rt.approval.denyAll();
    rt.controller?.abort();
  }

  isRunning(id: string): boolean {
    return this.sessions.get(id)?.running ?? false;
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
    if (rt.running) throw new Error('会话运行中，暂不能切换模型');
    rt.data.meta.model = model.trim();
    rt.data.meta.updatedAt = new Date().toISOString();
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
    if (ws) {
      const stat = await this.host.fs.stat(ws);
      if (!stat || !stat.isDirectory) {
        throw new Error(`工作区不存在或不是目录: ${ws}`);
      }
    }
    rt.data.meta.workspaceRoot = ws;
    rt.data.meta.updatedAt = new Date().toISOString();
    await this.persistSession(rt);
    return rt.data.meta;
  }

  /* -------------------- 设置 -------------------- */

  async getSettings(): Promise<Settings> {
    await this.ensureSettings();
    return this.settings;
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    await this.ensureSettings();
    this.settings = {
      ...this.settings,
      ...patch,
      // UI 总是提交全量 providers map，整体替换（按 key 合并会让"删除供应商"失效）
      providers: patch.providers ? { ...patch.providers } : this.settings.providers,
    };
    await this.host.fs.mkdir(this.host.env.dataDir(), { recursive: true });
    await this.host.fs.writeFile(this.settingsFile(), JSON.stringify(this.settings, null, 2));
    return this.settings;
  }

  /* -------------------- 内部 -------------------- */

  private createProvider(providerId: string, model: string): Provider {
    const entry = this.settings.providers[providerId];
    if (!entry) throw new Error(`未配置的 Provider: ${providerId}，请在设置中检查`);
    switch (entry.kind) {
      case 'mock':
        return new MockProvider(providerId);
      case 'anthropic':
        return new AnthropicProvider(providerId, { ...entry, model });
      case 'responses':
        return new ResponsesProvider(providerId, { ...entry, model });
      case 'openai-compatible':
      default:
        return new OpenAICompatibleProvider(providerId, { ...entry, model });
    }
  }

  /** 从供应商 API 拉取可用模型 ID（OpenAI 兼容 /models、Anthropic /v1/models） */
  async listProviderModels(providerId: string): Promise<string[]> {
    await this.ensureSettings();
    const entry = this.settings.providers[providerId];
    if (!entry) throw new Error(`未配置的模型服务: ${providerId}`);
    if (entry.kind === 'mock') return ['mock-1'];
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
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (data.data ?? [])
      .map((m) => m.id)
      .filter((x): x is string => !!x)
      .sort();
    if (ids.length === 0) throw new Error('供应商返回了空的模型列表');
    return ids;
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

  private async persistSession(rt: SessionRuntime): Promise<void> {
    await this.host.fs.mkdir(this.sessionsDir(), { recursive: true });
    await this.host.fs.writeFile(this.sessionFile(rt.data.meta.id), JSON.stringify(rt.data));
  }

  private async ensureSettings(): Promise<void> {
    if (this.settingsLoaded) return;
    try {
      const raw = await this.host.fs.readFile(this.settingsFile());
      const stored = JSON.parse(raw) as Settings;
      this.settings = this.migrateSettings(stored);
    } catch {
      this.settings = structuredClone(DEFAULT_SETTINGS);
    }
    this.settingsLoaded = true;
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
}
