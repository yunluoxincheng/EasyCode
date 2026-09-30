import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';

const VIEWPORTS: Array<{ id: 'desktop' | 'tablet' | 'mobile'; label: string; width: number | null }> = [
  { id: 'desktop', label: '桌面', width: null },
  { id: 'tablet', label: '平板', width: 768 },
  { id: 'mobile', label: '手机', width: 390 },
];

/**
 * 内嵌 Web 预览面板（TODOS #44）：
 * 与会话区左右分栏，加载后台 dev server 服务地址；
 * 地址栏 / 视口切换 / 外部浏览器兜底 / 失联占位态 / 跟随刷新（HMR 失效兜底）。
 */
export function PreviewPanel() {
  const store = useStore();
  const [reloadTick, setReloadTick] = useState(0);
  const [urlDraft, setUrlDraft] = useState(store.previewUrl ?? '');
  const [logLineCount, setLogLineCount] = useState(0);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const task = store.previewTask;
  const running = task?.status === 'running';
  const stopped = task !== null && !running;
  // 未绑定任务的裸 URL 预览不显示失联占位
  const showStoppedOverlay = stopped;

  // 同步外部地址变化（任务条/抽屉一键预览）
  useEffect(() => {
    setUrlDraft(store.previewUrl ?? '');
    setReloadTick((t) => t + 1);
  }, [store.previewUrl]);

  // 跟随刷新（TODOS #44）：任务产出新输出行时自动轻刷新（HMR 失效场景兜底）
  useEffect(() => {
    if (!store.previewFollow || !store.previewTaskId) return;
    const timer = setInterval(() => {
      const sessionId = store.activeId;
      const taskId = store.previewTaskId;
      if (!sessionId || !taskId || !store.client.getTaskLogs) return;
      void store.client
        .getTaskLogs(sessionId, taskId, 200)
        .then((text) => {
          const count = text ? text.split('\n').length : 0;
          setLogLineCount((prev) => {
            if (count > prev) setReloadTick((t) => t + 1);
            return count;
          });
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.previewFollow, store.previewTaskId]);

  // 拖拽调节宽度
  const startDrag = (e: React.MouseEvent): void => {
    dragRef.current = { startX: e.clientX, startWidth: store.previewWidth };
    e.preventDefault();
  };
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      store.setPreviewWidth(drag.startWidth - (e.clientX - drag.startX));
    };
    const onUp = (): void => {
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const vp = VIEWPORTS.find((v) => v.id === store.previewViewport) ?? VIEWPORTS[0];
  if (!store.previewOpen) return null;

  return (
    <aside className="preview-panel" style={{ width: store.previewWidth }}>
      <div className="preview-resize" onMouseDown={startDrag} role="separator" />
      <div className="preview-head">
        <div className="preview-viewport-switch">
          {VIEWPORTS.map((v) => (
            <button
              key={v.id}
              type="button"
              className={`preview-vp-btn ${store.previewViewport === v.id ? 'active' : ''}`}
              title={`${v.label}视口${v.width ? ` ${v.width}px` : '（自适应）'}`}
              onClick={() => store.setPreviewViewport(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="preview-address">
          <span className="preview-scheme">⌂</span>
          <input
            value={urlDraft}
            spellCheck={false}
            placeholder="输入本地服务地址，如 localhost:5173"
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                store.setPreviewUrl(urlDraft);
                setReloadTick((t) => t + 1);
              }
            }}
          />
        </div>
        <button
          className="preview-btn"
          type="button"
          title="刷新"
          onClick={() => setReloadTick((t) => t + 1)}
        >
          ⟳
        </button>
        <button
          className={`preview-btn ${store.previewFollow ? 'active' : ''}`}
          type="button"
          title={store.previewFollow ? '跟随刷新已开启：任务有新输出时自动刷新预览' : '跟随刷新已关闭'}
          onClick={() => store.togglePreviewFollow()}
        >
          ⚡
        </button>
        {store.previewUrl && (
          <button
            className="preview-btn"
            type="button"
            title="在系统浏览器打开"
            onClick={() => store.openExternalUrl(store.previewUrl!)}
          >
            ↗
          </button>
        )}
        <button
          className="preview-btn"
          type="button"
          title="收起预览面板"
          onClick={() => store.closePreview()}
        >
          ✕
        </button>
      </div>
      <div className="preview-body" ref={bodyRef}>
        {store.previewUrl ? (
          <div
            className="preview-frame-wrap"
            style={vp.width ? { width: vp.width, flex: '0 0 auto' } : undefined}
          >
            <iframe
              key={`${store.previewUrl}#${reloadTick}`}
              className="preview-frame"
              src={store.previewUrl}
              title="内嵌预览"
              // 本地 dev server 的常规能力集；不放开 allow-top-navigation 防止逃逸
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            />
            {showStoppedOverlay && (
              <div className="preview-overlay">
                <div className="preview-overlay-title">● 服务已停止</div>
                <div className="preview-overlay-cmd" title={task?.command}>
                  $ {task?.command}
                </div>
                <div className="preview-overlay-actions">
                  {task && (
                    <button
                      className="btn primary"
                      type="button"
                      onClick={() => {
                        void store.restartTask(task.id).then((newTask) => {
                          if (newTask) {
                            store.previewTaskId = newTask.id;
                            store.notify();
                            setReloadTick((t) => t + 1);
                          }
                        });
                      }}
                    >
                      ▶ 重新启动
                    </button>
                  )}
                  <button className="btn" type="button" onClick={() => setReloadTick((t) => t + 1)}>
                    ⟳ 重试连接
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="preview-empty">
            <div className="preview-empty-title">⧉ 内嵌预览</div>
            <div className="preview-empty-hint">
              启动后台 dev server（run_command · background）后，
              点击任务条上的「⧉」即可在此实时预览服务页面。
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
