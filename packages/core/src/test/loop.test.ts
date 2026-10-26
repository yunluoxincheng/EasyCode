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
  UserQuestionManager, ResponsesProvider, extractLatestTodos, compactHistoryMessages
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

test('拒绝路径：权限 deny 与用户拒绝均不执行，结果和持久化标记一致', async () => {
  for (const mode of ['yolo', 'ask'] as const) {
    const env = makeEnv(mode);
    env.host.process.run = async () => assert.fail('拒绝后不得运行命令');
    env.approval = new ApprovalManager((event) => {
      env.events.push(event);
      if (event.type === 'approval_request') env.approval.resolve(event.requestId, false);
    }, mode);
    const provider = scriptedProvider([
      { blocks: [{ type: 'tool_call', id: 'denied', name: 'run_command', input: { command: 'rm -rf build' } }] },
      { blocks: [{ type: 'text', text: '无法执行，已改用其他方案' }] },
    ]);
    const result = await runAgentLoop({ ...env, provider, tools: toolsFor(), workspace: '/ws', systemPrompt: 's',
      permissionRules: mode === 'yolo' ? [{ tool: 'run_command', pattern: 'rm', decision: 'deny', source: 'global' }] : [],
    });
    assert.equal(result.reason, 'completed');
    const event = env.events.find((event) => event.type === 'tool_result');
    assert.ok(event?.type === 'tool_result');
    assert.equal(event.approved, false);
    assert.equal(event.isError, false);
    assert.match(event.content, mode === 'yolo' ? /权限规则拒绝执行/ : /拒绝/);
    if (mode === 'yolo') assert.deepEqual(event.timing, { approvalMs: 0 });
    assert.equal(event.timing?.executionMs, undefined);
    assert.equal(env.events.some((event) => event.type === 'approval_request'), mode === 'ask');
    assert.equal(env.events.some((event) => event.type === 'tool_execution_start'), false);
    const persisted = env.messages.find((message) => message.role === 'tool_result');
    assert.ok(persisted?.role === 'tool_result');
    assert.match(persisted.content, /拒绝/);
    assert.equal(persisted.approved, false);
    assert.equal(persisted.isError, false);
    assert.equal(env.host.snapshot()['/ws/new.txt'], undefined);
  }
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
      { type: 'tool_call', id: 'old_before', name: 'write_file', input: { path: 'postgresql.conf', content: 'postgresql' } },
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
      assert.equal(deferred.approved, false);
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

    // 对实际交互循环的历史执行压缩，不能把旧参数提升为已执行事实。
    const compacted = compactHistoryMessages([...env.messages,
      { role: 'user', content: 'later turn' },
      { role: 'assistant', blocks: [{ type: 'text', text: 'later reply' }] },
      { role: 'user', content: 'latest turn' },
    ], { keepRecentTurns: 2 });
    assert.equal(compacted.compacted, true);
    const summary = compacted.messages[0];
    assert.ok(summary.role === 'user');
    assert.doesNotMatch(summary.content, /postgresql|任务清单状态/);
    if (!cancel) {
      assert.match(summary.content, /db\.txt/);
      assert.match(summary.content, /hello\.txt/);
      assert.equal(results.find((message) => message.toolCallId === 'mysql_after_answer')!.approved, true);
    } else assert.doesNotMatch(summary.content, /历史涉及文件|早期关键命令/);
  }
});

test('循环终止边界：步数耗尽与 Provider 进行中取消', async () => {
  for (const abort of [false, true]) {
    const env = makeEnv('yolo');
    const controller = new AbortController();
    let count = 0;
    const provider: Provider = { id: 'termination', async stream(_request, ctx) {
      count++;
      if (abort) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      }
      return { blocks: [{ type: 'tool_call', id: `call_${count}`, name: 'read_file', input: { path: 'hello.txt' } }] };
    } };
    const loop = runAgentLoop({ ...env, provider, tools: toolsFor(), workspace: '/ws', systemPrompt: 's',
      signal: controller.signal, maxSteps: 3 });
    if (abort) setTimeout(() => controller.abort(), 10);
    const result = await loop;
    assert.equal(result.reason, abort ? 'aborted' : 'error');
    if (!abort) {
      assert.match(result.errorMessage ?? '', /已达单次任务最大步数（3）/);
      assert.equal(count, 3);
    }
  }
});

test('消息转换：孤儿/断尾工具结果处理与未签名 thinking 过滤', () => {
  const msgs: ChatMessage[] = [
    { role: 'user', content: '测试孤儿与断尾' },
    // 孤儿 tool_result：前置无 tool_calls，应被过滤
    { role: 'tool_result', toolCallId: 'orphan_1', toolName: 'read_file', content: '孤儿数据' },
    // assistant 发起了 2 个 tool_call
    {
      role: 'assistant',
      blocks: [
        { type: 'thinking', text: '无签名的思考过程' },
        { type: 'text', text: '这是回答正文' },
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
  assert.equal(wire[1].content, '这是回答正文');
  assert.equal(wire[2].role, 'tool');
  assert.equal((wire[2] as { tool_call_id: string }).tool_call_id, 'call_1');
  assert.equal(wire[3].role, 'tool');
  assert.equal((wire[3] as { tool_call_id: string }).tool_call_id, 'call_2');
  assert.match(String((wire[3] as { content: string }).content), /中断或取消/);
  assert.equal(wire[4].role, 'user');
  const anthropic = toAnthropicWireMessages(msgs);
  const assistantContent = anthropic.find((message) => message.role === 'assistant')!.content as Array<{ type: string; text?: string }>;
  assert.equal(assistantContent.some((block) => block.type === 'thinking'), false);
  assert.deepEqual(assistantContent.filter((block) => block.type === 'text').map((block) => block.text), ['这是回答正文']);
});
