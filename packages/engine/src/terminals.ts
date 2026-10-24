import type { Host, TerminalHandle } from '@easycode/core';

export interface TerminalSnapshot {
  id: string;
  shell: string;
  cwd: string;
  running: boolean;
  exitCode?: number | null;
  error?: string;
  output: string;
  start: number;
  end: number;
}

interface Entry {
  snapshot: TerminalSnapshot;
  handle?: TerminalHandle;
  opening: Promise<void>;
  closing?: Promise<void>;
}

/** 每会话一个用户终端；仅内存保存有界回放，不写入会话历史或模型输入。 */
export class TerminalManager {
  private entries = new Map<string, Entry>();
  private disposed = false;
  private removed = new Set<string>();
  private deleting = new Map<string, Promise<void>>();
  constructor(private readonly host: Host) {}

  async open(sessionId: string, cwd: string): Promise<TerminalSnapshot> {
    if (this.disposed || this.removed.has(sessionId) || this.deleting.has(sessionId) || !this.host.terminal) throw new Error('当前会话或宿主不支持交互终端');
    let entry = this.entries.get(sessionId);
    if (!entry) {
      if (this.entries.size >= 8) throw new Error('最多同时保留 8 个终端，请先结束不再使用的终端');
      entry = {
        snapshot: { id: crypto.randomUUID(), cwd, shell: '', running: true, output: '', start: 0, end: 0 },
        opening: Promise.resolve(),
      };
      this.entries.set(sessionId, entry);
      const current = entry;
      current.opening = this.host.terminal.open({ cwd, cols: 100, rows: 20 }, {
        output: (chunk) => {
          const s = current.snapshot;
          s.output = (s.output + chunk).slice(-262144);
          s.end += chunk.length;
          s.start = s.end - s.output.length;
        },
        exit: (code) => { current.snapshot.running = false; current.snapshot.exitCode = code; },
      }).then((handle) => { current.handle = handle; current.snapshot.shell = handle.shell; })
        .catch((error) => {
          if (this.entries.get(sessionId) === current) this.entries.delete(sessionId);
          throw error;
        });
    }
    await entry.opening;
    if (this.entries.get(sessionId) !== entry || entry.closing) throw new Error('终端已结束或正在结束');
    return this.read(sessionId)!;
  }

  read(sessionId: string, cursor = 0): TerminalSnapshot | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    const s = entry.snapshot;
    const start = Number.isSafeInteger(cursor) ? Math.max(s.start, Math.min(s.end, cursor)) : s.start;
    return { ...s, start, output: s.output.slice(start - s.start) };
  }

  private async require(sessionId: string, terminalId: string): Promise<Entry> {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.snapshot.id !== terminalId) throw new Error('终端已结束或已替换，请重新打开');
    await entry.opening;
    if (!entry.snapshot.running || entry.closing) throw new Error('终端已退出或正在结束');
    return entry;
  }

  async write(sessionId: string, terminalId: string, data: string): Promise<void> {
    if (typeof data !== 'string' || data.length > 65536) throw new Error('终端输入超过大小限制');
    const entry = await this.require(sessionId, terminalId);
    if (entry.closing) throw new Error('终端正在结束');
    await entry.handle!.write(data);
  }

  async resize(sessionId: string, terminalId: string, cols: number, rows: number): Promise<void> {
    if (![cols, rows].every((n) => Number.isInteger(n) && n >= 2 && n <= 500)) throw new Error('终端尺寸无效');
    const entry = await this.require(sessionId, terminalId);
    await entry.handle!.resize(cols, rows);
  }

  async close(sessionId: string, terminalId?: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    if (terminalId && entry.snapshot.id !== terminalId) throw new Error('终端已替换，拒绝旧的结束操作');
    if (entry.closing) return entry.closing;
    delete entry.snapshot.error;
    entry.closing = (async () => {
      await entry.opening;
      await entry.handle!.close();
      if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId);
    })().catch((error) => {
      entry.snapshot.error = error instanceof Error ? error.message : '结束终端失败，请重试';
      throw error;
    }).finally(() => { entry.closing = undefined; });
    return entry.closing;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const results = await Promise.allSettled([...this.entries.keys()].map((id) => this.close(id)));
    if (results.some((r) => r.status === 'rejected')) throw new Error('部分终端结束失败，请重试');
  }

  async removeSession(sessionId: string, remove: () => Promise<void> = async () => {}): Promise<void> {
    const pending = this.deleting.get(sessionId);
    if (pending) return pending;
    const operation = (async () => {
      await this.close(sessionId);
      await remove();
      this.removed.add(sessionId);
    })().finally(() => { this.deleting.delete(sessionId); });
    this.deleting.set(sessionId, operation);
    return operation;
  }
}
