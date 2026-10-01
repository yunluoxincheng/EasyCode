/**
 * 后台任务管理器与本地服务端口探测（TODOS #37 Background Tasks & Port Watcher）。
 *
 * 职责：
 * - 通过宿主注入的 `process.spawn` / `process.kill` 启动与终止长期运行命令（dev server、watch 等）；
 * - 立即返回任务元数据，绝不阻塞 Agent 循环；
 * - 流式缓冲输出（环形行缓冲），正则捕获本地服务监听地址；
 * - 跨平台端口探活确认服务就绪（优先宿主 TCP 连接探测，退回 fetch）；
 * - 进程退出 / 被停止时发出状态事件，会话删除 / 应用退出时统一清理，杜绝僵尸进程与孤儿端口。
 */
import type { AgentEvent } from './events.js';
import type { Host, SpawnedProcessInfo } from './host.js';

export type BackgroundTaskStatus = 'running' | 'exited' | 'failed' | 'killed';

/** 对 UI / 工具层暴露的任务快照（只含元数据，不含日志正文） */
export interface BackgroundTaskInfo {
  id: string;
  pid?: number;
  command: string;
  startedAt: number;
  status: BackgroundTaskStatus;
  exitCode?: number | null;
  durationMs?: number;
  /** 从输出中捕获到的本地服务地址（按首次出现顺序） */
  urls: string[];
  /** 最近一次端口探活结果；undefined = 尚未探测 */
  alive?: boolean;
  /** 探活时间戳（ms） */
  probedAt?: number;
  /** 主服务地址（最近捕获、优先已就绪的） */
  primaryUrl?: string;
  /** 启动时的工作目录（「按原命令重启」复用） */
  cwd?: string;
  /** 启动时指定的 shell（「按原命令重启」复用） */
  shell?: string;
  /** 累计输出字节数（单调递增，供 UI 跟随刷新做增量信号） */
  outputBytes: number;
}

export interface BackgroundTaskOptions {
  /** 会话域（任务 id 前缀），用于宿主侧恢复时归属判断 */
  scope?: string;
  /** 任务状态变化时向会话事件流发射 background_task 事件 */
  onEvent?: (event: AgentEvent) => void;
  /** 单会话后台任务上限（防失控），默认 8 */
  maxTasks?: number;
}

interface BgTask {
  id: string;
  pid?: number;
  command: string;
  startedAt: number;
  status: BackgroundTaskStatus;
  exitCode?: number | null;
  durationMs?: number;
  urls: string[];
  alive?: boolean;
  probedAt?: number;
  /** 启动时的工作目录（「按原命令重启」复用） */
  cwd?: string;
  /** 启动时指定的 shell（「按原命令重启」复用） */
  shell?: string;
  /** 累计输出字节数（单调递增，供 UI 跟随刷新做增量信号） */
  outputBytes: number;
  /** 用户/系统已请求停止：迟到的宿主退出事件不得把状态改判为 failed */
  stopRequested?: boolean;
  /** 输出环形行缓冲（不含未完结的当前行） */
  lines: string[];
  /** 未凑齐换行的当前行（\r 覆盖语义下只保留最后一段，有硬上限） */
  pending: string;
  /** 行缓冲累计字符数（用于环形缓冲容量裁剪） */
  chars: number;
  /** 从宿主恢复接管的任务：无法重新挂接输出流 */
  recovered?: boolean;
}

const MAX_LINES = 1200;
const MAX_CHARS = 200_000;
/** 单行（未换行的开放尾部）硬上限：无换行 / 裸 \r 输出也不至于撑爆内存 */
const MAX_PENDING_CHARS = 64_000;
const PROBE_TTL_MS = 3_000;
const PROBE_TIMEOUT_MS = 1_600;

/** \r 覆盖语义：取最后一个 \r 之后的内容（进度条式原地刷新只留最终帧） */
function takeAfterLastCr(segment: string): string {
  const idx = segment.lastIndexOf('\r');
  return idx === -1 ? segment : segment.slice(idx + 1);
}

