import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentServer,
  CheckpointManager,
  Mutex,
  WorkspaceLockManager,
  parseCodeRangeMentions,
  resolveCodeRangeMentions,
  formatFileMention,
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

  // P1 #3 验证：存在跨回合修改冲突时，未传 force=true 必须被 CAS 校验拦截，绝不静默覆盖
  await assert.rejects(
    () => server.revertTurnCheckpoint(session.id, turn1.turnId),
    /\[CONFLICT\] 检测到文件在回退前已被修改/,
  );
  assert.equal(await host.fs.readFile('/ws/src/a.ts'), 'line1\nline2_turn2\n', 'CAS 拦截后文件保持原样未被覆盖');

  // 显式传入 force: true 执行第 1 回合强制回退：a.ts 回到第 1 回合前的原始版本，新建的 c.ts 被删除
  const undoRes = await server.revertTurnCheckpoint(session.id, turn1.turnId, { force: true });
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

test('审查回归 (P1 #1/#2/#3 & P2 #4/#5/#6/#7/#8/#9): 跨工作区锁一致性、unlink 失败上报、分步部分回退、编辑重发清理、防历史漂移与真实 NodeHost 验证', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { NodeHost } = await import('@easycode/host-node');
  const { writeFileTool } = await import('@easycode/core');

  // 1. P2 #5: 含空格路径的引号转义与解析闭环
  const quotedToken = formatFileMention('src/my file.ts', '10-12');
  assert.equal(quotedToken, '@"src/my file.ts":10-12');
  const parsedQuoted = parseCodeRangeMentions(`请检查 ${quotedToken} 的实现`);
  assert.equal(parsedQuoted.length, 1);
  assert.equal(parsedQuoted[0].path, 'src/my file.ts');
  assert.equal(parsedQuoted[0].startLine, 10);
  assert.equal(parsedQuoted[0].endLine, 12);

  // 2. P1 #2: unlink 失败或不支持时绝不吞错谎报成功
  const hostNoUnlink = new MemoryHost({ '/ws/new.ts': 'hello' });
  const mgrNoUnlink = new CheckpointManager(hostNoUnlink);
  const tNoUnlink = mgrNoUnlink.beginTurn({
    sessionId: 's_unlink',
    workspaceRoot: '/ws',
    turnNumber: 1,
    userMessageId: 'u_1',
  });
  await tNoUnlink.recordFileChange({
    callId: 'c_1',
    relPath: 'new.ts',
    absPath: '/ws/new.ts',
    existedBefore: false,
    beforeContent: null,
    afterContent: 'hello',
  });
  // 模拟 unlink 抛错且文件仍在磁盘上
  hostNoUnlink.fs.unlink = async () => {
    throw new Error('EBUSY: resource busy or locked');
  };
  await assert.rejects(
    () => mgrNoUnlink.revertTurn('s_unlink', tNoUnlink.turnId),
    /删除新建文件失败 \(new\.ts\): EBUSY/,
  );
  const afterFailSummary = (await mgrNoUnlink.listCheckpoints('s_unlink'))[0];
  assert.equal(afterFailSummary.revertedAt, undefined, '删除失败时绝不能将快照标记为已撤销');

  // 3. P2 #4: 分三次部分回退 A、B、C 后，整回合自动标记 revertedAt
  const hostPartial = new MemoryHost({
    '/ws/a.ts': 'a1',
    '/ws/b.ts': 'b1',
    '/ws/c.ts': 'c1',
  });
  const mgrPartial = new CheckpointManager(hostPartial);
  const tPartial = mgrPartial.beginTurn({
    sessionId: 's_partial',
    workspaceRoot: '/ws',
    turnNumber: 1,
    userMessageId: 'u_p1',
  });
  for (const name of ['a.ts', 'b.ts', 'c.ts']) {
    await tPartial.recordFileChange({
      callId: `call_${name}`,
      relPath: name,
      absPath: `/ws/${name}`,
      existedBefore: true,
      beforeContent: `${name[0]}0`,
      afterContent: `${name[0]}1`,
    });
  }
  await mgrPartial.revertTurn('s_partial', tPartial.turnId, ['a.ts']);
  assert.equal((await mgrPartial.listCheckpoints('s_partial'))[0].revertedAt, undefined);
  await mgrPartial.revertTurn('s_partial', tPartial.turnId, ['b.ts']);
  assert.equal((await mgrPartial.listCheckpoints('s_partial'))[0].revertedAt, undefined);
  await mgrPartial.revertTurn('s_partial', tPartial.turnId, ['c.ts']);
  const finalPartial = (await mgrPartial.listCheckpoints('s_partial'))[0];
  assert.ok(finalPartial.revertedAt, '所有文件分批恢复完成后，整回合必须标记 revertedAt');

  // 若恢复后文件又被外部修改，listCheckpoints 动态复核时应自动清除已失效的 revertedAt 标记
  await hostPartial.fs.writeFile('/ws/a.ts', 'MODIFIED_AGAIN_AFTER_REVERT');
  const afterReModify = (await mgrPartial.listCheckpoints('s_partial'))[0];
  assert.equal(afterReModify.revertedAt, undefined, '恢复后文件再次被修改时，不应继续维持已撤销标记');

  // P1 #3 进阶验证：即使传入 force: true，若打开预览后磁盘指纹又发生变化（expectedFingerprints 不匹配），同样必须拦截
  const previewBeforeEdit = await mgrPartial.previewUndo('s_partial', tPartial.turnId);
  const fpMap: Record<string, string> = {};
  for (const f of previewBeforeEdit.files) fpMap[f.path] = f.diskFingerprint;
  await hostPartial.fs.writeFile('/ws/a.ts', 'CHANGED_WHILE_MODAL_OPEN');
  await assert.rejects(
    () =>
      mgrPartial.revertTurn('s_partial', tPartial.turnId, {
        paths: ['a.ts'],
        force: true,
        expectedFingerprints: fpMap,
      }),
    /检测到文件在打开预览后又被修改/,
  );

  // 4. P2 #9: write_file 在读取原文件快照失败时中止覆盖写入，绝不伪造空字符串基准
  const hostReadFail = new MemoryHost({ '/ws/important.ts': 'PRECIOUS_CONTENT' });
  const readFiles = new Set<string>(['/ws/important.ts']);
  hostReadFail.fs.readFile = async () => {
    throw new Error('EACCES: permission denied');
  };
  let fileChangedCalled = false;
  await assert.rejects(
    () =>
      writeFileTool.execute(
        { path: 'important.ts', content: 'NEW_CONTENT' },
        {
          host: hostReadFail,
          workspace: '/ws',
          signal: new AbortController().signal,
          readFiles,
          onFileChange: () => {
            fileChangedCalled = true;
          },
        },
      ),
    /读取原文件快照失败，已中止覆盖写入以保护原文件/,
  );
  assert.equal(fileChangedCalled, false, '读取原文件失败时绝不能触发快照记录或覆盖原文件');

  // 5. P1 #1 + P2 #6 + P2 #7 + P2 #8: 工作区切换加锁一致性、编辑重发清理旧快照、历史行范围引用防漂移、大文件 stat 前置拦截
  const hostServer = new MemoryHost({
    '/wsA/main.ts': 'lineA1\nlineA2\nlineA3\n',
    '/wsB/other.ts': 'lineB1\n',
  });
  const server = new AgentServer(hostServer);
  // 注入零延迟测试 Provider 避免 MockProvider 打字机模拟耗时
  (server as any).createProvider = () => ({
    id: 'instant-mock',
    async stream() {
      return { blocks: [{ type: 'text' as const, text: 'ok' }] };
    },
  });
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
  const sSwitch = await server.createSession({
    workspaceRoot: '/wsA',
    providerId: 'mock',
    title: '跨工作区与防漂移会话',
  });

  // 发送首轮带 @main.ts:1-2 引用的消息
  await server.sendMessage(sSwitch.id, '请分析 @main.ts:1-2');
  const sDataAfterTurn1 = await server.getSession(sSwitch.id);
  const firstUserMsg = sDataAfterTurn1.messages.find((m) => m.role === 'user');
  assert.ok(firstUserMsg && firstUserMsg.role === 'user');
  assert.match(firstUserMsg.rangeContext ?? '', /lineA1/, '首轮发送时固化 rangeContext 快照');

  // 修改磁盘上的 /wsA/main.ts，验证第 2 轮发送时第 1 轮的 rangeContext 不会漂移成新内容
  await hostServer.fs.writeFile('/wsA/main.ts', 'DRIFTED_LINE_1\nDRIFTED_LINE_2\n');
  await server.sendMessage(sSwitch.id, '第二轮普通提问');
  const sDataAfterTurn2 = await server.getSession(sSwitch.id);
  const firstUserMsgAfterTurn2 = sDataAfterTurn2.messages.find((m) => m.role === 'user');
  assert.ok(firstUserMsgAfterTurn2 && firstUserMsgAfterTurn2.role === 'user');
  assert.match(firstUserMsgAfterTurn2.rangeContext ?? '', /lineA1/, '历史轮次的 rangeContext 保持发送时快照，不发生历史漂移');
  assert.doesNotMatch(firstUserMsgAfterTurn2.rangeContext ?? '', /DRIFTED_LINE_1/);

  // P2 #6: 在第 2 轮挂一个快照，然后调用 editLastUserMessage，验证第 2 轮的旧快照被清理
  const internalCheckpoints = (server as any).checkpoints as CheckpointManager;
  const t2Tracker = internalCheckpoints.beginTurn({
    sessionId: sSwitch.id,
    workspaceRoot: '/wsA',
    turnNumber: 2,
    userMessageId: sDataAfterTurn2.messages.filter((m) => m.role === 'user')[1].id!,
  });
  await t2Tracker.recordFileChange({
    callId: 'c_t2',
    relPath: 'main.ts',
    absPath: '/wsA/main.ts',
    existedBefore: true,
    beforeContent: 'lineA1\nlineA2\nlineA3\n',
    afterContent: 'DRIFTED_LINE_1\nDRIFTED_LINE_2\n',
  });
  assert.equal((await server.listTurnCheckpoints(sSwitch.id)).length, 1);
  await server.editLastUserMessage(sSwitch.id, '编辑重发第二轮提问（无文件修改）');
  assert.equal(
    (await server.listTurnCheckpoints(sSwitch.id)).length,
    0,
    '编辑重发截断旧回合后，被截断回合的残留快照必须被清理',
  );

  // P1 #1: 在 /wsA 记录快照后，将会话工作区切换至 /wsB，验证回退时锁定的是 /wsA 而非 /wsB
  const tSwitchTracker = internalCheckpoints.beginTurn({
    sessionId: sSwitch.id,
    workspaceRoot: '/wsA',
    turnNumber: 2,
    userMessageId: 'u_wsA',
  });
  await tSwitchTracker.recordFileChange({
    callId: 'c_wsA',
    relPath: 'main.ts',
    absPath: '/wsA/main.ts',
    existedBefore: true,
    beforeContent: 'ORIG_WSA',
    afterContent: 'DRIFTED_LINE_1\nDRIFTED_LINE_2\n',
  });
  await server.setSessionWorkspace(sSwitch.id, '/wsB');
  const wsLocks = (server as any).workspaceLocks as WorkspaceLockManager;
  const eventsOrder: string[] = [];
  const holdWsALock = wsLocks.getLock('/wsA').withLock(async () => {
    eventsOrder.push('wsA_lock_held');
    await new Promise((r) => setTimeout(r, 25));
    eventsOrder.push('wsA_lock_released');
  });
  const revertPromise = server
    .revertTurnCheckpoint(sSwitch.id, tSwitchTracker.turnId)
    .then(() => {
      eventsOrder.push('revert_done');
    });
  await Promise.all([holdWsALock, revertPromise]);
  assert.deepEqual(
    eventsOrder,
    ['wsA_lock_held', 'wsA_lock_released', 'revert_done'],
    '即使会话已切到 /wsB，回退 /wsA 的快照仍必须等待 /wsA 的互斥锁',
  );
  assert.equal(await hostServer.fs.readFile('/wsA/main.ts'), 'ORIG_WSA');

  // P2 #8: 超大文件 (> 2MB) 在 stat 阶段即被前置拦截，不调用 readFile 读入内存
  let hugeReadCalled = false;
  const origStat = hostServer.fs.stat.bind(hostServer.fs);
  const origRead = hostServer.fs.readFile.bind(hostServer.fs);
  hostServer.fs.stat = async (p: string) => {
    if (p.endsWith('huge.log')) return { isDirectory: false, size: 5 * 1024 * 1024, mtimeMs: 0 };
    return origStat(p);
  };
  hostServer.fs.readFile = async (p: string) => {
    if (p.endsWith('huge.log')) hugeReadCalled = true;
    return origRead(p);
  };
  const hugeRangeRes = await resolveCodeRangeMentions(hostServer, '/wsB', '查看 @huge.log:1-10');
  assert.equal(hugeRangeRes.snippets.length, 0);
  assert.equal(hugeReadCalled, false, '超过 2MB 的文件在 resolveCodeRangeMentions 中必须在 stat 阶段前置跳过，不触发 readFile');
  await assert.rejects(
    () => server.readWorkspaceFile(sSwitch.id, 'huge.log'),
    /文件体积过大/,
  );
  assert.equal(hugeReadCalled, false, '超过 2MB 的文件在 readWorkspaceFile 中必须在 stat 阶段前置拒绝，不触发 readFile');

  // 6. 真实 NodeHost 临时目录端到端验证（落盘快照、预览与回退删除新建文件）
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'easycode-chk-test-'));
  try {
    const wsDir = path.join(tmpRoot, 'ws');
    const dataDir = path.join(tmpRoot, 'data');
    await fsp.mkdir(wsDir, { recursive: true });
    await fsp.writeFile(path.join(wsDir, 'real.ts'), 'export const v = 1;\n', 'utf8');

    const nodeHost = new NodeHost({ dataDir });
    const nodeMgr = new CheckpointManager(nodeHost);
    const realTurn = nodeMgr.beginTurn({
      sessionId: 's_node_real',
      workspaceRoot: wsDir,
      turnNumber: 1,
      userMessageId: 'u_real_1',
    });
    await fsp.writeFile(path.join(wsDir, 'real.ts'), 'export const v = 2;\n', 'utf8');
    await realTurn.recordFileChange({
      callId: 'c_real_1',
      relPath: 'real.ts',
      absPath: path.join(wsDir, 'real.ts'),
      existedBefore: true,
      beforeContent: 'export const v = 1;\n',
      afterContent: 'export const v = 2;\n',
    });
    await fsp.writeFile(path.join(wsDir, 'created.ts'), 'export const created = true;\n', 'utf8');
    await realTurn.recordFileChange({
      callId: 'c_real_2',
      relPath: 'created.ts',
      absPath: path.join(wsDir, 'created.ts'),
      existedBefore: false,
      beforeContent: null,
      afterContent: 'export const created = true;\n',
    });

    await nodeMgr.revertTurn('s_node_real', realTurn.turnId);
    assert.equal(await fsp.readFile(path.join(wsDir, 'real.ts'), 'utf8'), 'export const v = 1;\n');
    await assert.rejects(() => fsp.stat(path.join(wsDir, 'created.ts')), /ENOENT/);
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('二轮复审回归: 多文件回退中途失败自动回滚与状态落盘、压缩后单调回合号与精确裁剪、非 System 模型零污染、跨工作区零误报冲突', async () => {
  // 1. P1: 多文件回退中途失败时，逆序自动回滚已修改的前序文件；若回滚也失败则按真实磁盘状态持久化记录
  const hostRollback = new MemoryHost({
    '/ws/A.ts': 'A_after',
    '/ws/B.ts': 'B_created',
    '/ws/C.ts': 'C_after',
  });
  const mgrRollback = new CheckpointManager(hostRollback);
  const tRollback = mgrRollback.beginTurn({
    sessionId: 's_rb',
    workspaceRoot: '/ws',
    turnNumber: 1,
    userMessageId: 'u_rb',
  });
  await tRollback.recordFileChange({
    callId: 'c_a',
    relPath: 'A.ts',
    absPath: '/ws/A.ts',
    existedBefore: true,
    beforeContent: 'A_before',
    afterContent: 'A_after',
  });
  await tRollback.recordFileChange({
    callId: 'c_b',
    relPath: 'B.ts',
    absPath: '/ws/B.ts',
    existedBefore: false,
    beforeContent: null,
    afterContent: 'B_created',
  });
  await tRollback.recordFileChange({
    callId: 'c_c',
    relPath: 'C.ts',
    absPath: '/ws/C.ts',
    existedBefore: true,
    beforeContent: 'C_before',
    afterContent: 'C_after',
  });

  // 令 B.ts 的 unlink 失败：A.ts 先被写为 A_before，随后 B.ts 报错触发逆序回滚 A.ts -> A_after
  const origUnlink = hostRollback.fs.unlink.bind(hostRollback.fs);
  hostRollback.fs.unlink = async (p: string) => {
    if (p.endsWith('B.ts')) throw new Error('EPERM: locked file');
    return origUnlink(p);
  };
  await assert.rejects(
    () => mgrRollback.revertTurn('s_rb', tRollback.turnId),
    /已自动回滚本批次前序修改的文件：A\.ts/,
  );
  assert.equal(await hostRollback.fs.readFile('/ws/A.ts'), 'A_after', '中途失败后前序 A.ts 必须被自动回滚至回退前内容');
  const rbSummary1 = (await mgrRollback.listCheckpoints('s_rb'))[0];
  assert.equal(rbSummary1.files.find((f) => f.path === 'A.ts')?.revertedAt, undefined);

  // 若回滚写回 A.ts 时也遭遇磁盘写入失败（A.ts 停留在 A_before），则 A.ts 的已恢复状态必须真实落盘并明确报错告知用户
  const origWrite = hostRollback.fs.writeFile.bind(hostRollback.fs);
  let aWriteCount = 0;
  hostRollback.fs.writeFile = async (p: string, data: string) => {
    if (p.endsWith('/ws/A.ts')) {
      aWriteCount++;
      if (aWriteCount === 2) throw new Error('EIO: rollback write failed');
    }
    return origWrite(p, data);
  };
  await assert.rejects(
    () => mgrRollback.revertTurn('s_rb', tRollback.turnId),
    /注意：同批次部分文件已恢复并落盘记录：A\.ts/,
  );
  assert.equal(await hostRollback.fs.readFile('/ws/A.ts'), 'A_before');
  const rbSummary2 = (await mgrRollback.listCheckpoints('s_rb'))[0];
  assert.ok(rbSummary2.files.find((f) => f.path === 'A.ts')?.revertedAt, '无法回滚的文件必须如实标记并持久化 revertedAt');
  assert.equal(rbSummary2.revertedAt, undefined, 'B.ts 与 C.ts 未恢复，整回合 revertedAt 必须保持未完成');

  // 2. P2: 历史压缩 (/compact) 后回合号单调递增，且 editLastUserMessage 只精确删除被截断消息对应的快照
  const hostCompact = new MemoryHost({
    '/wsA/app.ts': 'line1\nline2\nline3\n',
    '/wsB/app.ts': 'wsB_line1\n',
  });
  const server = new AgentServer(hostCompact);
  (server as any).createProvider = () => ({
    id: 'instant-mock-compact',
    async stream() {
      return { blocks: [{ type: 'text' as const, text: 'ok' }] };
    },
  });
  // 配置 capabilities 不含 'system' 的模型，同时验证二轮复审 P2（非 System 模型不污染历史与 rangeContext）
  await server.updateSettings({
    providers: {
      mock: {
        kind: 'mock',
        baseURL: '',
        name: 'Mock',
        enabled: true,
        models: [{ name: 'mock-no-sys', enabled: true, capabilities: [] }],
      },
    },
    defaultProvider: 'mock',
  });
  const session = await server.createSession({
    workspaceRoot: '/wsA',
    providerId: 'mock',
    model: 'mock-no-sys',
    title: '压缩与非System测试',
  });

  // Turn 1: 带 @app.ts:1-2 引用，且模型不支持 system 消息（走 mergeSystemIntoUser）
  await server.sendMessage(session.id, '第一轮提问 @app.ts:1-2');
  const sAfter1 = await server.getSession(session.id);
  assert.equal(sAfter1.meta.turnSeq, 1);
  const u1 = sAfter1.messages.find((m) => m.role === 'user');
  assert.ok(u1 && u1.role === 'user');
  assert.equal(u1.content, '第一轮提问 @app.ts:1-2', '非 System 模型的系统提示词与代码切片绝不能污染持久化 msg.content');
  assert.ok(u1.id, '非 System 模型合入系统提示词后仍必须保留首条用户消息 id');
  assert.match(u1.rangeContext ?? '', /line1/, '非 System 模型仍必须完整保留静态 rangeContext');

  // Turn 2 & Turn 3
  await server.sendMessage(session.id, '第二轮提问');
  await server.sendMessage(session.id, '第三轮提问');
  const sAfter3 = await server.getSession(session.id);
  assert.equal(sAfter3.meta.turnSeq, 3);

  // 为第 2 回合和第 3 回合分别登记快照
  const userMsgsBeforeCompact = sAfter3.messages.filter((m) => m.role === 'user');
  const internalMgr = (server as any).checkpoints as CheckpointManager;
  const chkTurn2 = internalMgr.beginTurn({
    sessionId: session.id,
    workspaceRoot: '/wsA',
    turnNumber: 2,
    userMessageId: userMsgsBeforeCompact[1].id!,
  });
  await chkTurn2.recordFileChange({
    callId: 'tc_turn2',
    relPath: 'app.ts',
    absPath: '/wsA/app.ts',
    existedBefore: true,
    beforeContent: 'v1',
    afterContent: 'line1\nline2\nline3\n',
  });
  const chkTurn3 = internalMgr.beginTurn({
    sessionId: session.id,
    workspaceRoot: '/wsA',
    turnNumber: 3,
    userMessageId: userMsgsBeforeCompact[2].id!,
  });
  await chkTurn3.recordFileChange({
    callId: 'tc_turn3',
    relPath: 'app.ts',
    absPath: '/wsA/app.ts',
    existedBefore: true,
    beforeContent: 'v2',
    afterContent: 'line1\nline2\nline3\n',
  });

  // 执行上下文压缩（仅保留最近 1 轮，消息数组中的 user 消息数缩减为 2 条：归档摘要 + 第 3 轮）
  await server.trimSessionHistory(session.id, 1);

  // 压缩后发送第 4 轮：turnSeq 必须单调递增为 4（绝不因消息数缩水而倒退为 3）
  await server.sendMessage(session.id, '压缩后的第四轮提问');
  const sAfter4 = await server.getSession(session.id);
  assert.equal(sAfter4.meta.turnSeq, 4, '压缩后新回合序号必须单调递增为 4');

  // 为第 4 轮登记快照，然后调用 editLastUserMessage 编辑第 4 轮：
  // 必须只清理第 4 轮的快照，绝不能误删压缩前第 2、3 轮的快照！
  const lastUser4 = [...sAfter4.messages].reverse().find((m) => m.role === 'user')!;
  const chkTurn4 = internalMgr.beginTurn({
    sessionId: session.id,
    workspaceRoot: '/wsA',
    turnNumber: 4,
    userMessageId: lastUser4.id!,
  });
  await chkTurn4.recordFileChange({
    callId: 'tc_turn4',
    relPath: 'app.ts',
    absPath: '/wsA/app.ts',
    existedBefore: true,
    beforeContent: 'v3',
    afterContent: 'line1\nline2\nline3\n',
  });
  assert.equal((await server.listTurnCheckpoints(session.id)).length, 3);

  await server.editLastUserMessage(session.id, '编辑重发第四轮提问');
  const remainingChks = await server.listTurnCheckpoints(session.id);
  assert.deepEqual(
    remainingChks.map((c) => c.turnNumber),
    [2, 3],
    '压缩后编辑最后一条消息，仅清理被截断的第 4 轮快照，第 2、3 轮快照完好保留',
  );

  // 3. P2: 跨工作区同名文件不产生错误冲突
  // 将会话切换至 /wsB 并记录修改 /wsB/app.ts 的第 6 轮快照
  await server.setSessionWorkspace(session.id, '/wsB');
  const chkWsB = internalMgr.beginTurn({
    sessionId: session.id,
    workspaceRoot: '/wsB',
    turnNumber: 6,
    userMessageId: 'u_wsb_6',
  });
  await chkWsB.recordFileChange({
    callId: 'tc_wsb',
    relPath: 'app.ts',
    absPath: '/wsB/app.ts',
    existedBefore: true,
    beforeContent: 'wsB_old',
    afterContent: 'wsB_line1\n',
  });

  // 预览 /wsA 的第 3 轮快照：虽然第 6 轮也改了相对路径同名的 app.ts，但因属于 /wsB，绝不能误报为第 3 轮的后续冲突
  const previewWsA3 = await server.previewTurnUndo(session.id, chkTurn3.turnId);
  assert.equal(previewWsA3.hasConflicts, false, '不同工作区的同名文件修改绝不能触发冲突误报');
  assert.equal(previewWsA3.files[0].modifiedInLaterTurns, false);
});

test('三轮复审回归: stat 权限异常保守拒绝、不可读文件在 force=true 下防清空、inFlight 写入失败文件的恢复与受损告警', async () => {
  // 1. P1: stat 抛出权限异常（EACCES/EPERM）时，绝不能当成文件不存在并谎报删除成功
  const hostStatErr = new MemoryHost({ '/ws/new.ts': 'secret_new_file' });
  const mgrStatErr = new CheckpointManager(hostStatErr);
  const tStatErr = mgrStatErr.beginTurn({
    sessionId: 's_stat_err',
    workspaceRoot: '/ws',
    turnNumber: 1,
    userMessageId: 'u_stat',
  });
  await tStatErr.recordFileChange({
    callId: 'c_stat',
    relPath: 'new.ts',
    absPath: '/ws/new.ts',
    existedBefore: false,
    beforeContent: null,
    afterContent: 'secret_new_file',
  });
  const origStat = hostStatErr.fs.stat.bind(hostStatErr.fs);
  hostStatErr.fs.stat = async (p: string) => {
    if (p.endsWith('/ws/new.ts')) {
      const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    }
    return origStat(p);
  };
  await assert.rejects(
    () => mgrStatErr.revertTurn('s_stat_err', tStatErr.turnId, { force: true }),
    /无法安全访问或读取以下文件的当前状态.*无法访问文件状态 \(stat\): EACCES/,
  );
  // 恢复正常 stat 后核实快照绝未被错误标记为 revertedAt
  hostStatErr.fs.stat = origStat;
  const statErrSummary = (await mgrStatErr.listCheckpoints('s_stat_err'))[0];
  assert.equal(statErrSummary.revertedAt, undefined, 'stat 权限异常时绝不能将快照标记为已恢复');

  // 2. P1: 文件存在但不可读（currentExists=true, currentContent=null）时，即使传 force=true 也必须在预检阶段拒绝，
  // 杜绝后续回滚使用 ?? '' 将用户原文件清空
  const hostUnreadable = new MemoryHost({
    '/ws/unreadable.ts': 'CRITICAL_USER_DATA',
    '/ws/second.ts': 'second_after',
  });
  const mgrUnreadable = new CheckpointManager(hostUnreadable);
  const tUnreadable = mgrUnreadable.beginTurn({
    sessionId: 's_unreadable',
    workspaceRoot: '/ws',
    turnNumber: 1,
    userMessageId: 'u_unreadable',
  });
  await tUnreadable.recordFileChange({
    callId: 'c_u1',
    relPath: 'unreadable.ts',
    absPath: '/ws/unreadable.ts',
    existedBefore: true,
    beforeContent: 'old_data',
    afterContent: 'after_data',
  });
  await tUnreadable.recordFileChange({
    callId: 'c_u2',
    relPath: 'second.ts',
    absPath: '/ws/second.ts',
    existedBefore: true,
    beforeContent: 'second_before',
    afterContent: 'second_after',
  });
  const origRead = hostUnreadable.fs.readFile.bind(hostUnreadable.fs);
  hostUnreadable.fs.readFile = async (p: string) => {
    if (p.endsWith('/ws/unreadable.ts')) {
      throw new Error('EACCES: read permission denied');
    }
    return origRead(p);
  };
  await assert.rejects(
    () => mgrUnreadable.revertTurn('s_unreadable', tUnreadable.turnId, { force: true }),
    /无法安全访问或读取以下文件的当前状态.*文件内容不可读 \(readFile\): EACCES/,
  );
  hostUnreadable.fs.readFile = origRead;
  assert.equal(
    await hostUnreadable.fs.readFile('/ws/unreadable.ts'),
    'CRITICAL_USER_DATA',
    '不可读文件在 force=true 下也必须被保守拒绝，原文件内容完好无损',
  );

  // 3. P2: 当前正在写入的 inFlight 文件若在部分修改磁盘后抛出 EIO，必须纳入恢复流程还原或报告受损状态
  const hostInFlight = new MemoryHost({
    '/ws/first.ts': 'first_after',
    '/ws/second.ts': 'second_after',
  });
  const mgrInFlight = new CheckpointManager(hostInFlight);
  const tInFlight = mgrInFlight.beginTurn({
    sessionId: 's_inflight',
    workspaceRoot: '/ws',
    turnNumber: 1,
    userMessageId: 'u_inflight',
  });
  await tInFlight.recordFileChange({
    callId: 'c_f1',
    relPath: 'first.ts',
    absPath: '/ws/first.ts',
    existedBefore: true,
    beforeContent: 'first_before',
    afterContent: 'first_after',
  });
  await tInFlight.recordFileChange({
    callId: 'c_f2',
    relPath: 'second.ts',
    absPath: '/ws/second.ts',
    existedBefore: true,
    beforeContent: 'second_before',
    afterContent: 'second_after',
  });

  // 场景 3A：writeFile 写 second.ts 时先将文件内容截断改写为 PARTIAL_TRUNCATED，然后抛出 ENOSPC；
  // 随后逆序回滚能够成功将 second.ts 与 first.ts 均恢复为回退前内容
  const origWriteInFlight = hostInFlight.fs.writeFile.bind(hostInFlight.fs);
  let secondWriteAttempts = 0;
  hostInFlight.fs.writeFile = async (p: string, data: string) => {
    if (p.endsWith('/ws/second.ts')) {
      secondWriteAttempts++;
      if (secondWriteAttempts === 1) {
        await origWriteInFlight(p, 'PARTIAL_TRUNCATED');
        throw new Error('ENOSPC: no space left on device');
      }
    }
    return origWriteInFlight(p, data);
  };
  await assert.rejects(
    () => mgrInFlight.revertTurn('s_inflight', tInFlight.turnId),
    /已自动回滚本批次前序修改的文件：second\.ts, first\.ts/,
  );
  assert.equal(await hostInFlight.fs.readFile('/ws/first.ts'), 'first_after');
  assert.equal(
    await hostInFlight.fs.readFile('/ws/second.ts'),
    'second_after',
    'inFlight 发生部分写入后抛错的文件也必须被纳入恢复队列还原至回退前内容',
  );

  // 场景 3B：若 inFlight 文件部分写入后抛错，且尝试恢复时继续抛错，必须明确向用户告警该文件处于受损状态
  hostInFlight.fs.writeFile = async (p: string, data: string) => {
    if (p.endsWith('/ws/second.ts')) {
      await origWriteInFlight(p, 'CORRUPTED_PARTIAL_WRITE');
      throw new Error('EIO: persistent disk write failure');
    }
    return origWriteInFlight(p, data);
  };
  await assert.rejects(
    () => mgrInFlight.revertTurn('s_inflight', tInFlight.turnId),
    /警告：文件写入异常后自动恢复失败，以下文件可能处于部分写入或受损状态：second\.ts/,
  );
});

test('四轮复审回归: onFileChange 持久化失败自动回滚文件、rename 原子提交与损坏 JSON 保护、越界行号跳过及 Composer 插入消费', async () => {
  const { writeFileTool, editFileTool } = await import('@easycode/core');

  // 1. P1: write_file（含新建与覆盖）和 edit_file 在 onFileChange 快照持久化失败时，自动回滚工作区文件与 CheckpointManager 内存态
  const hostRollback = new MemoryHost({
    '/ws/existing.ts': 'ORIG_CONTENT',
  });
  const mgrRollback = new CheckpointManager(hostRollback);
  const trackerRollback = mgrRollback.beginTurn({
    sessionId: 's_snap_fail',
    workspaceRoot: '/ws',
    turnNumber: 1,
    userMessageId: 'u_snap_1',
  });
  const readFiles = new Set<string>(['/ws/existing.ts']);
  const signal = new AbortController().signal;

  // 模拟 dataDir 快照持久化写入失败（如磁盘满 ENOSPC）
  const origWriteRb = hostRollback.fs.writeFile.bind(hostRollback.fs);
  let failCheckpointPersist = true;
  hostRollback.fs.writeFile = async (p: string, data: string) => {
    if (failCheckpointPersist && p.includes('/checkpoints/')) {
      throw new Error('ENOSPC: checkpoint storage full');
    }
    return origWriteRb(p, data);
  };

  // 1A: write_file 新建文件时快照落盘失败 -> 自动删除新建文件并回滚内存快照
  await assert.rejects(
    () =>
      writeFileTool.execute(
        { path: 'brand_new.ts', content: 'NEW_CONTENT' },
        {
          host: hostRollback,
          workspace: '/ws',
          signal,
          readFiles,
          callId: 'c_w_new',
          onFileChange: (ev) => trackerRollback.recordFileChange(ev),
        },
      ),
    /文件快照记录或持久化失败，已自动回滚工作区文件 \(brand_new\.ts\) 至修改前状态.*ENOSPC/,
  );
  assert.equal(await hostRollback.fs.stat('/ws/brand_new.ts'), null, '新建文件在快照落盘失败后必须被自动删除回滚');
  assert.equal((await mgrRollback.listCheckpoints('s_snap_fail')).length, 0, '快照落盘失败后内存缓存必须同步回滚');

  // 1B: write_file 覆盖已有文件时快照落盘失败 -> 自动还原原文件内容
  await assert.rejects(
    () =>
      writeFileTool.execute(
        { path: 'existing.ts', content: 'OVERWRITTEN_BY_WRITE' },
        {
          host: hostRollback,
          workspace: '/ws',
          signal,
          readFiles,
          callId: 'c_w_exist',
          onFileChange: (ev) => trackerRollback.recordFileChange(ev),
        },
      ),
    /文件快照记录或持久化失败，已自动回滚工作区文件 \(existing\.ts\) 至修改前状态.*ENOSPC/,
  );
  assert.equal(await hostRollback.fs.readFile('/ws/existing.ts'), 'ORIG_CONTENT', '覆盖写入在快照落盘失败后必须还原原文件内容');

  // 1C: edit_file 修改已有文件时快照落盘失败 -> 自动还原原文件内容
  await assert.rejects(
    () =>
      editFileTool.execute(
        { path: 'existing.ts', old_string: 'ORIG_CONTENT', new_string: 'EDITED_CONTENT' },
        {
          host: hostRollback,
          workspace: '/ws',
          signal,
          readFiles,
          callId: 'c_edit',
          onFileChange: (ev) => trackerRollback.recordFileChange(ev),
        },
      ),
    /文件快照记录或持久化失败，已自动回滚工作区文件 \(existing\.ts\) 至修改前状态.*ENOSPC/,
  );
  assert.equal(await hostRollback.fs.readFile('/ws/existing.ts'), 'ORIG_CONTENT', 'edit_file 在快照落盘失败后必须还原原文件内容');

  // 1D: 若 onFileChange 抛错且回滚工作区文件也失败，必须明确告警可能发生了未受快照保护的修改
  hostRollback.fs.writeFile = async (p: string, data: string) => {
    if (p.includes('/checkpoints/')) {
      throw new Error('ENOSPC: checkpoint storage full');
    }
    if (p.endsWith('/ws/existing.ts') && data === 'ORIG_CONTENT') {
      throw new Error('EIO: rollback write failed');
    }
    return origWriteRb(p, data);
  };
  await assert.rejects(
    () =>
      editFileTool.execute(
        { path: 'existing.ts', old_string: 'ORIG_CONTENT', new_string: 'UNPROTECTED_EDIT' },
        {
          host: hostRollback,
          workspace: '/ws',
          signal,
          readFiles,
          callId: 'c_edit_rb_fail',
          onFileChange: (ev) => trackerRollback.recordFileChange(ev),
        },
      ),
    /文件快照记录或持久化失败，且自动回滚工作区文件失败（警告：文件可能已发生未受快照保护的修改: existing\.ts）/,
  );
  hostRollback.fs.writeFile = origWriteRb;
  await hostRollback.fs.writeFile('/ws/existing.ts', 'ORIG_CONTENT');

  // 2. P1: 快照 JSON 使用 .tmp + rename 原子提交，且 loadSessionRecords 区分「不存在」「读取失败」「JSON 损坏」（拒绝静默清空）
  let renameCalledWith: { from: string; to: string } | null = null;
  const origRename = hostRollback.fs.rename!.bind(hostRollback.fs);
  hostRollback.fs.rename = async (from: string, to: string) => {
    renameCalledWith = { from, to };
    return origRename(from, to);
  };
  failCheckpointPersist = false;
  await editFileTool.execute(
    { path: 'existing.ts', old_string: 'ORIG_CONTENT', new_string: 'SAFE_EDITED' },
    {
      host: hostRollback,
      workspace: '/ws',
      signal,
      readFiles,
      callId: 'c_edit_ok',
      onFileChange: (ev) => trackerRollback.recordFileChange(ev),
    },
  );
  assert.ok(renameCalledWith, 'persistSessionRecords 必须通过 host.fs.rename 执行原子替换提交');
  assert.match((renameCalledWith as { from: string; to: string }).from, /s_snap_fail\.json\.tmp$/);
  assert.match((renameCalledWith as { from: string; to: string }).to, /s_snap_fail\.json$/);
  const validCheckpointJson = await hostRollback.fs.readFile('/easycode-demo/checkpoints/s_snap_fail.json');

  // 2A: 若快照 JSON 文件已损坏且无 .tmp 备份，新的 CheckpointManager 实例加载时必须报错而非静默初始化为空数组
  await hostRollback.fs.writeFile('/easycode-demo/checkpoints/s_snap_fail.json', '{corrupted_json_truncated');
  const mgrCorrupt = new CheckpointManager(hostRollback);
  await assert.rejects(
    () => mgrCorrupt.listCheckpoints('s_snap_fail'),
    /会话快照文件已损坏，JSON 解析失败/,
  );
  assert.equal(
    await hostRollback.fs.readFile('/easycode-demo/checkpoints/s_snap_fail.json'),
    '{corrupted_json_truncated',
    '损坏的快照文件绝不能被静默清空或覆盖为空数组',
  );

  // 2B: 若正式文件损坏但同目录存在完好的 .tmp 文件，自动从 .tmp 恢复并原子晋升
  await hostRollback.fs.writeFile('/easycode-demo/checkpoints/s_snap_fail.json.tmp', validCheckpointJson);
  const mgrRecovered = new CheckpointManager(hostRollback);
  const recoveredList = await mgrRecovered.listCheckpoints('s_snap_fail');
  assert.equal(recoveredList.length, 1, '存在完好 .tmp 时应自动恢复历史回合快照');
  assert.equal(recoveredList[0].files[0].path, 'existing.ts');

  // 2C: 若读取快照文件时发生权限错误（readFile 抛 EACCES），必须抛错而非静默视为空数组
  const origReadRb = hostRollback.fs.readFile.bind(hostRollback.fs);
  hostRollback.fs.readFile = async (p: string) => {
    if (p.endsWith('s_snap_fail.json')) {
      throw new Error('EACCES: checkpoint file permission denied');
    }
    return origReadRb(p);
  };
  const mgrReadErr = new CheckpointManager(hostRollback);
  await assert.rejects(
    () => mgrReadErr.listCheckpoints('s_snap_fail'),
    /读取会话快照文件失败.*EACCES/,
  );
  hostRollback.fs.readFile = origReadRb;

  // 3. P2: 越界的代码行引用（startLine > totalLines）必须跳过，绝不静默钳制到文件最后一行
  const hostRange = new MemoryHost({
    '/ws/short.ts': 'line1\nline2\nline3\nline4\nline5',
  });
  const outOfBoundsRes = await resolveCodeRangeMentions(
    hostRange,
    '/ws',
    '请检查 @short.ts:900 与区间 @short.ts:100-120',
  );
  assert.equal(outOfBoundsRes.snippets.length, 0, '起始行超出文件总行数的引用必须跳过，不能错误截取最后一行');
  assert.equal(outOfBoundsRes.enrichedText, '请检查 @short.ts:900 与区间 @short.ts:100-120');

  // 4. P2: Composer 插入指令消费确认（聊天页插入 → 切换到设置页卸载 → 返回聊天页重挂载，不重复插入）
  const fakeComposerStore = {
    composerInsertText: '',
    composerInsertTick: 0,
    insertIntoComposer(snippet: string) {
      this.composerInsertText = snippet;
      this.composerInsertTick++;
    },
    consumeComposerInsert(tick?: number): string {
      if (tick !== undefined && tick !== this.composerInsertTick) return '';
      const snippet = this.composerInsertText;
      if (!snippet) return '';
      this.composerInsertText = '';
      return snippet;
    },
  };
  let composerInputValue = '请分析';
  const runComposerMountEffect = () => {
    if (!fakeComposerStore.composerInsertTick || !fakeComposerStore.composerInsertText) return;
    const snippet = fakeComposerStore.consumeComposerInsert(fakeComposerStore.composerInsertTick);
    if (!snippet) return;
    composerInputValue = `${composerInputValue} ${snippet}`;
  };
  // 用户在聊天页点击文件树插入 @src/app.ts
  fakeComposerStore.insertIntoComposer('@src/app.ts ');
  runComposerMountEffect();
  assert.equal(composerInputValue, '请分析 @src/app.ts ');
  assert.equal(fakeComposerStore.composerInsertText, '', '消费后 composerInsertText 必须被清空');
  // 用户进入设置页再返回聊天页，Composer 重新挂载执行 Effect
  runComposerMountEffect();
  assert.equal(composerInputValue, '请分析 @src/app.ts ', 'Composer 重新挂载后绝不能重复插入已消费的旧路径');
});

test('五轮复审回归: 首次快照 rename 失败后重启不复活虚假快照、Undo 落盘失败补偿回滚、单回合 8MB 硬上限与后续部分撤销冲突消除', async () => {
  const { writeFileTool, editFileTool } = await import('@easycode/core');
  const signal = new AbortController().signal;

  // 1. P1: 首次保存快照时 writeFile(.tmp) 成功但 rename 失败 -> 工作区补偿删除 new.ts -> 重启后新 CheckpointManager 绝不恢复虚假快照
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

  // 2. P2: Undo (revertTurn) 恢复工作区文件成功，但最后的快照状态持久化失败 -> 自动逆序回滚工作区文件至 Undo 前状态
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

  // 2B: 若 Undo 状态持久化失败，且补偿还原工作区文件也失败 -> 明确报告部分完成与持久化失败详情
  const origWriteUndo = hostUndoFail.fs.writeFile.bind(hostUndoFail.fs);
  hostUndoFail.fs.rename = async () => {
    throw new Error('ENOSPC: disk full when persisting revertedAt');
  };
  hostUndoFail.fs.writeFile = async (p: string, data: string) => {
    if (p.endsWith('/ws/app.ts') && data === 'v2_after') {
      throw new Error('EIO: failed to restore v2_after');
    }
    return origWriteUndo(p, data);
  };
  await assert.rejects(
    () => mgrUndoFail.revertTurn('s_undo_persist_fail', trackerUndo.turnId),
    /注意：同批次部分文件已恢复；且快照状态持久化失败.*工作区文件已完成回退但快照状态未能落盘：app\.ts/,
  );
  hostUndoFail.fs.rename = origRenameUndo;
  hostUndoFail.fs.writeFile = origWriteUndo;

  // 3. P2: 单个活跃回合突破 8MB 会话快照容量硬上限时，拒绝记录并触发文件与内存双重回滚
  const chunk1_6MB = 'x'.repeat(1.6 * 1024 * 1024);
  const hostQuota = new MemoryHost({
    '/ws/f1.ts': chunk1_6MB,
    '/ws/f2.ts': chunk1_6MB,
    '/ws/f3.ts': chunk1_6MB,
  });
  const mgrQuota = new CheckpointManager(hostQuota);
  const trackerQuota = mgrQuota.beginTurn({
    sessionId: 's_quota_8mb',
    workspaceRoot: '/ws',
    turnNumber: 1,
    userMessageId: 'u_quota_1',
  });
  const readQuotaFiles = new Set(['/ws/f1.ts', '/ws/f2.ts', '/ws/f3.ts']);

  // f1: before 1.6MB + after 1.6MB = 3.2MB (<= 8MB) -> 成功
  await writeFileTool.execute(
    { path: 'f1.ts', content: `${chunk1_6MB}_mod1` },
    {
      host: hostQuota,
      workspace: '/ws',
      signal,
      readFiles: readQuotaFiles,
      callId: 'c_q1',
      onFileChange: (ev) => trackerQuota.recordFileChange(ev),
    },
  );
  // f2: 累计 6.4MB (<= 8MB) -> 成功
  await writeFileTool.execute(
    { path: 'f2.ts', content: `${chunk1_6MB}_mod2` },
    {
      host: hostQuota,
      workspace: '/ws',
      signal,
      readFiles: readQuotaFiles,
      callId: 'c_q2',
      onFileChange: (ev) => trackerQuota.recordFileChange(ev),
    },
  );
  // f3: 累计 9.6MB (> 8MB 硬上限) -> 拒绝并自动回滚 f3.ts 工作区内容及内存快照
  await assert.rejects(
    () =>
      writeFileTool.execute(
        { path: 'f3.ts', content: `${chunk1_6MB}_mod3` },
        {
          host: hostQuota,
          workspace: '/ws',
          signal,
          readFiles: readQuotaFiles,
          callId: 'c_q3',
          onFileChange: (ev) => trackerQuota.recordFileChange(ev),
        },
      ),
    /超过会话快照总容量硬上限 \(8MB\)/,
  );
  assert.equal(await hostQuota.fs.readFile('/ws/f3.ts'), chunk1_6MB, '超 8MB 失败后 f3.ts 必须自动回滚至原内容');
  const quotaSummaries = await mgrQuota.listCheckpoints('s_quota_8mb');
  assert.equal(quotaSummaries.length, 1);
  assert.deepEqual(
    quotaSummaries[0].files.map((f) => f.path),
    ['f1.ts', 'f2.ts'],
    '容量超限回滚后，内存与磁盘快照应完整保留前两个合法文件记录',
  );

  // 4. P3: 后续回合修改 A、B 两文件并仅部分撤销 A 后，预览更早回合的 A 不再误报 modifiedInLaterTurns
  const hostPartialLater = new MemoryHost({
    '/ws/a.ts': 'a_v0',
    '/ws/b.ts': 'b_v0',
  });
  const mgrPartialLater = new CheckpointManager(hostPartialLater);
  // 第 1 回合修改 a.ts: a_v0 -> a_v1
  const t1 = mgrPartialLater.beginTurn({
    sessionId: 's_p3',
    workspaceRoot: '/ws',
    turnNumber: 1,
    userMessageId: 'u1',
  });
  await hostPartialLater.fs.writeFile('/ws/a.ts', 'a_v1');
  await t1.recordFileChange({
    callId: 'c1',
    relPath: 'a.ts',
    absPath: '/ws/a.ts',
    existedBefore: true,
    beforeContent: 'a_v0',
    afterContent: 'a_v1',
  });
  // 第 2 回合同时修改 a.ts (a_v1 -> a_v2) 和 b.ts (b_v0 -> b_v2)
  const t2 = mgrPartialLater.beginTurn({
    sessionId: 's_p3',
    workspaceRoot: '/ws',
    turnNumber: 2,
    userMessageId: 'u2',
  });
  await hostPartialLater.fs.writeFile('/ws/a.ts', 'a_v2');
  await t2.recordFileChange({
    callId: 'c2_a',
    relPath: 'a.ts',
    absPath: '/ws/a.ts',
    existedBefore: true,
    beforeContent: 'a_v1',
    afterContent: 'a_v2',
  });
  await hostPartialLater.fs.writeFile('/ws/b.ts', 'b_v2');
  await t2.recordFileChange({
    callId: 'c2_b',
    relPath: 'b.ts',
    absPath: '/ws/b.ts',
    existedBefore: true,
    beforeContent: 'b_v0',
    afterContent: 'b_v2',
  });
  // 仅部分撤销第 2 回合中的 a.ts（此时 a.ts 恢复为 a_v1，b.ts 仍为 b_v2，因此第 2 回合整体未完全撤销）
  await mgrPartialLater.revertTurn('s_p3', t2.turnId, ['a.ts']);
  // 预览第 1 回合：由于第 2 回合对 a.ts 的修改已被单独撤销，预览第 1 回合的 a.ts 不应再报冲突
  const previewT1 = await mgrPartialLater.previewUndo('s_p3', t1.turnId);
  assert.equal(previewT1.files[0].modifiedInLaterTurns, false, '后续回合中已单独撤销的文件不应再误报为后续修改冲突');
  assert.equal(previewT1.hasConflicts, false);
});
