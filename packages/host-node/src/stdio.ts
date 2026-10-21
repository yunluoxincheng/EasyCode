import crossSpawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import type { StdioHost } from '@easycode/core';
import { spawnWindowsJob } from './windows-job.js';

interface Entry { id: string; child: ChildProcess; command: string; cwd?: string; startedAt: number }
const BASE_ENV = new Set(['HOME', 'LOGNAME', 'PATH', 'PATHEXT', 'COMSPEC', 'SHELL', 'TERM', 'USER', 'APPDATA', 'HOMEDRIVE',
  'HOMEPATH', 'LOCALAPPDATA', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE']);

export function createStdioHost(registry: Map<string, Entry>, kill: (id: string) => Promise<void>): StdioHost {
  let opening = 0;
  return {
    open: async (options, events) => {
      if (registry.size + opening >= 16) throw new Error('Stdio 进程数量已满');
      opening++;
      try {
      const env: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(process.env)) if (BASE_ENV.has(key.toUpperCase())) env[key] = value;
      for (const [key, value] of Object.entries(options.env ?? {})) {
        const original = process.platform === 'win32' ? Object.keys(env).find((k) => k.toLowerCase() === key.toLowerCase()) : undefined;
        env[original ?? key] = value;
      }
      const id = `stdio_${crypto.randomUUID()}`;
      const spawn = process.platform === 'win32' ? spawnWindowsJob : crossSpawn;
      const child = spawn(options.command, options.args ?? [], {
        cwd: options.cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin!.on('error', () => {});
      child.stdout!.setEncoding('utf8').on('data', (chunk: string) => events.stdout(chunk));
      child.stderr!.setEncoding('utf8').on('data', (chunk: string) => events.stderr(chunk));
      let closing: Promise<void> | undefined;
      const close = (): Promise<void> => {
        if (closing) return closing;
        closing = (process.platform === 'win32' ? new Promise<void>((resolve, reject) => {
          if (child.exitCode !== null || child.signalCode !== null) { registry.delete(id); resolve(); return; }
          const timer = setTimeout(() => { child.removeListener('close', finished); reject(new Error('Stdio Job 退出超时')); }, 5000);
          const finished = () => { clearTimeout(timer); registry.delete(id); resolve(); };
          child.once('close', finished);
          try { child.kill(); } catch { clearTimeout(timer); child.removeListener('close', finished); reject(new Error('Stdio Job 终止失败')); }
        }) : kill(id)).then(() => {
          child.stdin!.destroy(); child.stdout!.destroy(); child.stderr!.destroy();
        }).catch(() => { closing = undefined; throw new Error('Stdio 进程清理失败，可重试'); });
        return closing;
      };
      child.once('exit', () => { void close().catch(() => {}); });
      child.once('close', () => events.exit());
      await new Promise<void>((resolve, reject) => {
        child.once('error', () => reject(new Error('Stdio 启动失败，请检查命令与工作目录')));
        child.once('spawn', () => {
          registry.set(id, { id, child, command: options.command, cwd: options.cwd, startedAt: Date.now() });
          resolve();
        });
      });
      return {
        write: (data) => new Promise<void>((resolve, reject) => {
          if (data.length > 1_048_576 || child.stdin!.destroyed) { reject(new Error('Stdio 写入不可用')); return; }
          child.stdin!.write(data, 'utf8', (error) => error ? reject(new Error('Stdio 写入失败')) : resolve());
        }),
        close,
      };
      } finally { opening--; }
    },
  };
}
