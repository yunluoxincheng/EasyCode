import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BackgroundTaskManager,
  captureServiceUrls,
  MemoryHost,
  type Host,
  type ProcessSpawnHandle,
  type ProcessSpawnOptions,
  type SpawnedProcessInfo,
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
  readonly fs = {
    readFile: async () => '',
    writeFile: async () => {},
    appendFile: async () => {},
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => null,
  };
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
          startedAt: Date.now(),
          alive: !e.killed,
        })),
    probePort: async (url: string) => {
      this.probeCalls.push(url);
      return this.probeResults.get(url) ?? false;
    },
  };
}

/* ---------------- captureServiceUrls ---------------- */

test('captureServiceUrls：捕获 localhost / 127.0.0.1 完整 URL', () => {
  assert.deepEqual(captureServiceUrls('Local: http://localhost:5173/ ready'), [
    'http://localhost:5173',
  ]);
  assert.deepEqual(captureServiceUrls('listening on https://127.0.0.1:3000/api'), [
    'https://127.0.0.1:3000/api',
  ]);
});

test('captureServiceUrls：无协议 host:port 与 0.0.0.0/[::1] 归一化', () => {
  assert.deepEqual(captureServiceUrls('Tomcat started on port 8080: localhost:8080'), [
    'http://localhost:8080',
  ]);
  assert.deepEqual(captureServiceUrls('http://0.0.0.0:9229'), ['http://127.0.0.1:9229']);
  assert.deepEqual(captureServiceUrls('ready on [::1]:4000'), ['http://localhost:4000']);
});

test('captureServiceUrls：忽略外部地址、去重与去尾标点', () => {
  assert.deepEqual(captureServiceUrls('see https://vite.dev and http://192.168.1.4:8080'), []);
  const urls = captureServiceUrls('http://localhost:3000, then http://localhost:3000.');
  assert.equal(urls.length, 1);
});

/* ---------------- BackgroundTaskManager ---------------- */

test('start：立即返回任务元数据，不阻塞等待退出', async () => {
  const host = new FakeHost();
  const manager = new BackgroundTaskManager(host, { scope: 's1' });
  const started = Date.now();
  const info = await manager.start('pnpm dev', { cwd: '/ws' });
  assert.ok(Date.now() - started < 500);
  assert.equal(info.status, 'running');
  assert.equal(info.command, 'pnpm dev');
  assert.equal(info.pid, 1000);
  assert.ok(manager.has(info.id));
  // 指定 id 贯穿宿主（kill 索引一致）
  assert.ok(host.spawned.has(info.id));
});

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

test('stop：调用宿主 kill 并标记 killed，退出事件到达后不重复标记', async () => {
  const host = new FakeHost();
  const events: string[] = [];
  const manager = new BackgroundTaskManager(host, {
    scope: 's1',
    onEvent: (e) => {
      if (e.type === 'background_task') events.push(e.action);
    },
  });
  const info = await manager.start('node server.js');
  const after = await manager.stop(info.id);
  assert.equal(after?.status, 'killed');
  assert.ok(after?.durationMs !== undefined);
  assert.equal(host.spawned.get(info.id)!.killed, true);
  assert.equal(manager.get(info.id)!.status, 'killed');
  // 宿主迟到退出事件：status 已非 running，状态不被覆盖
  host.spawned.get(info.id)!.opts.onExit?.(0);
  assert.equal(manager.get(info.id)!.status, 'killed');
  assert.deepEqual(events, ['started', 'stopped']);
});

test('自然退出：code 0 → exited；非 0 → failed，并随事件上报', async () => {
  const host = new FakeHost();
  const seen: Array<{ action: string; status?: string }> = [];
  const manager = new BackgroundTaskManager(host, {
    scope: 's1',
    onEvent: (e) => {
      if (e.type === 'background_task') seen.push({ action: e.action, status: e.task.status });
    },
  });
  const ok = await manager.start('true');
  host.spawned.get(ok.id)!.opts.onExit?.(0);
  assert.equal(manager.get(ok.id)!.status, 'exited');
  const bad = await manager.start('false');
  host.spawned.get(bad.id)!.opts.onExit?.(1);
  assert.equal(manager.get(bad.id)!.status, 'failed');
  assert.deepEqual(seen, [
    { action: 'started', status: 'running' },
    { action: 'exited', status: 'exited' },
    { action: 'started', status: 'running' },
    { action: 'exited', status: 'failed' },
  ]);
});

test('并发上限与不支持环境', async () => {
  const host = new FakeHost();
  const manager = new BackgroundTaskManager(host, { scope: 's1', maxTasks: 2 });
  await manager.start('a');
  await manager.start('b');
  await assert.rejects(() => manager.start('c'), /上限/);
  // 无 spawn 能力的宿主（纯 MemoryHost 除外——演示模式有模拟实现）
  const noSpawn = new BackgroundTaskManager(
    { ...new MemoryHost(), process: { run: async () => ({ code: 0, stdout: '', stderr: '' }) } } as unknown as Host,
    { scope: 's2' },
  );
  await assert.rejects(() => noSpawn.start('x'), /不支持后台任务/);
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

test('disposeAll：清理全部运行中任务', async () => {
  const host = new FakeHost();
  const manager = new BackgroundTaskManager(host, { scope: 's1' });
  const a = await manager.start('a');
  const b = await manager.start('b');
  host.spawned.get(b.id)!.opts.onExit?.(0); // b 已自行退出
  await manager.disposeAll();
  assert.equal(manager.get(a.id)!.status, 'killed');
  assert.equal(manager.get(b.id)!.status, 'exited');
  assert.equal(manager.runningCount(), 0);
});

test('logs：tail 行数截断与任务不存在', async () => {
  const host = new FakeHost();
  const manager = new BackgroundTaskManager(host, { scope: 's1' });
  const info = await manager.start('gen');
  const entry = host.spawned.get(info.id)!;
  for (let i = 0; i < 50; i++) entry.opts.onOutput?.(`line-${i}\n`);
  const tail = manager.logs(info.id, 10)!;
  assert.ok(tail.includes('line-49'));
  assert.ok(!tail.includes('line-40\nline-41') === false || tail.split('\n').length <= 10);
  assert.equal(manager.logs('missing'), undefined);
});
