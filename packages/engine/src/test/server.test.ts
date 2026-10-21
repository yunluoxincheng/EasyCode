import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentServer,
  CheckpointManager,
  Mutex,
  WorkspaceLockManager,
  parseCodeRangeMentions,
  resolveCodeRangeMentions
} from '../index.js';
import { MemoryHost } from '@easycode/core';

test('Mutex & WorkspaceLockManager: FIFO 队列互斥与路径标准化', async () => {
  const mutex = new Mutex();
  const log: string[] = [];

  const task = async (name: string, delayMs: number) => {
    return mutex.withLock(async () => {
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, delayMs));
      log.push(`end ${name}`);
    });
  };

  await Promise.all([task('A', 20), task('B', 10), task('C', 5)]);
  assert.deepEqual(log, ['start A', 'end A', 'start B', 'end B', 'start C', 'end C']);

  const wm = new WorkspaceLockManager();
  if (process.platform === 'win32') {
    const lock1 = wm.getLock('E:\\MyProject\\src\\');
    const lock2 = wm.getLock('e:/myproject/src');
    assert.equal(lock1, lock2, 'Windows 路径大小写与分隔符差异应当共享同一 Mutex 实例');
  } else {
    const lock1 = wm.getLock('/workspace/MyProject/src/');
    const lock2 = wm.getLock('/workspace/MyProject/src');
    assert.equal(lock1, lock2, '非 Windows 路径尾斜杠差异应当共享同一 Mutex 实例');
    assert.notEqual(lock1, wm.getLock('/workspace/myproject/src'), '非 Windows 路径应保留大小写差异');
  }
});

test('AgentServer: 多会话并发执行互不阻塞', async () => {
  const host = new MemoryHost({
    '/ws1/file.txt': 'f1',
    '/ws2/file.txt': 'f2',
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

  const [s1, s2] = await Promise.all([
    server.createSession({ workspaceRoot: '/ws1', providerId: 'mock', title: '会话 1' }),
    server.createSession({ workspaceRoot: '/ws2', providerId: 'mock', title: '会话 2' }),
  ]);

  const receivedEvents: Array<{ sessionId: string; type: string }> = [];
  server.onEvent(({ sessionId, event }) => {
    receivedEvents.push({ sessionId, type: event.type });
  });

  // 并发发送消息
  await Promise.all([
    server.sendMessage(s1.id, '会话 1 问题'),
    server.sendMessage(s2.id, '会话 2 问题'),
  ]);

  // 验证两会话均执行完成且互不影响
  const d1 = await server.getSession(s1.id);
  const d2 = await server.getSession(s2.id);

  assert.ok(d1.messages.length >= 2, '会话 1 包含用户与助手消息');
  assert.ok(d2.messages.length >= 2, '会话 2 包含用户与助手消息');

  const s1Done = receivedEvents.some((e) => e.sessionId === s1.id && e.type === 'done');
  const s2Done = receivedEvents.some((e) => e.sessionId === s2.id && e.type === 'done');
  assert.ok(s1Done && s2Done, '两会话均成功收到 done 事件');
});

test('TODOS #38: @file:start-end 行范围引用解析、切片注入与工作区文件预览', async () => {
  const sampleLines = Array.from({ length: 30 }, (_, i) => `const line_${i + 1} = ${i + 1};`).join('\n');
  const host = new MemoryHost({
    '/ws/src/index.ts': sampleLines,
  });

  // 1. 解析语法验证（含单行、区间、逆序自动纠正、防邮箱/URL 误判）
  const mentions = parseCodeRangeMentions(
    '请看 @src/index.ts:5-8 和单行 @src/index.ts:12，忽略邮箱 dev@test.com:8080 与 http://localhost:3000 及逆序 @src/index.ts:20-18',
  );
  assert.equal(mentions.length, 3);
  assert.deepEqual(
    mentions.map((m) => ({ path: m.path, start: m.startLine, end: m.endLine })),
    [
      { path: 'src/index.ts', start: 5, end: 8 },
      { path: 'src/index.ts', start: 12, end: 12 },
      { path: 'src/index.ts', start: 18, end: 20 },
    ],
  );

  // 2. 切片注入验证（带行号标尺与说明文案，越界路径自动忽略）
  const resolved = await resolveCodeRangeMentions(
    host,
    '/ws',
    '优化 @src/index.ts:5-7 以及越界 @../outside.ts:1-3',
  );
  assert.equal(resolved.snippets.length, 1);
  assert.equal(resolved.snippets[0].startLine, 5);
  assert.equal(resolved.snippets[0].endLine, 7);
  assert.equal(resolved.snippets[0].totalLines, 30);
  assert.match(resolved.enrichedText, /用户截取了文件 `src\/index\.ts` 第 5-7 行片段（文件共 30 行）/);
  assert.match(resolved.enrichedText, /    5\| const line_5 = 5;/);
  assert.match(resolved.enrichedText, /    7\| const line_7 = 7;/);
  assert.doesNotMatch(resolved.enrichedText, /const line_8 = 8;/);

  // 3. AgentServer.readWorkspaceFile 预览与越界防护
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
    workspaceRoot: '/ws',
    providerId: 'mock',
    title: '文件预览测试',
  });
  const filePreview = await server.readWorkspaceFile(session.id, 'src/index.ts');
  assert.equal(filePreview.path, 'src/index.ts');
  assert.equal(filePreview.totalLines, 30);
  assert.equal(filePreview.truncated, false);
  await assert.rejects(
    () => server.readWorkspaceFile(session.id, '../outside.ts'),
    /路径越界/,
  );
});

