/**
 * PR #9 第七轮复审回归：Shell 环境变量前缀绕过 + 测试循环生命周期竞态。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MemoryHost,
  evaluatePermission,
  matchCommandPattern,
  normalizeShellCommand,
  type PermissionRule,
  type ProcessRunOptions,
  type ProcessResult,
} from '@easycode/core';
import { AgentServer } from '../index.js';

/* -------------------- P1：Shell 环境变量前缀归一化 -------------------- */

test('【P1 七轮】引号片段与裸文本拼接的赋值前缀同样被剥离', () => {
  // 以下写法在 POSIX Shell 中都以环境变量赋值开头，随后执行 rm
  const bypass = [
    'FOO="hello"world rm -rf build',
    'FOO=x"hello world" rm -rf build',
    "FOO='a b'c rm -rf build",
    'FOO=a"b"c"d e" rm -rf build',
    'FOO="he\\"llo" rm -rf build',
  ];
  for (const cmd of bypass) {
    assert.equal(normalizeShellCommand(cmd), 'rm -rf build', `归一化失败: ${cmd}`);
    assert.equal(matchCommandPattern('rm', cmd), true, `绕过 deny: ${cmd}`);
  }

  // 常规写法与多赋值前缀仍然正确（不回归）
  assert.equal(matchCommandPattern('rm', 'FOO="hello world" rm -rf build'), true);
  assert.equal(matchCommandPattern('rm', 'FOO=bar rm -rf build'), true);
  assert.equal(matchCommandPattern('rm', 'A=1 B="x y" rm -rf build'), true);
  assert.equal(matchCommandPattern('rm', 'FOO= rm -rf build'), true);

  // 词边界仍成立：rmdir 不得被 rm 命中
  assert.equal(matchCommandPattern('rm', 'FOO="a"b rmdir build'), false);
  // 引号未闭合视为不可解析：保守原样返回，不声称已清洗
  assert.equal(normalizeShellCommand('FOO="unclosed rm -rf build'), 'FOO="unclosed rm -rf build');
});

test('【P1 七轮】deny rm 规则对拼接式前缀生效（端到端裁决）', () => {
  const rules: PermissionRule[] = [{ tool: 'run_command', pattern: 'rm', decision: 'deny' }];
  for (const command of [
    'FOO="hello"world rm -rf build',
    'FOO=x"hello world" rm -rf build',
  ]) {
    const decision = evaluatePermission(rules, 'run_command', { command });
    assert.equal(decision?.decision, 'deny', `未拦截: ${command}`);
  }
});

/* -------------------- 测试工装 -------------------- */

/** 可阻断指定文件读/写的 MemoryHost：用于构造确定性的异步交错 */
class GatedHost extends MemoryHost {
  /** 命中闸门时把 release 函数塞进这里，测试据此精确控制时序 */
  pending: Array<() => void> = [];
  gatePattern: RegExp | null = null;
  private waiters: Array<() => void> = [];

  constructor(files: Record<string, string>) {
    super(files);
    const originalWrite = this.fs.writeFile.bind(this.fs);
    const originalRead = this.fs.readFile.bind(this.fs);
    const fsHooks = this.fs as unknown as {
      writeFile: (p: string, d: string) => Promise<void>;
      readFile: (p: string) => Promise<string>;
    };
    fsHooks.writeFile = async (p: string, d: string) => {
      await this.gate(p);
      return originalWrite(p, d);
    };
    fsHooks.readFile = async (p: string) => {
      await this.gate(p);
      return originalRead(p);
    };
  }

  private async gate(path: string): Promise<void> {
    if (!this.gatePattern?.test(path)) return;
    await new Promise<void>((release) => {
      this.pending.push(release);
      // 闸门命中即通知等待方：不使用轮询，避免与异步流程错位
      const waiters = this.waiters;
      this.waiters = [];
      for (const notify of waiters) notify();
    });
  }

  gateOn(pattern: RegExp): void {
    this.gatePattern = pattern;
  }

  /** 等到流程真正进入闸门（既有的命中或下一次命中） */
  waitForGate(): Promise<void> {
    if (this.pending.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      // 兜底：流程未进入闸门时给出明确失败，而不是挂到测试超时
      setTimeout(() => resolve(), 15_000).unref?.();
    });
  }

  releaseAll(): void {
    const list = this.pending;
    this.pending = [];
    this.gatePattern = null; // 放行后不再拦截，避免二次挂起
    for (const release of list) release();
  }
}

class RecordingHost extends GatedHost {
  runs: string[] = [];
  scripts: Array<{ code: number; stdout: string }>;

  constructor(files: Record<string, string>, scripts: Array<{ code: number; stdout: string }>) {
    super(files);
    this.scripts = [...scripts];
  }

  override process = {
    run: async (command: string, _options?: ProcessRunOptions): Promise<ProcessResult> => {
      if (/^\s*git\b/.test(command)) return { code: 0, stdout: '', stderr: '' };
      this.runs.push(command);
      const step = this.scripts.shift();
      return step
        ? { code: step.code, stdout: step.stdout, stderr: '' }
        : { code: 0, stdout: 'Tests  1 passed (1)', stderr: '' };
    },
  } as unknown as MemoryHost['process'];
}

