import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentServer,
  CheckpointManager,
  Mutex,
  WorkspaceLockManager,
  parseCodeRangeMentions,
  resolveCodeRangeMentions,
} from '../index.js';
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
  const lock1 = wm.getLock('E:\\MyProject\\src\\');
  const lock2 = wm.getLock('e:/myproject/src');
  assert.equal(lock1, lock2, '不同格式的相同路径应当共享同一 Mutex 实例');
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

test('AgentServer & buildSystemPrompt: 项目规范自动探测、初始化与提示词注入 (TODOS #33)', async () => {
  const host = new MemoryHost({
    '/project1/.easycoderules': '# Project 1 Rules\n- 必须使用 pnpm\n- 严禁使用全局变量',
    '/project2/AGENTS.md': '# Project 2 Directives\n- 优先函数式编程',
    '/project3/README.md': '# Project 3 without rules',
  });

  const server = new AgentServer(host);

  // 1. 探测优先匹配 .easycoderules
  const r1 = await server.getProjectRules('/project1');
  assert.ok(r1);
  assert.equal(r1.path, '.easycoderules');
  assert.ok(r1.content.includes('必须使用 pnpm'));

  // 2. 探测兼容匹配 AGENTS.md
  const r2 = await server.getProjectRules('/project2');
  assert.ok(r2);
  assert.equal(r2.path, 'AGENTS.md');
  assert.ok(r2.content.includes('优先函数式编程'));

  // 3. 无规则项目返回 null
  const r3 = await server.getProjectRules('/project3');
  assert.equal(r3, null);

  // 4. 一键初始化生成 .easycoderules
  const initRes = await server.initProjectRules('/project3');
  assert.ok(initRes);
  assert.equal(initRes.path, '.easycoderules');
  assert.ok(initRes.content.includes('项目行为规范'));

  // 再次探测即命中新初始化的规则
  const r3After = await server.getProjectRules('/project3');
  assert.ok(r3After);
  assert.equal(r3After.path, '.easycoderules');

  // 5. 验证 buildSystemPrompt 挂载规范
  const { buildSystemPrompt } = await import('../prompts.js');
  const prompt = buildSystemPrompt(host, '/project1', {
    rules: {
      projectRules: r1,
      globalRules: '回复必须简洁',
    },
  });
  assert.ok(prompt.includes('# 项目规范 (.easycoderules)'), '提示词包含项目规范章节');
  assert.ok(prompt.includes('必须使用 pnpm'), '提示词包含规范内容');
  assert.ok(prompt.includes('# 全局开发偏好'), '提示词包含全局偏好章节');
  assert.ok(prompt.includes('回复必须简洁'), '提示词包含全局偏好内容');
});

test('AgentServer: 工作区自定义指令 .easycode/prompts/*.md 扫描 (TODOS #32)', async () => {
  const host = new MemoryHost({
    '/ws/.easycode/prompts/deploy.md': '# 部署到生产环境\n请检查 build 产物并执行部署脚本。',
    '/ws/.easycode/prompts/audit.md': '代码合规性与依赖安全审计\n检查 package.json 依赖安全漏洞。',
  });

  const server = new AgentServer(host);

  const prompts = await server.listCustomPrompts('/ws');
  assert.equal(prompts.length, 2);

  const deploy = prompts.find((p) => p.id === 'deploy');
  assert.ok(deploy);
  assert.equal(deploy.name, '/deploy');
  assert.equal(deploy.description, '部署到生产环境');
  assert.ok(deploy.template.includes('执行部署脚本'));

  const audit = prompts.find((p) => p.id === 'audit');
  assert.ok(audit);
  assert.equal(audit.name, '/audit');
  assert.equal(audit.description, '代码合规性与依赖安全审计');

  // 无 prompts 目录时返回空数组
  const empty = await server.listCustomPrompts('/nonexistent');
  assert.deepEqual(empty, []);
});

