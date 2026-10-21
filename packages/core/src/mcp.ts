import type { StdioHost, StdioLaunchOptions, StdioTransport } from './host.js';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
}
export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void };
const MAX_FRAME = 1_048_576;
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_LIMITS = { servers: 8, tools: 128, prompts: 64 } as const;

/** 纯协议客户端：无平台 API、无第三方运行时；远端错误不进入诊断日志。 */
export class McpClient {
  private transport?: StdioTransport;
  private closed = false;
  private buffer = '';
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  private writes: Promise<void> = Promise.resolve();
  private queuedWrites = 0;
  private capabilities: Record<string, unknown> = {};
  private refreshing?: Promise<void>;
  tools: McpToolInfo[] = [];
  catalogVersion = 0;
  prompts: McpPromptInfo[] = [];

  constructor(
    private readonly host: StdioHost,
    private readonly timeoutMs = 30_000,
    private readonly onFailure: () => void = () => {},
    private readonly onCatalogChange: () => void = () => {},
  ) {}

  async connect(options: StdioLaunchOptions): Promise<void> {
    try {
      this.transport = await this.host.open(options, {
        stdout: (chunk) => this.receive(chunk),
        stderr: () => {}, // stderr 可含凭据；只排空，不存储、不展示。
        exit: () => this.fail('MCP 进程已退出'),
      });
      if (this.closed) { await this.close(); throw new Error('MCP 进程在初始化前退出'); }
      const result = await this.request('initialize', {
        protocolVersion: VERSIONS[0], capabilities: {},
        clientInfo: { name: 'EasyCode', version: '1' },
      }) as { protocolVersion?: string; capabilities?: Record<string, unknown> };
      if (!result || !VERSIONS.includes(result.protocolVersion ?? '') || !result.capabilities ||
          typeof result.capabilities !== 'object' || Array.isArray(result.capabilities)) {
        throw new Error('MCP 握手版本或能力不兼容');
      }
      this.capabilities = result.capabilities;
      await this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await this.refresh();
    } catch {
      this.fail('MCP 连接或初始化失败');
      throw new Error('MCP 连接或初始化失败，请检查命令、参数及环境配置');
    }
  }

