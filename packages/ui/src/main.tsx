import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { StoreProvider } from './useStore.js';
import { AppStore } from './store.js';
import { IpcAgentClient, createDemoClient } from './client.js';
import type { AgentClient } from './client.js';
import { NoopDecisionPolicy, type DecisionRequest } from '@easycode/core';
import type { ReflexWebPolicy } from './utils/reflexEngine.js';
import './styles.css';

/** 运行环境三态：Tauri（Rust 宿主）/ Electron（IPC 宿主）/ 浏览器演示（内存宿主） */
async function bootstrap(): Promise<void> {
  const w = window as unknown as Record<string, unknown>;
  try {
    let client: AgentClient;
    let reflexPolicy: ReflexWebPolicy | undefined;
    let electronBridge: ConstructorParameters<typeof IpcAgentClient>[0] | undefined;

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
      electronBridge = bridge;
    } else {
      client = createDemoClient();
    }

    const store = new AppStore(client);
    if (electronBridge) {
      const bridge = electronBridge;
      const fallback = new NoopDecisionPolicy();
      // 导入未完成或失败时也即时回复 defer，不能让主进程等待 30 秒超时。
      bridge.onEvent((payload) => {
        const ev = payload?.event as
          | {
              type?: string;
              reqId?: string;
              request?: DecisionRequest;
            }
          | undefined;
        if (ev && ev.type === 'reflex_decide' && ev.reqId && ev.request) {
          void (reflexPolicy ?? fallback).decide(ev.request).then((result) => {
            return bridge.invoke('reflex-decide-result', {
              reqId: ev.reqId,
              result,
            });
          }).catch((err) => console.warn('[Reflex] Decision bridge error:', err));
        }
      });
    }
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
    if (electronBridge) {
      // 可选策略的网络/模块异常不阻塞 Electron 主界面，也不升级为 BOOT ERROR。
      void import('./utils/reflexEngine.js').then(({ ReflexWebPolicy }) => {
        const webPolicy = new ReflexWebPolicy();
        reflexPolicy = webPolicy;
        const syncEnabled = () => webPolicy.setEnabled(store.settings?.reflexShadowMode === true);
        store.subscribe(syncEnabled);
        syncEnabled(); // 设置可能在模块加载完成前已返回，立即读取当前值。
      }).catch((err) => console.warn('[Reflex] Optional module unavailable:', err));
    }
  } catch (err) {
    // 启动失败直接显示在页面上，便于诊断壳层问题
    const root = document.getElementById('root')!;
    root.innerHTML = `<pre style="color:#f87171;font:12px/1.6 Consolas,monospace;padding:24px;white-space:pre-wrap">[ BOOT ERROR ]\n${String(
      err instanceof Error ? (err.stack ?? err.message) : err,
    )}</pre>`;
  }
}

void bootstrap();