/**
 * 从一行输出中提取本地服务监听地址。
 * 只接受 localhost / 127.0.0.1 / [::1] / 0.0.0.0 主机，其余一律忽略；
 * 无 scheme 的 `localhost:3000` 亦识别；0.0.0.0 归一化为 127.0.0.1。
 */
export function captureServiceUrls(line: string): string[] {
  const urls: string[] = [];
  const push = (raw: string): void => {
    let url = raw.replace(/[.,;:)\]}'"]+$/, '');
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
    url = url.replace(/^http:\/\/0\.0\.0\.0(:)/i, 'http://127.0.0.1$1');
    url = url.replace(/^http:\/\/\[::1\]/i, 'http://localhost');
    if (url.endsWith('/')) url = url.slice(0, -1);
    if (!urls.includes(url)) urls.push(url);
  };
  // 1. 带协议的完整 URL
  const full = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:\/[^\s"'<>`]*)?/gi;
  for (const m of line.matchAll(full)) push(m[0]);
  // 2. 无协议的 host:port（避免命中上一类的子串：先移除已匹配段）
  const stripped = line.replace(full, ' ');
  const bare = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{1,5}/gi;
  for (const m of stripped.matchAll(bare)) push(m[0]);
  return urls;
}

/** 解析 http(s) URL 为 TCP 探活目标；解析失败或非 http(s) 返回 null */
function parseProbeTarget(url: string): { host: string; port: number } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname;
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { host, port };
  } catch {
    return null;
  }
}

export class BackgroundTaskManager {
  private tasks = new Map<string, BgTask>();
  private readonly maxTasks: number;
  private seq = 0;

  constructor(
    private readonly host: Host,
    private readonly opts: BackgroundTaskOptions = {},
  ) {
    this.maxTasks = opts.maxTasks ?? 8;
  }

  private makeId(): string {
    const rand = Math.random().toString(36).slice(2, 8);
    return this.opts.scope ? `${this.opts.scope}:t${Date.now().toString(36)}${rand}` : `t${Date.now().toString(36)}${rand}`;
  }

  private emit(action: 'started' | 'exited' | 'stopped' | 'recovered', task: BgTask): void {
    this.opts.onEvent?.({ type: 'background_task', action, task: this.toInfo(task) });
  }

  private toInfo(t: BgTask): BackgroundTaskInfo {
    return {
      id: t.id,
      pid: t.pid,
      command: t.command,
      startedAt: t.startedAt,
      status: t.status,
      exitCode: t.exitCode,
      durationMs: t.durationMs,
      urls: [...t.urls],
      alive: t.alive,
      probedAt: t.probedAt,
      primaryUrl: this.primaryUrlOf(t),
      cwd: t.cwd,
      shell: t.shell,
      outputBytes: t.outputBytes,
    };
  }

  /** 主服务地址：输出中最近捕获的一个（alive 是针对它的最近一次探测结果） */
  private primaryUrlOf(t: BgTask): string | undefined {
    return t.urls[t.urls.length - 1];
  }

  /** 启动后台命令：立即返回任务元数据，不等待进程退出 */
  async start(command: string, runOpts?: { cwd?: string; shell?: string }): Promise<BackgroundTaskInfo> {
    const spawn = this.host.process.spawn;
    if (!spawn) {
      throw new Error('当前环境不支持后台任务（宿主未实现 process.spawn）');
    }
    const runningCount = [...this.tasks.values()].filter((t) => t.status === 'running').length;
    if (runningCount >= this.maxTasks) {
      throw new Error(`后台任务已达上限（${this.maxTasks}），请先停止部分任务再试`);
    }
    const id = this.makeId();
    const task: BgTask = {
      id,
      command,
      startedAt: Date.now(),
      status: 'running',
      urls: [],
      lines: [],
      pending: '',
      chars: 0,
      outputBytes: 0,
      cwd: runOpts?.cwd,
      shell: runOpts?.shell,
    };
    this.tasks.set(id, task);
    try {
      const handle = await spawn(command, {
        id,
        cwd: runOpts?.cwd,
        shell: runOpts?.shell,
        onOutput: (chunk) => this.writeOutput(id, chunk),
        onExit: (code) => this.markExited(id, code, false),
      });
      if (handle.id && handle.id !== id) {
        // 宿主忽略了指定 id（理论上不会发生）：以宿主返回的 id 为准
        const adopted = this.tasks.get(id);
        if (adopted) {
          this.tasks.delete(id);
          adopted.id = handle.id;
          this.tasks.set(handle.id, adopted);
        }
      }
      task.pid = handle.pid;
      this.emit('started', task);
      return this.toInfo(task);
    } catch (err) {
      this.tasks.delete(id);
      throw err;
    }
  }

