import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { StoreProvider } from './useStore.js';
import { AppStore } from './store.js';
import { IpcAgentClient, createDemoClient } from './client.js';
import type { AgentClient } from './client.js';
import type { DecisionRequest } from '@easycode/core';
import type { ReflexWebPolicy } from './utils/reflexEngine.js';
import './styles.css';

/** 运行环境三态：Tauri（Rust 宿主）/ Electron（IPC 宿主）/ 浏览器演示（内存宿主） */
async function bootstrap(): Promise<void> {
  const w = window as unknown as Record<string, unknown>;
  try {
    let client: AgentClient;
    let reflexPolicy: ReflexWebPolicy | undefined;

    const env = '__TAURI_INTERNALS__' in window ? 'tauri' : 'easycode' in window ? 'electron' : 'web';
    document.documentElement.classList.add(`env-${env}`);

    if (env === 'tauri') {
      const { createTauriClient } = await import('@easycode/host-tauri');
      const { ReflexWebPolicy } = await import('./utils/reflexEngine.js');
      reflexPolicy = new ReflexWebPolicy();
      client = await createTauriClient({ reflexPolicy });
    } else if (env === 'electron') {
      const bridge = w.easycode as ConstructorParameters<typeof IpcAgentClient>[0];
      client = new IpcAgentClient(bridge);

      // 在渲染进程挂载真实 WebAssembly 端侧推理引擎，响应 Electron 主进程派发的决策请求
      const { ReflexWebPolicy } = await import('./utils/reflexEngine.js');
      const webPolicy = new ReflexWebPolicy();
      reflexPolicy = webPolicy;
      bridge.onEvent((payload) => {
        const ev = payload?.event as
          | {
              type?: string;
              reqId?: string;
              request?: DecisionRequest;
            }
          | undefined;
        if (ev && ev.type === 'reflex_decide' && ev.reqId && ev.request) {
          void webPolicy.decide(ev.request).then((result) => {
            void bridge.invoke('reflex-decide-result', {
              reqId: ev.reqId,
              result,
            });
          });
        }
      });
    } else {
      client = createDemoClient();
    }

    const store = new AppStore(client);
    if (reflexPolicy) {
      const webPolicy = reflexPolicy;
      store.subscribe(() => webPolicy.setEnabled(store.settings?.reflexShadowMode === true));
    }
    createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <ErrorBoundary>
          <StoreProvider value={store}>
            <App />
          </StoreProvider>
        </ErrorBoundary>
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
