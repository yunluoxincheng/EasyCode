import { invoke, Channel } from '@tauri-apps/api/core';
import type { AgentClient, ShellInfo } from '@easycode/engine';
import { AgentServer } from '@easycode/engine';
import type { Host, ProcessResult, FsDirent } from '@easycode/core';

/* ------------------------------------------------------------------ */
/* 路径实现（同步，纯 TS；平台分隔符由 Rust 侧告知）                      */
/* ------------------------------------------------------------------ */

function makeWinPaths(): Host['paths'] {
  const isAbsolute = (p: string): boolean =>
    /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p) || /^[\\/]/.test(p);
  const normalize = (p: string): string => {
    const drive = p.match(/^[a-zA-Z]:/)?.[0] ?? '';
    let rest = drive ? p.slice(drive.length) : p;
    const unc = !drive && /^\\\\/.test(rest);
    const rooted = !drive && /^[\\/]/.test(rest);
    const segs = rest.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.');
    const out: string[] = [];
    for (const s of segs) {
      if (s === '..') out.pop();
      else out.push(s);
    }
    const prefix = drive ? drive + '\\' : unc ? '\\\\' : rooted ? '\\' : '';
    return prefix + out.join('\\');
  };
  return {
    join: (...parts: string[]) => {
      let acc = '';
      for (const part of parts) {
        if (!part) continue;
        if (isAbsolute(part)) acc = part;
        else acc = acc ? acc.replace(/[\\/]+$/, '') + '\\' + part : part;
      }
      return normalize(acc);
    },
    resolve: (...parts: string[]) => normalize(parts.join('\\')),
    dirname: (p: string) => {
      const n = normalize(p);
      const m = n.match(/^([a-zA-Z]:\\|\\\\|\\)/);
      const prefix = m ? m[1] : '';
      const dir = n.slice(prefix.length).replace(/[\\/][^\\/]*$/, '');
      return prefix + dir || prefix || '.';
    },
    basename: (p: string) => normalize(p).split('\\').pop() ?? '',
    isAbsolute,
    sep: '\\',
  };
}

function makePosixPaths(): Host['paths'] {
  const normalize = (p: string): string => {
    const out: string[] = [];
    for (const seg of p.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return '/' + out.join('/');
  };
  return {
    join: (...parts: string[]) => normalize(parts.filter(Boolean).join('/')),
    resolve: (...parts: string[]) => normalize(parts.filter(Boolean).join('/')),
    dirname: (p: string) => {
      const n = normalize(p);
      const d = n.replace(/\/[^/]*$/, '');
      return d || '/';
    },
    basename: (p: string) => normalize(p).split('/').pop() ?? '',
    isAbsolute: (p: string) => p.startsWith('/'),
    sep: '/',
  };
}

/* ------------------------------------------------------------------ */
/* Host 实现：fs / process 经 invoke 走 Rust                             */
/* ------------------------------------------------------------------ */

export async function createTauriHost(): Promise<Host> {
  const info = await invoke<{ sep: string; data_dir: string }>('host_info');
  const paths = info.sep === '\\' ? makeWinPaths() : makePosixPaths();

  const host: Host = {
    paths,
    fs: {
      readFile: (p) => invoke<string>('fs_read', { path: p }),
      writeFile: (p, data) => invoke<void>('fs_write', { path: p, data }),
      mkdir: (p, opts) => invoke<void>('fs_mkdir', { path: p, recursive: opts?.recursive ?? false }),
      readdir: (p) => invoke<FsDirent[]>('fs_readdir', { path: p }),
      stat: (p) => invoke<FsDirent extends never ? never : { isDirectory: boolean; size: number; mtimeMs: number } | null>('fs_stat', { path: p }),
      unlink: (p) => invoke<void>('fs_unlink', { path: p }),
    },
    process: {
      run: async (command, opts) => {
        const id = crypto.randomUUID();
        const onAbort = () => {
          invoke('proc_kill', { id }).catch(() => {});
        };
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        try {
          const result = await invoke<ProcessResult>('proc_run', {
            id,
            command,
            cwd: opts.cwd,
            timeoutMs: opts.timeoutMs ?? 120_000,
            shell: opts.shell,
          });
          return result;
        } finally {
          opts.signal?.removeEventListener('abort', onAbort);
        }
      },
    },
    env: {
      dataDir: () => info.data_dir,
    },
  };
  return host;
}

/* ------------------------------------------------------------------ */
/* HTTP 流式代理：LLM API 请求经 Rust reqwest，SSE 逐块回传 WebView，     */
/* 绕过浏览器 CORS 且不破坏流式输出。仅代理 http(s)，其余走原生 fetch。    */
/* ------------------------------------------------------------------ */

type Frame = { t: 's'; c: number } | { t: 'd'; d: string } | { t: 'x'; m: string } | { t: 'e' };

function b64ToU8(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

let fetchPatched = false;

function patchFetch(): void {
  if (fetchPatched) return;
  fetchPatched = true;
  const native = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/^https?:\/\//i.test(url)) return native(input as RequestInfo, init);
    // 只代理外部 API；Tauri IPC（ipc.localhost）/ 页面资源（tauri.localhost）/
    // 本机地址必须走原生通道，否则代理会拦截 IPC 自身造成 invoke 无限递归。
    try {
      const host = new URL(url).hostname;
      if (
        host.endsWith('.localhost') ||
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1'
      ) {
        return native(input as RequestInfo, init);
      }
    } catch {
      return native(input as RequestInfo, init);
    }

    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? undefined).forEach((v, k) => {
      headers[k] = v;
    });
    let body: string | null = null;
    if (typeof init?.body === 'string') body = init.body;
    else if (init?.body != null) body = new TextDecoder().decode(init.body as ArrayBuffer);

    const ch = new Channel<Frame>();
    const buffer: { t: 'd'; d: string }[] = [];
    let status: number | null = null;
    let failure: Error | null = null;
    let closed = false;
    let waiter: (() => void) | null = null;
    const id = crypto.randomUUID();
    const signal = init?.signal;

    const notify = (): void => {
      const w = waiter;
      waiter = null;
      w?.();
    };

    const cleanupAbort = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      failure = new DOMException('The operation was aborted.', 'AbortError');
      closed = true;
      void invoke('http_stream_cancel', { id }).catch(() => {});
      cleanupAbort();
      notify();
    };

    if (signal?.aborted) {
      onAbort();
      throw failure;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    ch.onmessage = (f) => {
      if (f.t === 's') status = f.c;
      else if (f.t === 'd') buffer.push(f);
      else if (f.t === 'x') failure = new Error(f.m);
      else if (f.t === 'e') {
        closed = true;
        cleanupAbort();
      }
      notify();
    };

    invoke('http_stream', { id, url, method, headers, body, onEvent: ch }).catch((e) => {
      failure = new Error(String(e));
      closed = true;
      cleanupAbort();
      notify();
    });

    /** 等到 ready() 为真或流终止；等状态与等数据使用各自独立的就绪条件 */
    const waitFor = (ready: () => boolean): Promise<void> =>
      new Promise<void>((resolve) => {
        const attempt = (): void => {
          if (ready() || closed || failure) {
            resolve();
          } else {
            waiter = attempt;
          }
        };
        attempt();
      });

    await waitFor(() => status !== null);
    if (status === null && failure) throw failure;

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await waitFor(() => buffer.length > 0);
        if (buffer.length > 0) {
          const f = buffer.shift()!;
          controller.enqueue(b64ToU8(f.d));
          return;
        }
        if (failure) controller.error(failure);
        else controller.close();
      },
    });

    return new Response(stream, {
      status: status ?? 599,
      headers: { 'content-type': 'application/octet-stream' },
    });
  };
}

