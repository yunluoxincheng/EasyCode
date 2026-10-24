import { execFile } from 'node:child_process';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
interface Member { pid: number; group: number; state: string }

async function probe(args: string[]): Promise<{ text: string; probePid: number | undefined }> {
  return new Promise((resolve, reject) => {
    const child = execFile('ps', args, { timeout: 3000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, COLUMNS: '120', LINES: '40' } },
      (error, stdout) => error ? reject(new Error('无法确认终端归属')) : resolve({ text: stdout, probePid: child.pid }));
  });
}

/** 只由仍存活的 PTY 监督进程查询自己的会话；不保存退出后的 PID/TTY 作为身份。 */
async function members(): Promise<Member[]> {
  // macOS 的 sess 是内核会话表示，不能与 POSIX SID 等同，也不能用其脱敏值分组。
  // 监督进程仍存活并持有控制终端，TTY 不会因用户 Shell 退出而释放/复用。
  const tty = (await probe(['-p', String(process.pid), '-o', 'tty='])).text.trim();
  if (!tty || tty.length > 128 || !/^[A-Za-z0-9_/]+$/.test(tty)) throw new Error('监督进程没有可确认的控制终端');
  const output = await probe(['-t', tty, '-o', 'pid=,pgid=,stat=']);
  const rows = output.text.trim().split('\n').map((line) => {
    const [pid, group, state] = line.trim().split(/\s+/);
    return { pid: Number(pid), group: Number(group), state };
  }).filter((row) => Number.isInteger(row.pid) && row.pid > 1 && Number.isInteger(row.group) && row.group > 1 && row.state);
  const anchor = rows.find((row) => row.pid === process.pid);
  if (!anchor || anchor.group !== process.pid) {
    throw new Error('终端监督进程未持有独立会话，拒绝清理无关进程');
  }
  return rows.filter((row) => row.pid !== process.pid && row.pid !== output.probePid && !row.state.startsWith('Z'));
}

function signal(pid: number, value: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || Math.abs(pid) <= 1) throw new Error('拒绝向系统或广播目标发送终端信号');
  try { process.kill(pid, value); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('终端作业结束失败，可重试'); }
}

async function waitEmpty(): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    if (!(await members()).length) return true;
    await pause(100);
  }
  return false;
}

export async function closeOwnTerminalSession(): Promise<void> {
  for (const group of new Set((await members()).map((row) => row.group))) signal(-group, 'SIGTERM');
  if (await waitEmpty()) return;
  // 宽限期后重新查询，覆盖 Shell/作业在收尾期间创建的进程组。
  const remaining = await members();
  for (const group of new Set(remaining.map((row) => row.group))) {
    if (group !== process.pid) signal(-group, 'SIGKILL');
  }
  // 非交互 Shell 可能与监督进程同组；保持监督身份存活，只结束当前查询到的成员。
  for (const row of await members()) if (row.group === process.pid) signal(row.pid, 'SIGKILL');
  if (!await waitEmpty()) throw new Error('终端会话仍有存活作业，可重试');
}
