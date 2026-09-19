import type { AgentEvent } from './events.js';
import type { Host } from './host.js';
import type { ChatMessage, ToolResultMessage } from './types.js';
import type { Provider, StreamRequest } from './providers/index.js';
import { extractToolCalls } from './providers/index.js';
import { ApprovalManager } from './approval.js';
import { executeTool, ToolRegistry } from './tools/index.js';

export interface LoopOptions {
  provider: Provider;
  tools: ToolRegistry;
  host: Host;
  workspace: string;
  systemPrompt: string;
  /** 会话消息数组，循环会原地追加 assistant / tool_result 消息 */
  messages: ChatMessage[];
  signal: AbortSignal;
  approval: ApprovalManager;
  emit(event: AgentEvent): void;
  maxSteps?: number;
  /** 思考强度（'' = 供应商默认），透传给 Provider */
  reasoningEffort?: string;
}

export interface LoopResult {
  reason: 'completed' | 'aborted' | 'error';
  errorMessage?: string;
}

/**
 * Agent 主循环：流式生成 → 执行工具 → 结果回传，直至模型不再调用工具。
 * 单一轮次入口，由上层（engine 的会话服务）驱动。
 */
export async function runAgentLoop(options: LoopOptions): Promise<LoopResult> {
  const {
    provider,
    tools,
    host,
    workspace,
    systemPrompt,
    messages,
    signal,
    approval,
    emit,
    maxSteps = 25,
    reasoningEffort,
  } = options;

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) return finish('aborted');

      emit({ type: 'assistant_start' });
      const request: StreamRequest = {
        messages,
        tools: tools.listSpecs(),
        system: systemPrompt,
        reasoningEffort: reasoningEffort || undefined,
      };
      const turn = await provider.stream(request, {
        signal,
        emit: (pe) => {
          if (pe.type === 'text_delta') emit({ type: 'text_delta', delta: pe.delta });
          else if (pe.type === 'reasoning_delta')
            emit({ type: 'reasoning_delta', delta: pe.delta });
        },
      });

      messages.push({ role: 'assistant', blocks: turn.blocks });
      emit({ type: 'step_end', usage: turn.usage });

      const calls = extractToolCalls(turn.blocks);
      if (calls.length === 0) {
        return finish('completed');
      }

      for (const call of calls) {
        if (signal.aborted) return finish('aborted');
        emit({ type: 'tool_call_start', call });
        const execution = await executeTool(tools, call.name, call.input, {
          host,
          workspace,
          signal,
          approval,
        });
        emit({
          type: 'tool_result',
          callId: call.id,
          toolName: call.name,
          content: execution.content,
          isError: execution.isError,
          durationMs: execution.durationMs,
        });
        const resultMessage: ToolResultMessage = {
          role: 'tool_result',
          toolCallId: call.id,
          toolName: call.name,
          content: execution.content,
          isError: execution.isError,
        };
        messages.push(resultMessage);
      }
    }
    return finish(
      'error',
      `已达单次任务最大步数（${maxSteps}），已停止。可将任务拆分后继续。`,
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return finish('aborted');
    }
    if (signal.aborted) return finish('aborted');
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: 'error', message });
    return finish('error', message);
  }

  function finish(reason: LoopResult['reason'], errorMessage?: string): LoopResult {
    emit({ type: 'done', reason });
    return errorMessage === undefined ? { reason } : { reason, errorMessage };
  }
}
