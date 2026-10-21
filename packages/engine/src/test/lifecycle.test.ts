/**
 * 测试循环取消：修复回合落盘期间停止，不得继续重跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MemoryHost, type ProcessRunOptions,
  type ProcessResult
} from '@easycode/core';
import { AgentServer } from '../index.js';

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
