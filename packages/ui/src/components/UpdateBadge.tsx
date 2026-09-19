import { useStore } from '../useStore.js';
import { updater, fmtBytes } from '../updater.js';
import type { UpdatePhase } from '../updater.js';

/** 侧栏底部角落的更新提醒：仅检测到新版本（含下载/安装中）时出现 */
export function UpdateBadge() {
  const store = useStore();
  const p: UpdatePhase = updater.phase;

  if (!updater.isSupported) return null;
  if (p.kind !== 'available' && p.kind !== 'downloading' && p.kind !== 'installing') {
    if (p.kind === 'error') store.showToast(`检查更新失败：${p.message}`);
    return null;
  }

  const cls = 'primary update-hot';
  const label = '⤓';
  const title = p.kind === 'downloading'
    ? `下载中 ${fmtBytes(p.received)}${p.total ? ` / ${fmtBytes(p.total)}` : ''}`
    : p.kind === 'installing' ? '安装中…' : `发现新版本 v${p.version}，点击更新`;

  return (
    <div className="update-badge">
      <button
        className={`btn ${cls} update-btn ${p.kind === 'available' ? 'hot' : ''}`}
        title={title}
        onClick={() => {
          store.updatePanelOpen = !store.updatePanelOpen;
          store.notify();
        }}
      >
        {label}
      </button>
      {store.updatePanelOpen && (p.kind === 'available' || p.kind === 'downloading' || p.kind === 'installing') && (
        <div className="update-pop">
          <div className="update-newver">发现新版本 v{'version' in p ? p.version : ''}</div>
          {p.kind === 'available' && p.notes && <div className="update-notes">{p.notes.slice(0, 160)}</div>}
          {p.kind === 'available' && (
            <button className="btn primary block" onClick={() => void updater.install()}>下载并安装</button>
          )}
          {p.kind === 'downloading' && (
            <>
              <div className="update-dl-text">
                下载中… {fmtBytes(p.received)}{p.total ? ` / ${fmtBytes(p.total)}` : ''}
              </div>
              <div className="update-bar">
                <div
                  className="update-bar-fill"
                  style={{ width: p.total ? `${Math.min(100, (p.received / p.total) * 100)}%` : '30%' }}
                />
              </div>
            </>
          )}
          {p.kind === 'installing' && <div className="update-status ok">安装完成，正在重启…</div>}
        </div>
      )}
    </div>
  );
}
