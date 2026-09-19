import type { Tool } from './index.js';

const MAX_OUTPUT = 40_000;

export const runCommandTool: Tool = {
  spec: {
    name: 'run_command',
    description:
      '在工作区根目录执行 shell 命令（构建、测试、git 等）。默认 120 秒超时，输出超长会截断。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        timeout_ms: { type: 'number', description: '超时毫秒数，默认 120000，上限 600000' },
      },
      required: ['command'],
    },
  },
  sensitive: true,
  async execute(input, { host, workspace, signal }) {
    const { command, timeout_ms = 120_000 } = input as {
      command: string;
      timeout_ms?: number;
    };
    const timeoutMs = Math.min(Math.max(1000, timeout_ms), 600_000);
    const result = await host.process.run(command, { cwd: workspace, timeoutMs, signal });
    const parts: string[] = [`退出码: ${result.code ?? 'signal'}`];
    const stdout = result.stdout.slice(0, MAX_OUTPUT);
    const stderr = result.stderr.slice(0, MAX_OUTPUT);
    if (stdout.trim()) parts.push(`stdout:\n${stdout}`);
    if (stderr.trim()) parts.push(`stderr:\n${stderr}`);
    return parts.join('\n');
  },
};
