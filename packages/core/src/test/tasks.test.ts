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

test('输出缓冲与 URL 捕获：去重、探测与无换行输出有界', async () => {
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
  const before = manager.get(id)!.outputBytes;
  const chunk = 'x'.repeat(8192);
  for (let i = 0; i < 64; i++) host.spawned.get(id)!.opts.onOutput?.(chunk);
  assert.ok(manager.logs(id)!.length < 100_000, '无换行日志仍有界');
  assert.ok(manager.logs(id)!.endsWith('x'), '截断后保留尾部');
  assert.equal(manager.get(id)!.outputBytes, before + 64 * 8192);
});

test('adopt：仅恢复本会话存活任务，并保留原参数重启与清理', async () => {
  const host = new FakeHost();
  const recovered: string[] = [];
  const manager = new BackgroundTaskManager(host, {
    scope: 's1',
    onEvent: (e) => {
      if (e.type === 'background_task' && e.action === 'recovered') recovered.push(e.task.id);
    },
  });
  manager.adopt([
    { id: 's1:tabc', pid: 1, command: 'pnpm dev', cwd: '/ws', shell: 'pwsh', startedAt: 1, alive: true },
    { id: 's2:tdef', pid: 2, command: 'pnpm dev', startedAt: 1, alive: true },
    { id: 's1:tdead', pid: 3, command: 'old', startedAt: 1, alive: false },
  ]);
  assert.deepEqual(recovered, ['s1:tabc']);
  assert.equal(manager.get('s1:tabc')!.status, 'running');
  assert.ok(manager.logs('s1:tabc')!.includes('恢复接管'));
  const restarted = await manager.restart('s1:tabc');
  assert.notEqual(restarted.id, 's1:tabc');
  assert.equal(restarted.command, 'pnpm dev');
  assert.equal(restarted.cwd, '/ws');
  assert.equal(restarted.shell, 'pwsh');
  assert.equal(host.spawned.get(restarted.id)!.opts.cwd, '/ws');
  assert.equal(host.spawned.get(restarted.id)!.opts.shell, 'pwsh');
  assert.equal(manager.get('s1:tabc')!.status, 'killed');
  assert.deepEqual(manager.clearFinished(), ['s1:tabc']);
  assert.equal(manager.logs('s1:tabc'), undefined);
  assert.equal(manager.get(restarted.id)!.status, 'running', '清理不影响运行中的新任务');
});

test('remove：等待启动、复用并发停止，退出回调不提前释放清理记录', async () => {
  const host = new FakeHost();
  let releaseStart!: () => void;
  let releaseKill!: () => void;
  let startedKilling!: () => void;
  const starting = new Promise<void>((r) => { releaseStart = r; });
  const killing = new Promise<void>((r) => { releaseKill = r; });
  const killStarted = new Promise<void>((r) => { startedKilling = r; });
  const spawn = host.process.spawn;
  let killCalls = 0;
  host.process.spawn = async (command, opts) => {
    await starting;
    return spawn(command, opts);
  };
  host.process.kill = async (id) => {
    killCalls++;
    host.spawned.get(id)!.opts.onExit?.(null);
    startedKilling();
    await killing;
    host.spawned.get(id)!.killed = true;
  };
  const removed: string[] = [];
  const manager = new BackgroundTaskManager(host, { onEvent: (e) => {
    if (e.type === 'background_task' && e.action === 'removed') removed.push(e.task.id);
  }});
  const start = manager.start('server');
  const id = manager.list()[0].id;
  let settled = false;
  const first = manager.remove(id).then((ok) => { settled = true; return ok; });
  const second = manager.remove(id);
  await Promise.resolve();
  assert.equal(killCalls, 0, '启动未完成前不执行 kill');
  assert.equal(settled, false);
  assert.equal(manager.has(id), true);
  releaseStart();
  await start;
  await killStarted;
  assert.equal(manager.get(id)!.status, 'killed', '退出回调已到达');
  assert.deepEqual(manager.clearFinished(), [], '整组停止未收敛时不能批量清理');
  assert.equal(manager.has(id), true);
  assert.equal(settled, false);
  releaseKill();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(killCalls, 1, '并发移除复用同一次实际停止');
  assert.deepEqual(removed, [id]);
  assert.equal(manager.has(id), false);
  assert.equal(manager.logs(id), undefined);
  assert.equal(await manager.remove(id), false, '重复移除已不存在任务是幂等的');
});

test('remove 停止失败：任务和错误保留，重试成功后删除', async () => {
  const host = new FakeHost();
  const kill = host.process.kill;
  let failKill = true;
  host.process.kill = async (id) => {
    if (failKill) throw new Error('taskkill failed');
    await kill(id);
  };
  const manager = new BackgroundTaskManager(host, { scope: 's1' });
  const info = await manager.start('node server.js');
  await assert.rejects(manager.remove(info.id), /taskkill failed/);
  assert.equal(manager.get(info.id)!.status, 'running');
  assert.equal(manager.get(info.id)!.stopError, 'taskkill failed');
  assert.equal(host.spawned.get(info.id)!.killed, false);
  assert.deepEqual(manager.clearFinished(), [], '失败记录不参与批量清理');
  host.spawned.get(info.id)!.opts.onExit?.(0);
  assert.equal(manager.get(info.id)!.status, 'exited');
  assert.deepEqual(manager.clearFinished(), [], '入口进程退出后仍保留失败清理的重试句柄');
  failKill = false;
  assert.equal(await manager.remove(info.id), true);
  assert.equal(host.spawned.get(info.id)!.killed, true);
  assert.equal(manager.has(info.id), false);
  assert.equal(manager.logs(info.id), undefined);
});
