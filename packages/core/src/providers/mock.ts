import type { ToolCallBlock } from '../types.js';
import type { StreamRequest, Provider, TurnResult, StreamContext } from './index.js';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

/**
 * 演示/测试用 Provider：按关键词选择一个工具调用，随后总结。
 * 无需网络与 API Key，即可完整演示 工具调用 → 审批 → Diff → 结果 全链路。
 */
export class MockProvider implements Provider {
  readonly id: string;

  constructor(id = 'demo') {
    this.id = id;
  }

  async stream(request: StreamRequest, ctx: StreamContext): Promise<TurnResult> {
    // 只统计「最后一条用户消息之后」的工具轮数，避免跨任务串状态
    let lastUserIdx = -1;
    for (const [i, m] of request.messages.entries()) {
      if (m.role === 'user' && typeof m.content === 'string') lastUserIdx = i;
    }
    const lastUser = lastUserIdx >= 0 ? request.messages[lastUserIdx] : undefined;
    const task = lastUser && lastUser.role === 'user' ? lastUser.content : '';
    const toolRounds = request.messages
      .slice(lastUserIdx + 1)
      .filter((m) => m.role === 'assistant' && m.blocks.some((b) => b.type === 'tool_call'))
      .length;

    if (toolRounds === 0) {
      await sleep(200, ctx.signal);
      const call = planFirstStep(task);
      await this.emitSlow(ctx, 'thinking', `用户需求是「${task.slice(0, 60)}」。我先调用工具获取信息，再决定下一步。`);
      await this.emitSlow(ctx, 'text', '好的，我先通过工具了解工作区情况，然后给出结果。\n\n');
      return {
        blocks: [
          { type: 'thinking', text: `用户需求是「${task.slice(0, 60)}」。我先调用工具获取信息。` },
          { type: 'text', text: '好的，我先通过工具了解工作区情况，然后给出结果。\n\n' },
          call,
        ],
        usage: { inputTokens: 100, outputTokens: 40 },
        stopReason: 'tool_calls',
      };
    }

    // 第二轮：根据上一轮工具结果总结
    await sleep(200, ctx.signal);
    const lastResult = [...request.messages]
      .reverse()
      .find((m) => m.role === 'tool_result');
    const excerpt =
      lastResult && lastResult.role === 'tool_result'
        ? lastResult.content.split('\n').slice(0, 8).join('\n')
        : '（无结果）';
    const summary =
      `工具返回结果（节选）：\n\n\`\`\`\n${excerpt}\n\`\`\`\n\n` +
      '以上是 **演示模式** 的输出：模型、工具调用、审批、结果回传的完整链路都已走通。' +
      '请在「设置」中配置真实 Provider（GLM / DeepSeek / OpenAI / Ollama 等）开始实际使用。';
    await this.emitSlow(ctx, 'text', summary);
    return {
      blocks: [{ type: 'text', text: summary }],
      usage: { inputTokens: 300, outputTokens: 80 },
      stopReason: 'stop',
    };
  }

  private async emitSlow(
    ctx: StreamContext,
    kind: 'text' | 'thinking',
    text: string,
  ): Promise<void> {
    // 按小块流出，模拟真实打字机效果，同时验证流式 UI
    const chunkSize = 6;
    for (let i = 0; i < text.length; i += chunkSize) {
      if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const delta = text.slice(i, i + chunkSize);
      ctx.emit(kind === 'text' ? { type: 'text_delta', delta } : { type: 'reasoning_delta', delta });
      await sleep(12);
    }
  }
}

function planFirstStep(task: string): ToolCallBlock {
  const id = `call_demo_${Date.now().toString(36)}`;
  if (/写|创建|新建|write|create/i.test(task)) {
    return {
      type: 'tool_call',
      id,
      name: 'write_file',
      input: {
        path: 'demo-output.md',
        content:
          '# EasyCode 演示输出\n\n这是由 Mock Provider 生成并通过审批后写入的文件。\n\n- 审批模式: ask 时会弹出确认卡片\n- 批准后本文件真实写入（演示模式写入内存文件系统）\n',
      },
    };
  }
  if (/读|read/i.test(task)) {
    return { type: 'tool_call', id, name: 'read_file', input: { path: 'hello.txt' } };
  }
  return { type: 'tool_call', id, name: 'list_dir', input: {} };
}
