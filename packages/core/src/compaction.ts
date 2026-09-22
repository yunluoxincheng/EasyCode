import type { ChatMessage, TodoItem } from './types.js';

export interface PruneToolOptions {
  /** 保留最近几轮用户交互中的工具输出不折叠（默认 1，即当前/最近轮次不折叠） */
  keepRecentTurns?: number;
  /** 触发折叠的最大字符数（默认 1000 字符） */
  maxChars?: number;
  /** 触发折叠的最大行数（默认 25 行） */
  maxLines?: number;
  /** 折叠后保留的头部行数（默认 10 行） */
  headLines?: number;
  /** 折叠后保留的尾部行数（默认 10 行） */
  tailLines?: number;
}

export interface PruneResult {
  modified: boolean;
  prunedCount: number;
  savedChars: number;
}

/**
 * 第一级压缩：修剪历史较早轮次中庞大的工具输出（如大文件读取、冗长构建日志）。
 * 严格保留 toolCallId 完备配对，原地更新消息中的 content，节省大量 Token。
 */
export function pruneHistoricalToolResults(
  messages: ChatMessage[],
  options: PruneToolOptions = {},
): PruneResult {
  const {
    keepRecentTurns = 1,
    maxChars = 1000,
    maxLines = 25,
    headLines = 10,
    tailLines = 10,
  } = options;

  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') {
      userIndices.push(i);
    }
  }

  // 若用户交互轮数未超过保护轮数，不修剪
  if (userIndices.length <= keepRecentTurns) {
    return { modified: false, prunedCount: 0, savedChars: 0 };
  }

  const cutIndex = userIndices[userIndices.length - keepRecentTurns];
  let modified = false;
  let prunedCount = 0;
  let savedChars = 0;

  for (let i = 0; i < cutIndex; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool_result') continue;

    const content = msg.content;
    if (!content) continue;

    // 检查是否超出阈值
    const lines = content.split('\n');
    if (content.length <= maxChars && lines.length <= maxLines) {
      continue;
    }

    // 执行折叠
    let folded: string;
    if (lines.length > headLines + tailLines) {
      const head = lines.slice(0, headLines).join('\n');
      const tail = lines.slice(-tailLines).join('\n');
      const omittedLines = lines.length - headLines - tailLines;
      folded = `[历史工具输出已折叠归档 · 原始 ${lines.length} 行 / ${content.length} 字符]\n${head}\n\n... [折叠省略中间 ${omittedLines} 行输出以节省上下文空间] ...\n\n${tail}`;
    } else {
      const half = Math.floor(maxChars / 2);
      const head = content.slice(0, half);
      const tail = content.slice(-half);
      const omittedChars = content.length - maxChars;
      folded = `[历史工具输出已折叠归档 · 原始 ${content.length} 字符]\n${head}\n\n... [折叠省略中间 ${omittedChars} 字符以节省上下文空间] ...\n\n${tail}`;
    }

    const saved = content.length - folded.length;
    if (saved > 0) {
      msg.content = folded;
      modified = true;
      prunedCount++;
      savedChars += saved;
    }
  }

  return { modified, prunedCount, savedChars };
}

/** 从会话消息列表中提取最新的 todo_write 任务清单快照 */
export function extractLatestTodos(messages: ChatMessage[]): TodoItem[] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      for (const block of msg.blocks) {
        if (block.type === 'tool_call' && block.name === 'todo_write') {
          const input = block.input as { todos?: TodoItem[] } | undefined;
          if (Array.isArray(input?.todos)) {
            return input.todos;
          }
        }
      }
    }
  }
  return undefined;
}

export interface CompactOptions {
  /** 保留最近几轮完整用户交互（默认 2） */
  keepRecentTurns?: number;
  /** 是否同步对保留轮次中的旧工具长输出做裁剪（默认 true） */
  pruneTools?: boolean;
}

/**
 * 第二级压缩：历史轮次阶段性归档压缩（Context Compaction）。
 * 保留最近 keepRecentTurns 轮完整交互，从早期轮次提取文件、命令、任务清单等关键事实，
 * 聚合成一条高密度阶段记忆说明消息，替换旧历史。
 */
