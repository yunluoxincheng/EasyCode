import type { Tool } from './index.js';
import type { BackgroundTaskInfo } from '../tasks.js';

const DEFAULT_TAIL = 120;

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function statusLine(t: BackgroundTaskInfo): string {
  const base =
    t.status === 'running'
      ? `运行中 · 已运行 ${fmtDuration(Date.now() - t.startedAt)}`
      : t.status === 'killed'
        ? '已被停止'
        : t.status === 'exited'
          ? `已退出（code ${t.exitCode ?? 'signal'}）`
          : `异常退出（code ${t.exitCode ?? 'signal'}）`;
  return base + (t.pid !== undefined ? ` · PID ${t.pid}` : '');
}

function urlsLine(t: BackgroundTaskInfo): string {
  if (t.urls.length === 0) return '服务地址: （输出中尚未捕获到本地服务地址）';
  const primary = t.primaryUrl ?? t.urls[t.urls.length - 1];
  const ready = t.status !== 'running' ? '' : t.alive === true ? '（端口探活：已就绪）' : t.alive === false ? '（端口探活：尚未就绪）' : '';
  const extra = t.urls.length > 1 ? `\n其余地址: ${t.urls.slice(0, -1).join(', ')}` : '';
  return `服务地址: ${primary}${ready}${extra}`;
}

/** 查看后台任务状态与输出；不传 task_id 时列出当前会话全部后台任务 */
export const readTaskLogsTool: Tool = {
  spec: {
    name: 'read_task_logs',
    description:
      '查看后台任务的实时输出与状态（不传 task_id 则列出本会话全部后台任务）。' +
      '用于检查 dev server / 长期服务是否启动成功、捕获服务地址、排错。任务输出保留最近若干行。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '后台任务 ID（run_command 返回的 ID；缺省则列出全部任务）' },
        tail_lines: { type: 'number', description: '返回最近的输出行数，默认 120' },
      },
    },
  },
  requiresWorkspace: false,
  async execute(input, { backgroundTasks }) {    const { task_id, tail_lines } = (input ?? {}) as { task_id?: string; tail_lines?: number };
    if (!backgroundTasks) {
      return '当前环境没有后台任务（本会话尚未用 run_command background 启动过任务，或环境不支持）。';
    }
    const tail = Math.max(1, Math.min(tail_lines ?? DEFAULT_TAIL, 1000));

    if (!task_id) {
      const list = backgroundTasks.list();
      if (list.length === 0) return '当前会话没有后台任务。';
      const rows = list.map(
        (t) => `- ${t.id} | ${t.command} | ${statusLine(t)}${t.primaryUrl ? ` | ${t.primaryUrl}` : ''}`,
      );
      return `后台任务共 ${list.length} 个：\n${rows.join('\n')}\n（用 read_task_logs(task_id) 查看具体输出）`;
    }

    const task = backgroundTasks.get(task_id);
    if (!task) {
      return `后台任务不存在: ${task_id}。可用 read_task_logs（不带参数）列出本会话全部任务。`;
    }
    // 有服务地址时顺带做一次探活，让模型能判断服务是否真正就绪
    if (task.status === 'running' && task.primaryUrl) {
      await backgroundTasks.probe(task.id);
    }
    const fresh = backgroundTasks.get(task.id) ?? task;
    const text = backgroundTasks.logs(task.id, tail) ?? '(暂无输出)';
    return `任务: ${task.id}\n命令: ${task.command}\n状态: ${statusLine(fresh)}\n${urlsLine(fresh)}\n--- 最近输出（末尾 ${tail} 行）---\n${text}`;
  },
};

/** 停止一个后台任务（Windows 下整棵进程树终止，杜绝孤儿端口占用） */
export const stopTaskTool: Tool = {
  spec: {
    name: 'stop_task',
    description: '停止一个后台任务（终止其整棵进程树）。停止 dev server、watch 进程或重启服务时使用。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '要停止的后台任务 ID' },
      },
      required: ['task_id'],
    },
  },
  sensitive: true,
  requiresWorkspace: false,
  async execute(input, { backgroundTasks }) {
    const { task_id } = (input ?? {}) as { task_id?: string };
    if (!backgroundTasks) {
      return '当前环境没有后台任务管理器，无需停止。';
    }
    if (!task_id) return '缺少 task_id。可用 read_task_logs（不带参数）列出全部任务。';
    const task = backgroundTasks.get(task_id);
    if (!task) {
      return `后台任务不存在: ${task_id}。可用 read_task_logs（不带参数）列出本会话全部任务。`;
    }
    if (task.status !== 'running') {
      return `任务 ${task_id} 已不在运行（${task.status}），无需停止。`;
    }
    const after = await backgroundTasks.stop(task_id);
    return `任务已停止: ${task_id}\n命令: ${after?.command ?? task.command}\n运行时长: ${fmtDuration(after?.durationMs ?? Date.now() - task.startedAt)}`;
  },
};
