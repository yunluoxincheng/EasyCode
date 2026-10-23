import {
  MemoryHost,
  type AgentEvent,
  type ApprovalMode,
  type SessionData,
  type SessionMeta,
  type DecisionStats,
  type ProjectDecisionTree,
  type BackgroundTaskInfo,
  type TestCommandDetection,
  type ToolSpec,
} from '@easycode/core';
import { AgentServer, type AgentClient, type ProviderEntry, type Settings } from '@easycode/engine';
import type {
  ModelTestResult,
  ProviderModelInfo,
  ShellInfo,
  ProjectRuleInfo,
  CustomPromptInfo,
  GitStatusSummary,
  GitDiffResult,
  GitDiffOptions,
  TurnCheckpointSummary,
  TurnUndoPreview,
  TurnUndoResult,
  RevertTurnOptions,
  WorkspaceFilePreview,
  RunTestLoopRequest,
  TestLoopResult,
  McpServerStatus,
  McpCommand,
} from '@easycode/engine';

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
  forkSession(id: string, options?: { upToMessageId?: string; beforeUserIndex?: number }) {
    return this.invoke<SessionMeta>('fork-session', { id, options });
  }
  trimSessionHistory(id: string, keepRecentTurns?: number) {
    return this.invoke<SessionData>('trim-session-history', { id, keepRecentTurns });
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
  getMcpServers() { return this.invoke<McpServerStatus[]>('get-mcp-servers'); }
  retryMcpServer(id: string) { return this.invoke<void>('retry-mcp-server', { id }); }
  getMcpCommands() { return this.invoke<McpCommand[]>('get-mcp-commands'); }
  getMcpTools() { return this.invoke<ToolSpec[]>('get-mcp-tools'); }
  getMcpPrompt(server: string, name: string, args: Record<string, string>, token: string) {
    return this.invoke<string>('get-mcp-prompt', { server, name, arguments: args, token });
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
  detectShells() {
    return this.invoke<ShellInfo[]>('detect-shells');
  }

  listWorkspaceFiles(id: string, query?: string, limit?: number) {
    return this.invoke<string[]>('list-workspace-files', { id, query, limit });
  }
  readWorkspaceFile(id: string, relPath: string) {
    return this.invoke<WorkspaceFilePreview>('read-workspace-file', { id, relPath });
  }
  listTurnCheckpoints(id: string) {
    return this.invoke<TurnCheckpointSummary[]>('list-turn-checkpoints', { id });
  }
  previewTurnUndo(id: string, turnId?: string) {
    return this.invoke<TurnUndoPreview>('preview-turn-undo', { id, turnId });
  }
  revertTurnCheckpoint(
    id: string,
    turnId?: string,
    optionsOrPaths?: RevertTurnOptions | string[],
  ) {
    return this.invoke<TurnUndoResult>('revert-turn-checkpoint', {
      id,
      turnId,
      options: optionsOrPaths,
    });
  }
  getProjectRules(id: string) {
    return this.invoke<ProjectRuleInfo | null>('get-project-rules', { id });
  }
  initProjectRules(id: string) {
    return this.invoke<ProjectRuleInfo>('init-project-rules', { id });
  }
  listCustomPrompts(id: string) {
    return this.invoke<CustomPromptInfo[]>('list-custom-prompts', { id });
  }
  getGitStatus(id: string) {
    return this.invoke<GitStatusSummary>('get-git-status', { id });
  }
  getGitDiff(id: string, options?: GitDiffOptions) {
    return this.invoke<GitDiffResult>('get-git-diff', { id, options });
  }
  stageGitFiles(id: string, paths?: string[]) {
    return this.invoke<{ ok: boolean; error?: string }>('stage-git-files', { id, paths });
  }
  discardGitChanges(id: string, paths: string[]) {
    return this.invoke<{ ok: boolean; error?: string }>('discard-git-changes', { id, paths });
  }
  listBackgroundTasks(id: string) {
    return this.invoke<BackgroundTaskInfo[]>('list-background-tasks', { id });
  }
  getTaskLogs(id: string, taskId: string, tailLines?: number) {
    return this.invoke<string>('get-task-logs', { id, taskId, tailLines });
  }
  stopBackgroundTask(id: string, taskId: string) {
    return this.invoke<BackgroundTaskInfo | null>('stop-background-task', { id, taskId });
  }
  removeBackgroundTask(id: string, taskId: string) {
    return this.invoke<boolean>('remove-background-task', { id, taskId });
  }
  clearFinishedBackgroundTasks(id: string) {
    return this.invoke<string[]>('clear-finished-background-tasks', { id });
  }
  restartBackgroundTask(id: string, taskId: string) {
    return this.invoke<BackgroundTaskInfo>('restart-background-task', { id, taskId });
  }
  openUrl(url: string) {
    return this.invoke<void>('open-url', { url });
  }
  getDecisionStats(filter?: { workspaceRoot?: string; sessionId?: string }) {
    return this.invoke<DecisionStats>('get-decision-stats', filter);
  }
  getDecisionTree() {
    return this.invoke<ProjectDecisionTree[]>('get-decision-tree');
  }
  exportDecisionDataset(filter?: { workspaceRoot?: string; sessionId?: string }) {
    return this.invoke<string>('export-decision-dataset', filter);
  }
  reviewDecision(sessionId: string, recordId: string, label: { selectedId?: string; defer: boolean }) {
    return this.invoke<void>('review-decision', { sessionId, recordId, label });
  }
  runTestLoop(id: string, options?: RunTestLoopRequest) {
    return this.invoke<TestLoopResult>('run-test-loop', { id, options });
  }
  detectSessionTestCommand(id: string) {
    return this.invoke<TestCommandDetection | null>('detect-session-test-command', { id });
  }
  isProjectTrusted(workspaceRoot: string) {
    return this.invoke<boolean>('is-project-trusted', { workspaceRoot });
  }
  setProjectTrust(workspaceRoot: string, trusted: boolean) {
    return this.invoke<Settings>('set-project-trust', { workspaceRoot, trusted });
  }
  countIgnoredProjectAllowRules(workspaceRoot: string) {
    return this.invoke<number>('count-ignored-project-allow', { workspaceRoot });
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
    // 演示项目的最小 package.json：让 /test-loop 的测试命令探测（scripts.test）可用
    '/demo-workspace/package.json': JSON.stringify(
      { name: 'easycode-demo', version: '0.0.0', scripts: { test: 'echo demo test passed' } },
      null,
      2,
    ),
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

  // 旧版设置迁移会剔除内置演示供应商（demo），浏览器演示模式在设置加载后重新注入 mock 服务
  const demoProvider: ProviderEntry = {
    kind: 'mock',
    baseURL: '',
    name: '演示 (Mock)',
    enabled: true,
    models: [{ name: 'mock-1', enabled: true }],
  };

  // 预创建一个演示会话
  const ready = (async () => {
    const current = await server.getSettings();
    await server.updateSettings({
      ...current,
      providers: { ...current.providers, demo: demoProvider },
    });
    return server.createSession({
      workspaceRoot: '/demo-workspace',
      providerId: 'demo',
      title: '演示会话',
    });
  })();

  const wrap = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    await ready;
    return await fn();
  };

  return {
    listSessions: () => wrap(() => server.listSessions()),
    createSession: (options) => wrap(() => server.createSession(options)),
    forkSession: (id, options) => wrap(() => server.forkSession(id, options)),
    trimSessionHistory: (id, keepRecentTurns) => wrap(() => server.trimSessionHistory(id, keepRecentTurns)),
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
    getMcpServers: () => wrap(() => server.getMcpServers()),
    retryMcpServer: (id) => wrap(() => server.retryMcpServer(id)),
    getMcpCommands: () => wrap(() => server.getMcpCommands()),
    getMcpTools: () => wrap(() => server.getMcpTools()),
    getMcpPrompt: (serverId, name, args, token) => wrap(() => server.getMcpPrompt(serverId, name, args, token)),
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
    listWorkspaceFiles: (id, query, limit) => wrap(() => server.listWorkspaceFiles(id, query, limit)),
    readWorkspaceFile: (id, relPath) => wrap(() => server.readWorkspaceFile(id, relPath)),
    listTurnCheckpoints: (id) => wrap(() => server.listTurnCheckpoints(id)),
    previewTurnUndo: (id, turnId) => wrap(() => server.previewTurnUndo(id, turnId)),
    revertTurnCheckpoint: (id, turnId, optionsOrPaths) =>
      wrap(() => server.revertTurnCheckpoint(id, turnId, optionsOrPaths)),
    getProjectRules: (id) => wrap(() => server.getSessionProjectRules(id)),
    initProjectRules: (id) => wrap(() => server.initSessionProjectRules(id)),
    listCustomPrompts: (id) => wrap(() => server.listSessionCustomPrompts(id)),
    getGitStatus: (id) => wrap(() => server.getGitStatus(id)),
    getGitDiff: (id, options) => wrap(() => server.getGitDiff(id, options)),
    stageGitFiles: (id, paths) => wrap(() => server.stageGitFiles(id, paths)),
    discardGitChanges: (id, paths) => wrap(() => server.discardGitChanges(id, paths)),
    listBackgroundTasks: (id) => wrap(() => server.listBackgroundTasks(id)),
    getTaskLogs: (id, taskId, tailLines) => wrap(() => server.getTaskLogs(id, taskId, tailLines)),
    stopBackgroundTask: (id, taskId) => wrap(() => server.stopBackgroundTask(id, taskId)),
    removeBackgroundTask: (id, taskId) => wrap(() => server.removeBackgroundTask(id, taskId)),
    clearFinishedBackgroundTasks: (id) => wrap(() => server.clearFinishedBackgroundTasks(id)),
    restartBackgroundTask: (id, taskId) => wrap(() => server.restartBackgroundTask(id, taskId)),
    openUrl: async (url) => {
      window.open(url, '_blank', 'noopener');
    },
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
    detectShells: async () => [
      { id: 'git-bash', name: 'Git Bash', path: 'C:\\Program Files\\Git\\bin\\bash.exe', available: true },
      { id: 'pwsh', name: 'PowerShell 7', path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', available: true },
      { id: 'powershell', name: 'Windows PowerShell', path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', available: true },
      { id: 'cmd', name: 'Command Prompt', path: 'C:\\Windows\\System32\\cmd.exe', available: true },
    ],
    getDecisionStats: (f) => wrap(() => server.getDecisionStats(f)),
    getDecisionTree: () => wrap(() => server.getDecisionTree()),
    exportDecisionDataset: (f) => wrap(() => server.exportDecisionDataset(f)),
    reviewDecision: (sid, rid, label) => wrap(() => server.reviewDecision(sid, rid, label)),
    runTestLoop: (id, options) => wrap(() => server.runTestLoop(id, options)),
    detectSessionTestCommand: (id) => wrap(() => server.detectSessionTestCommand(id)),
    isProjectTrusted: (root) => wrap(async () => server.getProjectTrust(root)),
    setProjectTrust: (root, trusted) => wrap(() => server.setProjectTrust(root, trusted)),
    countIgnoredProjectAllowRules: (root) =>
      wrap(() => server.countIgnoredProjectAllowRules(root)),
    onEvent: (listener) => server.onEvent(listener),
  };
}
