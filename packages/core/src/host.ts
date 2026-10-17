/** 宿主能力接口：core 唯一的 IO 出口。由具体运行环境实现。 */

export interface FsDirent {
  name: string;
  isDirectory: boolean;
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ProcessRunOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 执行所用的终端 shell；auto=由宿主自动探测，也可指定 git-bash / pwsh / powershell / cmd */
  shell?: string;
}

/** 后台进程句柄（TODOS #37）：宿主分配的任务 id 与操作系统 PID */
export interface ProcessSpawnHandle {
  id: string;
  pid?: number;
}

export interface ProcessSpawnOptions {
  /** 调用方指定的任务 id（未提供时宿主自生成）；kill/listSpawned 按此 id 索引 */
  id?: string;
  cwd?: string;
  shell?: string;
  signal?: AbortSignal;
  /** stdout + stderr 合流输出（宿主负责解码为文本；可能包含跨行的不完整片段） */
  onOutput?: (chunk: string) => void;
  /** 进程退出回调；code 为 null 表示被信号终止或退出码不可得 */
  onExit?: (code: number | null) => void;
}

/** 宿主侧仍存活（或最近存活）的后台进程记录，供 WebView 重载后恢复接管 */
export interface SpawnedProcessInfo {
  id: string;
  pid?: number;
  command: string;
  cwd?: string;
  /** 启动时的 shell（恢复接管后「按原命令重启」复用；宿主未记录时缺省） */
  shell?: string;
  startedAt: number;
  alive: boolean;
}

export interface Host {
  fs: {
    readFile(path: string): Promise<string>;
    writeFile(path: string, data: string): Promise<void>;
    appendFile(path: string, data: string): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    readdir(path: string): Promise<FsDirent[]>;
    stat(path: string): Promise<null | { isDirectory: boolean; size: number; mtimeMs: number }>;
    unlink?(path: string): Promise<void>;
    rename?(from: string, to: string): Promise<void>;
    /**
     * 解析为真实绝对路径（消解符号链接 / 硬链接别名），用于权限裁决与工作区包含性校验。
     *
     * 安全要点：`paths.resolve()` 只做词法归一化，**不会**识别 symlink。
     * 若工作区内存在 `public/key.txt -> ../private/key.txt`，词法路径是 `public/key.txt`
     * 而实际读取的是 `private/key.txt`，仅靠词法匹配会让针对 `private/**` 的 `deny`
     * 规则静默失效。因此文件路径类工具在裁决前必须经此能力取得真实目标。
     *
     * 返回 `null` 表示目标不存在；宿主不支持该能力时为 `undefined`（调用方按保守策略处理）。
     * 无法解析（权限不足、循环链接等）请抛出异常，由调用方保守拒绝。
     */
    realpath?(path: string): Promise<string | null>;
    /**
     * 不跟随符号链接的 stat（等价 `lstat`）。
     *
     * 必要性：`realpath()` 对「路径本身不存在」与「路径是符号链接但目标不存在（悬空链接）」
     * 都返回 ENOENT。若把两者混为一类，守卫会把悬空链接当成「待新建的普通文件」放行，
     * 随后 `writeFile` 跟随该链接在工作区外部创建文件（PR #9 第四轮复审 P1）。
     * 因此必须用 lstat 识别「本身是链接」，对悬空链接保守拒绝。
     *
     * 返回 `null` 表示路径本身不存在；宿主不支持时为 `undefined`。
     */
    lstat?(path: string): Promise<null | {
      isDirectory: boolean;
      isSymbolicLink: boolean;
      size: number;
      mtimeMs: number;
    }>;
  };
  process: {
    run(
      command: string,
      options: ProcessRunOptions,
    ): Promise<ProcessResult>;
    /** 启动长期运行的后台进程（TODOS #37）；宿主不支持时为 undefined */
    spawn?(
      command: string,
      options: ProcessSpawnOptions,
    ): Promise<ProcessSpawnHandle>;
    /** 终止后台进程（Windows 树杀整棵进程树）；宿主不支持时为 undefined */
    kill?(id: string): Promise<void>;
    /** 列出宿主侧仍记录的后台进程（WebView 重载后恢复接管）；宿主不支持时为 undefined */
    listSpawned?(): Promise<SpawnedProcessInfo[]>;
    /**
     * 本地服务端口探活：对 http(s) URL 的 host:port 发起 TCP 连接（跨平台、无 CORS 限制）。
     * 宿主不支持时为 undefined，管理器退回 fetch 探测。
     */
    probePort?(url: string, timeoutMs?: number): Promise<boolean>;
  };
  paths: {
    join(...parts: string[]): string;
    resolve(...parts: string[]): string;
    dirname(path: string): string;
    basename(path: string): string;
    isAbsolute(path: string): boolean;
    sep: string;
  };
  env: {
    /** 引擎持久化目录（会话/设置） */
    dataDir(): string;
  };
}

/* ------------------------------------------------------------------ */
/* MemoryHost：纯内存实现，用于浏览器演示模式与单元测试                   */
/* ------------------------------------------------------------------ */