export function compactHistoryMessages(
  messages: ChatMessage[],
  options: CompactOptions = {},
): { messages: ChatMessage[]; compacted: boolean; preservedTurns: number; discardedTurns: number } {
  const { keepRecentTurns = 2, pruneTools = true } = options;

  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') {
      userIndices.push(i);
    }
  }

  // 轮数较短，不需要切断历史；但可以执行工具输出裁剪
  if (userIndices.length <= keepRecentTurns) {
    if (pruneTools && userIndices.length > 1) {
      pruneHistoricalToolResults(messages, { keepRecentTurns: 1 });
    }
    return {
      messages,
      compacted: false,
      preservedTurns: userIndices.length,
      discardedTurns: 0,
    };
  }

  const cutIndex = userIndices[userIndices.length - keepRecentTurns];
  const discarded = messages.slice(0, cutIndex);
  const preserved = messages.slice(cutIndex);

  // 对保留的轮次中不是最后一轮的工具输出做一次长输出裁剪
  if (pruneTools) {
    pruneHistoricalToolResults(preserved, { keepRecentTurns: 1 });
  }

  // 从丢弃的历史中提取关键上下文事实
  const filesTouched = new Set<string>();
  const commandsRun: string[] = [];

  for (const msg of discarded) {
    if (msg.role === 'assistant') {
      for (const block of msg.blocks) {
        if (block.type === 'tool_call') {
          const input = block.input as Record<string, unknown> | undefined;
          if (['read_file', 'write_file', 'edit_file'].includes(block.name)) {
            const path = (input?.filePath || input?.path) as string | undefined;
            if (path && typeof path === 'string') {
              filesTouched.add(path);
            }
          } else if (block.name === 'run_command') {
            const cmd = input?.command as string | undefined;
            if (cmd && typeof cmd === 'string') {
              commandsRun.push(cmd.length > 50 ? cmd.slice(0, 47) + '...' : cmd);
            }
          }
        }
      }
    }
  }

  // 提取全局 latest todos
  const latestTodos = extractLatestTodos(messages);
  let todosSummary = '';
  if (latestTodos && latestTodos.length > 0) {
    const done = latestTodos.filter((t) => t.status === 'completed').length;
    const inProg = latestTodos.filter((t) => t.status === 'in_progress').length;
    const pending = latestTodos.filter((t) => t.status === 'pending').length;
    todosSummary = `已完成 ${done} 项，进行中 ${inProg} 项，待办 ${pending} 项`;
  }

  const discardedTurnsCount = userIndices.length - keepRecentTurns;
  const parts: string[] = [
    '【系统提示：早期历史会话已精简归档】',
    `为释放上下文空间并保障模型聚焦，前序 ${discardedTurnsCount} 轮对话及详细工具输出已压缩归档。`,
  ];

  if (filesTouched.size > 0) {
    const fileList = Array.from(filesTouched).slice(-12).join(', ');
    parts.push(`- 历史涉及文件：${fileList}${filesTouched.size > 12 ? ` 等共 ${filesTouched.size} 个文件` : ''}`);
  }

  if (commandsRun.length > 0) {
    const cmdList = commandsRun.slice(-4).join('; ');
    parts.push(`- 早期关键命令：${cmdList}`);
  }

  if (todosSummary) {
    parts.push(`- 任务清单状态：${todosSummary}`);
  }

  parts.push(`请继续基于上述背景与后续保留的最近 ${keepRecentTurns} 轮完整交互推进任务。`);

  const summaryMsg: ChatMessage = {
    role: 'user',
    content: parts.join('\n'),
    id: `m_${Date.now().toString(36)}_compact`,
    createdAt: new Date().toISOString(),
  };

  return {
    messages: [summaryMsg, ...preserved],
    compacted: true,
    preservedTurns: keepRecentTurns,
    discardedTurns: discardedTurnsCount,
  };
}
