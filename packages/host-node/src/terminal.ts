import path from 'node:path';
import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import type { TerminalHost } from '@easycode/core';

function executable(file: string): string | undefined {
  const dirs = path.isAbsolute(file) ? [''] : (process.env.PATH ?? '').split(path.delimiter);
  for (const dir of dirs) {
    const candidate = path.isAbsolute(file) ? file : path.join(dir, file);
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* 继续查找。 */ }
  }
  return undefined;
}

/** Windows 优先读取 Windows Terminal 默认 Profile，只接受可识别的 Shell 可执行文件。 */
async function defaultShell(): Promise<{ file: string; args: string[] }> {
  if (process.platform !== 'win32') {
    const file = process.env.SHELL && executable(process.env.SHELL) || '/bin/sh';
    return { file, args: ['-l'] };
  }
  const local = process.env.LOCALAPPDATA;
  const files = local ? [
    path.join(local, 'Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json'),
    path.join(local, 'Microsoft/Windows Terminal/settings.json'),
  ] : [];
  for (const file of files) {
    try {
      if ((await fs.stat(file)).size > 1048576) continue;
      const text = await fs.readFile(file, 'utf8');
      // JSONC 注释/尾随逗号仅在字符串之外移除，不能误用注释中的默认 Profile。
      const json = text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (match) => match.startsWith('"') ? match : ' ')
        .replace(/"(?:\\.|[^"\\])*"|,\s*(?=[}\]])/g, (match) => match.startsWith('"') ? match : '');
      const config = JSON.parse(json);
      if (typeof config.defaultProfile !== 'string' || !Array.isArray(config.profiles?.list)) continue;
      for (const profile of config.profiles.list) {
        if (profile?.guid !== config.defaultProfile) continue;
        const decoded = typeof profile.commandline === 'string' ? profile.commandline : '';
        const target = /^(?:"([^"]+)"|([^\s]+))/.exec(decoded);
        const requested = (target?.[1] ?? target?.[2] ?? (profile.source === 'Windows.Terminal.PowershellCore' ? 'pwsh.exe' : ''))
          .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name: string) => Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? match);
        if (!/^(pwsh|powershell|cmd|bash|zsh|fish)(\.exe)?$/i.test(path.basename(requested))) continue;
        const resolved = executable(requested);
        if (resolved) return { file: resolved, args: /(?:pwsh|powershell)\.exe$/i.test(resolved) ? ['-NoLogo'] : /cmd\.exe$/i.test(resolved) ? ['/d'] : ['-l'] };
      }
    } catch { /* 系统未配置 Windows Terminal 或配置不可读时使用系统 Shell 回退。 */ }
  }
  for (const name of ['pwsh.exe', 'powershell.exe', process.env.COMSPEC ?? 'cmd.exe']) {
    const file = executable(name);
    if (file) return { file, args: /cmd\.exe$/i.test(file) ? ['/d'] : ['-NoLogo'] };
  }
  throw new Error('未找到可用的系统 Shell');
}

