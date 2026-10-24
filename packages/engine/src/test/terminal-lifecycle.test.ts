import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { NodeHost } from '@easycode/host-node';
import { MemoryHost, type Host } from '@easycode/core';
import { AgentServer } from '../server.js';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error('terminal runtime timeout'); await delay(50); }
}
async function command(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, timeout: 5000,
    env: { ...process.env, COLUMNS: '120', LINES: '40' } }, (error, out) => error ? reject(error) : resolve(out)));
}
async function running(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  if (process.platform === 'win32') return true;
  try { return !(await command('ps', ['-p', String(pid), '-o', 'stat='])).trim().startsWith('Z'); }
  catch (error) { if ((error as { code?: number }).code === 1) return false; throw error; }
}

test('真实 PTY：Shell 自然退出后仍能清理 nohup/后台进程及监督资源', { timeout: 45000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easycode-pty-'));
  const program = path.join(directory, 'background.cjs');
  const ready = path.join(directory, 'ready.pid');
  await fs.writeFile(program, "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[2],String(process.pid)); setInterval(()=>{},1000);", 'utf8');
  const host = new NodeHost({ dataDir: directory });
  let shellExited = false;
  let exitEvents = 0;
  let background: number | undefined;
  const terminal = await host.terminal.open({ cwd: directory, cols: 90, rows: 20 }, {
    output: () => {}, exit: () => { shellExited = true; exitEvents++; },
  });
  try {
    if (process.platform === 'win32') {
      const quote = (text: string) => "'" + text.replaceAll("'", "''") + "'";
      await terminal.write(`Start-Process -FilePath ${quote(process.execPath)} -ArgumentList ${quote(`"${program}" "${ready}"`)} -NoNewWindow\r`);
    } else {
      const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
      await terminal.write(`nohup ${quote(process.execPath)} ${quote(program)} ${quote(ready)} >/dev/null 2>&1 &\r`);
    }
    await waitFor(async () => {
      try { background = Number(await fs.readFile(ready, 'utf8')); return Number.isInteger(background) && background > 0; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    });
    await terminal.write('exit\r');
    await waitFor(() => shellExited);
    assert.equal(await running(background!), true, 'background must exercise cleanup after Shell exit');
    if (terminal.supervisorPid) assert.equal(await running(terminal.supervisorPid), true, 'resource identity remains alive');
    await terminal.close();
    await waitFor(async () => !await running(background!));
    if (terminal.supervisorPid) assert.equal(await running(terminal.supervisorPid), false);
    assert.equal(exitEvents, 1, 'resource cleanup must not report Shell exit twice');
    await terminal.close();
  } finally {
    if (background && await running(background)) {
      // 基线对照失败时也只清理本用例启动的进程，不根据过期 PID 无条件终止。
      const line = process.platform === 'win32'
        ? await command('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${background}').CommandLine`])
        : await command('ps', ['-ww', '-p', String(background), '-o', 'args=']);
      if (line.includes(program)) process.kill(background, 'SIGKILL');
    }
    await terminal.close();
    await fs.unlink(program);
    await fs.unlink(ready).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('会话删除：关闭失败后可继续使用/重新打开，删除重试与在途隔离一致', async () => {
  const memory = new MemoryHost({ '/ws/file.txt': 'workspace' });
  let attempts = 0;
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const writes: string[] = [];
  const host: Host = Object.assign(memory, { terminal: { open: async () => ({ shell: 'unit-shell',
    write: async (data: string) => { writes.push(data); }, resize: async () => {},
    close: async () => { if (++attempts === 1) throw new Error('close once'); await gate; },
  }) } });
  const server = new AgentServer(host);
  await server.updateSettings({ providers: { mock: { kind: 'mock', baseURL: '', models: [{ name: 'mock' }] } } });
  const session = await server.createSession({ providerId: 'mock', workspaceRoot: '/ws' });
  const file = host.paths.join(host.env.dataDir(), 'sessions', session.id + '.json');
  const persisted = await host.fs.readFile(file);
  try {
    const first = await server.openTerminal(session.id);
    await assert.rejects(server.deleteSession(session.id), /close once/);
    assert.equal(await host.fs.readFile(file), persisted);
    assert.equal((await server.getSession(session.id)).meta.id, session.id);
    assert.equal((await server.openTerminal(session.id)).id, first.id, 'failed deletion must restore terminal access');
    await server.writeTerminal(session.id, first.id, 'still usable');
    assert.deepEqual(writes, ['still usable']);
    await server.closeTerminal(session.id, first.id);
    const second = await server.openTerminal(session.id);
    assert.notEqual(second.id, first.id);
    gate = new Promise<void>((resolve) => { release = resolve; });
    const deletion = server.deleteSession(session.id);
    await assert.rejects(server.openTerminal(session.id));
    release!(); await deletion;
    assert.equal(server.readTerminal(session.id), null);
    assert.equal(await host.fs.stat(file), null);
  } finally { release?.(); await server.stopAllBackgroundTasks(); }
});