  /** WebView 重载后从宿主恢复接管仍存活的进程（无历史输出流，仅保留元数据与停止能力） */
  adopt(infos: SpawnedProcessInfo[]): void {
    for (const info of infos) {
      if (!info.alive) continue;
      if (this.opts.scope && !info.id.startsWith(`${this.opts.scope}:`)) continue;
      if (this.tasks.has(info.id)) continue;
      if ([...this.tasks.values()].filter((t) => t.status === 'running').length >= this.maxTasks) break;
      const task: BgTask = {
        id: info.id,
        pid: info.pid,
        command: info.command,
        startedAt: info.startedAt,
        status: 'running',
        urls: [],
        lines: [],
        pending: '',
        chars: 0,
        outputBytes: 0,
        cwd: info.cwd,
        shell: info.shell,
        recovered: true,
      };
      task.lines.push('[EasyCode] 界面重载后恢复接管该进程；此前的输出历史不可用，停止操作仍有效。');
      this.tasks.set(info.id, task);
      this.emit('recovered', task);
    }
  }

  /** 累计一行（含 URL 捕获）并入环形缓冲 */
  private pushLine(task: BgTask, rawSegment: string): void {
    // URL 捕取要在 \r 归约前做：进度条帧里打印的服务地址同样有效
    for (const url of captureServiceUrls(rawSegment)) {
      if (!task.urls.includes(url)) {
        task.urls.push(url);
        task.alive = undefined;
        task.probedAt = undefined;
      }
    }
    const line = takeAfterLastCr(rawSegment);
    task.lines.push(line);
    task.chars += line.length + 1;
  }

  private writeOutput(id: string, chunk: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.outputBytes += chunk.length;
    task.pending += chunk;
    // 消费完整的 \n 结尾段（每段内部按 \r 覆盖语义归约成单行）
    let idx: number;
    while ((idx = task.pending.search(/\r?\n/)) !== -1) {
      const matched = task.pending.slice(idx).match(/^\r?\n/)?.[0] ?? '\n';
      const segment = task.pending.slice(0, idx);
      task.pending = task.pending.slice(idx + matched.length);
      this.pushLine(task, segment);
    }
    // 开放尾部（尚无换行）：\r 视为覆盖当前行，历史帧即时丢弃，
    // 保证 `building 10%\rbuilding 20%\r…` 这类裸回车进度输出不会无界堆积
    const lastCr = task.pending.lastIndexOf('\r');
    if (lastCr !== -1) {
      this.captureUrlsOnly(task, task.pending.slice(0, lastCr));
      task.pending = task.pending.slice(lastCr + 1);
    }
    // 单行硬上限：永不换行的超长输出（如 base64 流）也受控
    if (task.pending.length > MAX_PENDING_CHARS) {
      const overflow = task.pending.length - MAX_PENDING_CHARS;
      task.pending = `…[EasyCode] 超长单行已丢弃头部 ${overflow} 字符\n${task.pending.slice(-MAX_PENDING_CHARS)}`;
    }
    while (task.lines.length > MAX_LINES || task.chars > MAX_CHARS) {
      const dropped = task.lines.shift();
      if (dropped === undefined) break;
      task.chars -= dropped.length + 1;
    }
  }

  /** 只做 URL 捕获不保留内容（用于被 \r 覆盖语义丢弃的历史帧） */
  private captureUrlsOnly(task: BgTask, text: string): void {
    for (const url of captureServiceUrls(text)) {
      if (!task.urls.includes(url)) {
        task.urls.push(url);
        task.alive = undefined;
        task.probedAt = undefined;
      }
    }
  }

