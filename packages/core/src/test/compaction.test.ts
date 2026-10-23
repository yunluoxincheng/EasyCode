import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AgentEvent,
  ApprovalManager,
  ChatMessage,
  MemoryHost,
  Provider,
  StreamRequest, compactHistoryMessages,
  createBuiltinTools, runAgentLoop, executeTool, extractLatestTodos, type ToolCallBlock
} from '../index.js';

test('compactHistoryMessages: 仅归档确认成功的文件、命令与 Todo，保留最近轮次', async () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: '轮次 1：初始化项目并规划' },
    {
      role: 'assistant',
      blocks: [
        {
          type: 'tool_call',
          id: 't_1',
          name: 'todo_write',
          input: {
            todos: [
              { content: '任务一', status: 'completed', priority: 'high' },
              { content: '任务二', status: 'in_progress', priority: 'medium' },
            ],
          },
        },
        {
          type: 'tool_call',
          id: 't_2',
          name: 'write_file',
          input: { filePath: 'src/main.ts', content: 'console.log(1);' },
        },
      ],
    },
    { role: 'tool_result', toolCallId: 't_1', toolName: 'todo_write', content: 'ok', approved: true },
    { role: 'tool_result', toolCallId: 't_2', toolName: 'write_file', content: 'written', approved: true },
    { role: 'user', content: '轮次 2：执行测试' },
    {
      role: 'assistant',
      blocks: [
        {
          type: 'tool_call',
          id: 't_3',
          name: 'run_command',
          input: { command: 'pnpm test' },
        },
      ],
    },
    { role: 'tool_result', toolCallId: 't_3', toolName: 'run_command', content: 'all passed', approved: true },
    { role: 'user', content: '轮次 3：最近交互 A' },
    { role: 'assistant', blocks: [{ type: 'text', text: '正在处理 A' }] },
    { role: 'user', content: '轮次 4：最近交互 B' },
    { role: 'assistant', blocks: [{ type: 'text', text: '正在处理 B' }] },
  ];

  // 保留最近 2 轮（即 轮次 3 与 轮次 4）
  const res = compactHistoryMessages(messages, { keepRecentTurns: 2 });
  assert.equal(res.compacted, true);
  assert.equal(res.discardedTurns, 2);
  assert.equal(res.preservedTurns, 2);

  // 首条为归档摘要
  const first = res.messages[0];
  assert.equal(first.role, 'user');
  if (first.role === 'user') {
    assert.match(first.content, /早期历史会话已精简归档/);
    assert.match(first.content, /src\/main\.ts/);
    assert.match(first.content, /pnpm test/);
    assert.match(first.content, /任务清单状态/);
  }

  // 检查是否正确保留了轮次 3 和轮次 4
  const userMessages = res.messages.filter((m) => m.role === 'user');
  assert.equal(userMessages.length, 3); // 1 summary + 2 preserved user msgs
  assert.equal(userMessages[1].content, '轮次 3：最近交互 A');
  assert.equal(userMessages[2].content, '轮次 4：最近交互 B');

  // 使用实际工具执行器生成许可/校验结果，确认成功 A 不会被未执行的 B 覆盖。
  const host = new MemoryHost();
  const approval = new ApprovalManager(() => {}, 'yolo');
  const context = { host, approval, workspace: '/ws', signal: new AbortController().signal };
  const tools = createBuiltinTools();
  const timeline: ChatMessage[] = [{ role: 'user', content: 'plan' }];
  const a = [{ content: 'A', status: 'pending' }];
  const b = [{ content: 'B', status: 'completed' }];
  const call: ToolCallBlock = { type: 'tool_call', id: 'reused', name: 'todo_write', input: { todos: a } };
  const success = await executeTool(tools, call.name, call.input, context);
  assert.equal(success.approved, true);
  assert.equal(success.isError, false);
  timeline.push({ role: 'assistant', blocks: [call] }, {
    role: 'tool_result', toolCallId: call.id, toolName: call.name, ...success,
  });
  assert.deepEqual(extractLatestTodos(timeline), a);
  const cases = [
    { input: { todos: b }, permissionRules: [{ tool: 'todo_write', decision: 'deny' as const, source: 'global' as const }], approved: false, isError: false },
    { input: { todos: 'invalid' }, approved: false, isError: true },
    { input: { todos: [{ content: 'B', status: 'invalid' }] }, approved: true, isError: true },
    { input: { todos: [{ content: '', status: 'pending' }] }, approved: true, isError: true },
  ];
  for (const scenario of cases) {
    const execution = await executeTool(tools, call.name, scenario.input, { ...context, permissionRules: scenario.permissionRules });
    assert.equal(execution.approved, scenario.approved);
    assert.equal(execution.isError, scenario.isError);
    timeline.push({ role: 'assistant', blocks: [{ ...call, input: scenario.input }] }, {
      role: 'tool_result', toolCallId: call.id, toolName: call.name, ...execution,
    });
    assert.deepEqual(extractLatestTodos(timeline), a);
  }
  const proposed: ToolCallBlock = { ...call, input: { todos: b } };
  timeline.push({ role: 'assistant', blocks: [proposed] });
  assert.deepEqual(extractLatestTodos(timeline), a, '缺失结果不能提交清单');
  timeline.push({ role: 'tool_result', toolCallId: call.id, toolName: call.name, content: 'ok', isError: false });
  assert.deepEqual(extractLatestTodos(timeline), a, '旧历史缺少 approved 不能推断成功');
  timeline.push({ role: 'tool_result', toolCallId: call.id, toolName: call.name, ...success });
  assert.deepEqual(extractLatestTodos(timeline), a, '重复结果不能升级已消费的结果');
  timeline.push({ role: 'assistant', blocks: [proposed] }, {
    role: 'tool_result', toolCallId: call.id, toolName: 'write_file', ...success,
  });
  assert.deepEqual(extractLatestTodos(timeline), a, '工具名称必须匹配');
  timeline.push({ role: 'assistant', blocks: [proposed] }, { role: 'user', content: 'new turn' }, {
    role: 'tool_result', toolCallId: call.id, toolName: call.name, ...success,
  });
  assert.deepEqual(extractLatestTodos(timeline), a, '迟到结果不能跨用户轮次匹配');
  const updated = await executeTool(tools, call.name, proposed.input, context);
  timeline.push({ role: 'assistant', blocks: [proposed] }, {
    role: 'tool_result', toolCallId: call.id, toolName: call.name, ...updated,
  });
  assert.deepEqual(extractLatestTodos(timeline), b, '重用调用 ID 的新批次正常成功更新');

  for (const outcome of [undefined, {}, { approved: false, isError: false }, { approved: true, isError: true }]) {
    const unconfirmed: ChatMessage[] = [{ role: 'user', content: 'old turn' }, {
      role: 'assistant', blocks: [
        { type: 'tool_call', id: 'file', name: 'write_file', input: { path: 'unexecuted.conf' } },
        { type: 'tool_call', id: 'cmd', name: 'run_command', input: { command: 'install unexecuted' } },
      ],
    }];
    if (outcome) unconfirmed.push(
      { role: 'tool_result', toolCallId: 'file', toolName: 'write_file', content: 'output', ...outcome },
      { role: 'tool_result', toolCallId: 'cmd', toolName: 'run_command', content: 'output', ...outcome },
    );
    unconfirmed.push({ role: 'user', content: 'recent' });
    const summary = compactHistoryMessages(unconfirmed, { keepRecentTurns: 1 }).messages[0];
    assert.ok(summary.role === 'user');
    assert.doesNotMatch(summary.content, /unexecuted|历史涉及文件|早期关键命令/);
  }
});

