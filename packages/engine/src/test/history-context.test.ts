import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryHost, type ChatMessage, type SessionData } from '@easycode/core';
import { AgentServer } from '../server.js';

/** 协议级持久化历史：长输出仅用于检验原文与上下文的不同存储契约。 */
async function loadHistory(turns: number) {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push(
      { role: 'user', id: `u_${i}`, content: `requirement-${i}` },
      { role: 'assistant', id: `a_${i}`, blocks: [{
        type: 'tool_call', id: `call_${i}`, name: 'read_file', input: { path: `file-${i}.txt` },
      }] },
      { role: 'tool_result', id: `r_${i}`, toolCallId: `call_${i}`, toolName: 'read_file',
        approved: true, content: `original-output-${i}\n${'long original tool output\n'.repeat(180)}` },
      { role: 'assistant', id: `f_${i}`, blocks: [{ type: 'text', text: `reply-${i}` }] },
    );
  }
  const id = `s_history_${turns}`;
  const data: SessionData = {
    meta: { id, title: 'history', providerId: 'mock', model: 'mock-model', workspaceRoot: '/ws',
      createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z' },
    messages,
  };
  const host = new MemoryHost({
    '/ws/readme.txt': 'workspace',
    [`/easycode-demo/sessions/${id}.json`]: JSON.stringify(data),
  });
  const server = new AgentServer(host);
  await server.updateSettings({ providers: {
    mock: { kind: 'mock', baseURL: '', models: [{ name: 'mock-model' }] },
  }, defaultProvider: 'mock' });
  await server.listSessions();
  return { host, server, id, original: structuredClone(messages) };
}

test('短历史手动裁剪：保留原始工具输出，重载与重复压缩均不覆盖归档', async () => {
  const { host, server, id, original } = await loadHistory(2);
  const compacted = await server.trimSessionHistory(id);
  assert.deepEqual(compacted.history, original, '仅裁剪工具输出时也必须提交未裁剪原文');
  const output = compacted.messages.find((message) => message.id === 'r_0');
  assert.ok(original[2].role === 'tool_result');
  assert.ok(output?.role === 'tool_result' && output.content.length < original[2].content.length);
  assert.equal(compacted.messages.filter((message) => message.role === 'user').length, 2);

  const restarted = new AgentServer(host);
  await restarted.listSessions();
  const reloaded = await restarted.getSession(id);
  assert.deepEqual(reloaded.history, original);
  assert.deepEqual(reloaded.messages, compacted.messages, '裁剪结果与原文必须同时落盘');
  await restarted.trimSessionHistory(id);
  assert.deepEqual((await restarted.getSession(id)).history, original);

  const unchanged = await loadHistory(1);
  const oneTurn = await unchanged.server.trimSessionHistory(unchanged.id);
  assert.deepEqual(oneTurn.messages, unchanged.original);
  assert.equal(oneTurn.history, undefined, '无变化时不创建重复归档');
});

test('压缩历史分叉：保留模型边界与锚点前缀，编辑重生成后重载排除旧上下文', async () => {
  const { host, server, id, original } = await loadHistory(30);
  const parent = await server.trimSessionHistory(id, 2);
  const context = structuredClone(parent.messages);
  const whole = await server.forkSession(id);
  const forked = await server.getSession(whole.id);
  assert.deepEqual(forked.messages, context, '完整分叉不能恢复 30 轮原文到模型上下文');
  assert.deepEqual(forked.history, original);

  const nested = await server.forkSession(whole.id);
  assert.deepEqual((await server.getSession(nested.id)).messages, context);
  const prefix = await server.forkSession(id, { beforeUserIndex: 8 });
  const anchored = await server.getSession(prefix.id);
  assert.equal(anchored.history?.filter((message) => message.role === 'user').length, 8);
  assert.equal(anchored.messages.filter((message) => message.role === 'user').length, 3);
  assert.equal(JSON.stringify(anchored.messages).includes('file-29.txt'), false);

  const afterCall = await server.forkSession(id, { upToMessageId: 'a_4' });
  const paired = await server.getSession(afterCall.id);
  assert.equal(paired.history?.at(-1)?.id, 'r_4', '工具结果必须随锚点保留配对');
  assert.equal(paired.messages.filter((message) => message.role === 'user').length, 3);
  assert.equal(JSON.stringify(paired.messages).includes('file-5.txt'), false);

  await server.editUserMessage(prefix.id, 'u_2', 'updated requirement');
  const edited = structuredClone(await server.getSession(prefix.id));
  assert.deepEqual(edited.history?.filter((message) => message.role === 'user').map((message) => message.content),
    ['requirement-0', 'requirement-1', 'updated requirement']);
  assert.equal(JSON.stringify(edited.messages).includes('requirement-3'), false);
  const restarted = new AgentServer(host);
  await restarted.listSessions();
  assert.deepEqual(await restarted.getSession(prefix.id), JSON.parse(JSON.stringify(edited)));
  assert.deepEqual((await restarted.getSession(id)).history, original, '分叉/编辑不修改父会话原文');
});
