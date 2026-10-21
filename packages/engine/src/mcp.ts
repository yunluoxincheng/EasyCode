import { McpClient, mcpText, MCP_LIMITS, type Host, type JsonSchema, type ToolRegistry, type McpPromptInfo } from '@easycode/core';
import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Ajv2019 } from 'ajv/dist/2019.js';

const validators = new WeakMap<object, ValidateFunction>();
function inputValidator(schema: { type: 'object'; [key: string]: unknown }) {
  let validate = validators.get(schema);
  if (!validate) {
    const options = { strictSchema: true, strictTypes: false, strictTuples: false, strictRequired: false,
      validateFormats: false, coerceTypes: false, removeAdditional: false, useDefaults: false,
      addUsedSchema: false, ownProperties: true };
    const draft = schema.$schema;
    const ajv = draft === undefined || draft === 'https://json-schema.org/draft/2020-12/schema' ? new Ajv2020(options)
      : draft === 'https://json-schema.org/draft/2019-09/schema' ? new Ajv2019(options)
      : draft === 'http://json-schema.org/draft-07/schema#' || draft === 'https://json-schema.org/draft-07/schema#' ? new Ajv(options)
      : undefined;
    if (!ajv) throw new Error('MCP Schema 草案不受支持');
    // MCP 官方服务的头参数来源标记是注解；Stdio 不据此转发 HTTP 头。
    ajv.addKeyword({ keyword: 'x-mcp-header', valid: true });
    // 不加载远程引用；未知关键字、无法解析的引用或无效规格明确拒绝。
    validate = ajv.compile(schema as AnySchema);
    validators.set(schema, validate);
  }
  const check = validate;
  return (input: unknown) => {
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { return { ok: false as const, error: '输入不是合法 JSON' }; }
    }
    if (!input || typeof input !== 'object' || Array.isArray(input) || !check(input)) {
      return { ok: false as const, error: 'MCP 参数不符合工具声明的 JSON Schema' };
    }
    return { ok: true as const, value: input as Record<string, unknown> };
  };
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  cwd?: string;
  enabled?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** 仅引擎持久化使用；公开配置仅返回已保存的变量名。 */
  envRefs?: Record<string, string>;
  envConfigured?: string[];
  /** 写入时显式清除环境变量，不落盘。 */
  clearEnv?: string[];
}

export interface McpServerStatus {
  id: string;
  state: 'disabled' | 'connecting' | 'ready' | 'error';
  toolCount: number;
  promptCount: number;
  error?: string;
}

export interface McpCommand {
  catalogToken: string;
  server: string;
  name: string;
  alias: string;
  kind: 'tool' | 'prompt';
  description: string;
  arguments?: McpPromptInfo['arguments'];
}

/** 只接受用户全局配置；不自动读取工作区中的进程启动配置。 */
export function validateMcpServers(configs: Record<string, McpServerConfig>): void {
  if (!configs || typeof configs !== 'object' || Array.isArray(configs) || Object.keys(configs).length > MCP_LIMITS.servers) {
    throw new Error(`最多配置 ${MCP_LIMITS.servers} 个 MCP 服务`);
  }
  for (const [id, config] of Object.entries(configs)) {
    if (!/^[a-zA-Z0-9_-]{1,20}$/.test(id) || id.includes('__')) throw new Error('MCP 服务名限 1–20 个字母、数字、连字符或单下划线');
    if (config && typeof config === 'object') {
      if ('disabled' in config) throw new Error(`MCP 服务 ${id} 请改用 enabled:false 表示停用，避免误启动`);
      const known = new Set(['command', 'args', 'cwd', 'enabled', 'timeoutMs', 'env', 'envRefs', 'envConfigured', 'clearEnv', 'type']);
      if (Object.keys(config).some((key) => !known.has(key)) || ('type' in config && config.type !== 'stdio')) {
        throw new Error(`MCP 服务 ${id} 包含不支持的字段或远程传输；当前仅支持 Stdio`);
      }
    }
    const validString = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0');
    if (!config || typeof config !== 'object' || !validString(config.command, 2048) || !config.command.trim() ||
        (config.args !== undefined && (!Array.isArray(config.args) || config.args.length > 128 || config.args.some((a) => !validString(a, 8192)))) ||
        (config.cwd !== undefined && !validString(config.cwd, 2048)) ||
        (config.enabled !== undefined && typeof config.enabled !== 'boolean') ||
        (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 5000 || config.timeoutMs > 120000))) {
      throw new Error(`MCP 服务 ${id} 的命令、参数、目录或超时无效`);
    }
    for (const env of [config.env, config.envRefs]) {
      if (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length > 64 ||
          Object.entries(env).some(([name, value]) => ['__proto__', 'constructor', 'prototype'].includes(name) ||
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !validString(value, 16384)))) {
        throw new Error(`MCP 服务 ${id} 的环境变量无效`);
      }
    }
    if (config.clearEnv !== undefined && (!Array.isArray(config.clearEnv) || config.clearEnv.length > 64 ||
        config.clearEnv.some((key) => typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))) {
      throw new Error(`MCP 服务 ${id} 的环境变量清除列表无效`);
    }
  }
}