test('TODOS #36 & #38 全链路: 真实工具执行 write_file/edit_file 触发快照、失败/拒绝零脏快照、会话删除清理', async () => {
  const { runAgentLoop, createBuiltinTools, ApprovalManager } = await import('@easycode/core');
  const host = new MemoryHost({
    '/ws/src/app.ts': 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
  });
  const mgr = new CheckpointManager(host);
  const tracker = mgr.beginTurn({
    sessionId: 's_e2e',
    workspaceRoot: '/ws',
    turnNumber: 1,
    userMessageId: 'u_1',
  });

  let step = 0;
  const fakeProvider = {
    id: 'fake',
    async stream() {
      step++;
      if (step === 1) {
        return {
          blocks: [
            { type: 'tool_call' as const, id: 'tc_read', name: 'read_file', input: { path: 'src/app.ts' } },
          ],
        };
      }
      if (step === 2) {
        return {
          blocks: [
            // 1. 正常修改 app.ts (第1次)
            {
              type: 'tool_call' as const,
              id: 'tc_edit_1',
              name: 'edit_file',
              input: { path: 'src/app.ts', old_string: 'const b = 2;', new_string: 'const b = 20;' },
            },
            // 2. 同回合再次修改 app.ts (第2次)
            {
              type: 'tool_call' as const,
              id: 'tc_edit_2',
              name: 'edit_file',
              input: { path: 'src/app.ts', old_string: 'const c = 3;', new_string: 'const c = 30;' },
            },
            // 3. 失败的 edit_file（old_string 不存在，不应产生脏快照）
            {
              type: 'tool_call' as const,
              id: 'tc_edit_fail',
              name: 'edit_file',
              input: { path: 'src/app.ts', old_string: 'NOT_EXIST', new_string: 'x' },
            },
            // 4. 新建文件 helper.ts
            {
              type: 'tool_call' as const,
              id: 'tc_write_new',
              name: 'write_file',
              input: { path: 'src/helper.ts', content: 'export const h = true;\n' },
            },
          ],
        };
      }
      return { blocks: [{ type: 'text' as const, text: '修改完成' }] };
    },
  };

  const messages: any[] = [{ role: 'user', content: '修改代码', id: 'u_1' }];
  const approval = new ApprovalManager(() => {}, 'yolo');
  await runAgentLoop({
    provider: fakeProvider,
    tools: createBuiltinTools(),
    host,
    workspace: '/ws',
    systemPrompt: '',
    messages,
    signal: new AbortController().signal,
    approval,
    emit: () => {},
    onFileChange: (change) => tracker.recordFileChange(change),
  });

  // 验证真实工具执行后，快照精准记录了 2 个文件（失败的 tc_edit_fail 未被记入 toolCallIds）
  const summaries = await mgr.listCheckpoints('s_e2e');
  assert.equal(summaries.length, 1);
  assert.deepEqual(summaries[0].toolCallIds, ['tc_edit_1', 'tc_edit_2', 'tc_write_new']);
  assert.equal(summaries[0].files.length, 2);

  // 验证此刻磁盘为修改后状态
  assert.equal(await host.fs.readFile('/ws/src/app.ts'), 'const a = 1;\nconst b = 20;\nconst c = 30;\n');
  assert.equal(await host.fs.readFile('/ws/src/helper.ts'), 'export const h = true;\n');

  // 执行按单文件部分回退（先只回退 app.ts）
  await mgr.revertTurn('s_e2e', summaries[0].turnId, ['src/app.ts']);
  assert.equal(await host.fs.readFile('/ws/src/app.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  assert.ok(await host.fs.stat('/ws/src/helper.ts'), '未勾选的 helper.ts 此时仍保留');

  // 再全量回退该回合：helper.ts 亦被清理删除
  await mgr.revertTurn('s_e2e', summaries[0].turnId);
  assert.equal(await host.fs.stat('/ws/src/helper.ts'), null);

  // 删除会话快照文件后列表为空
  await mgr.deleteSessionCheckpoints('s_e2e');
  assert.deepEqual(await mgr.listCheckpoints('s_e2e'), []);
});

test('快照首次提交失败：回滚新文件，重启不恢复未提交记录', async () => {
  const { writeFileTool } = await import('@easycode/core');
  const signal = new AbortController().signal;
  const hostGhost = new MemoryHost({});
  const mgrGhost1 = new CheckpointManager(hostGhost);
  const trackerGhost = mgrGhost1.beginTurn({
    sessionId: 's_ghost',
    workspaceRoot: '/ws',
    turnNumber: 1,
    userMessageId: 'u_ghost_1',
  });
  const origRenameGhost = hostGhost.fs.rename!.bind(hostGhost.fs);
  hostGhost.fs.rename = async () => {
    throw new Error('EACCES: rename to target checkpoint json denied');
  };

  await assert.rejects(
    () =>
      writeFileTool.execute(
        { path: 'new.ts', content: 'created_then_aborted' },
        {
          host: hostGhost,
          workspace: '/ws',
          signal,
          readFiles: new Set(),
          callId: 'c_ghost',
          onFileChange: (ev) => trackerGhost.recordFileChange(ev),
        },
      ),
    /文件快照记录或持久化失败，已自动回滚工作区文件 \(new\.ts\) 至修改前状态.*EACCES/,
  );
  assert.equal(await hostGhost.fs.stat('/ws/new.ts'), null, '工作区新建文件已被补偿删除');
  assert.equal(
    await hostGhost.fs.stat('/easycode-demo/checkpoints/s_ghost.json.tmp'),
    null,
    'rename 失败时必须立即清理未提交的 .tmp 文件',
  );

  // 进一步模拟极端崩溃：即使进程在清理前强退导致磁盘上残留了未提交的 .tmp（而正式 s_ghost.json 从未生成），
  // 重启后新实例化的 CheckpointManager 也绝不能将该未提交 .tmp 晋升为正式快照
  await hostGhost.fs.writeFile(
    '/easycode-demo/checkpoints/s_ghost.json.tmp',
    JSON.stringify([
      {
        turnId: 'chk_aborted',
        sessionId: 's_ghost',
        workspaceRoot: '/ws',
        turnNumber: 1,
        userMessageId: 'u_ghost_1',
        toolCallIds: ['c_ghost'],
        createdAt: new Date().toISOString(),
        files: [
          {
            path: 'new.ts',
            existedBefore: false,
            beforeContent: null,
            afterContent: 'created_then_aborted',
            insertions: 1,
            deletions: 0,
          },
        ],
      },
    ]),
  );
  hostGhost.fs.rename = origRenameGhost;
  const mgrGhostRestarted = new CheckpointManager(hostGhost);
  const ghostList = await mgrGhostRestarted.listCheckpoints('s_ghost');
  assert.equal(ghostList.length, 0, '正式快照不存在时，残留的未提交 .tmp 绝不能在重启后被复活为虚假快照');

});

test('撤销状态提交失败：补偿恢复文件，保持快照与工作区一致', async () => {
  const { editFileTool } = await import('@easycode/core');
  const signal = new AbortController().signal;
  const hostUndoFail = new MemoryHost({
    '/ws/app.ts': 'v1_before',
  });
  const mgrUndoFail = new CheckpointManager(hostUndoFail);
  const trackerUndo = mgrUndoFail.beginTurn({
    sessionId: 's_undo_persist_fail',
    workspaceRoot: '/ws',
    turnNumber: 1,
    userMessageId: 'u_undo_1',
  });
  await editFileTool.execute(
    { path: 'app.ts', old_string: 'v1_before', new_string: 'v2_after' },
    {
      host: hostUndoFail,
      workspace: '/ws',
      signal,
      readFiles: new Set(['/ws/app.ts']),
      callId: 'c_undo_edit',
      onFileChange: (ev) => trackerUndo.recordFileChange(ev),
    },
  );
  assert.equal(await hostUndoFail.fs.readFile('/ws/app.ts'), 'v2_after');

  // 2A: 模拟 revertTurn 最后一步 persistSessionRecords 抛错，工作区文件回滚成功
  const origRenameUndo = hostUndoFail.fs.rename!.bind(hostUndoFail.fs);
  hostUndoFail.fs.rename = async () => {
    throw new Error('ENOSPC: disk full when persisting revertedAt');
  };
  await assert.rejects(
    () => mgrUndoFail.revertTurn('s_undo_persist_fail', trackerUndo.turnId),
    /ENOSPC.*已自动回滚本批次前序修改的文件：app\.ts/,
  );
  assert.equal(
    await hostUndoFail.fs.readFile('/ws/app.ts'),
    'v2_after',
    'Undo 状态持久化失败时，工作区文件必须被补偿还原至 Undo 前状态 (v2_after)',
  );
  hostUndoFail.fs.rename = origRenameUndo;
  const summaryAfterUndoRb = (await mgrUndoFail.listCheckpoints('s_undo_persist_fail'))[0];
  assert.equal(summaryAfterUndoRb.revertedAt, undefined, '快照状态保持未回退，与工作区真实内容严格一致');

});
