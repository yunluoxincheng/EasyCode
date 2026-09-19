import { useStore } from '../useStore.js';
import { updater, fmtBytes } from '../updater.js';

/** 关于页 · 更新区（与侧栏角标共用全局状态） */
export function UpdateSection() {
  const store = useStore();
  const p = updater.phase;

  return (
    <div className="update-section">
      <div className="update-row">
        <span className="update-label">当前版本</span>
        <span className="update-value">{updater.currentVersion ? `v${updater.currentVersion}` : '-'}</span>
      </div>
      <div className="update-row">
        <span className="update-label">更新通道</span>
        <span className="update-value">GitHub Releases（启动时静默检查）</span>
      </div>

      {p.kind === 'idle' && (
        <button className="btn primary" onClick={() => void updater.check(false)}>检查更新</button>
      )}
      {p.kind === 'checking' && <span className="update-status">正在检查更新…</span>}
      {p.kind === 'latest' && <span className="update-status ok">[ OK ] 已是最新版本</span>}
      {p.kind === 'available' && (
        <div className="update-avail">
          <div className="update-newver">发现新版本 v{p.version}</div>
          {p.notes && <div className="update-notes">{p.notes.slice(0, 200)}</div>}
          <button className="btn primary" onClick={() => void updater.install()}>下载并安装</button>
        </div>
      )}
      {p.kind === 'downloading' && (
        <div className="update-dl">
          <div className="update-dl-text">
            下载中… {fmtBytes(p.received)}{p.total ? ` / ${fmtBytes(p.total)}` : ''}
          </div>
          <div className="update-bar">
            <div
              className="update-bar-fill"
              style={{ width: p.total ? `${Math.min(100, (p.received / p.total) * 100)}%` : '30%' }}
            />
          </div>
        </div>
      )}
      {p.kind === 'installing' && <span className="update-status ok">安装完成，正在重启…</span>}
      {p.kind === 'error' && (
        <div className="update-err">
          <div className="error-line">{p.message}</div>
          <button className="btn" onClick={() => void updater.check(false)}>重试</button>
        </div>
      )}
      {!updater.isSupported && <p className="hint">当前环境不支持自动更新。</p>}
      {store.demoMode && null}
    </div>
  );
}