function bounded<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export function createTerminalHost(): TerminalHost {
  return { open: async (options, events) => {
    const shell = await defaultShell();
    // Electron 的 GUI 可执行文件在 Windows ConPTY 下没有可靠的继承式 stdio。
    // 辅助 Electron 开发壳使用现有 Node.js；主力 Tauri 宿主不走此路径。
    const node = process.versions.electron ? executable(process.platform === 'win32' ? 'node.exe' : 'node') : process.execPath;
    if (!node) throw new Error('Electron 调试终端需要 PATH 中可用的 Node.js');
    const { spawn } = await import('@lydell/node-pty');
    const token = crypto.randomUUID();
    const address = process.platform === 'win32' ? `\\\\.\\pipe\\easycode-pty-${token}` : `/tmp/easycode-pty-${token}.sock`;
    let control: net.Socket | undefined;
    let root: import('@lydell/node-pty').IPty | undefined;
    let shellExited = false;
    let ptyExited = false;
    let released = false;
    let reply: { resolve(): void; reject(error: Error): void } | undefined;
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    let exitResolve!: () => void;
    const exited = new Promise<void>((resolve) => { exitResolve = resolve; });
    const sockets = new Set<net.Socket>();
    let serverClosed: Promise<void> | undefined;
    const stopListening = () => serverClosed ??= new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    const server = net.createServer((socket) => {
      if (control) { socket.destroy(); return; }
      sockets.add(socket);
      const handshake = setTimeout(() => socket.destroy(), 1500);
      let buffer = '';
      socket.on('error', () => {});
      socket.on('close', () => { clearTimeout(handshake); sockets.delete(socket); });
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (buffer.length > 4096) { socket.destroy(); return; }
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try {
            const frame = JSON.parse(line);
            if (!control) {
              if (frame.type !== 'hello' || frame.token !== token || frame.pid !== root?.pid) { socket.destroy(); return; }
              control = socket;
              clearTimeout(handshake);
              // 认证完成后停止接入，已有控制连接保留到资源清理确认。
              void stopListening().catch(() => readyReject(new Error('终端控制监听释放失败')));
              readyResolve();
            } else if (control !== socket) { socket.destroy(); return; }
            else if (frame.type === 'shell_exit' && !shellExited && (frame.code === null || Number.isInteger(frame.code))) {
              shellExited = true; events.exit(frame.code);
            } else if (frame.type === 'closed') reply?.resolve();
            else if (frame.type === 'close_failed') reply?.reject(new Error('终端作业清理失败，可重试'));
            else { socket.destroy(); return; }
          } catch { socket.destroy(); return; }
        }
      });
    });
    server.maxConnections = 2;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, () => { server.removeListener('error', reject); resolve(); });
    });
    server.on('error', () => readyReject(new Error('终端控制通道失败')));
    if (process.platform !== 'win32') await fs.chmod(address, 0o600);
    const releaseChannel = async () => {
      for (const socket of sockets) socket.destroy();
      if (serverClosed) await serverClosed;
      else if (server.listening) await stopListening();
    };
    try {
      root = spawn(node, [fileURLToPath(new URL('./terminal-supervisor.js', import.meta.url)), JSON.stringify({
        address, token, file: shell.file, args: shell.args, cwd: options.cwd,
      })], { cwd: options.cwd, cols: options.cols, rows: options.rows, name: 'xterm-256color',
        env: { ...process.env, TERM: 'xterm-256color' } });
    } catch { await releaseChannel(); throw new Error('启动终端监督进程失败'); }
    const pty = root;
    pty.onData(events.output);
    pty.onExit(({ exitCode }) => {
      ptyExited = true;
      readyReject(new Error('终端监督进程提前退出'));
      if (!shellExited) { shellExited = true; events.exit(exitCode); }
      exitResolve();
    });
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
        closing ??= (async () => {
          if (released) return;
          // 监督进程异常死亡时不再根据过期 PID/设备名发送信号，也不谎报清理成功。
          if (ptyExited) throw new Error('终端监督身份已失效，无法确认资源清理');
          if (process.platform === 'win32') {
            // Shell 已退出时，监督进程仍保持 ConPTY 存活，原生库可按所属控制台清理。
            pty.kill();
          } else if (control && !control.destroyed) {
            const acknowledgement = new Promise<void>((resolve, reject) => {
              reply = { resolve, reject };
              control!.write(JSON.stringify({ type: 'close', token }) + '\n', (error) => {
                if (error) reject(new Error('终端控制通道写入失败，可重试'));
              });
            });
            try { await bounded(acknowledgement, 15000, '终端会话清理未确认，可重试'); }
            finally { reply = undefined; }
            pty.kill('SIGKILL');
          } else {
            // 监督进程在建立控制连接前不启动 Shell；HUP 由其按同一清理流程处理。
            pty.kill('SIGHUP');
          }
          await bounded(exited, 15000, '终端资源退出未完成，可重试');
          await releaseChannel();
          released = true;
        })().catch((error) => { closing = undefined; throw error; });
        return closing;
    };
    try { await bounded(ready, 10000, '终端监督握手超时'); }
    catch (error) { await close(); throw error; }
    return {
      shell: shell.file,
      supervisorPid: pty.pid,
      write: async (data) => { if (shellExited || ptyExited || closing) throw new Error('终端已退出或正在结束'); pty.write(data); },
      resize: async (cols, rows) => { if (!ptyExited && !released) pty.resize(cols, rows); },
      close,
    };
  } };
}
