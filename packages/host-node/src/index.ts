import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import net from 'node:net';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import type {
  Host,
  ProcessRunOptions,
  ProcessResult,
  ProcessSpawnHandle,
  ProcessSpawnOptions,
  SpawnedProcessInfo,
} from '@easycode/core';

export interface NodeHostOptions {
  /** 持久化数据目录（会话、设置），如 Electron 的 userData */
  dataDir: string;
}

interface SpawnEntry {
  id: string;
  child: ChildProcess;
  command: string;
  cwd?: string;
  startedAt: number;
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
    /** 启动长期运行的后台进程（TODOS #37）：输出/退出经回调流式回传 */
    spawn: (command: string, opts: ProcessSpawnOptions): Promise<ProcessSpawnHandle> =>
      spawnShell(command, opts, this.spawnEntries),
    /** 树杀后台进程（Windows taskkill /T /F，其余 SIGTERM→SIGKILL） */
    kill: (id: string) => killSpawned(this.spawnEntries, id),
    /** 列出宿主侧登记的后台进程（同进程内状态永不失联，主要用于接口对齐） */
    listSpawned: async (): Promise<SpawnedProcessInfo[]> =>
      [...this.spawnEntries.values()].map((e) => ({
        id: e.id,
        pid: e.child.pid,
        command: e.command,
        cwd: e.cwd,
        startedAt: e.startedAt,
        alive: e.child.exitCode === null && e.child.signalCode === null && !e.child.killed,
      })),
    /** 本地服务端口探活：对 http(s) URL 的 host:port 发起 TCP 连接（无 CORS 限制） */
    probePort: (url: string, timeoutMs = 1600) => probeTcp(url, timeoutMs),
  };
  readonly env: { dataDir(): string };

  /** 后台进程注册表（TODOS #37） */
  private readonly spawnEntries = new Map<string, SpawnEntry>();

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
    const child = nodeSpawn(command, {
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

/* ------------------------------------------------------------------ */
/* 后台进程（TODOS #37）                                              */
/* ------------------------------------------------------------------ */

function spawnShell(
  command: string,
  opts: ProcessSpawnOptions,
  registry: Map<string, SpawnEntry>,
): Promise<ProcessSpawnHandle> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = nodeSpawn(command, {
        shell: resolveNodeShell(opts.shell),
        cwd: opts.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    // spawn 失败（命令不存在等）以 error 事件异步报出
    const id = opts.id ?? `n${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const entry: SpawnEntry = {
      id,
      child,
      command,
      cwd: opts.cwd,
      startedAt: Date.now(),
    };

    const onAbort = () => {
      void killSpawned(registry, id);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    // StringDecoder 处理多字节字符跨 chunk 边界，避免中文输出乱码（不 setEncoding，吃原始 Buffer）
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    child.stdout?.on('data', (chunk: Buffer) => {
      opts.onOutput?.(outDecoder.write(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      opts.onOutput?.(errDecoder.write(chunk));
    });

    child.on('error', (err) => {
      registry.delete(id);
      opts.signal?.removeEventListener('abort', onAbort);
      opts.onOutput?.(`\n[EasyCode] 后台进程启动失败: ${String(err)}\n`);
      opts.onExit?.(null);
      reject(new Error(`后台进程启动失败: ${String(err)}`));
    });

    child.on('close', (code) => {
      registry.delete(id);
      opts.signal?.removeEventListener('abort', onAbort);
      opts.onExit?.(code);
    });

    if (child.pid !== undefined) {
      registry.set(id, entry);
      resolve({ id, pid: child.pid });
    }
    // pid 未分配时必有 'error' 事件随后到达（上方处理器 reject）
  });
}

/** 树杀：Windows 用 taskkill /T /F；类 Unix 先 SIGTERM，3s 后 SIGKILL 兜底 */
async function killSpawned(registry: Map<string, SpawnEntry>, id: string): Promise<void> {
  const entry = registry.get(id);
  if (!entry) return;
  registry.delete(id);
  const { child } = entry;
  if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    await new Promise<void>((resolve) => {
      const killer = nodeSpawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('close', () => resolve());
      killer.on('error', () => {
        child.kill('SIGKILL');
        resolve();
      });
    });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* 进程可能已退出 */
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }, 3000);
}

/** TCP 探活：连接成功即视为端口存活（协议无关，无 CORS 问题） */
function probeTcp(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      resolve(false);
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      resolve(false);
      return;
    }
    const port = target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80;
    const socket = net.connect({ host: target.hostname, port });
    const finish = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