test('AgentServer: 影子模式开关开启时执行 policy 并记录，开关关闭时零旁路开销', async () => {
  const host = new MemoryHost({
    '/ws/file.txt': 'test',
  });
  const server = new AgentServer(host);

  let decideCalls = 0;
  const mockPolicy = {
    async decide(req: any) {
      decideCalls++;
      return {
        selectedId: req.candidates[0].id,
        selectedText: req.candidates[0].text,
        confidence: 0.95,
        defer: false,
        scores: Object.fromEntries(req.candidates.map((c: { id: string }, i: number) => [
          c.id, i === 0 ? 0.95 : 0.05 / (req.candidates.length - 1),
        ])),
        latencyMs: 15.5,
      };
    },
  };
  server.setReflexPolicy(mockPolicy);

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
    reflexShadowMode: false,
  });

  const session = await server.createSession({ workspaceRoot: '/ws', providerId: 'mock', title: '测试会话' });
  await server.setApprovalMode(session.id, 'yolo');

  // 1. 关闭状态下发消息：decideCalls 应保持为 0，零记录
  await server.sendMessage(session.id, '请帮我写个函数');
  assert.equal(decideCalls, 0, '开关关闭时 policy 绝不调用');
  const statsOff = await server.getDecisionStats();
  assert.equal(statsOff.totalDecisions, 0, '开关关闭时零日志写入');

  // 2. 开启影子模式：decideCalls 应该增加，并且成功落盘记录
  await server.updateSettings({ reflexShadowMode: true });
  await server.sendMessage(session.id, '再写一个测试用例');
  assert.ok(decideCalls > 0, '开启开关后执行真实决策推理');
  const statsOn = await server.getDecisionStats();
  assert.ok(statsOn.totalDecisions > 0, '开启开关后成功落盘审计日志');
  assert.ok(statsOn.avgLatencyMs > 0, '包含真实推理耗时');
  assert.ok(statsOn.taskFamilyDistribution.tool_routing! > 0, '必须包含无泄漏的前置工具路由预测');

  // 验证导出的微调集：只导出证据充足的合格样本，每一行都有合法 target
  const finetuneJsonl = await server.exportDecisionDataset({ sessionId: session.id });
  if (finetuneJsonl.trim()) {
    for (const line of finetuneJsonl.trim().split('\n')) {
      const parsed = JSON.parse(line);
      assert.equal(parsed.schema_version, 1);
      assert.ok(parsed.target, '导出的微调样本必须具备 target');
      assert.equal(typeof parsed.target.defer, 'boolean');
      assert.ok(Array.isArray(parsed.target.selected));
      assert.ok(parsed.split_group.startsWith('online:'));
    }
  }
});

test('多回合任务与 Action Trace 边界：上一任务的操作绝不泄漏进新任务的前置路由中', async () => {
  const host = new MemoryHost({
    '/ws/file.txt': 'initial text',
  });
  const server = new AgentServer(host);

  const capturedRoutingStates: any[] = [];
  const mockPolicy = {
    async decide(req: any) {
      if (req.taskFamily === 'tool_routing') {
        capturedRoutingStates.push(JSON.parse(JSON.stringify(req.state)));
      }
      return {
        selectedId: req.candidates[0].id,
        selectedText: req.candidates[0].text,
        confidence: 0.9,
        defer: false,
        scores: Object.fromEntries(req.candidates.map((c: { id: string }, i: number) => [
          c.id, i === 0 ? 0.9 : 0.1 / (req.candidates.length - 1),
        ])),
        latencyMs: 10,
      };
    },
  };
  server.setReflexPolicy(mockPolicy);

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
    reflexShadowMode: true,
  });

  const session = await server.createSession({ workspaceRoot: '/ws', providerId: 'mock', title: '多回合会话' });
  await server.setApprovalMode(session.id, 'yolo');

  // 第 1 个回合任务
  await server.sendMessage(session.id, '任务一：请列出当前目录');
  const task1RoutingCount = capturedRoutingStates.length;
  assert.ok(task1RoutingCount > 0);

  // 第 2 个回合任务：起始第一步的 Action Trace 必须为空（以当前用户回合为边界）
  capturedRoutingStates.length = 0;
  await server.sendMessage(session.id, '任务二：请总结当前项目');
  assert.ok(capturedRoutingStates.length > 0);
  const task2FirstStepState = capturedRoutingStates[0];
  // 必须只反映任务二的用户意图，历史动作绝不混入任务一的工具调用
  assert.match(task2FirstStepState.summary, /任务二/);
  assert.deepEqual(task2FirstStepState.history, [], '新任务起始步的 Action Trace 必须为空，绝不混入上一任务');
});