async function bootstrap(host: MemoryHost): Promise<{ server: AgentServer; sessionId: string }> {
  const server = new AgentServer(host);
  await server.updateSettings({
    providers: {
      mock: {
        kind: 'mock',
        baseURL: '',
        name: 'Mock',
        enabled: true,
        models: [{ name: 'mock-1', enabled: true }],
      },
    },
    defaultProvider: 'mock',
    defaultApprovalMode: 'yolo',
    permissions: { enabled: true, rules: [] },
    testLoop: { maxRounds: 3, timeoutMs: 60_000 },
  });
  const session = await server.createSession({
    workspaceRoot: '/ws',
    providerId: 'mock',
    title: '七轮生命周期',
  });
  return { server, sessionId: session.id };
}

/* -------------------- P2：修复回合收尾期间停止 -------------------- */

test('【P2 七轮】修复回合落盘等待期间点停止，自愈不得继续下一轮', async () => {
  const host = new RecordingHost(
    {
      '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      '/ws/pnpm-lock.yaml': '',
      '/ws/src/a.ts': 'export const a = 1;\n',
    },
    [{ code: 1, stdout: 'FAIL  src/a.test.ts\r\nerror TS2304: Cannot find name a' }],
  );
  const { server, sessionId } = await bootstrap(host);

  // 闸门只卡会话落盘（sessions/*.json），不影响其它写入
  host.gateOn(/\/sessions\/.*\.json$/);

  const pending = server.runTestLoop(sessionId, { maxRounds: 3 });

  // 等第一轮测试 + 修复回合跑到「落盘」这一步（确定性等待，不用定时器）
  await host.waitForGate();
  assert.equal(host.runs.length, 1, '此刻应只跑过一轮测试');

  // 用户在此窗口点击停止：controller 必须仍然可中止
  server.abort(sessionId);
  host.releaseAll();

  const result = await pending;
  assert.equal(result.reason, 'aborted', `应中止，实际: ${JSON.stringify(result)}`);
  assert.equal(host.runs.length, 1, '停止后不得再执行下一轮测试');
  assert.equal(server.isSessionBusy(sessionId), false, '会话必须回到空闲态');
});

/* -------------------- P2：删除正在启动的测试循环 -------------------- */

test('【P2 七轮】启动阶段删除会话后，循环不得把会话写回磁盘（不复活）', async () => {
  const host = new RecordingHost(
    {
      '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      '/ws/pnpm-lock.yaml': '',
      '/ws/.easycode/test.json': JSON.stringify({ command: 'pnpm test', maxRounds: 2 }),
      '/ws/src/a.ts': 'export const a = 1;\n',
    },
    [
      { code: 1, stdout: 'FAIL  src/a.test.ts\r\nerror TS2304: Cannot find name a' },
      { code: 0, stdout: 'Tests  3 passed (3)' },
    ],
  );
  const { server, sessionId } = await bootstrap(host);
  const sessionFile = host.paths.join(host.env.dataDir(), 'sessions', `${sessionId}.json`);
  // 确认会话文件已存在（创建时已落盘）
  assert.ok(await host.fs.stat(sessionFile), '会话文件应在创建后存在');

  // 闸门卡住「读取项目测试配置」，把删除动作精确插进探测阶段
  host.gateOn(/\/\.easycode\/test\.json$/);
  const pending = server.runTestLoop(sessionId, { maxRounds: 2 });
  await host.waitForGate();

  // 该窗口内 controller 尚未跑起循环体，删除必须能终止它
  await server.deleteSession(sessionId);
  host.releaseAll();
  const result = await pending;

  assert.equal(result.ok, false);
  // 关键断言：会话既不在内存表中，磁盘文件也不得被收尾流程重新写回
  const listed = await server.listSessions();
  assert.equal(listed.some((s) => s.id === sessionId), false, '会话不得回到会话表');
  assert.equal(await host.fs.stat(sessionFile), null, '会话文件不得被重新写回（复活）');
  assert.equal(host.runs.length, 0, '删除后不应再执行测试命令');
});

test('【P2 七轮】循环运行中删除会话同样不会复活', async () => {
  const host = new RecordingHost(
    {
      '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      '/ws/pnpm-lock.yaml': '',
      '/ws/src/a.ts': 'export const a = 1;\n',
    },
    [{ code: 1, stdout: 'FAIL  src/a.test.ts\r\nerror TS2304: Cannot find name a' }],
  );
  const { server, sessionId } = await bootstrap(host);
  const sessionFile = host.paths.join(host.env.dataDir(), 'sessions', `${sessionId}.json`);

  host.gateOn(/\/sessions\/.*\.json$/);
  const pending = server.runTestLoop(sessionId, { maxRounds: 3 });
  await host.waitForGate(); // 修复回合落盘在途且被卡住

  // 删除会先等在途落盘落定再 unlink，因此必须与放行并发推进
  const deleting = server.deleteSession(sessionId);
  host.releaseAll();
  await deleting;
  await pending;

  assert.equal(await host.fs.stat(sessionFile), null, '删除后会话文件不得复活');
  const listed = await server.listSessions();
  assert.equal(listed.some((s) => s.id === sessionId), false);
});
