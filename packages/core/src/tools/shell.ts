import type { Tool } from './index.js';

const MAX_OUTPUT = 40_000;

export const runCommandTool: Tool = {
  spec: {
    name: 'run_command',
    description:
      '在工作区根目录执行 shell 命令（构建、测试、git 等）。默认前台运行，120 秒超时，输出超长会截断。' +
      '对 dev server、watch 模式、容器等不会自行退出的长期命令，必须传 background: true 后台运行：调用立即返回任务 ID，' +
      '随后用 read_task_logs 查看输出与服务地址、用 stop_task 停止。不要用前台命令运行无法自动退出的服务。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        timeout_ms: { type: 'number', description: '超时毫秒数（仅前台生效），默认 120000，上限 600000' },
        background: {
          type: 'boolean',
          description: '后台常驻运行（dev server / watch / 长期服务时使用）：立即返回任务 ID，不等待退出',
        },
      },
      required: ['command'],
    },
  },
  sensitive: true,
  async execute(input, { host, workspace, signal, shell, backgroundTasks }) {
    const { command, timeout_ms = 120_000, background } = input as {
      command: string;
      timeout_ms?: number;
      background?: boolean;
    };

    if (background) {
      if (!backgroundTasks) {
        return '当前环境不支持后台任务，无法后台运行该命令。请改用前台命令（会受 120s 超时限制）。';
      }
      const task = await backgroundTasks.start(command, { cwd: workspace, shell });
      const urlLine = task.primaryUrl
        ? `\n已捕获服务地址: ${task.primaryUrl}（就绪状态可用 read_task_logs 确认）`
        : '';
      return (
        `后台任务已启动 · ID: ${task.id}${task.pid !== undefined ? ` · PID: ${task.pid}` : ''}\n` +
        `命令: ${command}${urlLine}\n` +
        '该进程不会阻塞本任务，后续可用 read_task_logs 查看输出、确认服务就绪或排错；需要停止时用 stop_task。'
      );
    }

    const timeoutMs = Math.min(Math.max(1000, timeout_ms), 600_000);
    const result = await host.process.run(command, { cwd: workspace, timeoutMs, signal, shell });
    const parts: string[] = [`退出码: ${result.code ?? 'signal'}`];
    const stdout = result.stdout.slice(0, MAX_OUTPUT);
    const stderr = result.stderr.slice(0, MAX_OUTPUT);
    if (stdout.trim()) parts.push(`stdout:\n${stdout}`);
    if (stderr.trim()) parts.push(`stderr:\n${stderr}`);
    return parts.join('\n');
  },
};
