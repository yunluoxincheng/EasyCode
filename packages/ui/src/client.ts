import {
  MemoryHost,
  type AgentEvent,
  type ApprovalMode,
  type SessionData,
  type SessionMeta,
} from '@easycode/core';
import { AgentServer, type AgentClient, type Settings } from '@easycode/engine';
import type { ModelTestResult, ProviderModelInfo } from '@easycode/engine';

export type { AgentClient };

/* ------------------------------------------------------------------ */
/* Electron IPC 实现（preload 暴露 window.easycode）                    */
/* ------------------------------------------------------------------ */

interface PreloadBridge {
  invoke(method: string, args?: unknown): Promise<unknown>;
  onEvent(listener: (payload: { sessionId: string; event: AgentEvent }) => void): void;
  offEvent(listener: (payload: { sessionId: string; event: AgentEvent }) => void): void;
}

export class IpcAgentClient implements AgentClient {
  constructor(private readonly bridge: PreloadBridge) {}

  private invoke<T>(method: string, args?: unknown): Promise<T> {
    return this.bridge.invoke(method, args) as Promise<T>;
  }

  listSessions() {
    return this.invoke<SessionMeta[]>('list-sessions');
  }
  createSession(options: Parameters<AgentClient['createSession']>[0]) {
    return this.invoke<SessionMeta>('create-session', options);
  }
  deleteSession(id: string) {
    return this.invoke<void>('delete-session', { id });
  }
  renameSession(id: string, title: string) {
    return this.invoke<SessionMeta>('rename-session', { id, title });
  }
  getSession(id: string) {
    return this.invoke<SessionData>('get-session', { id });
  }
  sendMessage(id: string, text: string) {
    return this.invoke<void>('send-message', { id, text });
  }
  editLastUserMessage(id: string, text: string) {
    return this.invoke<void>('edit-last-user-message', { id, text });
  }
  respondApproval(id: string, requestId: string, approved: boolean) {
    return this.invoke<void>('respond-approval', { id, requestId, approved });
  }
  abort(id: string) {
    return this.invoke<void>('abort', { id });
  }
  setApprovalMode(id: string, mode: ApprovalMode) {
    return this.invoke<void>('set-approval-mode', { id, mode });
  }
  getApprovalMode(id: string) {
    return this.invoke<ApprovalMode>('get-approval-mode', { id });
  }
  setSessionModel(id: string, model: string) {
    return this.invoke<SessionMeta>('set-session-model', { id, model });
  }
  setSessionProvider(id: string, providerId: string, model?: string) {
    return this.invoke<SessionMeta>('set-session-provider', { id, providerId, model });
  }
  setSessionEffort(id: string, effort: string) {
    return this.invoke<SessionMeta>('set-session-effort', { id, effort });
  }
  setSessionWorkspace(id: string, workspace: string) {
    return this.invoke<SessionMeta>('set-session-workspace', { id, workspace });
  }
  getSettings() {
    return this.invoke<Settings>('get-settings');
  }
  updateSettings(patch: Partial<Settings>) {
    return this.invoke<Settings>('update-settings', { patch });
  }
  listProviderModels(id: string) {
    return this.invoke<ProviderModelInfo[]>('list-provider-models', { id });
  }
  testProviderModel(id: string, model: string) {
    return this.invoke<ModelTestResult>('test-provider-model', { id, model });
  }
  testWebSearch() {
    return this.invoke<{ ok: boolean; latencyMs: number; resultCount?: number; error?: string }>(
      'test-web-search',
    );
  }
  pickWorkspace() {
    return this.invoke<string | null>('pick-workspace');
  }
  openPath(path: string) {
    return this.invoke<void>('open-path', { path });
  }
  openInVscode(path: string) {
    return this.invoke<void>('open-in-vscode', { path });
  }
  notify(title: string, body: string) {
    return this.invoke<void>('send-notification', { title, body });
  }
  onEvent(listener: (payload: { sessionId: string; event: AgentEvent }) => void) {
    this.bridge.onEvent(listener);
    return () => this.bridge.offEvent(listener);
  }
}

