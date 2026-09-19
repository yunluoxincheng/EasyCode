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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      {store.toast && <div className="toast">{store.toast}</div>}
    </div>
  );
}
