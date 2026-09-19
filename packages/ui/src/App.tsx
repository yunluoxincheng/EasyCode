import React, { useEffect, useState } from 'react';
import { useStore } from './useStore.js';
import { Sidebar } from './components/Sidebar.js';
import { Transcript } from './components/Transcript.js';
import { Composer } from './components/Composer.js';
import { NewSessionDialog } from './components/NewSessionDialog.js';
import { SettingsPage } from './components/SettingsPage.js';
import { TitleBar, ResizeEdges } from './components/TitleBar.js';

export function App() {
  const store = useStore();
  const [showNewSession, setShowNewSession] = useState(false);

  useEffect(() => {
    store.init();
    store.loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app-shell">
      <TitleBar />
      {store.view === 'settings' ? (
        <SettingsPage />
      ) : (
        <div className="app">
          <Sidebar onNewSession={() => setShowNewSession(true)} />
          <section className="main">
            <Transcript />
            <Composer />
          </section>
        </div>
      )}
      {showNewSession && <NewSessionDialog onClose={() => setShowNewSession(false)} />}
      <ResizeEdges />
      {store.toast && <div className="toast">{store.toast}</div>}
    </div>
  );
}