function posixJoin(...parts: string[]): string {
  const joined = parts
    .filter((p) => p.length > 0)
    .join('/')
    .replace(/\/+/g, '/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

function posixNormalize(p: string): string {
  const parts = p.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

export class MemoryHost implements Host {
  private files = new Map<string, string>();
  /** 演示后台任务的定时器注册表（TODOS #37），供 kill 停止 */
  private demoTimers = new Map<string, ReturnType<typeof setInterval>>();

  readonly paths = {
    join: (...parts: string[]) => posixJoin(...parts),
    resolve: (...parts: string[]) => posixNormalize(posixJoin(...parts)),
    dirname: (p: string) => {
      const dir = posixNormalize(p).replace(/\/[^/]*$/, '');
      return dir === '' ? '/' : dir;
    },
    basename: (p: string) => posixNormalize(p).split('/').pop() ?? '',
    isAbsolute: (p: string) => p.startsWith('/'),
    sep: '/',
  };

  readonly fs = {
    readFile: async (p: string) => {
      const data = this.files.get(this.norm(p));
      if (data === undefined) throw new Error(`文件不存在: ${p}`);
      return data;
    },
    writeFile: async (p: string, data: string) => {
      this.files.set(this.norm(p), data);
    },
    appendFile: async (p: string, data: string) => {
      const key = this.norm(p);
      this.files.set(key, (this.files.get(key) ?? '') + data);
    },
    mkdir: async () => {},
    readdir: async (p: string) => {
      const dir = this.norm(p);
      const prefix = dir === '/' ? '/' : `${dir}/`;
      const seen = new Set<string>();
      const entries: FsDirent[] = [];
      for (const key of this.files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const [head, ...tail] = rest.split('/');
        if (seen.has(head)) continue;
        seen.add(head);
        entries.push({ name: head, isDirectory: tail.length > 0 });
      }
      return entries;
    },
    stat: async (p: string) => {
      const key = this.norm(p);
      const isFile = this.files.has(key);
      if (!isFile) {
        const hasChild = [...this.files.keys()].some((k) => k.startsWith(`${key}/`));
        if (hasChild || key === '/') return { isDirectory: true, size: 0, mtimeMs: 0 };
        return null;
      }
      const data = this.files.get(key) ?? '';
      return { isDirectory: false, size: data.length, mtimeMs: 0 };
    },
    unlink: async (p: string) => {
      this.files.delete(this.norm(p));
    },
    rename: async (from: string, to: string) => {
      const fromKey = this.norm(from);
      const toKey = this.norm(to);
      const data = this.files.get(fromKey);
      if (data === undefined) throw new Error(`文件不存在: ${from}`);
      this.files.set(toKey, data);
      if (fromKey !== toKey) this.files.delete(fromKey);
    },
    /** 内存文件系统无符号链接：词法归一化即真实路径 */
    realpath: async (p: string) => {
      const key = this.norm(p);
      if (this.files.has(key)) return key;
      const hasChild = [...this.files.keys()].some((k) => k.startsWith(`${key}/`));
      return hasChild || key === '/' ? key : null;
    },
    /** 内存文件系统无符号链接：lstat 等价于 stat */
    lstat: async (p: string) => {
      const st = await this.fs.stat(p);
      return st ? { ...st, isSymbolicLink: false } : null;
    },
  };

  readonly process = {
    run: async (command: string) => ({
      code: 0,
      stdout: `[演示模式] 未执行真实命令: ${command}`,
      stderr: '',
    }),
    /**
     * 演示模式后台任务模拟（TODOS #37）：不启动真实进程，仅按节奏吐出几行日志，
     * 让任务条 / 日志抽屉 / 预览面板在浏览器演示下可见可操作。
     */
    spawn: async (
      command: string,
      options: ProcessSpawnOptions,
    ): Promise<ProcessSpawnHandle> => {
      // 必须尊重调用方指定的 id：manager 的输出回调按此 id 索引任务
      const id = options.id ?? `demo_${Math.random().toString(36).slice(2, 10)}`;
      const lines = [
        `[演示] 正在启动: ${command}`,
        '[演示] dev server 准备中…',
        '[演示] Local: http://localhost:4173/',
        '[演示] 服务已就绪，保持运行中…',
      ];
      let i = 0;
      const timer = setInterval(() => {
        if (i < lines.length) options.onOutput?.(`${lines[i++]}\n`);
        // 输出完毕后保持静默长驻（模拟常驻服务），直到 kill
      }, 350);
      this.demoTimers.set(id, timer);
      return { id, pid: undefined };
    },
    kill: async (id: string) => {
      const timer = this.demoTimers.get(id);
      if (timer) {
        clearInterval(timer);
        this.demoTimers.delete(id);
      }
    },
    probePort: async () => true,
  };

  readonly env = { dataDir: () => '/easycode-demo' };

  constructor(initialFiles?: Record<string, string>) {
    for (const [p, content] of Object.entries(initialFiles ?? {})) {
      this.files.set(this.norm(p), content);
    }
  }

  /** 测试辅助：读取当前全部文件 */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files);
  }

  private norm(p: string): string {
    return posixNormalize(p.startsWith('/') ? p : `/${p}`);
  }
}
