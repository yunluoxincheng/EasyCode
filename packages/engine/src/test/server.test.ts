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
