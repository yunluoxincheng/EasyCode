import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryHost } from '@easycode/core';
import type { AgentEvent, PermissionRule, ProcessRunOptions, ProcessResult } from '@easycode/core';
import { ApprovalManager, ToolRegistry, executeTool, type Tool } from '@easycode/core';
import { WorkspaceLockManager } from '../workspace-lock.js';
import {
  AgentServer
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

test('【P2 复审】修复回合内部 done 不得提前结束 UI 回合', async () => {
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
    title: '内部 done',
  });
  const events: AgentEvent[] = [];
  server.onEvent((payload) => {
    if (payload.sessionId === session.id) events.push(payload.event);
  });

  const result = await server.runTestLoop(session.id, { maxRounds: 2 });
  assert.equal(result.ok, true);

  const doneCount = events.filter((e) => e.type === 'done').length;
  const loopDone = events.filter((e) => e.type === 'test_loop_done');
  assert.equal(doneCount, 0, '修复回合是内部回合，不得向外发 done（否则 UI 提前结束回合）');
  assert.equal(loopDone.length, 1, '结束语义必须由 test_loop_done 唯一掌握');
  // 过程事件仍然可见（助手输出、工具调用不能被一起吞掉）
  assert.ok(events.some((e) => e.type === 'text_delta'), '修复过程仍需可见');
});

test('【P1 复审】工作区切换与测试循环启动不得交错（TOCTOU）', async () => {
  const host = new ScriptedTestHost(
    {
      '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      '/ws/pnpm-lock.yaml': '',
      '/ws2/keep.txt': 'x',
    },
    [{ code: 0, stdout: 'Tests  1 passed (1)' }],
  );
  const bootHost = new AgentServer(host);
  await bootHost.updateSettings({
    providers: {
      mock: { kind: 'mock', baseURL: '', name: 'Mock', enabled: true, models: [{ name: 'mock-1', enabled: true }] },
    },
    defaultProvider: 'mock',
    defaultApprovalMode: 'yolo',
  });
  await bootHost.createSession({
    workspaceRoot: '/ws',
    providerId: 'mock',
    title: 'TOCTOU',
  });

  // 让 setSessionWorkspace 的目标目录 stat 变慢，制造「检查后 await」窗口；
  // 在窗口内启动测试循环，验证工作区切换不会穿过 busy 生效
  let releaseStat: (() => void) | undefined;
  const statGate = new Promise<void>((resolve) => {
    releaseStat = resolve;
  });
  let gatedPath = false;
  // fs 是只读属性：不改宿主实例，而是包一层再交给引擎（runs 等状态仍共享同一对象）
  const gatedHost = {
    ...host,
    fs: {
      ...host.fs,
      stat: async (p: string) => {
        // Windows 宿主会返回反斜杠路径，匹配前统一分隔符
        const normalized = p.replace(/\\/g, '/');
        if (!gatedPath && normalized.endsWith('/ws2')) {
          gatedPath = true;
          await statGate;
        }
        return host.fs.stat(p);
      },
    },
  } as unknown as typeof host;
  const server = new AgentServer(gatedHost);
  const sessions = await server.listSessions();
  const sessionId = sessions[0].id;

  const switching = server.setSessionWorkspace(sessionId, '/ws2');
  // 等切换调用确实停在 stat 里
  const deadline = Date.now() + 5000;
  while (!gatedPath) {
    if (Date.now() > deadline) throw new Error('等待 workpsace stat 进入超时');
    await new Promise((r) => setTimeout(r, 5));
  }
  const loop = server.runTestLoop(sessionId, { maxRounds: 1 });
  releaseStat?.();

  // 二者互斥：要么切换先完成（循环被拒），要么循环先占位（切换被拒），绝不能都成功
  const [switchOutcome, loopOutcome] = await Promise.allSettled([switching, loop]);
  const bothOk = switchOutcome.status === 'fulfilled' && loopOutcome.status === 'fulfilled';
  assert.equal(bothOk, false, '工作区切换与测试循环不得同时成功');
  const data = await server.getSession(sessionId);
  if (loopOutcome.status === 'fulfilled') {
    // 循环成功 → 工作区必须仍是原值（不允许中途被改）
    assert.equal(data.meta.workspaceRoot, '/ws', '循环进行中工作区不得被切走');
  }
});

