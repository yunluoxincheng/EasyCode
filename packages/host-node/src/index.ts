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
  shell?: string;
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
        shell: e.shell,
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
        // Unix 下让 shell 成为独立进程组长（pgid = pid）：停止时对整组发信号，
        // 才能连同 `sh -c "pnpm dev"` 拉起的 node/vite 后代一起终止（Windows 由 taskkill /T 负责）
        detached: process.platform !== 'win32',
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
      shell: opts.shell,
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

/**
 * 树杀并等待终止流程真正完成（Promise 语义 = 进程组已消亡或发生真失败）：
 * - Windows：taskkill /T /F 整树强杀；非零退出码时探活区分「进程已不存在（成功）」与真失败
 * - Unix：后台进程为独立进程组（detached 产生，pgid=pid）。组 SIGTERM → 等待 shell 退出或
 *   3s 宽限 → 以「组」为对象探活（不依赖组长自身状态，忽略 SIGTERM 的 node/vite 后代
 *   仍会被连根清除）→ 仍存活则组 SIGKILL → 确认消亡；EPERM 等真失败向上抛出，
 *   由 Core 回滚停止意图保持 UI 与真实进程一致
 */
async function killSpawned(registry: Map<string, SpawnEntry>, id: string): Promise<void> {
  const entry = registry.get(id);
  if (!entry) return;
  registry.delete(id);
  const { child } = entry;
  if (child.exitCode !== null || child.signalCode !== null || child.killed) return;

  if (process.platform === 'win32') {
    if (child.pid === undefined) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      return;
    }
    const pid = child.pid;
    await new Promise<void>((resolve, reject) => {
      const killer = nodeSpawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        // 非零退出码：区分「进程已不存在（视为成功）」与真失败（保持可重试语义）
        try {
          process.kill(pid, 0);
          reject(new Error(`taskkill 退出码 ${code}，进程可能仍在运行`));
        } catch {
          resolve(); // ESRCH：进程已不存在
        }
      });
      killer.on('error', () => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
        try {
          process.kill(pid, 0);
          reject(new Error('taskkill 不可用，且目标进程仍在运行'));
        } catch {
          resolve();
        }
      });
    });
    return;
  }

  // ---------- Unix：进程组生命周期 ----------
  const pid = child.pid;
  const groupAlive = (): boolean => {
    if (pid === undefined) {
      return child.exitCode === null && child.signalCode === null;
    }
    try {
      process.kill(-pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM'; // EPERM = 组存在但无权限
    }
  };
  /** 返回 done=信号已送达 / gone=组已不存在 / failed=权限等真失败（不静默吞掉） */
  const signalGroup = (signal: NodeJS.Signals): 'done' | 'gone' | 'failed' => {
    if (pid === undefined) {
      try {
        child.kill(signal);
        return 'done';
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'failed';
      }
    }
    try {
      process.kill(-pid, signal);
      return 'done';
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'failed';
    }
  };

  if (signalGroup('SIGTERM') === 'gone') return; // 组已不存在，无事可做
  // 等待组长 shell 退出或宽限期到（两者先到为准）
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      child.off('close', done);
      resolve();
    };
    const timer = setTimeout(done, 3000);
    child.once('close', done);
  });
  if (!groupAlive()) return;
  if (signalGroup('SIGKILL') === 'gone') return;
  // SIGKILL 已发出：短暂等待内核回收后确认整组消亡，仍存活则暴露为真失败
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (groupAlive()) {
    throw new Error('SIGKILL 已发送但进程组仍存活（可能权限不足），任务保持运行态');
  }
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
