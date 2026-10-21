import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BackgroundTaskManager, MemoryHost,
  type Host,
  type ProcessSpawnHandle,
  type ProcessSpawnOptions,
  type SpawnedProcessInfo
} from '../index.js';

/** 受控宿主：可编程地模拟后台进程的输出与退出 */
class FakeHost implements Host {
  spawned = new Map<
    string,
    { opts: ProcessSpawnOptions; command: string; killed: boolean }
  >();
  nextPid = 1000;
  probeResults = new Map<string, boolean>();
  probeCalls: string[] = [];

  readonly paths = {
    join: (...p: string[]) => p.join('/'),
    resolve: (...p: string[]) => p.join('/'),
    dirname: (p: string) => p.split('/').slice(0, -1).join('/') || '/',
    basename: (p: string) => p.split('/').pop() ?? '',
    isAbsolute: (p: string) => p.startsWith('/'),
    sep: '/',
  };
  readonly fs = new MemoryHost().fs;
  readonly env = { dataDir: () => '/data' };

  readonly process = {
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    spawn: async (command: string, opts: ProcessSpawnOptions): Promise<ProcessSpawnHandle> => {
      const id = opts.id ?? `fake_${this.nextPid}`;
      this.spawned.set(id, { opts, command, killed: false });
      return { id, pid: this.nextPid++ };
    },
    kill: async (id: string) => {
      const entry = this.spawned.get(id);
      if (entry) {
        entry.killed = true;
        entry.opts.onExit?.(null);
      }
    },
    listSpawned: async (): Promise<SpawnedProcessInfo[]> =>
      [...this.spawned.entries()]
        .filter(([, e]) => !e.killed)
        .map(([id, e]) => ({
          id,
          pid: 1,
          command: e.command,
          cwd: e.opts.cwd,
          shell: e.opts.shell,
          startedAt: Date.now(),
          alive: !e.killed,
        })),
    probePort: async (url: string) => {
      this.probeCalls.push(url);
      return this.probeResults.get(url) ?? false;
    },
  };
}

test('输出缓冲与 URL 捕获：writeOutput 行拆分、去重、主地址探测', async () => {
  const host = new FakeHost();
  host.probeResults.set('http://localhost:5173', true);
  const manager = new BackgroundTaskManager(host, { scope: 's1' });
  const info = await manager.start('vite');
  const id = info.id;
  // 模拟分片输出（跨行拆分 + 多字节场景由宿主解码层负责，这里给整行）
  host.spawned.get(id)!.opts.onOutput?.('VITE ready in 300 ms\n');
  host.spawned.get(id)!.opts.onOutput?.('➜  Local:   http://localhost:5173/\n➜  Local:   http://localhost:5173/\n');
  const logs = manager.logs(id)!;
  assert.match(logs, /VITE ready/);
  assert.match(logs, /localhost:5173/);
  assert.equal(manager.get(id)!.urls.length, 1);
  assert.equal(manager.get(id)!.primaryUrl, 'http://localhost:5173');
  const alive = await manager.probe(id, true);
  assert.equal(alive, true);
  assert.equal(manager.get(id)!.alive, true);
  assert.deepEqual(host.probeCalls, ['http://localhost:5173']);
  manager.list(); // 不抛错
});

test('adopt：仅接管本会话 scope 前缀的存活任务', async () => {
  const host = new FakeHost();
  const recovered: string[] = [];
  const manager = new BackgroundTaskManager(host, {
    scope: 's1',
    onEvent: (e) => {
      if (e.type === 'background_task' && e.action === 'recovered') recovered.push(e.task.id);
    },
  });
  manager.adopt([
    { id: 's1:tabc', pid: 1, command: 'pnpm dev', startedAt: 1, alive: true },
    { id: 's2:tdef', pid: 2, command: 'pnpm dev', startedAt: 1, alive: true },
    { id: 's1:tdead', pid: 3, command: 'old', startedAt: 1, alive: false },
  ]);
  assert.deepEqual(recovered, ['s1:tabc']);
  assert.equal(manager.get('s1:tabc')!.status, 'running');
  assert.ok(manager.logs('s1:tabc')!.includes('恢复接管'));
  // 恢复任务仍可停止（宿主按同一 id 索引）
  await manager.stop('s1:tabc');
  assert.equal(manager.get('s1:tabc')!.status, 'killed');
});

/* ---------------- 审查修复回归（PR #3） ---------------- */

test('无换行超长输出：内存受控且日志可见（pending 硬上限）', async () => {
  const host = new FakeHost();
  const manager = new BackgroundTaskManager(host, { scope: 's1' });
  const info = await manager.start('stream');
  const entry = host.spawned.get(info.id)!;
  const chunk = 'x'.repeat(8192);
  for (let i = 0; i < 64; i++) entry.opts.onOutput?.(chunk); // 512KB 无任何换行
  const logs = manager.logs(info.id)!;
  // 日志保留尾部（截断头部的超长单行），总量有硬上限而非随输出无限增长
  assert.ok(logs.length < 100_000, `logs 应有界，实际 ${logs.length}`);
  assert.ok(logs.endsWith('x'), '尾部内容应可见');
  // 单调计数不受截断影响
  assert.equal(manager.get(info.id)!.outputBytes, 64 * 8192);
});

test('restart：复用原命令、原工作目录与原 shell', async () => {
  const host = new FakeHost();
  const manager = new BackgroundTaskManager(host, { scope: 's1' });
  const info = await manager.start('$env:NODE_ENV="dev"; pnpm dev', {
    cwd: '/ws',
    shell: 'pwsh',
  });
  const restarted = await manager.restart(info.id);
  assert.notEqual(restarted.id, info.id, '重启产生新任务');
  assert.equal(restarted.command, info.command);
  assert.equal(restarted.cwd, '/ws');
  assert.equal(restarted.shell, 'pwsh');
  assert.equal(manager.get(info.id)!.status, 'killed', '旧任务被停止');
  const spawned = [...host.spawned.values()];
  assert.equal(spawned.length, 2);
  assert.equal(spawned[1].opts.cwd, '/ws');
  assert.equal(spawned[1].opts.shell, 'pwsh');
});

test('kill 失败：保持 running 态且可重试停止', async () => {
  const host = new FakeHost();
  let failKill = true;
  const failingKill: BackgroundTaskManager = new BackgroundTaskManager(
    {
      ...host,
      process: {
        ...host.process,
        kill: async () => {
          if (failKill) throw new Error('taskkill failed');
          return host.process.kill('any');
        },
      },
    } as unknown as Host,
    { scope: 's1' },
  );
  const info = await failingKill.start('node server.js');
  await assert.rejects(() => failingKill.stop(info.id), /taskkill failed/);
  assert.equal(failingKill.get(info.id)!.status, 'running', 'kill 失败不得误标 killed');
  failKill = false;
  const after = await failingKill.stop(info.id);
  assert.equal(after?.status, 'killed');
});
