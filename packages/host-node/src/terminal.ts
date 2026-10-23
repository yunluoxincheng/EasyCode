import path from 'node:path';
import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import { execFile } from 'node:child_process';
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

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

export function createTerminalHost(): TerminalHost {
  return { open: async (options, events) => {
    const shell = await defaultShell();
    const { spawn } = await import('@lydell/node-pty');
    const pty = spawn(shell.file, shell.args, { cwd: options.cwd, cols: options.cols, rows: options.rows,
      name: 'xterm-256color', env: { ...process.env, TERM: 'xterm-256color' } });
    let exited = false;
    pty.onData(events.output);
    pty.onExit(({ exitCode }) => { exited = true; events.exit(exitCode); });
    let closing: Promise<void> | undefined;
    return {
      shell: shell.file,
      write: async (data) => { if (exited) throw new Error('终端已退出'); pty.write(data); },
      resize: async (cols, rows) => { if (!exited) pty.resize(cols, rows); },
      close: () => {
        closing ??= (async () => {
          // node-pty 自然退出后已释放 PTY；旧设备名/PID 可能被复用，不再据此发送信号。
          if (exited) return;
          if (process.platform === 'win32') {
            // 先由 ConPTY 查询并结束控制台进程，不能先杀 Shell 再尝试附加其控制台。
            if (!exited) pty.kill();
            for (let i = 0; i < 60 && !exited; i++) await delay(100);
            if (!exited) await new Promise<void>((resolve, reject) => {
              execFile('taskkill', ['/PID', String(pty.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, (error) => {
                if (error && !exited) reject(new Error('终端进程树结束失败，可重试')); else resolve();
              });
            });
          } else {
            // 控制终端可包含前台/后台多个作业组，不能仅杀 Shell 自己的组。
            const tty = (pty as typeof pty & { ptsName?: string }).ptsName;
            if (typeof tty !== 'string' || !tty.startsWith('/dev/')) throw new Error('无法识别终端设备，保留句柄供重试');
            const groups = await new Promise<number[]>((resolve, reject) => {
              execFile('ps', ['-t', tty, '-o', 'pgid='], { timeout: 3000 }, (error, stdout, stderr) => {
                if (error && ((error as { code?: number | string }).code !== 1 || stderr.trim())) {
                  reject(new Error('无法确认终端作业组，请重试')); return;
                }
                resolve([...new Set(stdout.trim().split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0))]);
              });
            });
            for (const pid of groups) signalGroup(pid, 'SIGTERM');
            try { pty.kill('SIGHUP'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
            for (let i = 0; i < 30 && groups.some(groupAlive); i++) await delay(100);
            for (const pid of groups) signalGroup(pid, 'SIGKILL');
            for (let i = 0; i < 30 && groups.some(groupAlive); i++) await delay(100);
            if (groups.some(groupAlive)) throw new Error('终端作业组退出未完成，可重试');
          }
          for (let i = 0; i < 60 && !exited; i++) await delay(100);
          if (!exited) throw new Error('终端退出未完成，可重试');
        })().catch((error) => { closing = undefined; throw error; });
        return closing;
      },
    };
  } };
}
