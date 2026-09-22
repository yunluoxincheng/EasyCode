import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AgentEvent,
  ApprovalManager,
  ApprovalMode,
  ChatMessage,
  MemoryHost,
  MockProvider,
  Provider,
  StreamRequest,
  ToolCallBlock,
  TurnResult,
  createBuiltinTools,
  runAgentLoop,
  toOpenAIWireMessages,
  toAnthropicWireMessages,
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

test('循环：纯文本回复直接完成', async () => {
  const env = makeEnv();
  const provider = scriptedProvider([{ blocks: [{ type: 'text', text: '你好' }] }]);
  const result = await runAgentLoop({ ...env, provider, tools: toolsFor(), workspace: '/ws', systemPrompt: 's' });
  assert.equal(result.reason, 'completed');
  assert.equal(env.messages.length, 2); // user + assistant
  assert.equal(env.events.at(-1)?.type, 'done');
});

test('循环：工具调用 → 结果回传 → 第二轮完成', async () => {
  const env = makeEnv('yolo');
  const call: ToolCallBlock = {
    type: 'tool_call',
    id: 'c1',
    name: 'read_file',
    input: { path: 'hello.txt' },
  };
  const provider = scriptedProvider([
    { blocks: [call] },
    { blocks: [{ type: 'text', text: '读完了' }] },
  ]);
  const result = await runAgentLoop({ ...env, provider, tools: toolsFor(), workspace: '/ws', systemPrompt: 's' });
  assert.equal(result.reason, 'completed');
  const toolResult = env.messages.find((m) => m.role === 'tool_result');
  assert.ok(toolResult, '缺少 tool_result 消息');
  assert.equal(toolResult.role, 'tool_result');
  assert.match(toolResult.content, /hello easycode/);
  // 事件序列包含 tool_call_start 与 tool_result
  assert.ok(env.events.some((e) => e.type === 'tool_call_start'));
  assert.ok(env.events.some((e) => e.type === 'tool_result'));
});

test('审批：ask 模式挂起等待，批准后执行', async () => {
  const env = makeEnv('ask');
  const call: ToolCallBlock = {
    type: 'tool_call',
    id: 'c1',
    name: 'write_file',
    input: { path: 'new.txt', content: 'data' },
  };
  const provider = scriptedProvider([
    { blocks: [call] },
    { blocks: [{ type: 'text', text: '写入完成' }] },
  ]);
  const loop = runAgentLoop({ ...env, provider, tools: toolsFor(), workspace: '/ws', systemPrompt: 's' });

  // 等待审批请求事件出现后批准
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (env.events.some((e) => e.type === 'approval_request')) {
        clearInterval(timer);
        resolve();
      }
    }, 5);
  });
  const request = env.events.find((e) => e.type === 'approval_request');
  assert.ok(request && request.type === 'approval_request', '缺少审批请求事件');
  assert.ok(request.type === 'approval_request');
  env.approval.resolve(request.requestId, true);

  const result = await loop;
  assert.equal(result.reason, 'completed');
  assert.equal(env.host.snapshot()['/ws/new.txt'], 'data');
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

test('安全：路径逃逸被拒绝', async () => {
  const env = makeEnv('yolo');
  const call: ToolCallBlock = {
    type: 'tool_call',
    id: 'c1',
    name: 'read_file',
    input: { path: '../../../etc/passwd' },
  };
  const provider = scriptedProvider([{ blocks: [call] }, { blocks: [] }]);
  await runAgentLoop({ ...env, provider, tools: toolsFor(), workspace: '/ws', systemPrompt: 's' });
  const toolResult = env.messages.find((m) => m.role === 'tool_result');
  assert.ok(toolResult, '缺少 tool_result 消息');
  assert.equal(toolResult.role, 'tool_result');
  assert.match(toolResult.content, /越界|失败/);
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

test('MockProvider 演示链路：list_dir → 总结', async () => {
  const env = makeEnv('yolo');
  const result = await runAgentLoop({
    ...env,
    provider: new MockProvider(),
    tools: toolsFor(),
    workspace: '/ws',
    systemPrompt: 's',
  });
  assert.equal(result.reason, 'completed');
  assert.ok(env.events.some((e) => e.type === 'tool_result'));
  const last = env.messages.at(-1);
  assert.ok(last && last.role === 'assistant');
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
