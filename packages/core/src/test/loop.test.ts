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
