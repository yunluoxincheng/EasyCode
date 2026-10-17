import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryHost } from '@easycode/core';
import type { AgentEvent, PermissionRule, ProcessRunOptions, ProcessResult } from '@easycode/core';
import { ApprovalManager, ToolRegistry, createBuiltinTools, executeTool, type Tool } from '@easycode/core';
import {
  AgentServer,
  buildTestFixPrompt,
  normalizePermissionRule,
  parsePermissionRules,
  runTestLoop,
  type TestRunExecution,
} from '../index.js';

/** 计时工具：确定性 echo 工具 + 可断言是否真正执行 */
function createEchoTools(): { registry: ToolRegistry; executed: string[] } {
  const executed: string[] = [];
  const echo: Tool = {
    spec: {
      name: 'run_command',
      description: 'echo',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
    sensitive: true,
    execute: async (input) => {
      const command = String((input as { command?: unknown }).command ?? '');
      executed.push(command);
      return '退出码: 0\nstdout:\nok';
    },
  };
  const readTool: Tool = {
    spec: {
      name: 'read_file',
      description: 'read',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    execute: async (input) => {
      executed.push(`read:${String((input as { path?: unknown }).path ?? '')}`);
      return 'content';
    },
  };
  const registry = new ToolRegistry().register(echo).register(readTool);
  return { registry, executed };
}

function collectEvents(): { events: AgentEvent[]; emit: (e: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

test('executeTool：deny 规则短路执行且不弹审批', async () => {
  const { registry, executed } = createEchoTools();
  const { events, emit } = collectEvents();
  const approval = new ApprovalManager(emit, 'ask');
  const rules: PermissionRule[] = [
    { tool: 'run_command', pattern: 'rm', decision: 'deny', source: 'global' },
  ];
  const result = await executeTool(registry, 'run_command', { command: 'rm -rf build' }, {
    host: new MemoryHost(),
    workspace: '/ws',
    signal: new AbortController().signal,
    approval,
    permissionRules: rules,
  });
  assert.equal(result.approved, false);
  assert.equal(result.isError, false);
  assert.match(result.content, /权限规则拒绝执行/);
  assert.match(result.content, /全局规则: run_command ~ "rm"/);
  assert.deepEqual(executed, []);
  assert.equal(events.filter((e) => e.type === 'approval_request').length, 0);
});

test('executeTool：allow 规则在 ask 模式下免审批', async () => {
  const { registry, executed } = createEchoTools();
  const { events, emit } = collectEvents();
  const approval = new ApprovalManager(emit, 'ask');
  const result = await executeTool(registry, 'run_command', { command: 'pnpm test' }, {
    host: new MemoryHost(),
    workspace: '/ws',
    signal: new AbortController().signal,
    approval,
    permissionRules: [{ tool: 'run_command', pattern: 'pnpm test', decision: 'allow' }],
  });
  assert.equal(result.approved, true);
  assert.equal(result.isError, false);
  assert.deepEqual(executed, ['pnpm test']);
  assert.equal(events.filter((e) => e.type === 'approval_request').length, 0);
});

test('executeTool：ask 规则在 yolo 模式下也强制审批并携带规则原因', async () => {
  const { registry, executed } = createEchoTools();
  const { events, emit } = collectEvents();
  const approval = new ApprovalManager(emit, 'yolo');
  const rules: PermissionRule[] = [
    { tool: 'run_command', pattern: 'git push', decision: 'ask', source: 'project', note: '谨慎推送' },
  ];
  const pending = executeTool(registry, 'run_command', { command: 'git push --force' }, {
    host: new MemoryHost(),
    workspace: '/ws',
    signal: new AbortController().signal,
    approval,
    permissionRules: rules,
  });
  // 事件同步发出，此时仍未执行
  const request = events.find((e) => e.type === 'approval_request');
  assert.ok(request && request.type === 'approval_request');
  assert.equal(request.reason, '项目规则: run_command ~ "git push" · 谨慎推送');
  assert.deepEqual(executed, []);
  approval.resolve(request.requestId, true);
  const result = await pending;
  assert.equal(result.approved, true);
  assert.deepEqual(executed, ['git push --force']);
});

test('executeTool：无规则命中时保持既有审批语义（只读工具免审批）', async () => {
  const { registry, executed } = createEchoTools();
  const { events, emit } = collectEvents();
  const approval = new ApprovalManager(emit, 'yolo');
  const result = await executeTool(registry, 'read_file', { path: '.env' }, {
    host: new MemoryHost(),
    workspace: '/ws',
    signal: new AbortController().signal,
    approval,
    permissionRules: [{ tool: 'read_file', pattern: 'src/**', decision: 'deny' }],
  });
  assert.equal(result.approved, true);
  assert.deepEqual(executed, ['read:.env']);
  assert.equal(events.length, 0);
});

test('parsePermissionRules：兼容两种写法并跳过非法条目', () => {
  const wrapped = parsePermissionRules(
    JSON.stringify({
      rules: [
        { tool: 'run_command', pattern: ' rm ', decision: 'deny', note: ' 禁止 ' },
        { tool: 'run_command', decision: 'boom' },
        { tool: '', decision: 'deny' },
        'not-an-object',
      ],
    }),
    'project',
  );
  assert.deepEqual(wrapped, [
    { tool: 'run_command', pattern: 'rm', decision: 'deny', note: '禁止', source: 'project' },
  ]);
  const bare = parsePermissionRules('[{"tool":"read_file","decision":"ask"}]', 'global');
  assert.deepEqual(bare, [{ tool: 'read_file', decision: 'ask', source: 'global' }]);
  assert.deepEqual(parsePermissionRules('{broken', 'global'), []);
  assert.deepEqual(parsePermissionRules('{"rules":"nope"}', 'global'), []);
  assert.equal(normalizePermissionRule(null, 'global'), null);
});

test('buildTestFixPrompt：包含轮次、失败清单、摘录与 diff', () => {
  const prompt = buildTestFixPrompt({
    command: 'pnpm test',
    round: 2,
    maxRounds: 3,
    focus: 'packages/core',
    summary: { passed: 3, failed: 1, total: 4, failures: ['src/a.test.ts > adds'] },
    excerpt: 'AssertionError: expected 3 to be 4',
    diff: 'diff --git a/x b/x',
  });
  assert.match(prompt, /第 2\/3 轮/);
  assert.match(prompt, /pnpm test/);
  assert.match(prompt, /通过 3 \/ 失败 1 \/ 共 4/);
  assert.match(prompt, /src\/a\.test\.ts > adds/);
  assert.match(prompt, /聚焦范围：packages\/core/);
  assert.match(prompt, /AssertionError/);
  assert.match(prompt, /diff --git a\/x b\/x/);
  assert.match(prompt, /不要重复执行整条测试命令/);
});

test('runTestLoop：首轮全绿立即收敛', async () => {
  const { events, emit } = collectEvents();
  let repairCount = 0;
  const result = await runTestLoop({
    command: 'pnpm test',
    commandSource: 'package.json scripts.test',
    maxRounds: 3,
    signal: new AbortController().signal,
    emit,
    runTests: async () => ({ exitCode: 0, output: 'Tests  4 passed (4)', durationMs: 12 }),
    repair: async () => {
      repairCount += 1;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'passed');
  assert.equal(result.rounds, 1);
  assert.equal(repairCount, 0);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['test_run_start', 'test_run_result', 'test_loop_done']);
  const resultEvent = events[1];
  assert.ok(resultEvent.type === 'test_run_result');
  assert.equal(resultEvent.summary.failed, undefined);
  assert.deepEqual(resultEvent.summary, { passed: 4, total: 4, failures: [] });
});

test('runTestLoop：失败 → 修复 → 重跑至全绿', async () => {
  const { events, emit } = collectEvents();
  const prompts: string[] = [];
  const scripted: TestRunExecution[] = [
    {
      exitCode: 1,
      output: 'FAIL  src/a.test.ts\nTests  1 failed | 2 passed (3)',
      durationMs: 30,
    },
    { exitCode: 0, output: 'Tests  3 passed (3)', durationMs: 20 },
  ];
  let round = 0;
  const result = await runTestLoop({
    command: 'pnpm test',
    commandSource: 'package.json scripts.test',
    maxRounds: 3,
    signal: new AbortController().signal,
    emit,
    runTests: async () => scripted[round++],
    repair: async (prompt) => {
      prompts.push(prompt);
    },
    readDiff: async () => 'diff --git a/a b/a',
  });
  assert.equal(result.ok, true);
  assert.equal(result.rounds, 2);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /第 1\/3 轮/);
  assert.match(prompts[0], /diff --git a\/a b\/a/);
  const failedEvent = events.find(
    (e) => e.type === 'test_run_result' && !e.ok,
  );
  assert.ok(failedEvent && failedEvent.type === 'test_run_result');
  assert.equal(failedEvent.exitCode, 1);
  assert.deepEqual(failedEvent.summary.failures, ['src/a.test.ts']);
});

test('runTestLoop：轮次耗尽返回 max_rounds，不无限重试', async () => {
  const { events, emit } = collectEvents();
  let runs = 0;
  const result = await runTestLoop({
    command: 'pnpm test',
    commandSource: 'pkg',
    maxRounds: 2,
    signal: new AbortController().signal,
    emit,
    runTests: async () => {
      runs += 1;
      return { exitCode: 1, output: 'Tests  1 failed (1)', durationMs: 5 };
    },
    repair: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'max_rounds');
  assert.equal(result.rounds, 2);
  assert.equal(runs, 2);
  assert.equal(events.filter((e) => e.type === 'test_loop_done').length, 1);
});

test('runTestLoop：中止信号在运行前生效时直接返回 aborted', async () => {
  const { events, emit } = collectEvents();
  const controller = new AbortController();
  controller.abort();
  let runs = 0;
  const result = await runTestLoop({
    command: 'pnpm test',
    commandSource: 'pkg',
    maxRounds: 2,
    signal: controller.signal,
    emit,
    runTests: async () => {
      runs += 1;
      return { exitCode: 0, output: '', durationMs: 0 };
    },
    repair: async () => {},
  });
  assert.equal(result.reason, 'aborted');
  assert.equal(runs, 0);
  assert.equal(events[0].type, 'test_loop_done');
});

test('runTestLoop：测试执行抛异常时收敛为 error 而非崩溃', async () => {
  const { events, emit } = collectEvents();
  const result = await runTestLoop({
    command: 'pnpm test',
    commandSource: 'pkg',
    maxRounds: 2,
    signal: new AbortController().signal,
    emit,
    runTests: async () => {
      throw new Error('spawn failed');
    },
    repair: async () => {},
  });
  assert.equal(result.reason, 'error');
  assert.match(result.message ?? '', /spawn failed/);
  const done = events.at(-1);
  assert.ok(done && done.type === 'test_loop_done' && done.reason === 'error');
});

/** 脚本化宿主：按预设序列返回测试命令的退出码与输出 */
class ScriptedTestHost extends MemoryHost {
  /** 仅记录测试命令（git 差异探测等辅助命令不计入，避免污染轮次断言） */
  runs: string[] = [];
  /** 辅助命令（git 等）单独统计 */
  auxRuns: string[] = [];
  private readonly script: Array<{ code: number; stdout: string }>;

  constructor(files: Record<string, string>, script: Array<{ code: number; stdout: string }>) {
    super(files);
    this.script = [...script];
  }

  override process = {
    run: async (command: string, _options?: ProcessRunOptions): Promise<ProcessResult> => {
      // 自愈循环在修复回合前会读取 git diff（readDiff）；若它消耗脚本序列，
      // 真正的测试轮次就会拿到错位的预设结果。辅助命令一律不占用脚本。
      if (/^\s*git\b/.test(command)) {
        this.auxRuns.push(command);
        return { code: 0, stdout: '', stderr: '' };
      }
      this.runs.push(command);
      const step = this.script.shift();
      if (!step) return { code: 0, stdout: 'Tests  1 passed (1)', stderr: '' };
      return { code: step.code, stdout: step.stdout, stderr: '' };
    },
  } as unknown as MemoryHost['process'];
}

test('AgentServer.runTestLoop：集成权限规则、项目配置与自愈回合', async () => {
  const host = new ScriptedTestHost(
    {
      '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      '/ws/pnpm-lock.yaml': '',
      '/ws/.easycode/permissions.json': JSON.stringify({
        rules: [{ tool: 'run_command', pattern: 'rm', decision: 'deny' }],
      }),
      '/ws/src/a.ts': 'export const a = 1;\n',
    },
    [
      { code: 1, stdout: 'FAIL  src/a.test.ts\r\nerror TS2304: Cannot find name a' },
      { code: 0, stdout: 'Tests  3 passed (3)' },
    ],
  );
  const server = new AgentServer(host);
  await server.updateSettings({
    providers: {
      mock: { kind: 'mock', baseURL: '', name: 'Mock', enabled: true, models: [{ name: 'mock-1', enabled: true }] },
    },
    defaultProvider: 'mock',
    defaultApprovalMode: 'yolo',
    permissions: { enabled: true, rules: [] },
  });
  const session = await server.createSession({
    workspaceRoot: '/ws',
    providerId: 'mock',
    title: '测试自愈',
  });

  const detection = await server.detectSessionTestCommand(session.id);
  assert.equal(detection?.command, 'pnpm test');

  const projectRules = await server.loadProjectPermissions('/ws');
  assert.deepEqual(projectRules, [
    { tool: 'run_command', pattern: 'rm', decision: 'deny', source: 'project' },
  ]);

  const events: AgentEvent[] = [];
  server.onEvent((payload) => {
    if (payload.sessionId === session.id) events.push(payload.event);
  });

  const result = await server.runTestLoop(session.id, { maxRounds: 2, focus: 'src/a.ts' });
  assert.equal(result.ok, true);
  assert.equal(result.rounds, 2);
  // 首轮失败 + 次轮通过，说明修复回合被真正驱动
  assert.equal(host.runs.length, 2);
  assert.equal(
    events.filter((e) => e.type === 'test_run_start').length,
    2,
  );
  const data = await server.getSession(session.id);
  // 修复回合把失败摘要写入会话历史，便于重载后回溯
  assert.ok(
    data.messages.some(
      (m) => m.role === 'user' && m.content.includes('测试自愈循环 · 第 1/2 轮'),
    ),
  );

  // 权限规则生效：项目级 deny 让 rm 命令被拒绝且不落执行
  const denyResult = await executeTool(
    new ToolRegistry().register({
      spec: {
        name: 'run_command',
        description: 'echo',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
      sensitive: true,
      execute: async () => 'should-not-run',
    }),
    'run_command',
    { command: 'rm -rf build' },
    {
      host,
      workspace: '/ws',
      signal: new AbortController().signal,
      approval: new ApprovalManager(() => {}, 'yolo'),
      permissionRules: await server.resolvePermissionRules('/ws'),
    },
  );
  assert.equal(denyResult.approved, false);
  assert.match(denyResult.content, /项目规则: run_command ~ "rm"/);
});

test('AgentServer.runTestLoop：未绑定工作区与未探测到命令时给出明确错误', async () => {
  const host = new MemoryHost({ '/ws/readme.md': 'x' });
  const server = new AgentServer(host);
  await server.updateSettings({
    providers: {
      mock: { kind: 'mock', baseURL: '', name: 'Mock', enabled: true, models: [{ name: 'mock-1', enabled: true }] },
    },
    defaultProvider: 'mock',
    defaultApprovalMode: 'yolo',
  });
  const plain = await server.createSession({ providerId: 'mock', title: '纯对话' });
  await assert.rejects(() => server.runTestLoop(plain.id), /未绑定工作区/);

  const bound = await server.createSession({
    workspaceRoot: '/ws',
    providerId: 'mock',
    title: '无测试',
  });
  await assert.rejects(() => server.runTestLoop(bound.id), /未探测到测试命令/);
});

test('AgentServer.runTestLoop：ask 模式取消审批则不执行任何测试', async () => {
  const host = new ScriptedTestHost(
    { '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) },
    [],
  );
  const server = new AgentServer(host);
  await server.updateSettings({
    providers: {
      mock: { kind: 'mock', baseURL: '', name: 'Mock', enabled: true, models: [{ name: 'mock-1', enabled: true }] },
    },
    defaultProvider: 'mock',
    defaultApprovalMode: 'ask',
  });
  const session = await server.createSession({
    workspaceRoot: '/ws',
    providerId: 'mock',
    title: '审批取消',
  });
  server.onEvent((payload) => {
    // 审批请求到达即模拟用户拒绝
    if (payload.sessionId === session.id && payload.event.type === 'approval_request') {
      server.respondApproval(session.id, payload.event.requestId, false);
    }
  });
  const result = await server.runTestLoop(session.id);
  assert.equal(result.reason, 'aborted');
  assert.equal(host.runs.length, 0);
});

test('AgentServer.runTestLoop：测试命令受权限规则约束，deny 直接拒绝且不执行', async () => {
  const host = new ScriptedTestHost(
    {
      '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      // 项目级配置把测试命令改成破坏性命令，模拟不可信仓库
      '/ws/.easycode/test.json': JSON.stringify({ command: 'rm -rf build' }),
      '/ws/.easycode/permissions.json': JSON.stringify({
        rules: [{ tool: 'run_command', pattern: 'rm', decision: 'deny' }],
      }),
    },
    [],
  );
  const server = new AgentServer(host);
  await server.updateSettings({
    providers: {
      mock: { kind: 'mock', baseURL: '', name: 'Mock', enabled: true, models: [{ name: 'mock-1', enabled: true }] },
    },
    defaultProvider: 'mock',
    // YOLO 模式同样不得绕过 deny 规则
    defaultApprovalMode: 'yolo',
  });
  const session = await server.createSession({
    workspaceRoot: '/ws',
    providerId: 'mock',
    title: '规则拦截',
  });
  await assert.rejects(() => server.runTestLoop(session.id), /测试命令被权限规则拒绝/);
  assert.equal(host.runs.length, 0);
});

test('AgentServer.runTestLoop：ask 规则在 YOLO 模式下仍强制审批并标注规则来源', async () => {
  const host = new ScriptedTestHost(
    {
      '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      '/ws/pnpm-lock.yaml': '',
      '/ws/.easycode/permissions.json': JSON.stringify({
        rules: [{ tool: 'run_command', pattern: 'pnpm test', decision: 'ask', note: '测试命令必须确认' }],
      }),
    },
    [{ code: 0, stdout: 'Tests  2 passed (2)' }],
  );
  const server = new AgentServer(host);
  await server.updateSettings({
    providers: {
      mock: { kind: 'mock', baseURL: '', name: 'Mock', enabled: true, models: [{ name: 'mock-1', enabled: true }] },
    },
    defaultProvider: 'mock',
    defaultApprovalMode: 'yolo',
  });
  const session = await server.createSession({
    workspaceRoot: '/ws',
    providerId: 'mock',
    title: '强制审批',
  });
  const approvals: AgentEvent[] = [];
  server.onEvent((payload) => {
    if (payload.sessionId === session.id && payload.event.type === 'approval_request') {
      approvals.push(payload.event);
      server.respondApproval(session.id, payload.event.requestId, true);
    }
  });
  const result = await server.runTestLoop(session.id);
  assert.equal(result.ok, true);
  assert.equal(approvals.length, 1, 'YOLO 模式下 ask 规则仍应弹一次审批');
  const request = approvals[0];
  assert.ok(request.type === 'approval_request');
  assert.equal(request.toolName, 'test_loop');
  assert.match(request.reason ?? '', /项目规则: run_command ~ "pnpm test"/);
  assert.equal(host.runs.length, 1);
});

test('AgentServer.runTestLoop：修复回合中被用户停止时循环一并收敛，不再跑下一轮测试', async () => {
  const host = new ScriptedTestHost(
    {
      '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      '/ws/pnpm-lock.yaml': '',
    },
    [
      { code: 1, stdout: 'FAIL  src/a.test.ts\nTests  1 failed (1)' },
      { code: 0, stdout: 'Tests  1 passed (1)' },
    ],
  );
  const server = new AgentServer(host);
  await server.updateSettings({
    providers: {
      mock: { kind: 'mock', baseURL: '', name: 'Mock', enabled: true, models: [{ name: 'mock-1', enabled: true }] },
    },
    defaultProvider: 'mock',
    defaultApprovalMode: 'yolo',
  });
  const session = await server.createSession({
    workspaceRoot: '/ws',
    providerId: 'mock',
    title: '中止传播',
  });
  let aborted = false;
  server.onEvent((payload) => {
    // 修复回合一开始（首个助手事件）就等价于点「停止」
    if (
      !aborted &&
      payload.sessionId === session.id &&
      (payload.event.type === 'assistant_start' || payload.event.type === 'text_delta')
    ) {
      aborted = true;
      server.abort(session.id);
    }
  });
  const result = await server.runTestLoop(session.id, { maxRounds: 2 });
  assert.equal(aborted, true, '修复回合必须真正被驱动');
  assert.equal(result.reason, 'aborted');
  assert.equal(host.runs.length, 1, '中止后不得再跑下一轮测试');
});

/* ------------------------------------------------------------------ */
/* PR #9 审查返工回归                                                  */
/* ------------------------------------------------------------------ */

test('【P1 信任边界】不可信项目自带 allow 规则不得取消用户的 ask 保护', async () => {
  const host = new ScriptedTestHost(
    {
      '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      '/ws/pnpm-lock.yaml': '',
      // 克隆来的仓库试图自行放行所有命令
      '/ws/.easycode/permissions.json': JSON.stringify({
        rules: [
          { tool: 'run_command', decision: 'allow' },
          { tool: 'run_command', pattern: 'rm', decision: 'deny' },
        ],
      }),
    },
    [],
  );
  const server = new AgentServer(host);
  await server.updateSettings({
    providers: {
      mock: { kind: 'mock', baseURL: '', name: 'Mock', enabled: true, models: [{ name: 'mock-1', enabled: true }] },
    },
    defaultProvider: 'mock',
    defaultApprovalMode: 'ask',
    permissions: { enabled: true, rules: [] },
  });
  const session = await server.createSession({
    workspaceRoot: '/ws',
    providerId: 'mock',
    title: '信任边界',
  });

  // 默认未信任：项目级 allow 被丢弃，deny 保留
  const rules = await server.resolvePermissionRules('/ws');
  assert.ok(rules);
  assert.equal(rules.some((r) => r.decision === 'allow'), false, '项目级 allow 必须被忽略');
  assert.equal(rules.some((r) => r.decision === 'deny'), true, '项目级 deny 必须保留');
  assert.equal(await server.countIgnoredProjectAllowRules('/ws'), 1);

  // 由此在 ask 模式下调用 run_command 仍然需要审批
  const events: AgentEvent[] = [];
  const approval = new ApprovalManager((e) => events.push(e), 'ask');
  const pending = executeTool(
    createBuiltinTools(),
    'run_command',
    { command: 'ls' },
    { host, workspace: '/ws', signal: new AbortController().signal, approval, permissionRules: rules },
  );
  const req = events.find((e) => e.type === 'approval_request');
  assert.ok(req && req.type === 'approval_request', 'ask 模式下必须请求审批');
  approval.resolve(req.requestId, true);
  assert.equal((await pending).approved, true);

  // 显式信任后，项目级 allow 才会参与裁决
  await server.updateSettings({ permissions: { enabled: true, trustProjectAllow: true, rules: [] } });
  const trusted = await server.resolvePermissionRules('/ws');
  assert.equal(trusted?.some((r) => r.decision === 'allow'), true);
  assert.equal(await server.countIgnoredProjectAllowRules('/ws'), 0);
});

test('【P2 统一裁决】测试命令命中 allow 时 ask 模式下免审批直接执行', async () => {
  const host = new ScriptedTestHost(
    {
      '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      '/ws/pnpm-lock.yaml': '',
      '/ws/.easycode/permissions.json': JSON.stringify({
        rules: [{ tool: 'run_command', pattern: 'pnpm test', decision: 'allow' }],
      }),
    },
    [{ code: 0, stdout: 'Tests  2 passed (2)' }],
  );
  const server = new AgentServer(host);
  await server.updateSettings({
    providers: {
      mock: { kind: 'mock', baseURL: '', name: 'Mock', enabled: true, models: [{ name: 'mock-1', enabled: true }] },
    },
    defaultProvider: 'mock',
    // ask 模式：若 allow 未生效就会弹审批并卡住
    defaultApprovalMode: 'ask',
    // 项目级 allow 需显式信任（见上一条用例）
    permissions: { enabled: true, trustProjectAllow: true, rules: [] },
  });
  const session = await server.createSession({
    workspaceRoot: '/ws',
    providerId: 'mock',
    title: 'allow 免审批',
  });
  const approvals: AgentEvent[] = [];
  server.onEvent((payload) => {
    if (payload.sessionId === session.id && payload.event.type === 'approval_request') {
      approvals.push(payload.event);
      server.respondApproval(session.id, payload.event.requestId, true);
    }
  });
  const result = await server.runTestLoop(session.id, { maxRounds: 1 });
  assert.equal(approvals.length, 0, '命中 allow 时不得弹审批');
  assert.equal(result.ok, true);
  assert.equal(host.runs.length, 1);
});

test('【P1 并发】连续启动两次测试循环只有一次能进入运行态', async () => {
  const host = new ScriptedTestHost(
    {
      '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      '/ws/pnpm-lock.yaml': '',
    },
    [{ code: 0, stdout: 'Tests  1 passed (1)' }],
  );
  const server = new AgentServer(host);
  await server.updateSettings({
    providers: {
      mock: { kind: 'mock', baseURL: '', name: 'Mock', enabled: true, models: [{ name: 'mock-1', enabled: true }] },
    },
    defaultProvider: 'mock',
    defaultApprovalMode: 'yolo',
  });
  const session = await server.createSession({
    workspaceRoot: '/ws',
    providerId: 'mock',
    title: '并发启动',
  });

  // 检查与占位之间若有 await，两次调用都会通过检查并各自启动一个循环
  const first = server.runTestLoop(session.id, { maxRounds: 1 });
  const second = server.runTestLoop(session.id, { maxRounds: 1 });
  const outcomes = await Promise.allSettled([first, second]);
  const rejected = outcomes.filter((o) => o.status === 'rejected');
  assert.equal(rejected.length, 1, '第二次启动必须被拒绝');
  assert.match(
    String((rejected[0] as PromiseRejectedResult).reason?.message ?? rejected[0]),
    /正在运行中/,
  );
  assert.equal(host.runs.length, 1, '测试命令只能被执行一次');
});

test('【P2 错误收敛】修复回合抛异常时循环发出唯一一次终止事件', async () => {
  const { events, emit } = collectEvents();
  const result = await runTestLoop({
    command: 'pnpm test',
    commandSource: 'pkg',
    maxRounds: 3,
    signal: new AbortController().signal,
    emit,
    runTests: async () => ({ exitCode: 1, output: 'Tests  1 failed (1)', durationMs: 5 }),
    repair: async () => {
      throw new Error('模型初始化失败');
    },
  });
  assert.equal(result.reason, 'error');
  assert.match(result.message ?? '', /模型初始化失败/);
  const done = events.filter((e) => e.type === 'test_loop_done');
  assert.equal(done.length, 1, '终止事件必须且只能发一次');
  assert.ok(done[0].type === 'test_loop_done' && done[0].reason === 'error');
});

test('【P2 错误收敛】修复回合返回失败结果时终止循环，不再重跑测试', async () => {
  const { events, emit } = collectEvents();
  let runCount = 0;
  const result = await runTestLoop({
    command: 'pnpm test',
    commandSource: 'pkg',
    maxRounds: 3,
    signal: new AbortController().signal,
    emit,
    runTests: async () => {
      runCount += 1;
      return { exitCode: 1, output: 'Tests  1 failed (1)', durationMs: 5 };
    },
    repair: async () => ({ ok: false, message: '回合以 error 结束' }),
  });
  assert.equal(result.reason, 'error');
  assert.equal(result.rounds, 1);
  assert.equal(runCount, 1, '修复失败后不得继续重跑测试');
  assert.equal(events.filter((e) => e.type === 'test_loop_done').length, 1);
});

test('【P2 错误收敛】修复回合返回 aborted 时收敛为 aborted', async () => {
  const { events, emit } = collectEvents();
  const result = await runTestLoop({
    command: 'pnpm test',
    commandSource: 'pkg',
    maxRounds: 3,
    signal: new AbortController().signal,
    emit,
    runTests: async () => ({ exitCode: 1, output: 'Tests  1 failed (1)', durationMs: 5 }),
    repair: async () => ({ ok: false, aborted: true }),
  });
  assert.equal(result.reason, 'aborted');
  assert.equal(events.filter((e) => e.type === 'test_loop_done').length, 1);
});
