/**
 * EasyCode 桌面主进程 —— 薄壳：
 * 装配 AgentServer + NodeHost，桥接渲染进程（IPC 白名单分发）。
 * 业务逻辑全部在 @easycode/engine / @easycode/core。
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell, Tray } from 'electron';
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { DecisionPolicy, DecisionRequest, DecisionResult } from '@easycode/core';
import { NoopDecisionPolicy } from '@easycode/core';
import { AgentServer } from '@easycode/engine';
import { NodeHost } from '@easycode/host-node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let closeToTray = true;

function showMainWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function initTray(): void {
  if (tray) return;
  const iconPath = path.join(__dirname, '../../../app-icon.png');
  try {
    tray = new Tray(iconPath);
    tray.setToolTip('EasyCode');
    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => showMainWindow(),
      },
      { type: 'separator' },
      {
        label: '退出 EasyCode',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(contextMenu);
    tray.on('click', () => showMainWindow());
    tray.on('double-click', () => showMainWindow());
  } catch {
    /* 托盘初始化失败不影响主窗口 */
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#0a0e0b',
    title: 'EasyCode',
    autoHideMenuBar: true,
    frame: false, // 自绘标题栏（TitleBar 组件）
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devServer = process.env.EASYCODE_DEV_SERVER;
  if (devServer) {
    mainWindow.loadURL(devServer);
    mainWindow.webContents.openDevTools({ mode: 'bottom' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../ui/dist/index.html'));
  }

  mainWindow.on('close', (e) => {
    if (!isQuitting && closeToTray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const dataDir = () => app.getPath('userData');
const host = new NodeHost({ dataDir: dataDir() });
const server = new AgentServer(host);

/**
 * Electron 渲染进程端侧模型决策桥接策略：
 * 当处于 Electron 环境且开启影子模式时，将主进程 Agent 循环产生的决策请求
 * 通过 IPC 派发给渲染进程运行的 WebAssembly ONNX 模型，并接收真实推理结果。
 */
class ElectronBridgeDecisionPolicy implements DecisionPolicy {
  private pending = new Map<string, (res: DecisionResult) => void>();

  handleResult(reqId: string, result: DecisionResult): void {
    const resolve = this.pending.get(reqId);
    if (resolve) {
      this.pending.delete(reqId);
      resolve(result);
    }
  }

  async decide(req: DecisionRequest): Promise<DecisionResult> {
    const win = mainWindow;
    if (!win || win.isDestroyed()) {
      return new NoopDecisionPolicy().decide(req);
    }
    const reqId = `ref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    return new Promise<DecisionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        resolve(new NoopDecisionPolicy().decide(req));
      }, 5000);

      this.pending.set(reqId, (res) => {
        clearTimeout(timer);
        resolve(res);
      });

      win.webContents.send('easycode:event', {
        sessionId: '__reflex__',
        event: {
          type: 'reflex_decide',
          reqId,
          request: req,
        },
      });
    });
  }
}

const bridgePolicy = new ElectronBridgeDecisionPolicy();
server.setReflexPolicy(bridgePolicy);

// 引擎事件 → 渲染进程
server.onEvent((payload) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('easycode:event', payload);
  }
});

// 白名单式 IPC 分发（渲染层永远拿不到 Node 能力本身）
/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = (args: any, event: Electron.IpcMainInvokeEvent) => unknown;
const handlers: Record<string, Handler> = {
  'list-sessions': () => server.listSessions(),
  'create-session': (args) => server.createSession(args),
  'fork-session': (args) => server.forkSession(args.id, args.options),
  'trim-session-history': (args) => server.trimSessionHistory(args.id, args.keepRecentTurns),
  'delete-session': (args) => server.deleteSession(args.id),
  'rename-session': (args) => server.renameSession(args.id, args.title),
  'get-session': (args) => server.getSession(args.id),
  'edit-last-user-message': async (args) => {
    await server.editLastUserMessage(args.id, args.text);
    return null;
  },
  'send-message': async (args) => {
    await server.sendMessage(args.id, args.text);
    return null;
  },
  'respond-approval': (args) => {
    server.respondApproval(args.id, args.requestId, args.approved);
    return null;
  },
  abort: (args) => {
    server.abort(args.id);
    return null;
  },
  'set-approval-mode': (args) => {
    server.setApprovalMode(args.id, args.mode);
    return null;
  },
  'get-approval-mode': (args) => server.getApprovalMode(args.id),
  'set-session-model': (args) => server.setSessionModel(args.id, args.model),
  'set-session-provider': (args) => server.setSessionProvider(args.id, args.providerId, args.model),
  'set-session-effort': (args) => server.setSessionEffort(args.id, args.effort),
  'set-session-workspace': (args) => server.setSessionWorkspace(args.id, args.workspace),
  'get-settings': () => server.getSettings(),
  'update-settings': async (args) => {
    const s = await server.updateSettings(args.patch);
    if (s.closeToTray !== undefined) {
      closeToTray = s.closeToTray !== false;
    }
    return s;
  },
  'list-provider-models': (args) => server.listProviderModels(args.id),
  'test-provider-model': (args) => server.testProviderModel(args.id, args.model),
  'test-web-search': () => server.testWebSearch(),
  'list-workspace-files': (args) => server.listWorkspaceFiles(args.id as string, args.query as string | undefined),
  'get-project-rules': (args) => server.getSessionProjectRules(args.id as string),
  'init-project-rules': (args) => server.initSessionProjectRules(args.id as string),
  'list-custom-prompts': (args) => server.listSessionCustomPrompts(args.id as string),
  'get-git-status': (args) => server.getGitStatus(args.id as string),
  'get-git-diff': (args) => server.getGitDiff(args.id as string, args.options),
  'stage-git-files': (args) => server.stageGitFiles(args.id as string, args.paths as string[] | undefined),
  'discard-git-changes': (args) => server.discardGitChanges(args.id as string, args.paths as string[]),
  'get-decision-stats': (args) => server.getDecisionStats(args),
  'get-decision-tree': () => server.getDecisionTree(),
  'export-decision-dataset': (args) => server.exportDecisionDataset(args),
  'detect-shells': () => {
    const isWin = process.platform === 'win32';
    if (!isWin) return [];
    const check = (cmd: string) => {
      try {
        const out = cp.execFileSync('cmd', ['/C', 'where', cmd], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        return out.split(/\r?\n/)[0] || '';
      } catch {
        return '';
      }
    };
    const gitBash = fs.existsSync('C:\\Program Files\\Git\\bin\\bash.exe') ? 'C:\\Program Files\\Git\\bin\\bash.exe' : check('bash');
    const pwsh = check('pwsh');
    const powershell = check('powershell') || 'powershell.exe';
    const cmd = check('cmd') || 'cmd.exe';
    return [
      { id: 'pwsh', name: 'PowerShell 7', path: pwsh, available: !!pwsh },
      { id: 'git-bash', name: 'Git Bash', path: gitBash, available: !!gitBash },
      { id: 'powershell', name: 'Windows PowerShell', path: powershell, available: !!powershell },
      { id: 'cmd', name: 'Command Prompt', path: cmd, available: !!cmd },
    ];
  },
  'pick-workspace': async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '选择工作区目录',
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  },
  'open-path': async (args) => {
    const err = await shell.openPath(String(args.path));
    if (err) throw new Error(err);
    return null;
  },
  'open-in-vscode': (args) => {
    const p = String(args.path);
    const isWin = process.platform === 'win32';
    try {
      const found = isWin
        ? cp.execFileSync('cmd', ['/C', 'where', 'code'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
        : cp.execFileSync('which', ['code'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (!found) throw new Error();
    } catch {
      throw new Error('未检测到 VS Code，请先安装并在 PATH 中注册 code 命令');
    }
    if (isWin) cp.spawn('cmd', ['/C', 'code', p], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
    else cp.spawn('code', [p], { detached: true, stdio: 'ignore' }).unref();
    return null;
  },
  'send-notification': (args) => {
    if (!Notification.isSupported()) return null;
    new Notification({ title: String(args.title), body: String(args.body), silent: true }).show();
    return null;
  },
  'win-control': (args, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    if (args?.action === 'min') win.minimize();
    else if (args?.action === 'max') (win.isMaximized() ? win.unmaximize() : win.maximize());
    else if (args?.action === 'close') win.close();
    return null;
  },
  'reflex-decide-result': (args: { reqId: string; result: DecisionResult }) => {
    if (args?.reqId && args?.result) {
      bridgePolicy.handleResult(args.reqId, args.result);
    }
    return null;
  },
};

ipcMain.handle('easycode', async (event, method: string, args: unknown) => {
  const handler = handlers[method];
  if (!handler) throw new Error(`未知方法: ${method}`);
  return await Promise.resolve(handler(args, event));
});

app.whenReady().then(async () => {
  try {
    const s = await server.getSettings();
    closeToTray = s.closeToTray !== false;
  } catch {
    /* 使用默认值 */
  }
  createWindow();
  initTray();
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (!closeToTray || isQuitting) {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else showMainWindow();
});
