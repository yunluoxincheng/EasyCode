import type { AgentEvent } from './events.js';
import type { Host } from './host.js';
import type { ChatMessage, ToolResultMessage } from './types.js';
import type { Provider, StreamRequest } from './providers/index.js';
import { extractToolCalls } from './providers/index.js';
import { ApprovalManager } from './approval.js';
import { executeTool, getToolExecutionOutcome, ToolRegistry } from './tools/index.js';
import { compactHistoryMessages, pruneHistoricalToolResults } from './compaction.js';
import { startDecisionObservation, type DecisionPolicy, type DecisionObservation } from './policy.js';

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

/** 从历史消息中提取已完成的实际操作轨迹（Action Trace），以当前用户回合为边界，绝不混入上一任务且无未来答案泄漏 */
function extractRecentActionTrace(messages: ChatMessage[], maxItems = 4): string[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  const turnMessages = lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : messages;
  const trace: string[] = [];
  for (const m of turnMessages) {
    if (m.role === 'assistant') {
      for (const b of m.blocks) {
        if (b.type === 'tool_call') {
          const input = b.input as Record<string, unknown> | undefined;
          const target = input?.path ?? input?.command ?? input?.query ?? '';
          const targetStr = typeof target === 'string' && target ? `(${target.slice(0, 40)})` : '';
          trace.push(`call: ${b.name}${targetStr}`);
        }
      }
    } else if (m.role === 'tool_result') {
      const isFailed = m.isError || (m.toolName === 'run_command' && /^退出码: (?!0(?:\n|$))/.test(m.content));
      trace.push(`result: ${m.toolName} (${isFailed ? 'error' : 'ok'})`);
    }
  }
  return trace.slice(-maxItems);
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

  let pendingRecoveries: Array<{ observation: DecisionObservation; name: string; input: unknown }> = [];
  let reasoningObs: DecisionObservation | undefined;
  let lastCompletedStep = 0;
  try {
    const readFiles = new Set<string>();
    for (let step = 0; step < maxSteps; step++) {
      lastCompletedStep = step;
      if (signal.aborted) return finish('aborted');

      // 决策点 1：推理深度自适应旁路（TODOS #40 reasoning_effort）
      if (step === 0 && policy) {
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        reasoningObs = startDecisionObservation(policy, {
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
        });
        // 绝不直接把用户配置当做 target！实际动作仅记录事实配置供审计参考，真实标签依据整轮复杂度证据判定
        reasoningObs?.actual({
          description: `User configured effort: ${reasoningEffort || 'default'}`,
        });
      }

      // 决策点 2：工具路由前瞻预测旁路（TODOS #40 tool_routing）
      // 必须在调用 provider.stream 之前执行，绝不泄漏模型已生成的工具调用结果！
      let toolRoutingObs: DecisionObservation | undefined;
      if (policy) {
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        const userPrompt = typeof lastUser?.content === 'string' ? lastUser.content.slice(0, 250) : 'Task in progress';
        const actionTrace = extractRecentActionTrace(messages);
        const lastAction = actionTrace.length > 0 ? actionTrace[actionTrace.length - 1] : 'Task initiated';
        toolRoutingObs = startDecisionObservation(policy, {
          taskFamily: 'tool_routing',
          instruction: 'Predict the most appropriate tool family for the current step.',
          state: {
            summary: `Step ${step + 1}: ${userPrompt}. Last progress: ${lastAction}`,
            history: actionTrace,
          },
          candidates: [
            { id: 'read_inspect', text: 'READ_INSPECT: Read file content or list directory' },
            { id: 'edit_write', text: 'EDIT_WRITE: Edit existing code or write files' },
            { id: 'search_explore', text: 'SEARCH_EXPLORE: Search symbols or regex in project' },
            { id: 'run_command', text: 'RUN_COMMAND: Run shell command or execute tests' },
            { id: 'git_vcs', text: 'GIT_VCS: Check git status or diff changes' },
            { id: 'stop_respond', text: 'STOP_RESPOND: Stop tool calling and respond directly to user' },
          ],
          metadata: { step, completedActionCount: actionTrace.length },
        });
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
      let recoveryFollowup: DecisionObservation | undefined;
      if (pendingRecoveries.length > 0) {
        const first = calls[0];
        const single = pendingRecoveries.length === 1 && calls.length === 1
          ? pendingRecoveries[0] : undefined;
        let selectedId: string | undefined;
        if (single && first) {
          if (first.name === single.name) {
            selectedId = JSON.stringify(first.input) === JSON.stringify(single.input)
              ? 'retry_same' : 'modify_input';
          } else if (['read_file', 'list_dir', 'search_files'].includes(first.name)) {
            selectedId = 'search_dir';
          }
          recoveryFollowup = single.observation;
        }
        for (const pending of pendingRecoveries) {
          pending.observation.actual({
            selectedId: single ? selectedId : undefined,
            description: first
              ? `Next agent tool: ${first.name}${single ? '' : ' (multiple preceding failures)'}`
              : 'Assistant replied without a tool call',
          });
          if (!first || !single) pending.observation.outcome({
            status: 'unknown', evidence: 'No unambiguous recovery tool execution',
          });
        }
        pendingRecoveries = [];
      }

      let toolRoutingFollowup: DecisionObservation | undefined;
      if (toolRoutingObs) {
        if (calls.length === 0) {
          toolRoutingObs.actual({
            selectedId: 'stop_respond',
            description: 'Agent responded directly without calling any tools',
          });
          toolRoutingObs.outcome({
            status: 'success',
            evidence: 'Turn completed without tools',
          });
        } else {
          const actualToolName = calls[0]?.name;
          let mappedRoutingId: string | undefined;
          if (actualToolName === 'read_file' || actualToolName === 'list_dir') mappedRoutingId = 'read_inspect';
          else if (actualToolName === 'write_file' || actualToolName === 'edit_file') mappedRoutingId = 'edit_write';
          else if (actualToolName === 'search_files') mappedRoutingId = 'search_explore';
          else if (actualToolName === 'run_command') mappedRoutingId = 'run_command';
          else if (actualToolName === 'git_status' || actualToolName === 'git_diff') mappedRoutingId = 'git_vcs';

          toolRoutingObs.actual({
            selectedId: mappedRoutingId,
            description: `Agent chose tool: ${actualToolName}`,
          });
          toolRoutingFollowup = toolRoutingObs;
        }
      }

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
        const toolOutcome = getToolExecutionOutcome(call.name, execution);
        if (toolRoutingFollowup && call === calls[0]) {
          toolRoutingFollowup.outcome(toolOutcome);
        }
        if (recoveryFollowup && call === calls[0]) {
          recoveryFollowup.outcome(toolOutcome);
        }

        // 决策点 2：工具执行错误恢复旁路（TODOS #40 recovery）
        if (execution.isError && policy) {
          const observation = startDecisionObservation(policy, {
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
            });
          if (observation) pendingRecoveries.push({ observation, name: call.name, input: call.input });
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
      let contextObservation: DecisionObservation | undefined;
      if (contextWindow && turn.usage?.inputTokens && policy) {
        const ratio = turn.usage.inputTokens / contextWindow;
        contextObservation = startDecisionObservation(policy, {
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
          });
      }

      let contextAction: 'keep' | 'prune_tools' | 'compact_all' = 'keep';
      // 上下文超限保护（TODOS #31）：若本轮输入的 Token 超过设定阈值，触发智能阶梯压缩
      if (
        contextWindow &&
        turn.usage?.inputTokens &&
        turn.usage.inputTokens > contextWindow * autoCompactThreshold
      ) {
        const beforeTokens = turn.usage.inputTokens;
        const compactRes = compactHistoryMessages(messages, { keepRecentTurns: 2, pruneTools: true });
        if (compactRes.compacted) {
          contextAction = 'compact_all';
          messages.splice(0, messages.length, ...compactRes.messages);
          emit({
            type: 'context_compacted',
            beforeTokens,
            summary: `上下文用量已达 ${Math.round((beforeTokens / contextWindow) * 100)}%，已自动归档前序 ${compactRes.discardedTurns} 轮历史并压缩工具长输出。`,
          });
        } else {
          const pruneRes = pruneHistoricalToolResults(messages, { keepRecentTurns: 1 });
          if (pruneRes.modified) {
            contextAction = 'prune_tools';
            emit({
              type: 'context_compacted',
              beforeTokens,
              summary: `上下文用量已达 ${Math.round((beforeTokens / contextWindow) * 100)}%，已压缩历史工具长输出（节省约 ${Math.round(pruneRes.savedChars / 4)} tokens）。`,
            });
          }
        }
      }
      contextObservation?.actual({ selectedId: contextAction, description: `Context rule: ${contextAction}` });
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
    if (reasoningObs) {
      reasoningObs.outcome({
        status: reason === 'completed' ? 'success' : 'failure',
        evidence: `turnSteps:${lastCompletedStep + 1};reason:${reason}`,
      });
    }
    for (const pending of pendingRecoveries) {
      pending.observation.actual({ description: `No follow-up action: ${reason}` });
      pending.observation.outcome({ status: 'unknown', evidence: 'Agent turn ended before recovery' });
    }
    pendingRecoveries = [];
    emit({ type: 'done', reason });
    return errorMessage === undefined ? { reason } : { reason, errorMessage };
  }
}
