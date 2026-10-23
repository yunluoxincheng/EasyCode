import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

// Vite 不输出 Store 的独立 JS；编译实际源码，不复制或替换归约逻辑。
const source = await readFile(new URL('../src/store.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
} }).outputText.replace(/from ["']@easycode\/engine["']/g, `from ${JSON.stringify(import.meta.resolve('@easycode/engine'))}`);
const { AppStore } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

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
