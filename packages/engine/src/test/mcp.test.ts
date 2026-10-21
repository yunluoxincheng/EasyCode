import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalManager, executeTool, McpClient, MemoryHost, ToolRegistry,
  type McpToolInfo, type StdioHost, type StdioLaunchOptions } from '@easycode/core';
import { McpManager } from '../mcp.js';

/** 确定性协议交错，仅验证契约；不替代真实服务/宿主的功能证据。 */
function protocol(tools: McpToolInfo[]) {
  const state = { tools, prompts: [] as Array<{ name: string }>, lists: 0, calls: [] as unknown[],
    hold: false, release: undefined as (() => void) | undefined };
  let emit: (message: unknown) => void = () => {};
  let notifyList: (() => void) | undefined;
  const stdio: StdioHost = { open: async (_options, events) => {
    emit = (message) => events.stdout(`${JSON.stringify(message)}\n`);
    return {
      close: async () => {},
      write: async (line) => {
        const message = JSON.parse(line);
        if (!message.id) return;
        let result: unknown;
        if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {}, prompts: {} } };
        else if (message.method === 'tools/list') {
          state.lists++;
          result = { tools: structuredClone(state.tools) };
          if (state.hold) {
            state.hold = false;
            state.release = () => emit({ jsonrpc: '2.0', id: message.id, result });
            notifyList?.(); return;
          }
        } else if (message.method === 'prompts/list') result = { prompts: state.prompts };
        else if (message.method === 'tools/call') {
          state.calls.push(message.params.arguments);
          result = { content: [{ type: 'text', text: JSON.stringify(message.params.arguments) }] };
        } else throw new Error('unexpected protocol method');
        emit({ jsonrpc: '2.0', id: message.id, result });
      },
    };
  } };
  return { state, stdio, changed: (kind: 'tools' | 'prompts') => emit({ jsonrpc: '2.0', method: `notifications/${kind}/list_changed` }),
    entered: () => new Promise<void>((resolve) => { notifyList = resolve; }) };
}
const tool = (name: string, schema: Record<string, unknown>): McpToolInfo => ({ name, inputSchema: { type: 'object', ...schema } });

test('MCP 参数：自由键、组合、引用/嵌套数组原样执行，必填与类型错误在审批前拒绝', async () => {
  const service = protocol([
    tool('labels', { additionalProperties: { type: 'string' } }),
    tool('choice', { properties: { choice: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      fallback: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['choice'] }),
    tool('rows', { properties: { rows: { type: 'array', items: { $ref: '#/$defs/row' } } }, required: ['rows'],
      $defs: { row: { type: 'object', properties: { active: { type: 'boolean' } }, required: ['active'], additionalProperties: false } } }),
    tool('tags', { patternProperties: { '^tag_': { type: 'string' } }, additionalProperties: false }),
  ]);
  const host = new MemoryHost();
  const config: StdioLaunchOptions = { command: 'protocol-only', args: [] };
  const manager = new McpManager({ ...host, stdio: service.stdio }, async () => config);
  manager.sync({ check: config });
  const registry = new ToolRegistry();
  try {
    await manager.register(registry);
    const commands = manager.commands().filter((c) => c.kind === 'tool');
    const approval = new ApprovalManager(() => { throw new Error('invalid input reached approval'); }, 'yolo');
    const invoke = (index: number, input: unknown) => executeTool(registry, commands[index].alias, input,
      { host, workspace: '', signal: new AbortController().signal, approval });
    const valid = [{ priority: 'high', owner: 'alice' }, { choice: 3, fallback: null }, { rows: [{ active: true }] }, { tag_owner: 'alice' }];
    for (const [index, input] of valid.entries()) {
      const result = await invoke(index, JSON.stringify(input));
      assert.equal(result.isError, false, result.content);
      assert.deepEqual(JSON.parse(result.content), input);
    }
    for (const [index, input] of [[0, { priority: 1 }], [1, {}], [2, { rows: [{ active: 'true' }] }], [2, { rows: [{}] }]] as const) {
      const result = await invoke(index, input);
      assert.equal(result.approved, false); assert.equal(result.isError, true);
      assert.equal(result.timing.executionMs, undefined);
    }
    assert.deepEqual(service.state.calls, valid, '不得裁剪、填默认值或隐式转换参数');
    const pendingApproval = new ApprovalManager((event) => {
      if (event.type === 'approval_request') { manager.sync({ check: { ...config, enabled: false } }); pendingApproval.resolve(event.requestId, true); }
    }, 'ask');
    const stale = await executeTool(registry, commands[0].alias, valid[0],
      { host, workspace: '', signal: new AbortController().signal, approval: pendingApproval });
    assert.equal(stale.isError, true);
    assert.equal(service.state.calls.length, valid.length, '停用后批准旧调用不能执行');
    service.state.tools = [tool('unsupported', { $ref: 'https://example.invalid/unavailable-schema' })];
    manager.sync({ check: config });
    const rejected = new ToolRegistry(); await manager.register(rejected);
    assert.equal(rejected.listSpecs().length, 0);
    assert.equal(manager.statuses()[0].state, 'error', '无法安全处理的 Schema 必须拒绝注册');
  } finally { await manager.dispose(); }
});

test('MCP 目录：刷新中再次通知会重读工具及 Prompt，不发布已知过期快照', async () => {
  const service = protocol([tool('initial', {})]);
  const published: string[][] = [];
  const client = new McpClient(service.stdio, 1000, () => {}, () => published.push(client.tools.map((t) => t.name)));
  try {
    await client.connect({ command: 'protocol-only', args: [] });
    service.state.tools = [tool('stale', {})]; service.state.hold = true;
    const entered = service.entered(); service.changed('tools'); await entered;
    service.state.tools = [tool('latest', {})]; service.state.prompts = [{ name: 'latest-prompt' }];
    service.changed('prompts'); service.state.release!(); await client.refresh();
    assert.deepEqual(client.tools.map((t) => t.name), ['latest']);
    assert.deepEqual(client.prompts.map((p) => p.name), ['latest-prompt']);
    assert.equal(published.some((names) => names.includes('stale')), false);
    assert.ok(service.state.lists >= 3);
  } finally { await client.close(); }
});
