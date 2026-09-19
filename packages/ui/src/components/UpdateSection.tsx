import { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest' }
  | { kind: 'available'; version: string; notes?: string }
  | { kind: 'downloading'; received: number; total: number | null }
  | { kind: 'installing' }
  | { kind: 'error'; message: string };

const envTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 关于页 · 检查更新（Tauri updater：检查 → 下载进度 → 安装并重启） */
export function UpdateSection() {
  const store = useStore();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const updateRef = useRef<unknown>(null);
  const checkingRef = useRef(false);

  // 启动静默检查一次（仅 Tauri 环境）
  useEffect(() => {
    if (!envTauri) return;
    void check(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const check = async (silent = false): Promise<void> => {
    if (!envTauri) {
      setPhase({ kind: 'error', message: '当前为浏览器演示环境，无自动更新' });
      return;
    }
    if (checkingRef.current) return;
    checkingRef.current = true;
    setPhase({ kind: 'checking' });
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (update) {
        updateRef.current = update;
        setPhase({ kind: 'available', version: update.version ?? '', notes: update.body ?? undefined });
      } else {
        setPhase({ kind: 'latest' });
        if (silent) setTimeout(() => setPhase((p) => (p.kind === 'latest' ? { kind: 'idle' } : p)), 2500);
      }
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      checkingRef.current = false;
    }
  };

  const install = async (): Promise<void> => {
    const update = updateRef.current as
      | { downloadAndInstall?: (cb?: (e: unknown) => void) => Promise<void>; version: string }
      | null;
    if (!update?.downloadAndInstall) return;
    setPhase({ kind: 'downloading', received: 0, total: null });
    try {
      await update.downloadAndInstall((event: unknown) => {
        const e = event as { event?: string; data?: { chunkLength?: number; contentLength?: number; received?: number; total?: number } };
        if (e.event === 'Started') {
          setPhase({ kind: 'downloading', received: 0, total: e.data?.contentLength ?? null });
        } else if (e.event === 'Progress' && e.data?.chunkLength) {
          setPhase((p) =>
            p.kind === 'downloading'
              ? { ...p, received: p.received + (e.data?.chunkLength ?? 0) }
              : p,
          );
        } else if (e.event === 'Finished') {
          setPhase({ kind: 'installing' });
        }
      });
      await import('@tauri-apps/plugin-process').then((m) => m.relaunch());
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const fmt = (n: number): string =>
    n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;

  return (
    <div className="update-section">
      <div className="update-row">
        <span className="update-label">当前版本</span>
        <span className="update-value">v0.1.0</span>
      </div>
      <div className="update-row">
        <span className="update-label">更新通道</span>
        <span className="update-value">GitHub Releases（启动时静默检查）</span>
      </div>

      {phase.kind === 'idle' && (
        <button className="btn primary" onClick={() => void check(false)}>检查更新</button>
      )}
      {phase.kind === 'checking' && (
        <span className="update-status">正在检查更新…</span>
      )}
      {phase.kind === 'latest' && (
        <span className="update-status ok">[ OK ] 已是最新版本</span>
      )}
      {phase.kind === 'available' && (
        <div className="update-avail">
          <div className="update-newver">发现新版本 v{phase.version}</div>
          {phase.notes && <div className="update-notes">{phase.notes.slice(0, 200)}</div>}
          <button className="btn primary" onClick={() => void install()}>下载并安装</button>
        </div>
      )}
      {phase.kind === 'downloading' && (
        <div className="update-dl">
          <div className="update-dl-text">
            下载中… {phase.total ? `${fmt(phase.received)} / ${fmt(phase.total)}` : fmt(phase.received)}
          </div>
          <div className="update-bar">
            <div
              className="update-bar-fill"
              style={{
                width: phase.total ? `${Math.min(100, (phase.received / phase.total) * 100)}%` : '30%',
              }}
            />
          </div>
        </div>
      )}
      {phase.kind === 'installing' && (
        <span className="update-status ok">安装完成，正在重启…</span>
      )}
      {phase.kind === 'error' && (
        <div className="update-err">
          <div className="error-line">{phase.message}</div>
          <button className="btn" onClick={() => void check(false)}>重试</button>
        </div>
      )}
      {!envTauri && <p className="hint">演示环境不支持更新检查。</p>}
      {store.demoMode && null}
    </div>
  );
}
