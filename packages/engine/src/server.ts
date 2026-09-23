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
  runWebSearch,
  listFilesRecursively,
  compactHistoryMessages,
  pruneHistoricalToolResults,
  getGitStatus,
  getGitDiff,
  stageGitFiles,
  discardGitChanges,
  splitUnifiedDiff,
  type ApprovalMode,
  type TodoItem,
  type GitStatusSummary,
  type GitFileChange,
  type GitDiffResult,
  type GitDiffOptions,
  NoopDecisionPolicy,
  type DecisionStats,
  type ProjectDecisionTree,
} from '@easycode/core';
import { Settings, DEFAULT_SETTINGS, PROVIDER_PRESETS } from './settings.js';
import type { ModelTestResult, ProviderEntry, ProviderModel, ProviderModelInfo } from './settings.js';
import { loadModelDirectory, resolveModelMeta } from './model-catalog.js';
import { buildSystemPrompt } from './prompts.js';
import { WorkspaceLockManager } from './workspace-lock.js';
import { DecisionStatsManager } from './stats.js';
import { ShadowDecisionPolicy } from './shadow.js';

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
  private readonly workspaceLocks = new WorkspaceLockManager();
  private readonly decisionStats: DecisionStatsManager;
  private settings: Settings = structuredClone(DEFAULT_SETTINGS);
  private settingsLoaded = false;

  constructor(private readonly host: Host) {
    this.decisionStats = new DecisionStatsManager(host);
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
    if (rt.running) {
      throw new Error('原会话正在运行中，请等待完成或停止后再分叉');
    }

    let slicedMessages: ChatMessage[] = [];
    if (options?.beforeUserIndex !== undefined) {
      const targetUserIndex = options.beforeUserIndex;
      if (targetUserIndex <= 0) {
        slicedMessages = [];
      } else {
        let userCount = 0;
        let cutIdx = rt.data.messages.length;
        for (let i = 0; i < rt.data.messages.length; i++) {
          if (rt.data.messages[i].role === 'user') {
            if (userCount === targetUserIndex) {
              cutIdx = i;
              break;
            }
            userCount++;
          }
        }
        slicedMessages = rt.data.messages.slice(0, cutIdx);
      }
    } else if (options?.upToMessageId) {
      const targetId = options.upToMessageId;
      const idx = rt.data.messages.findIndex((m) => m.id === targetId);
      if (idx === -1) {
        slicedMessages = rt.data.messages.slice();
      } else {
        let endIdx = idx + 1;
        while (endIdx < rt.data.messages.length && rt.data.messages[endIdx].role === 'tool_result') {
          endIdx++;
        }
        slicedMessages = rt.data.messages.slice(0, endIdx);
      }
    } else {
      slicedMessages = rt.data.messages.slice();
    }

    const clonedMessages = structuredClone(slicedMessages);
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
        messages: clonedMessages,
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
    if (rt.running) {
      throw new Error('会话正在运行中，请先等待完成或点击停止');
    }

    if (rt.data.messages.length === 0) return rt.data;

    const compRes = compactHistoryMessages(rt.data.messages, {
      keepRecentTurns,
      pruneTools: true,
    });

    if (compRes.compacted) {
      rt.data.messages = compRes.messages;
      const latestTodos = extractLatestTodos(rt.data.messages);
      if (latestTodos) {
        rt.data.todos = structuredClone(latestTodos);
      }
      rt.data.meta.updatedAt = new Date().toISOString();
      await this.persistSession(rt);
    } else {
      // 即使轮数未超过 keepRecentTurns，也对历史旧工具的长输出执行折叠压缩
      const pruneRes = pruneHistoricalToolResults(rt.data.messages, { keepRecentTurns: 1 });
      if (pruneRes.modified) {
        rt.data.meta.updatedAt = new Date().toISOString();
        await this.persistSession(rt);
      }
    }
    return rt.data;
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
      await this.decisionStats.deleteSessionRecords(id);
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
    rt.data.messages.push({
      role: 'user',
      content,
      id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
    });
    rt.data.meta.updatedAt = new Date().toISOString();
    await this.runTurn(rt);
  }

  /** 编辑最近一条用户消息：替换文本、丢弃其后的内容并重新生成 */
  async editLastUserMessage(id: string, text: string): Promise<void> {
    const rt = this.requireSession(id);
    if (rt.running) throw new Error('会话正在运行中，请先等待完成或点击停止');
    const content = text.trim();
    if (!content) throw new Error('消息为空');
    let idx = -1;
    for (let i = rt.data.messages.length - 1; i >= 0; i--) {
      if (rt.data.messages[i].role === 'user') {
        idx = i;
        break;
      }
    }
    if (idx === -1) throw new Error('会话中没有用户消息');
    const old = rt.data.messages[idx] as {
      role: 'user';
      content: string;
      id?: string;
      createdAt?: string;
    };
    rt.data.messages[idx] = { role: 'user', content, id: old.id, createdAt: old.createdAt };
    rt.data.messages = rt.data.messages.slice(0, idx + 1);
    rt.data.meta.updatedAt = new Date().toISOString();
    await this.runTurn(rt);
  }

  /** 执行一轮 Agent（消息由调用方先行构造；负责运行态与持久化） */
  private async runTurn(rt: SessionRuntime): Promise<void> {
    const id = rt.data.meta.id;
    rt.running = true;
    rt.controller = new AbortController();
    let wireMessages: ChatMessage[] | undefined;
    try {
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
      const provider = this.createProvider(rt.data.meta.providerId, model, useNativeSearch);
      const webSearchCfg = this.settings.webSearch;
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
      wireMessages =
        caps.includes('system') || !systemPrompt
          ? rt.data.messages
          : mergeSystemIntoUser(rt.data.messages, systemPrompt);

      // 装配微型决策策略（TODOS #40：Shadow Mode 旁路观测）
      const policy = new ShadowDecisionPolicy(
        new NoopDecisionPolicy(),
        this.decisionStats,
        {
          sessionId: rt.data.meta.id,
          sessionTitle: rt.data.meta.title,
          workspaceRoot: rt.data.meta.workspaceRoot,
        },
      );

      const result = await runAgentLoop({
        provider,
        tools: builtinTools,
        host: this.host,
        workspace: rt.data.meta.workspaceRoot,
        systemPrompt: caps.includes('system') ? systemPrompt : '',
        messages: wireMessages,
        signal: rt.controller.signal,
        approval: rt.approval,
        policy,
        emit: (event) => {
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
          this.emitterFor(id)(event);
        },
        reasoningEffort: rt.data.meta.reasoningEffort ?? '',
        shell: this.settings.shell ?? 'auto',
        maxSteps: this.settings.maxSteps ?? 200,
        contextWindow: autoCompact ? contextWindow : undefined,
        autoCompactThreshold: compactThreshold,
        workspaceLock: rt.data.meta.workspaceRoot
          ? this.workspaceLocks.getLock(rt.data.meta.workspaceRoot)
          : undefined,
      });
      if (result.reason === 'error' && result.errorMessage) {
        this.events.emit({ sessionId: id, event: { type: 'error', message: result.errorMessage } });
      }
    } finally {
      if (wireMessages && wireMessages !== rt.data.messages) {
        rt.data.messages = wireMessages;
      }
      rt.running = false;
      rt.controller = undefined;
      rt.data.meta.updatedAt = new Date().toISOString();
      const latestTodos = extractLatestTodos(rt.data.messages);
      if (latestTodos) {
        rt.data.todos = latestTodos;
      }
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

  /** 会话级 Provider 切换（同时重置模型为该 Provider 第一个启用模型） */
  async setSessionProvider(id: string, providerId: string, model?: string): Promise<SessionMeta> {
    await this.ensureSettings();
    const rt = this.requireSession(id);
    if (rt.running) throw new Error('会话运行中，暂不能切换模型服务');
    const entry = this.settings.providers[providerId];
    if (!entry) throw new Error(`未配置的模型服务: ${providerId}`);
    const enabledModels = (entry.models ?? []).filter((m) => m.enabled !== false).map((m) => m.name);
    rt.data.meta.providerId = providerId;
    rt.data.meta.model = model?.trim() ?? enabledModels[0] ?? '';
    rt.data.meta.reasoningEffort = '';
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

  private createProvider(providerId: string, model: string, nativeWebSearch: boolean): Provider {
    const entry = this.settings.providers[providerId];
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
    const entry = this.settings.providers[providerId];
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
    const entry = this.settings.providers[providerId];
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
    await this.ensureSettings();
    const ws = this.settings.webSearch;
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
      const fullPath = this.host.paths.join(root, rel);
      try {
        const stat = await this.host.fs.stat(fullPath);
        if (stat && !stat.isDirectory) {
          const content = await this.host.fs.readFile(fullPath);
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
        const fullPath = this.host.paths.join(promptsDir, fileName);
        try {
          const content = await this.host.fs.readFile(fullPath);
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

  /** 导出完全兼容 Reflex V1 训练集规范的微调数据集 JSONL */
  async exportDecisionDataset(filter?: { workspaceRoot?: string; sessionId?: string }): Promise<string> {
    return this.decisionStats.exportDataset(filter);
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** 关闭"对话中系统消息"时：把系统提示词并入首条用户消息（不改动存储的会话数组） */
function mergeSystemIntoUser(messages: ChatMessage[], system: string): ChatMessage[] {
  const idx = messages.findIndex((m) => m.role === 'user');
  if (idx === -1) return messages;
  const first = messages[idx];
  const out = [...messages];
  if (first.role === 'user') {
    out[idx] = { role: 'user', content: `${system}\n\n---\n\n${first.content}` };
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
  if (ws.backend === 'tavily') return !!ws.tavilyApiKey?.trim();
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
