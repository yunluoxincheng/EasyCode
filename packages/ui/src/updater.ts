import { getVersion } from '@tauri-apps/api/app';

/** 更新阶段（tauri-plugin-updater 生命周期） */
export type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest' }
  | { kind: 'available'; version: string; notes?: string }
  | { kind: 'downloading'; received: number; total: number | null }
  | { kind: 'installing' }
  | { kind: 'error'; message: string };

type Update = {
  version: string;
  body?: string;
  downloadAndInstall?: (cb?: (e: unknown) => void) => Promise<void>;
};

/**
 * 自动更新全局控制器（单例）：侧栏角标与关于页共用一份状态。
 * 仅 Tauri 环境工作；浏览器/Electron 下 isSupported=false。
 */
class UpdaterController {
  phase: UpdatePhase = { kind: 'idle' };
  currentVersion = '';
  isSupported = false;
  available = false;

  private listeners = new Set<() => void>();
  private update: Update | null = null;
  private checking = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): number => this.version;
  private version = 0;

  private notify(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  private set(phase: UpdatePhase): void {
    this.phase = phase;
    this.available = phase.kind === 'available' || phase.kind === 'downloading' || phase.kind === 'installing';
    this.notify();
  }

  /** 应用启动时调用：读取当前版本并静默检查一次，此后每小时静默复查 */
  async init(): Promise<void> {
    if (!('__TAURI_INTERNALS__' in window)) return;
    this.isSupported = true;
    try {
      this.currentVersion = await getVersion();
    } catch {
      this.currentVersion = '';
    }
    this.notify();
    void this.check(true);
    window.setInterval(() => {
      // 下载/安装进行中不打断；避免复查重置进度
      if (this.checking || this.phase.kind === 'downloading' || this.phase.kind === 'installing') {
        return;
      }
      void this.check(true);
    }, 60 * 60 * 1000);
  }

  async check(silent = false): Promise<void> {
    if (!this.isSupported || this.checking) return;
    this.checking = true;
    this.set({ kind: 'checking' });
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = (await check()) as Update | null;
      if (update) {
        this.update = update;
        this.set({ kind: 'available', version: update.version, notes: update.body });
      } else {
        this.update = null;
        this.set({ kind: 'latest' });
        if (silent) {
          setTimeout(() => {
            if (this.phase.kind === 'latest') this.set({ kind: 'idle' });
          }, 3000);
        }
      }
    } catch (err) {
      if (!silent) this.set({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      else this.set({ kind: 'idle' });
    } finally {
      this.checking = false;
    }
  }

  async install(): Promise<void> {
    if (!this.update?.downloadAndInstall) return;
    this.set({ kind: 'downloading', received: 0, total: null });
    try {
      await this.update.downloadAndInstall((event: unknown) => {
        const e = event as {
          event?: string;
          data?: { chunkLength?: number; contentLength?: number };
        };
        if (e.event === 'Started') {
          this.set({ kind: 'downloading', received: 0, total: e.data?.contentLength ?? null });
        } else if (e.event === 'Progress' && e.data?.chunkLength) {
          const p = this.phase;
          if (p.kind === 'downloading') {
            this.set({ kind: 'downloading', received: p.received + (e.data?.chunkLength ?? 0), total: p.total });
          }
        } else if (e.event === 'Finished') {
          this.set({ kind: 'installing' });
        }
      });
      this.set({ kind: 'installing' });
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (err) {
      this.set({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }
}

export const updater = new UpdaterController();

export function fmtBytes(n: number): string {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}