  private send(message: unknown): Promise<void> {
    if (this.closed || !this.transport) return Promise.reject(new Error('MCP 连接已关闭'));
    if (this.queuedWrites >= 32) return Promise.reject(new Error('MCP 写入队列已满'));
    const encoded = JSON.stringify(message);
    if (encoded.length > MAX_FRAME || new TextEncoder().encode(encoded).byteLength > MAX_FRAME) return Promise.reject(new Error('MCP 消息超过大小限制'));
    const transport = this.transport;
    this.queuedWrites++;
    const task = this.writes.catch(() => {}).then(() => {
      if (this.closed) throw new Error('MCP 连接已关闭');
      return transport.write(`${encoded}\n`);
    });
    this.writes = task;
    return task.finally(() => { this.queuedWrites--; });
  }

  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    if (this.closed || this.pending.size >= 32) return Promise.reject(new Error('MCP 连接不可用或请求已满'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: unknown) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => {
        finish(new DOMException('Aborted', 'AbortError'));
        void this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }).catch(() => {});
      };
      const timer = setTimeout(() => {
        finish(new Error(`MCP 请求超时：${method}`));
        this.fail('MCP 请求超时，请手动重连');
      }, this.timeoutMs);
      this.pending.set(id, { resolve: (value) => finish(undefined, value), reject: (error) => finish(error) });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      void this.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
        .catch(() => { finish(new Error('MCP 消息发送失败')); this.fail('MCP 消息发送失败'); });
    });
  }

  private receive(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    if (this.buffer.length > MAX_FRAME) { this.fail('MCP 接收缓冲超限'); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        if (!messages.length || messages.length > 32) throw new Error('batch');
        for (const message of messages) this.message(message);
      } catch { this.fail('MCP 返回无效协议消息'); return; }
    }
  }

  private message(value: unknown): void {
    if (!value || typeof value !== 'object') throw new Error('message');
    const message = value as Record<string, unknown>;
    if (message.jsonrpc !== '2.0') throw new Error('version');
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        if (typeof message.id !== 'string' && typeof message.id !== 'number') throw new Error('request id');
        void this.send({ jsonrpc: '2.0', id: message.id, ...(message.method === 'ping'
          ? { result: {} } : { error: { code: -32601, message: 'Client capability not supported' } }) }).catch(() => {});
      } else if (message.method === 'notifications/tools/list_changed' || message.method === 'notifications/prompts/list_changed') {
        void this.refresh().catch(() => this.fail('MCP 列表刷新失败'));
      }
      return;
    }
    if (typeof message.id !== 'number') return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return; // 超时或取消后的迟到结果不得重新生效。
    if ('error' in message) waiter.reject(new Error('MCP 服务拒绝请求'));
    else if ('result' in message) waiter.resolve(message.result);
    else throw new Error('response');
  }

  private async list(method: string, field: string, limit: number): Promise<unknown[]> {
    const values: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.request(method, cursor ? { cursor } : {}) as Record<string, unknown>;
      if (!page || !Array.isArray(page[field])) throw new Error('MCP 列表格式无效');
      values.push(...page[field]);
      if (values.length > limit) throw new Error('MCP 列表超过数量限制');
      if (new TextEncoder().encode(JSON.stringify(values)).byteLength > 524288) throw new Error('MCP 目录规格超过大小限制');
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
      if (cursor && (cursors.has(cursor) || cursors.size >= 16)) throw new Error('MCP 分页游标无效');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return values;
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const tools = this.capabilities.tools ? await this.list('tools/list', 'tools', MCP_LIMITS.tools) : [];
      const prompts = this.capabilities.prompts ? await this.list('prompts/list', 'prompts', MCP_LIMITS.prompts) : [];
      const names = new Set<string>();
      for (const raw of tools) {
        const tool = raw as McpToolInfo;
        if (!tool || typeof tool.name !== 'string' || !tool.name || tool.name.length > 128 || names.has(tool.name) ||
            !tool.inputSchema || tool.inputSchema.type !== 'object' || JSON.stringify(tool.inputSchema).length > 65_536 ||
            (tool.description !== undefined && typeof tool.description !== 'string')) throw new Error('MCP 工具规格无效');
        names.add(tool.name);
      }
      names.clear();
      for (const raw of prompts) {
        const prompt = raw as McpPromptInfo;
        if (!prompt || typeof prompt.name !== 'string' || !prompt.name || prompt.name.length > 128 || names.has(prompt.name) ||
            (prompt.description !== undefined && typeof prompt.description !== 'string') ||
            (prompt.arguments !== undefined && (!Array.isArray(prompt.arguments) || prompt.arguments.length > 16 ||
              new Set(prompt.arguments.map((arg) => arg?.name)).size !== prompt.arguments.length ||
              prompt.arguments.some((arg) => !arg || typeof arg.name !== 'string' || !arg.name || arg.name.length > 128 ||
                (arg.required !== undefined && typeof arg.required !== 'boolean') ||
                (arg.description !== undefined && typeof arg.description !== 'string'))))) {
          throw new Error('MCP Prompt 规格无效');
        }
        names.add(prompt.name);
      }
      if (this.closed) throw new Error('MCP 连接已关闭');
      const changed = JSON.stringify([this.tools, this.prompts]) !== JSON.stringify([tools, prompts]);
      this.tools = tools as McpToolInfo[];
      this.prompts = prompts as McpPromptInfo[];
      if (changed) {
        this.catalogVersion++;
        try { this.onCatalogChange(); } catch { /* 观察者不控制协议生命周期。 */ }
      }
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = '';
    for (const waiter of [...this.pending.values()]) waiter.reject(new Error(reason));
    try { this.onFailure(); } catch { /* 观察者异常不得阻断管道清理。 */ }
    void this.close().catch(() => {}); // 关闭失败保留 transport，供管理器重试。
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of [...this.pending.values()]) waiter.reject(new Error('MCP 连接已关闭'));
    const transport = this.transport;
    if (transport) {
      await transport.close();
      if (this.transport === transport) this.transport = undefined;
    }
  }
}

/** 当前工具消息模型是文本，禁止把大型二进制编码直接拼进上下文。 */
export function mcpText(result: unknown): string {
  if (!result || typeof result !== 'object') throw new Error('MCP 结果格式无效');
  const value = result as { content?: unknown; structuredContent?: unknown; isError?: boolean };
  const parts: string[] = [];
  if (Array.isArray(value.content)) {
    for (const block of value.content.slice(0, 64)) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text.slice(0, 65_536));
      else if (block.type === 'resource' && typeof block.resource?.text === 'string') parts.push(block.resource.text.slice(0, 65_536));
      else if (block.type === 'resource_link' && typeof block.uri === 'string') parts.push(`资源：${block.uri.slice(0, 2048)}`);
      else parts.push('[ MCP ] 当前仅支持文本与结构化内容，该媒体未展开。');
    }
  }
  if (value.structuredContent !== undefined) parts.push(JSON.stringify(value.structuredContent).slice(0, 65_536));
  const output = parts.join('\n').slice(0, 65_536) || '[ MCP ] 调用已完成，无文本结果。';
  if (value.isError) throw new Error(output);
  return output;
}
