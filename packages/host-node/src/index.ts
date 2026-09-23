import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Host, ProcessRunOptions, ProcessResult } from '@easycode/core';

export interface NodeHostOptions {
  /** 持久化数据目录（会话、设置），如 Electron 的 userData */
  dataDir: string;
}

/**
 * Node.js 宿主：桌面壳（Electron 主进程）与 CLI 共用。
 * 真实文件系统 + 子进程；路径语义跟随当前平台。
 */
export class NodeHost implements Host {
  readonly paths = {
    join: (...parts: string[]) => path.join(...parts),
    resolve: (...parts: string[]) => path.resolve(...parts),
    dirname: (p: string) => path.dirname(p),
    basename: (p: string) => path.basename(p),
    isAbsolute: (p: string) => path.isAbsolute(p),
    sep: path.sep,
  };
  readonly fs = {
    readFile: (p: string) => fsp.readFile(p, 'utf8'),
    writeFile: (p: string, data: string) => fsp.writeFile(p, data, 'utf8'),
    appendFile: (p: string, data: string) => fsp.appendFile(p, data, 'utf8'),
    mkdir: async (p: string, opts?: { recursive?: boolean }) => {
      await fsp.mkdir(p, opts);
    },
    readdir: async (p: string) => {
      const dirents = await fsp.readdir(p, { withFileTypes: true });
      return dirents.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
    },
    stat: async (p: string) => {
      try {
        const s = await fsp.stat(p);
        return { isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
      } catch {
        return null;
      }
    },
    unlink: (p: string) => fsp.unlink(p),
  };
  readonly process = {
    run: (command: string, opts: ProcessRunOptions) =>
      runShell(command, opts),
  };
  readonly env: { dataDir(): string };

  constructor(options: NodeHostOptions) {
    this.env = { dataDir: () => options.dataDir };
  }
}

function resolveNodeShell(shell?: string): boolean | string {
  if (!shell || shell === 'auto') return true;
  if (process.platform === 'win32') {
    switch (shell) {
      case 'git-bash':
        return 'bash.exe';
      case 'pwsh':
        return 'pwsh.exe';
      case 'powershell':
        return 'powershell.exe';
      case 'cmd':
        return 'cmd.exe';
      default:
        return true;
    }
  }
  return true;
}

function runShell(
  command: string,
  opts: ProcessRunOptions,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const child = spawn(command, {
      shell: resolveNodeShell(opts.shell),
      cwd: opts.cwd,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const onAbort = () => child.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      child.kill();
      stderr += `\n[EasyCode] 命令超时（${Math.round(timeoutMs / 1000)}s），已终止。`;
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 200_000) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 200_000) stderr += chunk;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code: null, stdout, stderr: stderr + String(err) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr });
    });
  });
}