  private markExited(id: string, code: number | null, killed: boolean): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return;
    // 冲刷未完结的尾巴行
    if (task.pending.trim()) {
      this.pushLine(task, task.pending);
    }
    task.pending = '';
    task.durationMs = Date.now() - task.startedAt;
    task.exitCode = code;
    // 停止请求在先时，无论退出码如何都判定为 killed（被停止 ≠ 异常退出）
    task.status = killed || task.stopRequested ? 'killed' : code === 0 ? 'exited' : 'failed';
    task.alive = false;
    task.probedAt = Date.now();
    this.emit(killed || task.stopRequested ? 'stopped' : 'exited', task);
  }

  /** 停止任务：Windows 树杀整棵进程树；Unix 以进程组为单位终止，杜绝孤儿子进程占端口 */
  async stop(id: string): Promise<BackgroundTaskInfo | null> {
    const task = this.tasks.get(id);
    if (!task) return null;
    if (task.status !== 'running') return this.toInfo(task);
    const kill = this.host.process.kill;
    if (!kill) throw new Error('当前环境不支持终止后台任务（宿主未实现 process.kill）');
    // 先记录停止意图：kill 触发的宿主 onExit 可能先于本函数返回到达
    task.stopRequested = true;
    try {
      await kill(id);
    } catch (err) {
      // kill 失败时回滚停止意图，保持 UI 状态与真实进程一致
      task.stopRequested = undefined;
      throw err;
    }
    // 宿主 onExit 已把状态置为 killed 时这里是 no-op；否则兜底标记
    if (task.status === 'running' && task.stopRequested) {
      this.markExited(id, task.exitCode ?? null, true);
    }
    return this.toInfo(task);
  }

  /** 以原命令、原工作目录与原 shell 重新拉起任务（旧任务仍在运行则先停止） */
  async restart(id: string): Promise<BackgroundTaskInfo> {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`后台任务不存在: ${id}`);
    if (task.status === 'running') {
      await this.stop(id);
    }
    return this.start(task.command, { cwd: task.cwd, shell: task.shell });
  }

  list(): BackgroundTaskInfo[] {
    return [...this.tasks.values()].map((t) => this.toInfo(t));
  }

  get(id: string): BackgroundTaskInfo | undefined {
    const t = this.tasks.get(id);
    return t ? this.toInfo(t) : undefined;
  }

  /** 读取任务日志尾部；task 不存在时返回 undefined。含未换行的当前行 */
  logs(id: string, tailLines = 200): string | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const lines = task.lines.slice(-Math.max(1, Math.min(tailLines, MAX_LINES)));
    if (task.pending) lines.push(task.pending);
    return lines.join('\n');
  }

  has(id: string): boolean {
    return this.tasks.has(id);
  }

  /**
   * 对任务的主服务地址做端口探活（带 TTL 缓存）。
   * 优先宿主 TCP 探测（无 CORS 限制）；宿主未实现时退回 fetch（no-cors）。
   */
  async probe(id: string, force = false): Promise<boolean | undefined> {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const url = this.primaryUrlOf(task);
    if (!url) return undefined;
    const target = parseProbeTarget(url);
    if (!target) return undefined;
    if (!force && task.alive !== undefined && task.probedAt && Date.now() - task.probedAt < PROBE_TTL_MS) {
      return task.alive;
    }
    let alive: boolean;
    const probePort = this.host.process.probePort;
    if (probePort) {
      try {
        alive = await probePort(url, PROBE_TIMEOUT_MS);
      } catch {
        alive = false;
      }
    } else if (typeof fetch === 'function') {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      try {
        await fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
        alive = true;
      } catch {
        alive = false;
      } finally {
        clearTimeout(timer);
      }
    } else {
      return undefined;
    }
    task.alive = alive;
    task.probedAt = Date.now();
    return alive;
  }

  /** 终止所有仍在运行的任务（会话删除 / 应用退出时调用） */
  async disposeAll(): Promise<void> {
    const running = [...this.tasks.values()].filter((t) => t.status === 'running');
    for (const task of running) {
      try {
        await this.stop(task.id);
      } catch {
        // 单个任务清理失败不影响其余
      }
    }
  }

  /** 运行中任务数 */
  runningCount(): number {
    return [...this.tasks.values()].filter((t) => t.status === 'running').length;
  }
}
