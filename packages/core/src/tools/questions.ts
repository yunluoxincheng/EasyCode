import type { Tool } from './index.js';
import { parseUserQuestions } from '../questions.js';

export const askUserTool: Tool = {
  requiresWorkspace: false,
  interactionBoundary: true,
  validateInput(input) {
    try { return { ok: true, value: { questions: parseUserQuestions(input) } }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  },
  spec: {
    name: 'ask_user',
    description: '需要澄清需求、补充信息或由用户选择方案时，提出 1–3 个相关问题并等待实际回答。' +
      '请单独调用本工具；同批其他预生成调用不会执行，收到回答后须先重新规划工具参数。' +
      '可提供 2–6 个选项（每项有 label 和可选 description），也可仅自由文本；任何选项都不代表默认回答。' +
      '收到回答后继续同一任务；问题与工具执行审批不同，YOLO 也必须等待用户提交。',
    parameters: {
      type: 'object', required: ['questions'], properties: {
        questions: { type: 'array', description: '1–3 个相关问题，ID 必须唯一', items: {
          type: 'object', required: ['id', 'question'], properties: {
            id: { type: 'string', description: '最多 64 字符的字母、数字、下划线或连字符' },
            question: { type: 'string', description: '问题正文，最多 1200 字符' },
            options: { type: 'array', description: '省略或空数组表示自由文本；有选项时须为 2–6 个不重复的选项', items: {
              type: 'object', required: ['label'], properties: {
                label: { type: 'string', description: '选项名称，最多 160 字符' },
                description: { type: 'string', description: '可选的影响或取舍说明，最多 500 字符' },
              },
            } },
          },
        } },
      },
    },
  },
  async execute(input, context) {
    if (!context.questions || !context.callId) throw new Error('当前环境未接入用户提问交互');
    return JSON.stringify(await context.questions.request(context.callId, input, context.signal));
  },
};
