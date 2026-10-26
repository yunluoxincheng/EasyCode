import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApprovalManager, MemoryHost, ResponsesProvider, ToolRegistry, runAgentLoop,
  type AgentEvent, type Provider, type ChatMessage } from '../index.js';

test('Responses 生命周期：拒绝空白参数，完成即取消读取，心跳不延长超时且可停止', async (t) => {
  const provider = new ResponsesProvider('stream-contract', { baseURL: 'https://example.invalid', model: 'contract' });
  const added = { type: 'response.output_item.added', output_index: 0,
    item: { id: 'item', type: 'function_call', call_id: 'call', name: 'no_args', arguments: '' } };
  const completed = (args: unknown) => ({ type: 'response.completed', response: { status: 'completed',
    output: [{ type: 'function_call', call_id: 'call', name: 'no_args', arguments: args }] } });
  const encode = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
  let response: Response;
  t.mock.method(globalThis, 'fetch', async () => response);
  const start = (events: unknown[], close = false) => {
    let sink!: ReadableStreamDefaultController<Uint8Array>;
    const state = { cancelled: false, executions: 0, settled: false };
    response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { sink = controller; for (const event of events) controller.enqueue(encode(event)); if (close) controller.close(); },
      cancel() { state.cancelled = true; },
    }));
    let ready!: () => void;
    const prepared = new Promise<void>((resolve) => { ready = resolve; });
    const controller = new AbortController();
    let requests = 0;
    const real: Provider = { id: provider.id, stream: (request, context) =>
      requests++ === 0 ? provider.stream(request, context) : Promise.resolve({ blocks: [] }) };
    const tools = new ToolRegistry().register({
      spec: { name: 'no_args', description: 'Explicit empty-object arguments required', parameters: { type: 'object' } },
      requiresWorkspace: false, execute: async () => { state.executions++; return 'ok'; },
    });
    const messages: ChatMessage[] = [{ role: 'user', content: 'run no_args' }];
    const emitted: AgentEvent[] = [];
    const result = runAgentLoop({ provider: real, tools, host: new MemoryHost(), workspace: '', systemPrompt: '',
      messages, approval: new ApprovalManager(() => {}, 'yolo'), signal: controller.signal,
      emit: (event) => { emitted.push(event); if (event.type === 'tool_call_preparing') ready(); },
    }).then((result) => { state.settled = true; return result; });
    return { state, result, prepared, controller, sink, emitted };
  };
  for (const args of [undefined, null, 0, '', ' \t\n', '{', '{}', ' { } ']) {
    const stream = start([added, completed(args)]); // 完成后故意保持传输打开。
    const result = await stream.result;
    const valid = args === '{}' || args === ' { } ';
    assert.equal(result.reason, valid ? 'completed' : 'error', `arguments=${JSON.stringify(args)}`);
    assert.equal(stream.state.executions, valid ? 1 : 0, '空白参数不能靠无参数工具绕过校验');
    if (!valid) assert.match(result.errorMessage ?? '', /JSON/);
    assert.equal(stream.state.cancelled, true, '无须等待服务端关闭连接');
  }
  for (const terminal of ['response.failed', 'response.incomplete', 'error', 'eof']) {
    const stream = start(terminal === 'eof' ? [added] : [added, { type: terminal }], terminal === 'eof');
    assert.equal((await stream.result).reason, 'error');
    assert.equal(stream.state.executions, 0);
  }

  // 只替换时间；实际 SSE reader、取消信号和 Agent 循环继续运行。
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
  try {
    const stream = start([added]);
    await stream.prepared;
    t.mock.timers.tick(119000);
    stream.sink.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stream.state.settled, false);
    t.mock.timers.tick(1000);
    const result = await stream.result;
    assert.equal(result.reason, 'error', 'watchdog 必须报错，而非冒充用户取消');
    assert.match(result.errorMessage ?? '', /120 秒/);
    assert.equal(stream.state.cancelled, true);
    assert.equal(stream.state.executions, 0);

    const active = start([added]);
    await active.prepared;
    t.mock.timers.tick(119000);
    active.sink.enqueue(encode({ type: 'response.function_call_arguments.delta', item_id: 'item', delta: '{' }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(119000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(active.state.settled, false, '有效参数进展后仍可持续生成超过两分钟');
    active.controller.abort();
    assert.equal((await active.result).reason, 'aborted');
    assert.equal(active.state.cancelled, true);
    assert.equal(active.state.executions, 0);
  } finally { t.mock.timers.reset(); }
});