/* ------------------------------------------------------------------ */
/* AgentClient：WebView 内运行完整引擎（core + engine + TauriHost）        */
/* ------------------------------------------------------------------ */

export async function createTauriClient(): Promise<AgentClient> {
  patchFetch();
  const host = await createTauriHost();
  const server = new AgentServer(host);
  return {
    listSessions: () => server.listSessions(),
    createSession: (options) => server.createSession(options),
    forkSession: (id, options) => server.forkSession(id, options),
    deleteSession: (id) => server.deleteSession(id),
    renameSession: (id, title) => server.renameSession(id, title),
    getSession: (id) => server.getSession(id),
    sendMessage: (id, text) => server.sendMessage(id, text),
    editLastUserMessage: async (id, text) => {
      await server.editLastUserMessage(id, text);
    },
    respondApproval: async (id, requestId, approved) => {
      server.respondApproval(id, requestId, approved);
    },
    abort: async (id) => {
      server.abort(id);
    },
    setApprovalMode: async (id, mode) => {
      server.setApprovalMode(id, mode);
    },
    getApprovalMode: async (id) => server.getApprovalMode(id),
    setSessionModel: async (id, model) => server.setSessionModel(id, model),
    setSessionProvider: async (id, providerId, model) => server.setSessionProvider(id, providerId, model),
    setSessionEffort: async (id, effort) => server.setSessionEffort(id, effort),
    setSessionWorkspace: async (id, workspace) => server.setSessionWorkspace(id, workspace),
    getSettings: () => server.getSettings(),
    updateSettings: (patch) => server.updateSettings(patch),
    listProviderModels: (id) => server.listProviderModels(id),
    testProviderModel: (id, model) => server.testProviderModel(id, model),
    testWebSearch: () => server.testWebSearch(),
    listWorkspaceFiles: (id, query) => server.listWorkspaceFiles(id, query),
    pickWorkspace: () => invoke<string | null>('pick_folder'),
    openPath: (path: string) => invoke<void>('open_path', { path }),
    openInVscode: (path: string) => invoke<void>('open_in_vscode', { path }),
    notify: (title: string, body: string) => invoke<void>('send_notification', { title, body }),
    detectShells: () => invoke<ShellInfo[]>('proc_detect_shells'),
    onEvent: (listener) => server.onEvent(listener),
  };
}
