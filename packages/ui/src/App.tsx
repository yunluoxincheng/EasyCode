import React, { lazy, Suspense, useEffect } from 'react';
import { useStoreSlice } from './useStore.js';
import type { AppStore } from './store.js';
import { Sidebar } from './components/Sidebar.js';
import { Transcript } from './components/Transcript.js';
import { Composer } from './components/Composer.js';
import { CreateProjectDialog } from './components/CreateProjectDialog.js';
import { ModelSwitchGuardModal } from './components/ModelSwitchGuardModal.js';
import { SettingsPage } from './components/SettingsPage.js';
import { TitleBar, ResizeEdges } from './components/TitleBar.js';
import { ContextMenu } from './components/ContextMenu.js';
import { GitInspectorModal } from './components/GitInspectorModal.js';
import { BackgroundTasksBar } from './components/BackgroundTasksBar.js';
import { TaskLogsDrawer } from './components/TaskLogsDrawer.js';
import { PreviewPanel } from './components/PreviewPanel.js';
import { TurnUndoModal } from './components/TurnUndoModal.js';
import { FilePreviewModal } from './components/WorkspaceFileTree.js';
import { updater } from './updater.js';
const TerminalPanel = lazy(() => import('./components/TerminalPanel.js'));

const selectApp = (s: AppStore) => [
  s.view, s.settings, s.createProjectOpen, s.pendingModelSwitch, s.gitModalOpen,
  s.turnUndoModalTurnId, s.filePreviewPath, s.toast, s.toastKind,
  s.activeId, s.terminalOpen,
];

export function App() {
  const store = useStoreSlice(selectApp);

  useEffect(() => {
    store.init();
    store.loadSettings().then((s) => {
      if ('__TAURI_INTERNALS__' in window) {
        import('@tauri-apps/api/core')
          .then(({ invoke }) => invoke('set_close_to_tray', { enabled: s.closeToTray !== false }))
          .catch(() => {});
      }
    });
    void updater.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 响应 CRT 扫描线设置：关闭时给 html 根元素添加 crt-off 类名
  useEffect(() => {
    document.documentElement.classList.toggle('crt-off', store.settings?.crtScanline === false);
  }, [store.settings?.crtScanline]);

  return (
    <div className="app-shell">
      <TitleBar />
      {store.view === 'settings' ? (
        <SettingsPage />
      ) : (
        <div className="app">
          <Sidebar />
          <section className="main">
            <Transcript />
            <TaskLogsDrawer />
            <BackgroundTasksBar />
            {store.terminalOpen && store.activeId && <Suspense fallback={<div role="status">[ WAIT ] 正在加载终端</div>}>
              <TerminalPanel key={store.activeId} sessionId={store.activeId} />
            </Suspense>}
            <Composer />
          </section>
          <PreviewPanel />
        </div>
      )}
      {store.createProjectOpen && <CreateProjectDialog />}
      {store.pendingModelSwitch && <ModelSwitchGuardModal />}
      {store.gitModalOpen && <GitInspectorModal onClose={() => store.closeGitModal()} />}
      {store.turnUndoModalTurnId && <TurnUndoModal />}
      {store.filePreviewPath && <FilePreviewModal />}
      <ResizeEdges />
      <ContextMenu />
      {store.toast && (
        <div className={`toast ${store.toastKind === 'err' ? 'err' : ''}`}>{store.toast}</div>
      )}
    </div>
  );
}
