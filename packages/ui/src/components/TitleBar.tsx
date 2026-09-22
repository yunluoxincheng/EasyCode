import React from 'react';
import { useStore } from '../useStore.js';
import { HelpButton } from './HelpMenu.js';
import { ExportButton } from './ExportButton.js';

type Env = 'tauri' | 'electron' | 'web';

export function currentEnv(): Env {
  if ('__TAURI_INTERNALS__' in window) return 'tauri';
  if ('easycode' in window) return 'electron';
  return 'web';
}

async function winControl(action: 'min' | 'max' | 'close'): Promise<void> {
  if (currentEnv() === 'tauri') {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    if (action === 'min') await win.minimize();
    else if (action === 'max') await win.toggleMaximize();
    else await win.close();
    return;
  }
  if (currentEnv() === 'electron') {
    const bridge = (window as unknown as { easycode: { invoke(m: string, a?: unknown): Promise<unknown> } }).easycode;
    await bridge.invoke('win-control', { action });
  }
}

/** 自绘标题栏（tmux 状态条风）：Tauri 用 data-tauri-drag-region，Electron 用 CSS app-region */
export function TitleBar(): React.ReactElement {
  const store = useStore();
  const env = currentEnv();
  const session = store.activeSession;
  const hasControls = env !== 'web';

  const onDoubleClick = (): void => {
    if (hasControls) void winControl('max');
  };

  return (
    <div className="titlebar" data-tauri-drag-region onDoubleClick={onDoubleClick}>
      <div className="titlebar-brand" data-tauri-drag-region>
        <span className="titlebar-mark">▚</span>
        <span className="titlebar-name">EASYCODE</span>
      </div>
      <div className="titlebar-center" data-tauri-drag-region>
        {session && (
          <span className="titlebar-session" title={session.workspaceRoot}>
            {session.title} —— {store.providerLabelOf(session.providerId)} · {session.model}
          </span>
        )}
      </div>
      <div className="titlebar-right" data-tauri-drag-region>
        {store.running && <span className="titlebar-live">● AGENT RUNNING</span>}
      </div>
      <ExportButton />
      <HelpButton />
      {hasControls && (
        <div className="titlebar-controls">
          <button className="tbtn" title="最小化" onClick={() => void winControl('min')}>─</button>
          <button className="tbtn" title="最大化 / 还原" onClick={() => void winControl('max')}>□</button>
          <button className="tbtn close" title="关闭" onClick={() => void winControl('close')}>✕</button>
        </div>
      )}
    </div>
  );
}

/** Tauri 无边框窗口的边缘缩放手柄 */
export function ResizeEdges(): React.ReactElement | null {
  if (currentEnv() !== 'tauri') return null;
  const edges: Array<[string, string]> = [
    ['n', 'North'], ['s', 'South'], ['e', 'East'], ['w', 'West'],
    ['ne', 'NorthEast'], ['nw', 'NorthWest'], ['se', 'SouthEast'], ['sw', 'SouthWest'],
  ];
  const onDown = (dir: string) => (e: React.MouseEvent): void => {
    e.preventDefault();
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
      getCurrentWindow().startResizeDragging(dir as never),
    );
  };
  return (
    <>
      {edges.map(([cls, dir]) => (
        <div key={cls} className={`resize-edge resize-${cls}`} onMouseDown={onDown(dir)} />
      ))}
    </>
  );
}
