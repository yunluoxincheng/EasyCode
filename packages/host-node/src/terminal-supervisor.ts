/** PTY 内的宿主监督进程：用户 Shell 退出后继续持有会话身份和控制连接。 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { closeOwnTerminalSession } from './terminal-processes.js';

const options = JSON.parse(process.argv[2] ?? '{}') as {
  address: string; token: string; file: string; args: string[]; cwd: string;
};
if (typeof options.address !== 'string' || typeof options.token !== 'string' || typeof options.file !== 'string' ||
    !Array.isArray(options.args) || typeof options.cwd !== 'string') throw new Error('终端监督启动参数无效');

let closed = false;
let parentGone = false;
let stopping: Promise<void> | undefined;
const socket = net.connect(options.address);
const hold = setInterval(() => {}, 30000);
const send = (frame: Record<string, unknown>) => {
  if (!socket.destroyed) socket.write(JSON.stringify(frame) + '\n');
};
const stop = (): Promise<void> => {
  stopping ??= (process.platform === 'win32' ? Promise.resolve() : closeOwnTerminalSession())
    .then(() => { closed = true; })
    .catch((error) => { stopping = undefined; throw error; });
  return stopping;
};
const ownerLost = () => {
  if (parentGone) return;
  parentGone = true;
  void stop().then(() => { clearInterval(hold); process.exit(0); }).catch(() => {
    // 无法确认清理时保留监督身份，不能把失败伪装为资源释放成功。
  });
};
process.on('SIGINT', () => {});
process.on('SIGBREAK', () => {});
process.on('SIGTERM', () => { if (closed) process.exit(0); });
process.on('SIGHUP', ownerLost);
socket.on('error', ownerLost);
socket.on('close', ownerLost);
socket.on('connect', () => {
  send({ type: 'hello', token: options.token, pid: process.pid });
  const env = { ...process.env };
  const shell = spawn(options.file, options.args, { cwd: options.cwd, env, stdio: 'inherit', windowsHide: true });
  shell.once('error', () => send({ type: 'shell_exit', code: 127 }));
  shell.once('exit', (code) => send({ type: 'shell_exit', code }));
});
let buffer = '';
socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  if (buffer.length > 4096) { socket.destroy(); return; }
  let index: number;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    try {
      const command = JSON.parse(line);
      if (command.type !== 'close' || command.token !== options.token) { socket.destroy(); return; }
      void stop().then(() => send({ type: 'closed' }), () => send({ type: 'close_failed' }));
    } catch { socket.destroy(); return; }
  }
});
