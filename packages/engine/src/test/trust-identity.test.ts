/**
 * PR #9 第八轮复审回归：信任物理身份、并发落盘删除、规则加载期停止。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NodeHost } from '@easycode/host-node';
import { MemoryHost, type ProcessRunOptions, type ProcessResult } from '@easycode/core';
import { AgentServer } from '../index.js';

async function makeDirs() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'easycode-r8-'));
  return {
    base,
    cleanup: () => fsp.rm(base, { recursive: true, force: true }),
  };
}

async function makeServer(host: NodeHost | MemoryHost) {
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
    permissions: { enabled: true, trustedWorkspaces: [], rules: [] },
    testLoop: { maxRounds: 3, timeoutMs: 60_000 },
  });
  return server;
}

async function writeProjectAllowRule(projectRoot: string): Promise<void> {
  await fsp.mkdir(path.join(projectRoot, '.easycode'), { recursive: true });
  await fsp.writeFile(
    path.join(projectRoot, '.easycode', 'permissions.json'),
    JSON.stringify({ rules: [{ tool: 'run_command', pattern: 'rm', decision: 'allow' }] }),
    'utf8',
  );
}

/* -------------------- P1：信任绑定物理身份 -------------------- */

test('【P1 八轮】信任链接指向的 A 后改指 B，B 的项目 allow 不得生效', async () => {
  const { base, cleanup } = await makeDirs();
  try {
    const projA = path.join(base, 'projA');
    const projB = path.join(base, 'projB');
    await fsp.mkdir(projA, { recursive: true });
    await fsp.mkdir(projB, { recursive: true });
    await writeProjectAllowRule(projA);
    await writeProjectAllowRule(projB);

    const wsLink = path.join(base, 'ws-link');
    await fsp.symlink(projA, wsLink, 'junction');

    const host = new NodeHost({ dataDir: path.join(base, 'data') });
    const server = await makeServer(host);

    // 对链接路径授予信任（此时物理目标是 A）
    await server.setProjectTrust(wsLink, true);
    assert.equal(await server.getProjectTrust(wsLink), true, 'A 应被信任');
    const rulesForA = await server.resolvePermissionRules(wsLink);
    assert.equal(
      rulesForA?.some((r) => r.decision === 'allow'),
      true,
      'A 的项目 allow 应生效',
    );

    // 链接改指到 B
    await fsp.unlink(wsLink);
    await fsp.symlink(projB, wsLink, 'junction');

    // 词法路径完全没变，但物理项目已经换了 —— 授权不得继承
    assert.equal(
      await server.getProjectTrust(wsLink),
      false,
      '改指后不得沿用给 A 的信任',
    );
    const rulesForB = await server.resolvePermissionRules(wsLink);
    assert.equal(
      (rulesForB ?? []).some((r) => r.decision === 'allow'),
      false,
      'B 的项目级 allow 不得生效',
    );

    // 对 B 显式授权后才生效（功能没被整体废掉）
    await server.setProjectTrust(wsLink, true);
    assert.equal(await server.getProjectTrust(wsLink), true);
    const rulesForB2 = await server.resolvePermissionRules(wsLink);
    assert.equal(rulesForB2?.some((r) => r.decision === 'allow'), true);
    // 撤销 B 后物理路径也必须失去授权；改指不能复活 B 的旧授权。
    await server.setProjectTrust(wsLink, false);
    assert.equal(await server.getProjectTrust(projB), false);
    await fsp.unlink(wsLink);
    await fsp.symlink(projA, wsLink, 'junction');
    assert.equal(await server.getProjectTrust(wsLink), true, '此前授予 A 的独立信任仍然有效');
    await fsp.unlink(wsLink);
    await fsp.symlink(projB, wsLink, 'junction');
    assert.equal(await server.getProjectTrust(wsLink), false);
    assert.equal((await server.resolvePermissionRules(wsLink))?.some((r) => r.decision === 'allow') ?? false, false);
  } finally {
    await cleanup();
  }
});

/* -------------------- P2：并发落盘与删除 -------------------- */

/** 可精确卡住写入的宿主（确定性闸门，不用定时等待） */
class GatedMemoryHost extends MemoryHost {
  pending: Array<() => void> = [];
  gatePattern: RegExp | null = null;
  private waiters: Array<() => void> = [];
  writeCount = 0;
  /** 删除落定后仍发起的写入（用于断言「不得复活」） */
  writesAfterClose: string[] = [];
  closed = false;

