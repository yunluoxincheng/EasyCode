import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { StoreProvider } from './useStore.js';
import { AppStore } from './store.js';
import { IpcAgentClient, createDemoClient } from './client.js';
import type { AgentClient } from './client.js';
import './styles.css';

/** 运行环境三态：Tauri（Rust 宿主）/ Electron（IPC 宿主）/ 浏览器演示（内存宿主） */
async function bootstrap(): Promise<void> {
  const w = window as unknown as Record<string, unknown>;
  try {
    let client: AgentClient;

    const env = '__TAURI_INTERNALS__' in window ? 'tauri' : 'easycode' in window ? 'electron' : 'web';
    document.documentElement.classList.add(`env-${env}`);

    if (env === 'tauri') {
      const { createTauriClient } = await import('@easycode/host-tauri');
      client = await createTauriClient();
    } else if (env === 'electron') {
      client = new IpcAgentClient(w.easycode as ConstructorParameters<typeof IpcAgentClient>[0]);
    } else {
      client = createDemoClient();
    }

    const store = new AppStore(client);
    createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <StoreProvider value={store}>
          <App />
        </StoreProvider>
      </React.StrictMode>,
    );
  } catch (err) {
    // 启动失败直接显示在页面上，便于诊断壳层问题
    const root = document.getElementById('root')!;
    root.innerHTML = `<pre style="color:#f87171;font:12px/1.6 Consolas,monospace;padding:24px;white-space:pre-wrap">[ BOOT ERROR ]\n${String(
      err instanceof Error ? (err.stack ?? err.message) : err,
    )}</pre>`;
  }
}

void bootstrap();
