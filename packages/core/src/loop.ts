import type { AgentEvent } from './events.js';
import type { Host } from './host.js';
import type { ChatMessage, ToolResultMessage } from './types.js';
import type { Provider, StreamRequest } from './providers/index.js';
import { extractToolCalls } from './providers/index.js';
import { ApprovalManager } from './approval.js';
import { executeTool, ToolRegistry } from './tools/index.js';
import { compactHistoryMessages, pruneHistoricalToolResults } from './compaction.js';
import type { DecisionPolicy } from './policy.js';

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
  /** 命令行终端 Shell：auto=自动选择，也可指定 git-bash / pwsh / powershell / cmd */
  shell?: string;
  /** 模型上下文容量上限（Token），用于在多步循环中超限自动压缩 */
  contextWindow?: number;
  /** 上下文自动压缩触发阈值（默认 0.85 即 85%） */
  autoCompactThreshold?: number;
  /** 工作区并发互斥锁（TODOS #29） */
  workspaceLock?: { withLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> };
  /** 决策小模型策略接口（TODOS #40）：用于影子观测或自适应路由 */
  policy?: DecisionPolicy;
}

export interface LoopResult {
  reason: 'completed' | 'aborted' | 'error';
  errorMessage?: string;
}

/** 为消息补 id/createdAt（UI 锚点与回合分组用；wire 格式会忽略这些字段） */
function stamp(
  msg: ChatMessage & { id?: string; createdAt?: string },
): ChatMessage & { id?: string; createdAt?: string } {
  return {
    ...msg,
    id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  };
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
    maxSteps = 200,
    reasoningEffort,
    shell,
    contextWindow,
    autoCompactThreshold = 0.85,
    workspaceLock,
    policy,
  } = options;

  try {
    const readFiles = new Set<string>();
    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) return finish('aborted');

      // 决策点 1：推理深度自适应旁路（TODOS #40 reasoning_effort）
      if (step === 0 && policy) {
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        void policy
          .decide({
            taskFamily: 'reasoning_effort',
            instruction: 'Choose the appropriate reasoning effort for the current task.',
            state: {
              summary:
                typeof lastUser?.content === 'string'
                  ? lastUser.content.slice(0, 300)
                  : 'Task started',
            },
            candidates: [
              { id: 'fast', text: 'FAST: Low computation for simple edits and queries' },
              { id: 'medium', text: 'MEDIUM: Standard reasoning for typical bugs and features' },
              { id: 'high', text: 'HIGH: Extended reasoning for complex architecture and deep logic' },
            ],
          })
          .catch(() => {});
      }

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

      messages.push(stamp({ role: 'assistant', blocks: turn.blocks }));
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
          readFiles,
          shell,
          workspaceLock,
          policy,
        });

        // 决策点 2：工具执行错误恢复旁路（TODOS #40 recovery）
        if (execution.isError && policy) {
          void policy
            .decide({
              taskFamily: 'recovery',
              instruction: 'Decide the best recovery strategy after tool execution failure.',
              state: {
                summary: `Tool '${call.name}' failed with output: ${execution.content.slice(0, 250)}`,
                history: [call.name],
              },
              candidates: [
                { id: 'retry_same', text: 'Retry the exact same command or input' },
                { id: 'modify_input', text: 'Modify arguments or input parameters before retrying' },
                { id: 'search_dir', text: 'Search directory or read other files to locate missing context' },
                { id: 'ask_user', text: 'Ask user for clarification or instructions' },
                { id: 'stop', text: 'Stop execution and report error' },
              ],
              metadata: { toolName: call.name, content: execution.content },
            })
            .catch(() => {});
        }

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
        messages.push(stamp(resultMessage));
      }

      // 决策点 3：上下文压缩前瞻旁路（TODOS #40 context_management）
      if (contextWindow && turn.usage?.inputTokens && policy) {
        const ratio = turn.usage.inputTokens / contextWindow;
        void policy
          .decide({
            taskFamily: 'context_management',
            instruction: 'Decide whether to prune or compact context history.',
            state: {
              summary: `Current token usage: ${turn.usage.inputTokens}/${contextWindow} (${Math.round(ratio * 100)}%)`,
              history: messages.slice(-2).map((m) => m.role),
            },
            candidates: [
              { id: 'keep', text: 'Keep current history as is' },
              { id: 'prune_tools', text: 'Prune historical tool outputs only' },
              { id: 'compact_all', text: 'Compact early history messages into summary' },
            ],
            metadata: { inputTokens: turn.usage.inputTokens, contextWindow, ratio },
          })
          .catch(() => {});
      }

      // 上下文超限保护（TODOS #31）：若本轮输入的 Token 超过设定阈值，触发智能阶梯压缩
      if (
        contextWindow &&
        turn.usage?.inputTokens &&
        turn.usage.inputTokens > contextWindow * autoCompactThreshold
      ) {
        const beforeTokens = turn.usage.inputTokens;
        const compactRes = compactHistoryMessages(messages, { keepRecentTurns: 2, pruneTools: true });
        if (compactRes.compacted) {
          messages.splice(0, messages.length, ...compactRes.messages);
          emit({
            type: 'context_compacted',
            beforeTokens,
            summary: `上下文用量已达 ${Math.round((beforeTokens / contextWindow) * 100)}%，已自动归档前序 ${compactRes.discardedTurns} 轮历史并压缩工具长输出。`,
          });
        } else {
          const pruneRes = pruneHistoricalToolResults(messages, { keepRecentTurns: 1 });
          if (pruneRes.modified) {
            emit({
              type: 'context_compacted',
              beforeTokens,
              summary: `上下文用量已达 ${Math.round((beforeTokens / contextWindow) * 100)}%，已压缩历史工具长输出（节省约 ${Math.round(pruneRes.savedChars / 4)} tokens）。`,
            });
          }
        }
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
