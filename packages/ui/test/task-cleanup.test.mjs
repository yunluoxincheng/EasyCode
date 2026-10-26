import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

// Vite 不输出 Store 的独立 JS；编译实际源码，不复制或替换归约逻辑。
const source = await readFile(new URL('../src/store.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
} }).outputText.replace(/from ["'](@easycode\/(?:engine|core))["']/g, (_, name) => `from ${JSON.stringify(import.meta.resolve(name))}`);
const { AppStore } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('工具生成 Store：并行分片保留独立计时，稳定选中未完成调用并按回合清理', (t) => {
  let dispatch;
  const store = new AppStore({ onEvent: (listener) => { dispatch = listener; } });
  t.after(() => store.flushPendingNotify());
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  store.activeId = 's1';
  const send = (event, sessionId = 's1') => dispatch({ sessionId, event });
  const progress = (callId, argumentChars, argumentsComplete = false) =>
    ({ type: 'tool_call_preparing', callId, name: callId, argumentChars, argumentsComplete });
  send({ type: 'assistant_start' });
  send(progress('A', 1));
  now = 2000;
  send(progress('B', 2));
  assert.equal(store.preparingTool.callId, 'A', '后来的并行调用不抢占展示');
  now = 3000;
  send(progress('A', 3));
  now = 4000;
  send(progress('B', 4));
  assert.equal(store.preparingTool.startedAt, 1000);
  assert.equal(store.preparingTool.argumentChars, 3);
  send(progress('A', 3, true));
  assert.equal(store.preparingTool.callId, 'B');
  assert.equal(store.preparingTool.startedAt, 2000, '切换展示仍沿用 B 的原始开始时间');
  assert.equal(store.preparingTool.lastProgressAt, 4000);
  assert.equal(store.preparingTool.argumentChars, 4);
  send({ type: 'assistant_start' }, 's2');
  send(progress('A', 99), 's2');
  assert.equal(store.preparingTool.callId, 'B', '后台会话不能覆盖当前调用');
  store.activeId = 's2';
  assert.equal(store.preparingTool.argumentChars, 99);
  store.activeId = 's1';
  send(progress('B', 4, true));
  assert.equal(store.preparingTool.argumentsComplete, true);
  for (const boundary of [
    { type: 'assistant_start' }, { type: 'step_end' },
    { type: 'tool_call_start', call: { id: 'A', name: 'A', input: {} } },
    { type: 'error', message: 'interrupted' }, { type: 'done', reason: 'aborted' },
  ]) {
    send({ type: 'assistant_start' });
    now += 1000;
    send(progress('A', 0));
    assert.equal(store.preparingTool.startedAt, now, '新回合重用 ID 不沿用旧计时');
    send(boundary);
    assert.equal(store.preparingTool, undefined);
    assert.equal(store.sessionStates.get('s1').preparingTools, undefined);
  }
});

test('后台任务 Store：删除后的旧快照不复活记录，空列表继续刷新且会话隔离', async (t) => {
  let dispatch;
  let resolveSnapshot;
  const snapshot = new Promise((resolve) => { resolveSnapshot = resolve; });
  const client = {
    onEvent: (listener) => { dispatch = listener; },
    listBackgroundTasks: async () => snapshot,
  };
  const store = new AppStore(client);
  t.after(() => { if (store.bgPollTimer !== null) clearInterval(store.bgPollTimer); });
  const task = { id: 's1:old', command: 'server', startedAt: 1, status: 'running', urls: [], outputBytes: 0 };
  const remaining = { ...task, id: 's1:remaining' };
  const state = store.getOrCreateSessionState('s1');
  store.activeId = 's1';
  state.bgTasks = [task];
  store.bgTasks = [task];
  store.taskDrawerOpen = store.previewOpen = true;
  store.taskDrawerTaskId = store.previewTaskId = task.id;
  const polling = store.refreshBackgroundTasks();
  dispatch({ sessionId: 's1', event: { type: 'background_task', action: 'removed', task } });
  resolveSnapshot([task, remaining]);
  await polling;
  assert.deepEqual(store.bgTasks, [], '旧快照不能恢复已移除任务');
  assert.equal(store.taskDrawerOpen, false);
  assert.equal(store.previewOpen, false);
  assert.equal(store.bgRefreshNeeded.has('s1'), true);
  assert.notEqual(store.bgPollTimer, null, '尚未取得新快照时继续轮询');
  client.listBackgroundTasks = async () => [remaining];
  await store.refreshBackgroundTasks();
  assert.deepEqual(store.bgTasks, [remaining]);
  assert.equal(store.bgRefreshNeeded.has('s1'), false);

  let resolveLate;
  client.listBackgroundTasks = () => new Promise((resolve) => { resolveLate = resolve; });
  const oldSessionPoll = store.refreshBackgroundTasks('s1');
  const other = { ...task, id: 's2:other' };
  store.activeId = 's2';
  store.getOrCreateSessionState('s2').bgTasks = [other];
  store.bgTasks = [other];
  store.taskDrawerOpen = store.previewOpen = true;
  store.taskDrawerTaskId = store.previewTaskId = other.id;
  dispatch({ sessionId: 's1', event: { type: 'background_task', action: 'removed', task: remaining } });
  resolveLate([remaining]);
  await oldSessionPoll;
  assert.deepEqual(state.bgTasks, []);
  assert.deepEqual(store.bgTasks, [other], '旧会话结果不能覆盖当前会话');
  assert.equal(store.taskDrawerTaskId, other.id);
  assert.equal(store.taskDrawerOpen, true);
  assert.equal(store.previewTaskId, other.id);
  assert.equal(store.previewOpen, true);
});