/* ------------------------------------------------------------------ */
/* 演示模式实现：浏览器内跑完整引擎（MemoryHost + MockProvider）          */
/* ------------------------------------------------------------------ */

export function createDemoClient(): AgentClient {
  const host = new MemoryHost({
    '/demo-workspace/hello.txt': 'hello EasyCode!\n这是演示工作区中的示例文件。\n',
    '/demo-workspace/src/main.ts': `export function main(): void {\n  console.log('EasyCode demo');\n}\n`,
    '/demo-workspace/README.md': '# 演示工作区\n\n无需 API Key 即可体验完整 Agent 链路。\n',
    '/easycode-demo/settings.json': JSON.stringify({
      providers: {
        demo: {
          kind: 'mock',
          baseURL: '',
          name: '演示 (Mock)',
          enabled: true,
          models: [{ name: 'mock-1', enabled: true }],
        },
      },
      defaultProvider: 'demo',
      defaultApprovalMode: 'ask',
    }),
  });
  const server = new AgentServer(host);

  // 预创建一个演示会话
  let ready = server.createSession({
    workspaceRoot: '/demo-workspace',
    providerId: 'demo',
    title: '演示会话',
  });

  const wrap = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    await ready;
    return await fn();
  };

  return {
    listSessions: () => wrap(() => server.listSessions()),
    createSession: (options) => wrap(() => server.createSession(options)),
    deleteSession: (id) => wrap(() => server.deleteSession(id)),
    renameSession: (id, title) => wrap(() => server.renameSession(id, title)),
    getSession: (id) => wrap(() => server.getSession(id)),
    sendMessage: (id, text) => wrap(() => server.sendMessage(id, text)),
    editLastUserMessage: (id, text) => wrap(() => server.editLastUserMessage(id, text)),
    respondApproval: (id, requestId, approved) =>
      wrap(() => {
        server.respondApproval(id, requestId, approved);
      }),
    abort: (id) =>
      wrap(() => {
        server.abort(id);
      }),
    setApprovalMode: (id, mode) =>
      wrap(() => {
        server.setApprovalMode(id, mode);
      }),
    getApprovalMode: (id) => wrap(() => server.getApprovalMode(id)),
    setSessionModel: (id, model) => wrap(() => server.setSessionModel(id, model)),
    setSessionProvider: (id, providerId, model) => wrap(() => server.setSessionProvider(id, providerId, model)),
    setSessionEffort: (id, effort) => wrap(() => server.setSessionEffort(id, effort)),
    setSessionWorkspace: (id, workspace) => wrap(() => server.setSessionWorkspace(id, workspace)),
    getSettings: () => wrap(() => server.getSettings()),
    updateSettings: (patch) => wrap(() => server.updateSettings(patch)),
    listProviderModels: (id) => wrap(() => server.listProviderModels(id)),
    testProviderModel: (id, model) =>
      wrap(async () => {
        const infos = await server.listProviderModels(id).catch(() => []);
        if (!infos.some((m) => m.name === model)) {
          return { ok: false, latencyMs: 0, error: '模型不在该服务的列表中' };
        }
        return { ok: true, latencyMs: 1 };
      }),
    testWebSearch: () =>
      wrap(() => ({ ok: false, latencyMs: 0, error: '演示模式无搜索后端' })),
    pickWorkspace: async () => '/demo-workspace',
    openPath: async (_path) => { /* 演示模式：无实际文件系统 */ },
    openInVscode: async (_path) => { /* 演示模式：无实际文件系统 */ },
    notify: async (title, body) => {
      // 演示模式（浏览器）：退回 Web Notification
      if (!('Notification' in window)) return;
      const send = (): void => { new Notification(title, { body, silent: true }); };
      if (Notification.permission === 'granted') send();
      else if (Notification.permission === 'default') {
        await Notification.requestPermission().then((p) => { if (p === 'granted') send(); });
      }
    },
    onEvent: (listener) => server.onEvent(listener),
  };
}