  constructor(files: Record<string, string>) {
    super(files);
    const originalWrite = this.fs.writeFile.bind(this.fs);
    const originalRead = this.fs.readFile.bind(this.fs);
    const hooks = this.fs as unknown as {
      writeFile: (p: string, d: string) => Promise<void>;
      readFile: (p: string) => Promise<string>;
    };
    hooks.writeFile = async (p: string, d: string) => {
      this.writeCount += 1;
      if (this.closed) this.writesAfterClose.push(p);
      await this.gate(p);
      return originalWrite(p, d);
    };
    hooks.readFile = async (p: string) => {
      await this.gate(p);
      return originalRead(p);
    };
  }

  private async gate(target: string): Promise<void> {
    if (!this.gatePattern?.test(target)) return;
    await new Promise<void>((release) => {
      this.pending.push(release);
      const waiters = this.waiters;
      this.waiters = [];
      for (const notify of waiters) notify();
    });
  }

  gateOn(pattern: RegExp): void {
    this.gatePattern = pattern;
  }

  waitForGate(): Promise<void> {
    if (this.pending.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      setTimeout(() => resolve(), 15_000).unref?.();
    });
  }

  releaseAll(): void {
    const list = this.pending;
    this.pending = [];
    this.gatePattern = null;
    for (const release of list) release();
  }

  /** 只放行**最后**进入闸门的写入，其余继续挂住（用于构造确定性的乱序完成） */
  releaseLast(): void {
    const release = this.pending.pop();
    release?.();
  }

  /** 当前挂在闸门里的写入数量 */
  get heldCount(): number {
    return this.pending.length;
  }

  /** 推进微任务直到至少 n 个写入进入闸门（有界等待，避免死等） */
  async waitForHeld(n: number, rounds = 200): Promise<boolean> {
    for (let i = 0; i < rounds; i += 1) {
      if (this.pending.length >= n) return true;
      await new Promise((r) => setImmediate(r));
    }
    return this.pending.length >= n;
  }
}

/** 测试脚本：git 不占序列，测试命令按序列返回 */
class ScriptedMemoryHost extends GatedMemoryHost {
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

const WS_FILES = {
  '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
  '/ws/pnpm-lock.yaml': '',
  '/ws/src/a.ts': 'export const a = 1;\n',
};

const FAILING = { code: 1, stdout: 'FAIL  src/a.test.ts\r\nerror TS2304: Cannot find name a' };

test('【P2 八轮】多个并发落盘任务时删除会话，文件不得被较早的写入复活', async () => {
  const host = new ScriptedMemoryHost(WS_FILES, [FAILING]);
  const server = await makeServer(host);
  const session = await server.createSession({
    workspaceRoot: '/ws',
    providerId: 'mock',
    title: '八轮并发落盘',
  });
  const sessionFile = host.paths.join(host.env.dataDir(), 'sessions', `${session.id}.json`);
  const wroteBefore = host.writeCount;

  // 卡住会话落盘：让写入堆在闸门里
  host.gateOn(/\/sessions\/.*\.json$/);
  const loop = server.runTestLoop(session.id, { maxRounds: 3 });
  await host.waitForGate();

  // 同一会话上再触发多次落盘（不 await）：模拟多个并发持久化任务
  const extraWrites = [
    server.renameSession(session.id, '改名 1'),
    server.renameSession(session.id, '改名 2'),
  ].map((p) => p.catch(() => undefined));
  // 等这些写入真正进入闸门（并发实现下会同时挂住多个；串行实现下只有一个能挂住）
  await host.waitForHeld(2);

  // 删除必须等全部在途写入落定后才 unlink
  const deleting = server.deleteSession(session.id);
  // 关键交错：先放行**后**进入闸门的写入（并发实现下删除只会等最后一个），
  // 让更早的写入仍挂在闸门里。若没串行化也没登记全部在途任务，
  // 删除会在早先写入完成前就 unlink，该写入随后完成即把文件重新创建出来。
  host.releaseLast();
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
  // 再放行剩余写入（并解除布防，避免后续排队写入把删除卡死）
  host.closed = true;
  host.releaseAll();
  await deleting;
  await Promise.allSettled(extraWrites);
  await loop;
  for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r));

  assert.equal(await host.fs.stat(sessionFile), null, '会话文件不得被在途写入复活');
  assert.deepEqual(host.writesAfterClose, [], '删除落定后不得再发起会话写入');
  const listed = await server.listSessions();
  assert.equal(listed.some((s) => s.id === session.id), false, '会话不得回到会话表');
  assert.ok(host.writeCount > wroteBefore, '确实发生过落盘（闸门不是空转）');
});