interface Entry {
  id: string;
  config?: McpServerConfig;
  revision: number;
  status: McpServerStatus;
  client?: McpClient;
  pending: Promise<void>;
}

function alias(server: string, name: string, index: number): string {
  return `mcp__${server}__${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 28)}_${index}`;
}

/** 每个服务的重配串行化；失败连接只有显式重连或配置变化才重试。 */
export class McpManager {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;

  constructor(private readonly host: Host, private readonly resolve: (id: string) => Promise<McpServerConfig>,
    private readonly onChanged: () => void = () => {}) {}

  private changed(): void {
    try { this.onChanged(); } catch { /* 视图订阅故障不影响配置事务或进程清理。 */ }
  }

  sync(configs: Record<string, McpServerConfig>): void {
    if (this.disposed) return;
    for (const id of new Set([...this.entries.keys(), ...Object.keys(configs)])) {
      let entry = this.entries.get(id);
      if (!entry) {
        entry = { id, revision: 0, status: { id, state: 'disabled', toolCount: 0, promptCount: 0 }, pending: Promise.resolve() };
        this.entries.set(id, entry);
      }
      if (JSON.stringify(entry.config) !== JSON.stringify(configs[id])) {
        entry.config = configs[id] ? structuredClone(configs[id]) : undefined;
        this.schedule(entry);
      }
    }
  }

  private schedule(entry: Entry): void {
    const revision = ++entry.revision;
    // 重配立即中断旧初始化/请求，不等握手超时才开始排队清理。
    if (entry.client) void entry.client.close().catch(() => {});
    entry.status = { id: entry.id, state: entry.config?.enabled === false || !entry.config ? 'disabled' : 'connecting', toolCount: 0, promptCount: 0 };
    entry.pending = entry.pending.catch(() => {}).then(async () => {
      if (entry.revision !== revision) return;
      try {
        // 关闭失败时保留句柄，禁止启动新一代进程掩盖旧进程。
        if (entry.client) { await entry.client.close(); entry.client = undefined; }
        if (entry.revision !== revision) return;
        if (!entry.config || entry.config.enabled === false || this.disposed) {
          entry.status = { id: entry.id, state: 'disabled', toolCount: 0, promptCount: 0 };
          if (!entry.config) this.entries.delete(entry.id);
          return;
        }
        if (!this.host.stdio) throw new Error('此宿主不支持双向管道');
        const config = await this.resolve(entry.id);
        if (revision !== entry.revision || this.disposed) return;
        if (config.cwd && !this.host.paths.isAbsolute(config.cwd)) throw new Error('MCP 工作目录必须是绝对路径');
        const client = new McpClient(this.host.stdio, config.timeoutMs ?? 30000, () => {
          if (entry.client === client && entry.revision === revision) {
            entry.status = { id: entry.id, state: 'error', toolCount: 0, promptCount: 0, error: '连接中断或协议错误，请手动重连' };
            this.changed();
          }
        }, () => {
          if (entry.client !== client || entry.revision !== revision) return;
          try { for (const tool of client.tools) inputValidator(tool.inputSchema); }
          catch {
            entry.status = { id: entry.id, state: 'error', toolCount: 0, promptCount: 0, error: 'MCP 工具 Schema 不受支持或无效，请检查服务规格后重连' };
            void client.close().catch(() => {});
          }
          this.changed();
        });
        entry.client = client;
        await client.connect({ command: config.command, args: config.args ?? [], cwd: config.cwd || this.host.env.dataDir(), env: config.env });
        for (const tool of client.tools) inputValidator(tool.inputSchema);
        if (revision === entry.revision && !this.disposed) {
          entry.status = { id: entry.id, state: 'ready', toolCount: client.tools.length, promptCount: client.prompts.length };
          this.changed();
        }
      } catch {
        if (entry.revision === revision && entry.status.state !== 'error') entry.status = {
          id: entry.id, state: 'error', toolCount: 0, promptCount: 0,
          error: '连接或清理失败，请检查命令、参数、绝对工作目录和环境凭据后手动重连',
        };
        this.changed();
      }
    });
    this.changed();
  }