test('runAgentLoop: 当 inputTokens 超出阈值时自动触发上下文压缩并发出事件', async () => {
  const host = new MemoryHost({
    '/ws/file.txt': 'sample',
  });
  const events: AgentEvent[] = [];
  const messages: ChatMessage[] = [
    { role: 'user', content: '旧轮次 1' },
    { role: 'assistant', blocks: [{ type: 'text', text: '旧轮次 1 答复' }] },
    { role: 'user', content: '旧轮次 2' },
    { role: 'assistant', blocks: [{ type: 'text', text: '旧轮次 2 答复' }] },
    { role: 'user', content: '当前轮次 3：请读文件并处理' },
  ];
  const approval = new ApprovalManager((e) => events.push(e), 'yolo');
  const signal = new AbortController().signal;

  let turnIndex = 0;
  const provider: Provider = {
    id: 'scripted',
    async stream(_req: StreamRequest, _ctx) {
      if (turnIndex === 0) {
        turnIndex++;
        return {
          blocks: [
            {
              type: 'tool_call',
              id: 'c_read',
              name: 'read_file',
              input: { path: 'file.txt' },
            },
          ],
          usage: { inputTokens: 920, outputTokens: 50 }, // 920 > 1000 * 0.85
        };
      }
      return {
        blocks: [{ type: 'text', text: '文件处理完成' }],
        usage: { inputTokens: 400, outputTokens: 20 },
      };
    },
  };

  const result = await runAgentLoop({
    provider,
    tools: createBuiltinTools(),
    host,
    workspace: '/ws',
    systemPrompt: 'sys',
    messages,
    signal,
    approval,
    emit: (e) => events.push(e),
    contextWindow: 1000,
    autoCompactThreshold: 0.85,
  });

  assert.equal(result.reason, 'completed');

  // 验证 context_compacted 事件是否发出
  const compactEv = events.find((e) => e.type === 'context_compacted');
  assert.ok(compactEv, '应触发 context_compacted 事件');
  if (compactEv?.type === 'context_compacted') {
    assert.equal(compactEv.beforeTokens, 920);
    assert.match(compactEv.summary, /92%/);
  }

  // 验证消息数组已被就地压缩归档
  assert.ok(messages.length < 10);
  const firstMsg = messages[0];
  assert.equal(firstMsg.role, 'user');
  if (firstMsg.role === 'user') {
    assert.match(firstMsg.content, /早期历史会话已精简归档/);
  }
});
