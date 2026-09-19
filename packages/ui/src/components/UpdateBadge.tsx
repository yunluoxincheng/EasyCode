import { useStore } from '../useStore.js';
import { updater, fmtBytes } from '../updater.js';
import type { UpdatePhase } from '../updater.js';

/** 侧栏底部角落的更新按钮：新版本时高亮，点击在原地弹出下载/安装面板 */
export function UpdateBadge() {
  const store = useStore();
  const p: UpdatePhase = updater.phase;
  const dim = updater.currentVersion ? `v${updater.currentVersion}` : '';

  if (!updater.isSupported) return null;

  let cls = 'ghost';
  let label = '↻';
  let title = '检查更新';
  if (p.kind === 'checking') { cls = 'ghost'; label = '◌'; title = '正在检查更新…'; }
  if (p.kind === 'latest') { cls = 'ghost'; label = '✓'; title = '已是最新版本'; }
  if (p.kind === 'available' || p.kind === 'downloading' || p.kind === 'installing') {
    cls = 'primary update-hot';
    label = '⤓';
    title = p.kind === 'downloading'
      ? `下载中 ${fmtBytes(p.received)}${p.total ? ` / ${fmtBytes(p.total)}` : ''}`
      : p.kind === 'installing' ? '安装中…' : `发现新版本 v${p.version}，点击更新`;
  }
  if (p.kind === 'error') { cls = 'danger'; label = '!'; title = `更新检查失败：${p.message}`; }

  return (
    <div className="update-badge">
      <button
        className={`btn ${cls} update-btn ${p.kind === 'available' ? 'hot' : ''}`}
        title={title}
        onClick={() => {
          if (p.kind === 'available') { store.updatePanelOpen = !store.updatePanelOpen; store.notify(); }
          else if (p.kind === 'idle' || p.kind === 'error' || p.kind === 'latest') void updater.check(false);
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
