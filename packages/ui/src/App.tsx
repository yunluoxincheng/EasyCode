import React, { useEffect, useState } from 'react';
import { useStore } from './useStore.js';
import { Sidebar } from './components/Sidebar.js';
import { Transcript } from './components/Transcript.js';
import { Composer } from './components/Composer.js';
import { CreateProjectDialog } from './components/CreateProjectDialog.js';
import { ModelSwitchGuardModal } from './components/ModelSwitchGuardModal.js';
import { SettingsPage } from './components/SettingsPage.js';
import { TitleBar, ResizeEdges } from './components/TitleBar.js';
import { ContextMenu } from './components/ContextMenu.js';
import { updater } from './updater.js';

export function App() {
  const store = useStore();

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
            <Composer />
          </section>
        </div>
      )}
      {store.createProjectOpen && <CreateProjectDialog />}
      {store.pendingModelSwitch && <ModelSwitchGuardModal />}
      <ResizeEdges />
      <ContextMenu />
      {store.toast && (
        <div className={`toast ${store.toastKind === 'err' ? 'err' : ''}`}>{store.toast}</div>
      )}
    </div>
  );
}
