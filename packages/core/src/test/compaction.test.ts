import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AgentEvent,
  ApprovalManager,
  ChatMessage,
  MemoryHost,
  Provider,
  StreamRequest,
  TurnResult,
  compactHistoryMessages,
  createBuiltinTools,
  pruneHistoricalToolResults,
  runAgentLoop,
} from '../index.js';

test('pruneHistoricalToolResults: 单轮或未超保护轮次不折叠', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: '查看代码' },
    {
      role: 'tool_result',
      toolCallId: 'call_1',
      toolName: 'read_file',
      content: 'A'.repeat(5000),
    },
  ];
  const res = pruneHistoricalToolResults(messages, { keepRecentTurns: 1 });
  assert.equal(res.modified, false);
  assert.equal(messages[1].role === 'tool_result' && messages[1].content.length, 5000);
});

test('pruneHistoricalToolResults: 早期轮次大工具输出执行折叠，保留最近轮次并保持 toolCallId', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: '第一轮：查大文件' },
    {
      role: 'assistant',
      blocks: [{ type: 'tool_call', id: 'call_1', name: 'read_file', input: { path: 'big.txt' } }],
    },
    {
      role: 'tool_result',
      toolCallId: 'call_1',
      toolName: 'read_file',
      content: Array.from({ length: 60 }, (_, i) => `Line ${i + 1}: content content content`).join('\n'),
    },
    { role: 'user', content: '第二轮：最新指令' },
    {
      role: 'tool_result',
      toolCallId: 'call_2',
      toolName: 'read_file',
      content: Array.from({ length: 60 }, (_, i) => `Active Line ${i + 1}`).join('\n'),
    },
  ];

  const res = pruneHistoricalToolResults(messages, { keepRecentTurns: 1, maxChars: 500, maxLines: 20 });
  assert.equal(res.modified, true);
  assert.equal(res.prunedCount, 1);
  assert.ok(res.savedChars > 0);

  // 第一轮被折叠
  const oldTool = messages[2];
  assert.equal(oldTool.role, 'tool_result');
  if (oldTool.role === 'tool_result') {
    assert.equal(oldTool.toolCallId, 'call_1');
    assert.match(oldTool.content, /历史工具输出已折叠归档/);
    assert.match(oldTool.content, /Line 1:/);
    assert.match(oldTool.content, /Line 60:/);
    assert.match(oldTool.content, /折叠省略中间/);
  }

  // 第二轮（最近轮次）受保护，未被折叠
  const recentTool = messages[4];
  assert.equal(recentTool.role, 'tool_result');
  if (recentTool.role === 'tool_result') {
    assert.equal(recentTool.toolCallId, 'call_2');
    assert.doesNotMatch(recentTool.content, /历史工具输出已折叠归档/);
  }
});

test('compactHistoryMessages: 早期轮次归档，提取文件与 Todo，保留最近轮次', () => {
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
    { role: 'tool_result', toolCallId: 't_1', toolName: 'todo_write', content: 'ok' },
    { role: 'tool_result', toolCallId: 't_2', toolName: 'write_file', content: 'written' },
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
    { role: 'tool_result', toolCallId: 't_3', toolName: 'run_command', content: 'all passed' },
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
