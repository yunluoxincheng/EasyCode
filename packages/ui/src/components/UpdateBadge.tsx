import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useStore } from '../useStore.js';
import { updater, fmtBytes } from '../updater.js';
import type { UpdatePhase } from '../updater.js';
import { renderMarkdown } from '../markdown.js';

/**
 * 侧栏底部角落的更新提醒：启动检测到新版本即出现（经 useSyncExternalStore
 * 订阅 updater 自身版本号）；悬停/点击展开更新说明（Markdown 渲染），下载带进度条。
 */
export function UpdateBadge() {
  const store = useStore();
  useSyncExternalStore(updater.subscribe, updater.getSnapshot, () => 0);
  const p: UpdatePhase = updater.phase;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const lastError = useRef('');

  const active = p.kind === 'available' || p.kind === 'downloading' || p.kind === 'installing';

  useEffect(() => {
    if (p.kind === 'error' && p.message !== lastError.current) {
      lastError.current = p.message;
      store.showToast(`检查更新失败：${p.message}`, 'err');
    }
  }, [p, store]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!updater.isSupported || !active) return null;

  return (
    <div className="update-badge" ref={wrapRef}>
      <button
        className={`btn update-btn ${p.kind === 'available' ? 'hot' : ''}`}
        title={
          p.kind === 'downloading'
            ? `下载中 ${fmtBytes(p.received)}${p.total ? ` / ${fmtBytes(p.total)}` : ''}`
            : p.kind === 'installing'
              ? '安装中…'
              : `发现新版本 v${p.version}，悬停查看更新内容`
        }
        onClick={() => setOpen(!open)}
      >
        ⤓
      </button>
      {open && (
        <div className="update-pop">
          {p.kind === 'available' && (
            <>
              <div className="update-newver">发现新版本 v{p.version}</div>
              {p.notes && (
                <div
                  className="md update-md"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(p.notes) }}
                />
              )}
              <button className="btn primary block" onClick={() => void updater.install()}>
                下载并安装
              </button>
            </>
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
          {p.kind === 'installing' && (
            <div className="update-status ok">安装完成，正在重启…</div>
          )}
        </div>
      )}
    </div>
  );
}