test('【P2 四轮】跨会话：一个会话持锁时另一会话的测试循环被挡住', async () => {
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
  const a = await server.createSession({ workspaceRoot: '/ws', providerId: 'mock', title: 'A' });
  const b = await server.createSession({ workspaceRoot: '/ws', providerId: 'mock', title: 'B' });

  const locks = (server as unknown as { workspaceLocks: WorkspaceLockManager }).workspaceLocks;
  let releaseA: (() => void) | undefined;
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const holdingA = locks.withLock('/ws', async () => {
    await gateA;
  });

  let ranDuringHold = false;
  const originalRun = host.process.run as unknown as (
    command: string,
    options?: ProcessRunOptions,
  ) => Promise<ProcessResult>;
  host.process = {
    ...host.process,
    run: async (command: string, options?: ProcessRunOptions) => {
      if (!/^\s*git\b/.test(command)) ranDuringHold = true;
      return originalRun(command, options);
    },
  } as unknown as typeof host.process;

  // 会话 B 的测试循环必须等工作区锁释放（会话级锁保护不了这一点）
  const loopB = server.runTestLoop(b.id, { maxRounds: 1 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ranDuringHold, false, '跨会话同样必须遵守工作区互斥');

  releaseA?.();
  await holdingA;
  const result = await loopB;
  assert.equal(ranDuringHold, true);
  assert.equal(result.ok, true);
  assert.equal(server.isSessionBusy(a.id), false);
});

/* ------------------------------------------------------------------ */
/* PR #9 第二轮复审回归                                                */
/* ------------------------------------------------------------------ */

/** 构造一个已绑定工作区、可跑测试的 AgentServer */
async function makeServer(
  files: Record<string, string>,
  script: Array<{ code: number; stdout: string }>,
  settings: Parameters<AgentServer['updateSettings']>[0] = {},
): Promise<{ host: ScriptedTestHost; server: AgentServer }> {
  const host = new ScriptedTestHost(files, script);
  const server = new AgentServer(host);
  await server.updateSettings({
    providers: {
      mock: { kind: 'mock', baseURL: '', name: 'Mock', enabled: true, models: [{ name: 'mock-1', enabled: true }] },
    },
    defaultProvider: 'mock',
    defaultApprovalMode: 'yolo',
    ...settings,
  });
  return { host, server };
}

const TEST_PKG = { '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) };

test('【P1 复审】拒绝测试循环审批后必须发出终止事件（前端不得卡在运行态）', async () => {
  const { host, server } = await makeServer(TEST_PKG, [], { defaultApprovalMode: 'ask' });
  const session = await server.createSession({
    workspaceRoot: '/ws',
    providerId: 'mock',
    title: '审批拒绝收敛',
  });
  const events: AgentEvent[] = [];
  server.onEvent((payload) => {
    if (payload.sessionId !== session.id) return;
    events.push(payload.event);
    if (payload.event.type === 'approval_request') {
      // 模拟用户点「拒绝」
      server.respondApproval(session.id, payload.event.requestId, false);
    }
  });

  const result = await server.runTestLoop(session.id, { maxRounds: 1 });
  assert.equal(result.reason, 'aborted');
  const done = events.filter((e) => e.type === 'test_loop_done');
  assert.equal(done.length, 1, '拒绝路径必须发出 test_loop_done，否则 UI 永久 running');
  assert.ok(done[0].type === 'test_loop_done' && done[0].reason === 'aborted');
  assert.equal(host.runs.length, 0, '拒绝后不得执行任何测试');
  // 收尾后会话必须恢复空闲，可再次启动
  assert.equal(server.isSessionBusy(session.id), false);
});

test('【P1 复审】测试循环期间不得切换工作区 / Provider / 回退快照', async () => {
  // 用可控宿主：让测试命令「挂住」，确保断言发生在循环真正运行期间
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = new ScriptedTestHost(
    { ...TEST_PKG, '/ws2/keep.txt': 'x' },
    [{ code: 0, stdout: 'Tests  1 passed (1)' }],
  );
  // 只覆盖 run，保留 spawn / kill / listSpawned 等其它进程能力
  const originalProcess = host.process;
  const originalRun = originalProcess.run as unknown as (
    command: string,
    options?: ProcessRunOptions,
  ) => Promise<ProcessResult>;
  let gateHit = false;
  host.process = {
    ...originalProcess,
    run: async (command: string, options?: ProcessRunOptions) => {
      // 测试命令探测结果是 `npm test`（无锁文件时默认 npm），必须按命令内容而非
      // 具体的 vitest 字样判断，否则 gate 不生效、循环瞬间结束
      if (!gateHit && /\btest\b/i.test(command)) {
        gateHit = true;
        await gate;
      }
      return originalRun(command, options);
    },
  } as unknown as typeof host.process;

  const server = new AgentServer(host);
  await server.updateSettings({
    providers: {
      mock: { kind: 'mock', baseURL: '', name: 'Mock', enabled: true, models: [{ name: 'mock-1', enabled: true }] },
      other: { kind: 'mock', baseURL: '', name: 'Other', enabled: true, models: [{ name: 'o-1', enabled: true }] },
    },
    defaultProvider: 'mock',
    defaultApprovalMode: 'yolo',
  });
  const session = await server.createSession({
    workspaceRoot: '/ws',
    providerId: 'mock',
    title: '运行期锁定',
  });

  const pending = server.runTestLoop(session.id, { maxRounds: 1 });
  // P1：紧接着重复启动，也只能有一个调用取得会话占位。
  await assert.rejects(server.runTestLoop(session.id, { maxRounds: 1 }), /正在运行中/);
  // 等循环进入运行态（busy=true；此时 running 可能为 false——这正是复审指出的窗口）。
  // 必须带超时：忙等待若无上限，一旦状态没按预期变化就会把整个测试进程挂死。
  const waitDeadline = Date.now() + 5000;
  while (!server.isSessionBusy(session.id)) {
    if (Date.now() > waitDeadline) {
      release?.();
      throw new Error('等待测试循环进入运行态超时（isSessionBusy 始终为 false）');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(server.isRunning(session.id), false, '测试命令执行期间 running 应为 false');

  await assert.rejects(() => server.setSessionWorkspace(session.id, '/ws2'), /运行中/);
  await assert.rejects(() => server.setSessionProvider(session.id, 'other'), /运行中/);
  await assert.rejects(() => server.setSessionModel(session.id, 'm2'), /运行中/);
  await assert.rejects(() => server.revertTurnCheckpoint(session.id), /运行中/);

  release?.();
  await pending;
  assert.equal(host.runs.length, 1, '并发第二次启动不得实际执行命令');

  // 结束后恢复正常可用
  const meta = await server.setSessionWorkspace(session.id, '/ws2');
  assert.equal(meta.workspaceRoot, '/ws2');
});
