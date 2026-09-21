import type { Tool } from './index.js';
import type { TodoItem } from '../types.js';

export const todoWriteTool: Tool = {
  spec: {
    name: 'todo_write',
    description:
      '创建或更新当前任务清单。当执行复杂、跨多文件或多步骤的开发任务时，必须先使用此工具规划任务步骤，并在每个步骤开始时将其标记为 in_progress，完成时标记为 completed。至多只能有 1 个任务处于 in_progress 状态。整体替换式更新。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '完整的最新任务清单。整体替换式更新。',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '任务具体内容简述' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: '任务状态：pending(待办), in_progress(进行中), completed(已完成)',
              },
              priority: {
                type: 'string',
                enum: ['high', 'medium', 'low'],
                description: '优先级（可选）',
              },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  sensitive: false,
  requiresWorkspace: false,
  async execute(input) {
    const { todos } = (input ?? {}) as { todos?: TodoItem[] };
    if (!Array.isArray(todos)) {
      throw new Error('参数错误：todos 必须为数组');
    }

    const inProgressCount = todos.filter((t) => t.status === 'in_progress').length;
    if (inProgressCount > 1) {
      throw new Error(
        `参数错误：至多只能有 1 个任务处于 in_progress（进行中）状态，当前有 ${inProgressCount} 个。`,
      );
    }

    const validStatuses = new Set(['pending', 'in_progress', 'completed']);
    for (let i = 0; i < todos.length; i++) {
      const item = todos[i];
      if (!item || typeof item.content !== 'string' || !item.content.trim()) {
        throw new Error(`参数错误：第 ${i + 1} 项任务的 content 必须为非空字符串`);
      }
      if (!validStatuses.has(item.status)) {
        throw new Error(
          `参数错误：第 ${i + 1} 项任务的状态非法 "${item.status}"，仅支持 pending / in_progress / completed`,
        );
      }
    }

    const completed = todos.filter((t) => t.status === 'completed').length;
    const inProgress = inProgressCount;
    const pending = todos.filter((t) => t.status === 'pending').length;

    const lines: string[] = [
      `任务清单已更新（共 ${todos.length} 项：已完成 ${completed} 项，进行中 ${inProgress} 项，待办 ${pending} 项）：`,
    ];

    todos.forEach((t, i) => {
      const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◍' : '○';
      const pri = t.priority ? ` [${t.priority.toUpperCase()}]` : '';
      lines.push(`  [${icon}] ${i + 1}. ${t.content}${pri}`);
    });

    return lines.join('\n');
  },
};
