/**
 * EasyCode 桌面主进程 —— 薄壳：
 * 装配 AgentServer + NodeHost，桥接渲染进程（IPC 白名单分发）。
 * 业务逻辑全部在 @easycode/engine / @easycode/core。
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { AgentServer } from '@easycode/engine';
import { NodeHost } from '@easycode/host-node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

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
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const dataDir = () => app.getPath('userData');
const host = new NodeHost({ dataDir: dataDir() });
const server = new AgentServer(host);

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
  'delete-session': (args) => server.deleteSession(args.id),
  'rename-session': (args) => server.renameSession(args.id, args.title),
  'get-session': (args) => server.getSession(args.id),
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
  'set-session-workspace': (args) => server.setSessionWorkspace(args.id, args.workspace),
  'get-settings': () => server.getSettings(),
  'update-settings': (args) => server.updateSettings(args.patch),
  'list-provider-models': (args) => server.listProviderModels(args.id),
  'pick-workspace': async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '选择工作区目录',
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  },
  'win-control': (args, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    if (args?.action === 'min') win.minimize();
    else if (args?.action === 'max') (win.isMaximized() ? win.unmaximize() : win.maximize());
    else if (args?.action === 'close') win.close();
    return null;
  },
};

ipcMain.handle('easycode', async (event, method: string, args: unknown) => {
  const handler = handlers[method];
  if (!handler) throw new Error(`未知方法: ${method}`);
  return await Promise.resolve(handler(args, event));
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
