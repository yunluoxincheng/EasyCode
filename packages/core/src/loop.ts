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
  try {
    const readFiles = new Set<string>();
    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) return finish('aborted');

      // 决策点 1：推理深度自适应旁路（TODOS #40 reasoning_effort）
      if (step === 0 && policy) {
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        const observation = startDecisionObservation(policy, {
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
        const selectedId = reasoningEffort === 'low' || reasoningEffort === 'fast'
          ? 'fast' : reasoningEffort === 'medium' ? 'medium'
          : reasoningEffort === 'high' ? 'high' : undefined;
        observation?.actual({
          selectedId,
          description: selectedId ? `Configured request effort: ${reasoningEffort}` : 'Provider default or unsupported effort',
        });
      }

      // 决策点 5：信息充分性判断旁路（TODOS #40 information_sufficiency）
      let infoObservation: DecisionObservation | undefined;
      if (policy) {
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        infoObservation = startDecisionObservation(policy, {
          taskFamily: 'information_sufficiency',
          instruction: 'Assess whether the current context information is sufficient to proceed.',
          state: {
            summary:
              typeof lastUser?.content === 'string'
                ? lastUser.content.slice(0, 300)
                : 'Task in progress',
            history: messages.slice(-3).map((m) => m.role),
          },
          candidates: [
            { id: 'proceed', text: 'PROCEED: Information is sufficient, proceed with action' },
            { id: 'read_more', text: 'READ_MORE: Need to inspect more files or details' },
            { id: 'search', text: 'SEARCH: Need to search codebase for missing context' },
            { id: 'ask_user', text: 'ASK_USER: Requirement is ambiguous, need user clarification' },
          ],
          metadata: { step },
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

      if (infoObservation) {
        let actualInfo = 'proceed';
        if (calls.length > 0) {
          const fn = calls[0].name;
          if (fn === 'read_file' || fn === 'list_dir') actualInfo = 'read_more';
          else if (fn === 'search_files') actualInfo = 'search';
          else actualInfo = 'proceed';
        } else {
          const text = turn.blocks.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join(' ');
          actualInfo = /[?？]/.test(text) ? 'ask_user' : 'proceed';
        }
        infoObservation.actual({
          selectedId: actualInfo,
          description: calls.length > 0 ? `Agent invoked ${calls[0].name}` : `Agent replied (${actualInfo})`,
        });
      }

      // 决策点 8：工具路由预测旁路（TODOS #40 tool_routing）
      if (policy && calls.length > 0) {
        const textParts = turn.blocks
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join(' ');
        const toolObs = startDecisionObservation(policy, {
          taskFamily: 'tool_routing',
          instruction: 'Predict the most appropriate tool family for the current step.',
          state: {
            summary:
              textParts.slice(0, 300) ||
              `Planned tools: ${calls.map((c) => c.name).join(', ')}`,
            history: calls.map((c) => c.name),
          },
          candidates: [
            { id: 'read_inspect', text: 'READ_INSPECT: Read file content or list directory' },
            { id: 'edit_write', text: 'EDIT_WRITE: Edit existing code or write files' },
            { id: 'search_explore', text: 'SEARCH_EXPLORE: Search symbols or regex in project' },
            { id: 'run_command', text: 'RUN_COMMAND: Run shell command or execute tests' },
            { id: 'git_vcs', text: 'GIT_VCS: Check git status or diff changes' },
            { id: 'stop_respond', text: 'STOP_RESPOND: Stop tool calling and respond to user' },
          ],
          metadata: { actualTool: calls[0]?.name, totalCalls: calls.length },
        });

        const actualToolName = calls[0]?.name;
        let mappedRoutingId: string | undefined;
        if (actualToolName === 'read_file' || actualToolName === 'list_dir') mappedRoutingId = 'read_inspect';
        else if (actualToolName === 'write_file' || actualToolName === 'edit_file') mappedRoutingId = 'edit_write';
        else if (actualToolName === 'search_files') mappedRoutingId = 'search_explore';
        else if (actualToolName === 'run_command') mappedRoutingId = 'run_command';
        else if (actualToolName === 'git_status' || actualToolName === 'git_diff') mappedRoutingId = 'git_vcs';

        toolObs?.actual({
          selectedId: mappedRoutingId,
          description: `First tool call: ${actualToolName}`,
        });
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
        if (recoveryFollowup && call === calls[0]) {
          recoveryFollowup.outcome(getToolExecutionOutcome(call.name, execution));
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

        // 决策点 6：代码变更验证手段旁路（TODOS #40 verification）
        if (
          !execution.isError &&
          (call.name === 'edit_file' || call.name === 'write_file') &&
          policy
        ) {
          const verifyObs = startDecisionObservation(policy, {
            taskFamily: 'verification',
            instruction:
              'Choose the most effective verification method for the recent code changes.',
            state: {
              summary: `Modified file via '${call.name}'. Workspace: ${workspace}`,
              history: [call.name],
            },
            candidates: [
              { id: 'run_test', text: 'RUN_TEST: Run automated unit/integration tests' },
              { id: 'run_build', text: 'RUN_BUILD: Run project build or compile check' },
              { id: 'inspect_diff', text: 'INSPECT_DIFF: Inspect git diff of modified lines' },
              {
                id: 'no_verify',
                text: 'NO_VERIFY: Pure documentation or minor tweak, skip verification',
              },
            ],
            metadata: { toolName: call.name, input: call.input },
          });
          verifyObs?.actual({
            description: `File modified via ${call.name}; observe follow-up verification`,
          });
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
    for (const pending of pendingRecoveries) {
      pending.observation.actual({ description: `No follow-up action: ${reason}` });
      pending.observation.outcome({ status: 'unknown', evidence: 'Agent turn ended before recovery' });
    }
    pendingRecoveries = [];
    emit({ type: 'done', reason });
    return errorMessage === undefined ? { reason } : { reason, errorMessage };
  }
}
