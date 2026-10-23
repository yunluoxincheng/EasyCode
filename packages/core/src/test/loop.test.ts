import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AgentEvent,
  ApprovalManager,
  ApprovalMode,
  ChatMessage,
  MemoryHost, Provider,
  StreamRequest,
  ToolCallBlock,
  TurnResult,
  createBuiltinTools,
  runAgentLoop,
  toOpenAIWireMessages,
  toAnthropicWireMessages,
  UserQuestionManager, ResponsesProvider, extractLatestTodos
} from '../index.js';

/** 收集事件 + 消息的测试脚手架 */
function makeEnv(mode: ApprovalMode = 'yolo') {
  const host = new MemoryHost({
    '/ws/hello.txt': 'hello easycode\nsecond line\n',
  });
  const events: AgentEvent[] = [];
  const messages: ChatMessage[] = [{ role: 'user', content: '帮我处理一下' }];
  const approval = new ApprovalManager((e) => events.push(e), mode);
  const signal = new AbortController().signal;
  const emit = (e: AgentEvent) => events.push(e);
  return { host, events, messages, approval, emit, signal };
}

/** 脚本化 Provider：按预设轮次返回 blocks */
function scriptedProvider(turns: TurnResult[]): Provider {
  let i = 0;
  return {
    id: 'scripted',
    async stream(_req: StreamRequest, ctx) {
      if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      return turns[i++] ?? { blocks: [{ type: 'text', text: 'done' }] };
    },
  };
}

function toolsFor(): ReturnType<typeof createBuiltinTools> {
  return createBuiltinTools();
}

