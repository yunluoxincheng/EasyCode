import type { Tool } from './index.js';
import { parseDelegatedTask } from '../delegation.js';

export const delegateTaskTool: Tool = {
  spec: {
    name: 'task',
    description: '委派一个独立上下文的只读代码探索任务并等待结论。适合跨文件检索和实现定位。' +
      '子任务只获得目标、提示与项目规范，不获得主会话历史；请给出完整问题。' +
      '仅可读文件、列目录、搜索、查看 Git 状态与全局差异，不能写文件、执行 Shell、访问 MCP、联网或继续委派。' +
      '每次最多 16 步/120 秒，每主回合最多 4 次；结论最多 6000 字符，请要求文件路径和定位依据。',
    parameters: { type: 'object', required: ['description'], properties: {
      description: { type: 'string', description: '自包含的探索目标，最多 4000 字符' },
      hints: { type: 'string', description: '可选的文件或方向提示，最多 2000 字符' },
      return_format: { type: 'string', description: '可选的结论格式要求，最多 1000 字符' },
    } },
  },
  sensitive: false,
  validateInput(input) {
    try { return { ok: true, value: { ...parseDelegatedTask(input) } }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  },
  async execute(input, context) {
    if (!context.delegatedTasks || !context.callId || !context.messageId) throw new Error('当前环境未接入只读子任务');
    return context.delegatedTasks.run({ id: context.callId, messageId: context.messageId }, parseDelegatedTask(input), context.signal);
  },
};