  statuses(): McpServerStatus[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.status,
      ...(entry.status.state === 'ready' && entry.client
        ? { toolCount: entry.client.tools.length, promptCount: entry.client.prompts.length } : {}),
    }));
  }

  async retry(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('未配置的 MCP 服务');
    this.schedule(entry);
    await entry.pending;
  }

  commands(): McpCommand[] {
    return [...this.entries.values()].flatMap((entry) => entry.status.state !== 'ready' || !entry.client ? [] : [
      ...entry.client.tools.map((tool, index) => ({ server: entry.id, name: tool.name,
        catalogToken: `${entry.revision}:${entry.client!.catalogVersion}`,
        alias: alias(entry.id, tool.name, index), kind: 'tool' as const, description: (tool.description ?? tool.name).slice(0, 1000) })),
      ...entry.client.prompts.map((prompt, index) => ({ server: entry.id, name: prompt.name,
        catalogToken: `${entry.revision}:${entry.client!.catalogVersion}`,
        alias: `mcp-prompt-${entry.id}-${index}`, kind: 'prompt' as const,
        description: (prompt.description ?? prompt.name).slice(0, 1000), arguments: prompt.arguments })),
    ]);
  }

  async prompt(server: string, name: string, args: Record<string, string>, token: string): Promise<string> {
    const entry = this.entries.get(server);
    const client = entry?.client;
    const spec = client?.prompts.find((p) => p.name === name);
    if (!entry || entry.status.state !== 'ready' || !client || !spec) throw new Error('MCP Prompt 当前不可用');
    if (token !== `${entry.revision}:${client.catalogVersion}`) throw new Error('MCP Prompt 目录已变化，请重新选择');
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.values(args).some((v) => typeof v !== 'string' || v.length > 8192) || Object.keys(args).length > 16) {
      throw new Error('MCP Prompt 参数无效');
    }
    for (const arg of spec.arguments ?? []) if (arg.required && (!Object.hasOwn(args, arg.name) || !args[arg.name])) {
      throw new Error(`请填写 Prompt 参数：${arg.name}`);
    }
    const revision = entry.revision;
    const catalog = client.catalogVersion;
    const result = await client.request('prompts/get', { name, arguments: args }) as { messages?: unknown[] };
    if (entry.revision !== revision || entry.client !== client || entry.status.state !== 'ready' || client.catalogVersion !== catalog) throw new Error('MCP 配置已变化，请重新选择');
    if (!Array.isArray(result?.messages) || result.messages.length > 64) throw new Error('MCP Prompt 结果无效');
    return result.messages.map((message) => {
      const value = message as { content?: unknown };
      return mcpText({ content: [value.content] });
    }).join('\n\n').slice(0, 65_536);
  }

  async register(registry: ToolRegistry, signal?: AbortSignal): Promise<void> {
    const waiting = Promise.all([...this.entries.values()].map((entry) => entry.pending));
    await waitFor(waiting, signal);
    const enabled = [...this.entries.values()].filter((entry) => entry.status.state === 'ready' && entry.client);
    const count = enabled.reduce((sum, entry) => sum + entry.client!.tools.length, 0);
    if (registry.listSpecs().length + count > 128) throw new Error('含内置工具的总数超过 128，请停用不需要的 MCP 服务');
    if (enabled.reduce((sum, entry) => sum + new TextEncoder().encode(JSON.stringify(entry.client!.tools)).byteLength, 0) > 524288) {
      throw new Error('MCP 工具规格总量超过 512 KiB，请停用不需要的服务');
    }
    for (const entry of this.entries.values()) {
      const client = entry.client;
      if (entry.status.state !== 'ready' || !client) continue;
      const revision = entry.revision;
      const catalog = client.catalogVersion;
      client.tools.forEach((tool, index) => registry.register({
        spec: { name: alias(entry.id, tool.name, index),
          description: `[MCP:${entry.id}] ${tool.name}\n${(tool.description ?? '').slice(0, 4000)}`,
          parameters: tool.inputSchema as JsonSchema },
        sensitive: true, requiresWorkspace: false,
        validateInput: inputValidator(tool.inputSchema),
        execute: async (input, ctx) => {
          if (entry.revision !== revision || entry.client !== client || entry.status.state !== 'ready' || client.catalogVersion !== catalog) {
            throw new Error('MCP 连接或配置已变化，请重新发起调用');
          }
          const result = await client.request('tools/call', { name: tool.name, arguments: input }, ctx.signal);
          if (entry.revision !== revision || entry.client !== client || entry.status.state !== 'ready' || client.catalogVersion !== catalog) {
            throw new Error('MCP 连接已变化，过期结果已丢弃');
          }
          return mcpText(result);
        },
      }));
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const entry of this.entries.values()) { entry.config = undefined; this.schedule(entry); }
    await Promise.all([...this.entries.values()].map((entry) => entry.pending));
    if ([...this.entries.values()].some((entry) => entry.client)) throw new Error('MCP 进程清理未完成，可重试');
  }
}

function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