test('【P2 拒绝态】权限规则拒绝时 tool_result 事件显式携带 approved=false', async () => {
  const env = makeEnv('yolo');
  const call: ToolCallBlock = {
    type: 'tool_call',
    id: 'c_deny',
    name: 'run_command',
    input: { command: 'rm -rf build' },
  };
  const provider = scriptedProvider([
    { blocks: [call] },
    { blocks: [{ type: 'text', text: '无法执行，已改用其他方案' }] },
  ]);
  const result = await runAgentLoop({
    ...env,
    provider,
    tools: toolsFor(),
    workspace: '/ws',
    systemPrompt: 's',
    permissionRules: [
      { tool: 'run_command', pattern: 'rm', decision: 'deny', source: 'global' },
    ],
  });
  assert.equal(result.reason, 'completed');
  const event = env.events.find(
    (e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result',
  );
  assert.ok(event, '缺少 tool_result 事件');
  // UI 依据结构化字段渲染「拒绝」，不再匹配中文提示文本
  assert.equal(event.approved, false);
  assert.equal(event.isError, false);
  assert.match(event.content, /权限规则拒绝执行/);
  assert.deepEqual(event.timing, { approvalMs: 0 });
  assert.equal(event.timing.executionMs, undefined);
});

test('交互批次：答案重规划前不执行旧参数，停止也补齐全部协议结果', async (t) => {
  for (const cancel of [false, true]) {
    const env = makeEnv('yolo');
    const controller = new AbortController();
    const writes: string[] = [];
    let commands = 0;
    const write = env.host.fs.writeFile;
    env.host.fs.writeFile = async (path, content) => { writes.push(content); await write(path, content); };
    env.host.process.run = async () => { commands++; return { code: 0, stdout: '', stderr: '' }; };
    const calls: ToolCallBlock[] = [
      { type: 'tool_call', id: 'old_before', name: 'write_file', input: { path: 'db.txt', content: 'postgresql' } },
      { type: 'tool_call', id: 'question', name: 'ask_user', input: { questions: [{ id: 'db', question: 'Database?', options: [{ label: 'PostgreSQL' }, { label: 'MySQL' }] }] } },
      { type: 'tool_call', id: 'old_after', name: 'run_command', input: { command: 'install postgresql' } },
      { type: 'tool_call', id: 'old_todo', name: 'todo_write', input: { todos: [{ content: 'use postgresql', status: 'pending' }] } },
    ];
    let writesAtQuestion: string[] = [];
    let todosAtQuestion: unknown;
    const questions = new UserQuestionManager((event) => {
      env.events.push(event);
      if (event.type === 'question_request') {
        writesAtQuestion = [...writes];
        todosAtQuestion = extractLatestTodos(env.messages);
        if (cancel) controller.abort();
        else questions.respond(event.request.requestId, [{ questionId: 'db', selectedOption: 'MySQL' }]);
      }
    });
    let rounds = 0;
    const provider: Provider = { id: 'fixed-mixed-batch', async stream(request) {
      rounds++;
      if (rounds === 1) return { blocks: calls };
      if (rounds === 2) {
        const results = request.messages.filter((message) => message.role === 'tool_result');
        assert.deepEqual(results.map((message) => message.toolCallId).sort(), calls.map((call) => call.id).sort());
        const answer = results.find((message) => message.toolCallId === 'question')!;
        assert.equal(JSON.parse(answer.content).answers[0].selectedOption, 'MySQL');
        assert.equal(extractLatestTodos(request.messages), undefined, '未执行的预生成清单不能覆盖真实状态');
        return { blocks: [
          { type: 'tool_call', id: 'read_after_answer', name: 'read_file', input: { path: 'hello.txt' } },
          { type: 'tool_call', id: 'mysql_after_answer', name: 'write_file', input: { path: 'db.txt', content: 'mysql' } },
        ] };
      }
      return { blocks: [{ type: 'text', text: 'done' }] };
    } };
    const result = await runAgentLoop({ ...env, provider, questions, tools: toolsFor(), signal: controller.signal, workspace: '/ws', systemPrompt: 's' });
    assert.equal(result.reason, cancel ? 'aborted' : 'completed');
    assert.deepEqual(writesAtQuestion, []);
    assert.equal(todosAtQuestion, undefined);
    assert.deepEqual(writes, cancel ? [] : ['mysql']);
    assert.equal(commands, 0);
    assert.equal(rounds, cancel ? 1 : 3);
    const results = env.messages.filter((message) => message.role === 'tool_result');
    assert.equal(results.length, cancel ? 4 : 6);
    for (const call of calls.filter((call) => call.id !== 'question')) {
      const deferred = results.find((message) => message.toolCallId === call.id)!;
      assert.equal(deferred.isError, true);
      assert.equal(env.events.some((event) => event.type === 'tool_execution_start' && event.callId === call.id), false);
    }
    if (!cancel) assert.match(results.find((message) => message.toolCallId === 'read_after_answer')!.content, /hello easycode/);
    const expected = results.map((message) => message.toolCallId);
    assert.deepEqual(toOpenAIWireMessages(env.messages).filter((message) => message.role === 'tool').map((message) => message.tool_call_id), expected);
    const anthropic = toAnthropicWireMessages(env.messages).flatMap((message) => message.content as Array<{ type: string; tool_use_id?: string }>);
    assert.deepEqual(anthropic.filter((block) => block.type === 'tool_result').map((block) => block.tool_use_id), expected);
    let responseIds: string[] = [];
    t.mock.method(globalThis, 'fetch', async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body));
      responseIds = body.input.filter((item: { type: string }) => item.type === 'function_call_output').map((item: { call_id: string }) => item.call_id);
      return new Response('data: {"type":"response.completed","response":{"output":[]}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    await new ResponsesProvider('wire-check', { baseURL: 'https://example.invalid', model: 'test' }).stream({ messages: env.messages, tools: [] }, { signal: new AbortController().signal, emit: () => {} });
    assert.deepEqual(responseIds, expected);
    t.mock.restoreAll();
  }
});

test('审批：拒绝时工具不执行，模型收到拒绝说明', async () => {
  const env = makeEnv('ask');
  const call: ToolCallBlock = {
    type: 'tool_call',
    id: 'c1',
    name: 'run_command',
    input: { command: 'rm -rf /' },
  };
  const provider = scriptedProvider([
    { blocks: [call] },
    { blocks: [{ type: 'text', text: '好的，不执行了' }] },
  ]);
  const loop = runAgentLoop({ ...env, provider, tools: toolsFor(), workspace: '/ws', systemPrompt: 's' });
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (env.events.some((e) => e.type === 'approval_request')) {
        clearInterval(timer);
        resolve();
      }
    }, 5);
  });
  const request = env.events.find((e) => e.type === 'approval_request');
  if (request && request.type === 'approval_request') env.approval.resolve(request.requestId, false);
  await loop;
  const toolResult = env.messages.find((m) => m.role === 'tool_result');
  assert.ok(toolResult, '缺少 tool_result 消息');
  assert.equal(toolResult.role, 'tool_result');
  assert.match(toolResult.content, /拒绝/);
  assert.equal(env.host.snapshot()['/ws/new.txt'], undefined);
});

