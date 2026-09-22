import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentServer } from '../server.js';
import { MemoryHost } from '@easycode/core';

test('AgentServer.forkSession 继承配置、截取指定轮次上下文并重置统计', async () => {
  const host = new MemoryHost({
    '/workspace/main.ts': 'console.log(1);',
  });

  const server = new AgentServer(host);
  await server.updateSettings({
    providers: {
      mock: {
        kind: 'mock',
        baseURL: '',
        name: 'Mock',
        enabled: true,
        models: [{ name: 'mock-model', enabled: true }],
      },
    },
    defaultProvider: 'mock',
  });

  const orig = await server.createSession({
    workspaceRoot: '/workspace',
    providerId: 'mock',
    title: '重构方案讨论',
  });

  const origData = await server.getSession(orig.id);
  origData.messages = [
    { role: 'user', content: '问题 1：方案 A 还是方案 B？', id: 'm_1' },
    {
      role: 'assistant',
      blocks: [{ type: 'text', text: '方案 A 更轻量，方案 B 更成熟。' }],
      id: 'm_2',
    },
    { role: 'user', content: '问题 2：我们选方案 A。', id: 'm_3' },
    {
      role: 'assistant',
      blocks: [{ type: 'text', text: '好的，开始落地方案 A。' }],
      id: 'm_4',
    },
  ];

  // 1. 在问题 2 前分叉（beforeUserIndex: 1，仅保留问题 1 及助手回答）
  const forked1 = await server.forkSession(orig.id, { beforeUserIndex: 1 });
  assert.notEqual(forked1.id, orig.id);
  assert.equal(forked1.title, '重构方案讨论（分支）');
  assert.equal(forked1.workspaceRoot, '/workspace');
  assert.equal(forked1.providerId, 'mock');

  const forked1Data = await server.getSession(forked1.id);
  assert.equal(forked1Data.messages.length, 2);
  assert.equal(forked1Data.messages[0].role, 'user');
  if (forked1Data.messages[0].role === 'user') {
    assert.equal(forked1Data.messages[0].content, '问题 1：方案 A 还是方案 B？');
  }
  assert.equal(forked1Data.messages[1].role, 'assistant');

  // 2. 原会话内容不受影响（无损深拷贝）
  assert.equal(origData.messages.length, 4);

  // 3. 全量分叉（保留全部历史）
  const forkedAll = await server.forkSession(orig.id);
  const forkedAllData = await server.getSession(forkedAll.id);
  assert.equal(forkedAllData.messages.length, 4);

  // 4. 按消息 ID 分叉（upToMessageId: 'm_2'）
  const forkedById = await server.forkSession(orig.id, { upToMessageId: 'm_2' });
  const forkedByIdData = await server.getSession(forkedById.id);
  assert.equal(forkedByIdData.messages.length, 2);
  assert.equal(forkedByIdData.messages[1].id, 'm_2');
});

test('AgentServer.trimSessionHistory 保留最新指定轮次并注入归档说明', async () => {
  const host = new MemoryHost({
    '/workspace/file.txt': 'hello',
  });
  const server = new AgentServer(host);
  await server.updateSettings({
    providers: {
      mock: {
        kind: 'mock',
        baseURL: '',
        name: 'Mock',
        enabled: true,
        models: [{ name: 'mock-model', enabled: true }],
      },
    },
    defaultProvider: 'mock',
  });
  const session = await server.createSession({
    workspaceRoot: '/workspace',
    providerId: 'mock',
    title: '长会话排错',
  });

  const sessionData = await server.getSession(session.id);
  sessionData.messages = [
    { role: 'user', content: '轮次 1：发现 bug', id: 'u_1' },
    { role: 'assistant', blocks: [{ type: 'text', text: '定位中...' }], id: 'a_1' },
    { role: 'user', content: '轮次 2：提供日志', id: 'u_2' },
    { role: 'assistant', blocks: [{ type: 'text', text: '分析日志...' }], id: 'a_2' },
    { role: 'user', content: '轮次 3：给出补丁', id: 'u_3' },
    { role: 'assistant', blocks: [{ type: 'text', text: '补丁已应用。' }], id: 'a_3' },
  ];

  // 保留最近 1 轮（u_3 + a_3），加上一条系统提示共 3 条
  const trimmed = await server.trimSessionHistory(session.id, 1);
  assert.equal(trimmed.messages.length, 3);
  assert.equal(trimmed.messages[0].role, 'user');
  if (trimmed.messages[0].role === 'user') {
    assert.match(trimmed.messages[0].content, /早期历史会话已精简归档/);
  }
  assert.equal(trimmed.messages[1].id, 'u_3');
  assert.equal(trimmed.messages[2].id, 'a_3');
});

test('AgentServer: contextCompaction 设置默认值与工具长输出折叠', async () => {
  const host = new MemoryHost({
    '/workspace/dummy.txt': 'init',
  });
  const server = new AgentServer(host);
  const settings = await server.getSettings();
  assert.equal(settings.contextCompaction?.autoCompact, true);
  assert.equal(settings.contextCompaction?.threshold, 0.85);

  await server.updateSettings({
    providers: {
      mock: {
        kind: 'mock',
        baseURL: '',
        name: 'Mock',
        enabled: true,
        models: [{ name: 'mock-model', enabled: true }],
      },
    },
    defaultProvider: 'mock',
  });
  const session = await server.createSession({
    workspaceRoot: '/workspace',
    providerId: 'mock',
    title: '工具修剪会话',
  });

  const sessionData = await server.getSession(session.id);
  sessionData.messages = [
    { role: 'user', content: '第一轮' },
    {
      role: 'assistant',
      blocks: [{ type: 'tool_call', id: 't_big', name: 'read_file', input: { path: 'a.log' } }],
    },
    {
      role: 'tool_result',
      toolCallId: 't_big',
      toolName: 'read_file',
      content: Array.from({ length: 40 }, (_, i) => `log line ${i}`).join('\n'),
    },
    { role: 'user', content: '第二轮：最新问题' },
    { role: 'assistant', blocks: [{ type: 'text', text: '已收到最新问题' }] },
  ];

  // 轮次总共 2 轮，keepRecentTurns=2 时不切除轮次，但对第一轮大工具输出执行修剪
  const trimmed = await server.trimSessionHistory(session.id, 2);
  const toolMsg = trimmed.messages.find((m) => m.role === 'tool_result');
  assert.ok(toolMsg && toolMsg.role === 'tool_result');
  assert.match(toolMsg.content, /历史工具输出已折叠归档/);
});
