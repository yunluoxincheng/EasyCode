import React, { useEffect, useState } from 'react';
import { useStore } from './useStore.js';
import { Sidebar } from './components/Sidebar.js';
import { Transcript } from './components/Transcript.js';
import { Composer } from './components/Composer.js';
import { CreateProjectDialog } from './components/CreateProjectDialog.js';
import { SettingsPage } from './components/SettingsPage.js';
import { TitleBar, ResizeEdges } from './components/TitleBar.js';
import { updater } from './updater.js';

export function App() {
  const store = useStore();

  useEffect(() => {
    store.init();
    store.loadSettings();
    void updater.init();
    // 禁用 WebView 原生右键菜单；输入类控件内保留（右键粘贴可用）——TODOS #16
    const onContextMenu = (e: MouseEvent): void => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      e.preventDefault();
    };
    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
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
      <ResizeEdges />
      {store.toast && (
        <div className={`toast ${store.toastKind === 'err' ? 'err' : ''}`}>{store.toast}</div>
      )}
    </div>
  );
}