test('循环：maxSteps 步数上限生效', async () => {
  const env = makeEnv('yolo');
  const infiniteCall: ToolCallBlock = {
    type: 'tool_call',
    id: 'c1',
    name: 'read_file',
    input: { path: 'hello.txt' },
  };
  let count = 0;
  const infiniteProvider: Provider = {
    id: 'infinite',
    async stream() {
      count++;
      return { blocks: [infiniteCall] };
    },
  };
  const result = await runAgentLoop({
    ...env,
    provider: infiniteProvider,
    tools: toolsFor(),
    workspace: '/ws',
    systemPrompt: 's',
    maxSteps: 3,
  });
  assert.equal(result.reason, 'error');
  assert.match(result.errorMessage ?? '', /已达单次任务最大步数（3）/);
  assert.equal(count, 3);
});


test('中止：abort 后循环以 aborted 结束', async () => {
  const env = makeEnv();
  const controller = new AbortController();
  const provider: Provider = {
    id: 'slow',
    async stream(_req, ctx) {
      await new Promise((r) => setTimeout(r, 50));
      if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      return { blocks: [{ type: 'text', text: 'never' }] };
    },
  };
  const loop = runAgentLoop({
    ...env,
    provider,
    tools: toolsFor(),
    workspace: '/ws',
    systemPrompt: 's',
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);
  const result = await loop;
  assert.equal(result.reason, 'aborted');
});

test('toOpenAIWireMessages: 过滤孤儿 tool_result 并自动补齐断尾未履行 tool_calls', () => {
  const msgs: ChatMessage[] = [
    { role: 'user', content: '测试孤儿与断尾' },
    // 孤儿 tool_result：前置无 tool_calls，应被过滤
    { role: 'tool_result', toolCallId: 'orphan_1', toolName: 'read_file', content: '孤儿数据' },
    // assistant 发起了 2 个 tool_call
    {
      role: 'assistant',
      blocks: [
        { type: 'tool_call', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
        { type: 'tool_call', id: 'call_2', name: 'read_file', input: { path: 'b.txt' } },
      ],
    },
    // 只回复了 call_1
    { role: 'tool_result', toolCallId: 'call_1', toolName: 'read_file', content: 'a content' },
    // 紧接着又有新的 user 消息，call_2 未履行（断尾）
    { role: 'user', content: '下次提问' },
  ];

  const wire = toOpenAIWireMessages(msgs);
  // 预期：
  // 1: user
  // 2: assistant (包含 call_1, call_2)
  // 3: tool (call_1)
  // 4: tool (call_2 自动补齐占位取消结果)
  // 5: user ('下次提问')
  assert.equal(wire.length, 5);
  assert.equal(wire[0].role, 'user');
  assert.equal(wire[1].role, 'assistant');
  assert.equal(wire[2].role, 'tool');
  assert.equal((wire[2] as { tool_call_id: string }).tool_call_id, 'call_1');
  assert.equal(wire[3].role, 'tool');
  assert.equal((wire[3] as { tool_call_id: string }).tool_call_id, 'call_2');
  assert.match(String((wire[3] as { content: string }).content), /中断或取消/);
  assert.equal(wire[4].role, 'user');
});

test('toAnthropicWireMessages: 过滤未签名的 thinking 块并合并相邻 tool_result', () => {
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      blocks: [
        { type: 'thinking', text: '无签名的思考过程' },
        { type: 'text', text: '这是回答正文' },
      ],
    },
  ];

  const wire = toAnthropicWireMessages(msgs);
  assert.equal(wire.length, 2);
  const assistantContent = (wire[1] as { content: Array<{ type: string; text?: string }> }).content;
  // 无签名的 thinking 块已被过滤，保留 text
  assert.equal(assistantContent.length, 1);
  assert.equal(assistantContent[0].type, 'text');
  assert.equal(assistantContent[0].text, '这是回答正文');
});