test('TODOS #36: CheckpointManager 同回合多次修改基准保持、冲突检测与安全回退（含新建文件删除）', async () => {
  const host = new MemoryHost({
    '/ws/src/a.ts': 'line1\nline2\nline3\n',
    '/ws/src/b.ts': 'const x = 1;\n',
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
    workspaceRoot: '/ws',
    providerId: 'mock',
    title: '快照回退测试',
  });

  // 直接验证 CheckpointManager 在回合内多次修改同一文件与新建文件的行为
  const mgr = new CheckpointManager(host);
  const turn1 = mgr.beginTurn({
    sessionId: session.id,
    workspaceRoot: '/ws',
    turnNumber: 1,
    userMessageId: 'u_turn_1',
  });

  // 第 1 次修改 a.ts: v0 -> v1
  await host.fs.writeFile('/ws/src/a.ts', 'line1\nline2_v1\nline3\n');
  await turn1.recordFileChange({
    callId: 'call_1',
    relPath: 'src/a.ts',
    absPath: '/ws/src/a.ts',
    existedBefore: true,
    beforeContent: 'line1\nline2\nline3\n',
    afterContent: 'line1\nline2_v1\nline3\n',
  });

  // 同回合第 2 次修改 a.ts: v1 -> v2（基准必须保持为 v0）
  await host.fs.writeFile('/ws/src/a.ts', 'line1\nline2_v2\nline3\nline4\n');
  await turn1.recordFileChange({
    callId: 'call_2',
    relPath: 'src/a.ts',
    absPath: '/ws/src/a.ts',
    existedBefore: true,
    beforeContent: 'line1\nline2_v1\nline3\n',
    afterContent: 'line1\nline2_v2\nline3\nline4\n',
  });

  // 同回合新建 c.ts（existedBefore = false）
  await host.fs.writeFile('/ws/src/c.ts', 'export const c = 42;\n');
  await turn1.recordFileChange({
    callId: 'call_3',
    relPath: 'src/c.ts',
    absPath: '/ws/src/c.ts',
    existedBefore: false,
    beforeContent: null,
    afterContent: 'export const c = 42;\n',
  });

  const list1 = await mgr.listCheckpoints(session.id);
  assert.equal(list1.length, 1);
  assert.equal(list1[0].files.length, 2);
  assert.deepEqual(list1[0].toolCallIds, ['call_1', 'call_2', 'call_3']);

  // 开启第 2 回合，再次修改 a.ts，制造跨回合冲突
  const turn2 = mgr.beginTurn({
    sessionId: session.id,
    workspaceRoot: '/ws',
    turnNumber: 2,
    userMessageId: 'u_turn_2',
  });
  await host.fs.writeFile('/ws/src/a.ts', 'line1\nline2_turn2\n');
  await turn2.recordFileChange({
    callId: 'call_4',
    relPath: 'src/a.ts',
    absPath: '/ws/src/a.ts',
    existedBefore: true,
    beforeContent: 'line1\nline2_v2\nline3\nline4\n',
    afterContent: 'line1\nline2_turn2\n',
  });

  // 预览第 1 回合的回退：应检测到 a.ts 在第 2 回合被修改过，而 c.ts 无冲突
  const preview1 = await server.previewTurnUndo(session.id, turn1.turnId);
  assert.equal(preview1.turnNumber, 1);
  assert.equal(preview1.hasConflicts, true);
  const fileA = preview1.files.find((f) => f.path === 'src/a.ts')!;
  const fileC = preview1.files.find((f) => f.path === 'src/c.ts')!;
  assert.equal(fileA.modifiedInLaterTurns, true);
  assert.deepEqual(fileA.laterTurnNumbers, [2]);
  assert.equal(fileA.diskDiverged, true);
  assert.equal(fileC.existedBefore, false);
  assert.equal(fileC.modifiedInLaterTurns, false);
  assert.equal(fileC.diskDiverged, false);

  // 执行第 1 回合回退：a.ts 应回到第 1 回合前的原始版本，新建的 c.ts 应被删除，会话应追加回退系统通知
  const undoRes = await server.revertTurnCheckpoint(session.id, turn1.turnId);
  assert.deepEqual(undoRes.revertedPaths.sort(), ['src/a.ts', 'src/c.ts']);
  const aContentAfterUndo = await host.fs.readFile('/ws/src/a.ts');
  assert.equal(aContentAfterUndo, 'line1\nline2\nline3\n');
  const cStatAfterUndo = await host.fs.stat('/ws/src/c.ts');
  assert.equal(cStatAfterUndo, null, '本回合新建的文件在回退后应被删除');

  const lastMsg = undoRes.session.messages[undoRes.session.messages.length - 1];
  assert.equal(lastMsg.role, 'assistant');
  if (lastMsg.role === 'assistant') {
    const text = lastMsg.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    assert.match(text, /已撤销第 1 回合的文件变更/);
  }
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
