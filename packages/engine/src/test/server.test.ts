import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentServer, Mutex, WorkspaceLockManager } from '../index.js';
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
        scores: { [req.candidates[0].id]: 0.95 },
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
});
