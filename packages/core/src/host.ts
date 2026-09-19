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

export interface Host {
  fs: {
    readFile(path: string): Promise<string>;
    writeFile(path: string, data: string): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    readdir(path: string): Promise<FsDirent[]>;
    stat(path: string): Promise<null | { isDirectory: boolean; size: number; mtimeMs: number }>;
    unlink?(path: string): Promise<void>;
  };
  process: {
    run(
      command: string,
      options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal },
    ): Promise<ProcessResult>;
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
  };

  readonly process = {
    run: async (command: string) => ({
      code: 0,
      stdout: `[演示模式] 未执行真实命令: ${command}`,
      stderr: '',
    }),
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
