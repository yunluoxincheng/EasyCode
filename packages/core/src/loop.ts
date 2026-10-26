import type { AgentEvent } from './events.js';
import type { Host } from './host.js';
import type { ChatMessage, ToolCallBlock, ToolResultMessage } from './types.js';
import type { Provider, StreamRequest } from './providers/index.js';
import { extractToolCalls } from './providers/index.js';
import { ApprovalManager } from './approval.js';
import { executeTool, getToolExecutionOutcome, ToolRegistry, type FileChangeEvent, type ToolExecution } from './tools/index.js';
import { compactHistoryMessages, pruneHistoricalToolResults } from './compaction.js';
import { startDecisionObservation, type DecisionPolicy, type DecisionObservation, type DecisionOutcome } from './policy.js';
import type { PermissionRule } from './permissions.js';
import type { BackgroundTaskManager } from './tasks.js';
import type { UserQuestionManager } from './questions.js';
import type { DelegatedTaskRunner } from './delegation.js';

export interface LoopOptions {
  delegatedTasks?: DelegatedTaskRunner;
  questions?: UserQuestionManager;
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
  /** 宿主注入的请求容量估算；不要求 Provider 返回 usage，core 不依赖分词库。 */
  countContextTokens?: (request: StreamRequest) => Promise<number>;
  keepRecentTurns?: number;
  /** 工作区并发互斥锁（TODOS #29） */
  workspaceLock?: { withLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> };
  /** 决策小模型策略接口（TODOS #40）：用于影子观测或自适应路由 */
  policy?: DecisionPolicy;
  /** 会话级后台任务管理器（TODOS #37）：run_command background 与任务查询/停止工具依赖 */
  backgroundTasks?: BackgroundTaskManager;
  /** 文件写操作完成后的快照回调（TODOS #36）：供上层记录回合级 Pre-edit 快照 */
  onFileChange?: (change: FileChangeEvent) => Promise<void> | void;
  /** 权限规则（TODOS #47）：全局 + 项目级规则并集，命中即优先于审批模式 */
  permissionRules?: PermissionRule[];
  /** 压缩前保留可编辑的原始历史；归档数据不参与模型请求。 */
  onBeforeCompaction?: () => void;
  onMessage?: (message: ChatMessage) => void;
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

/** 提炼纯净的结构化错误事实分类，绝不泄露原始报错日志、环境变量或文件明文 */
export function extractStructuredErrorFact(
  toolName: string,
  content: string,
): { errorCategory: string; exitCode?: number } {
  if (toolName === 'run_command') {
    const exitMatch = /^退出码: (\d+|signal)/.exec(content);
    const code = exitMatch ? (exitMatch[1] === 'signal' ? 137 : parseInt(exitMatch[1], 10)) : undefined;
    if (code === 127 || /command not found|不是内部或外部命令/i.test(content)) {
      return { errorCategory: 'command_not_found', exitCode: code };
    }
    if (/timed? ?out|超时/i.test(content)) {
      return { errorCategory: 'command_timeout', exitCode: code };
    }
    if (/permission denied|拒绝访问|EACCES/i.test(content)) {
      return { errorCategory: 'permission_denied', exitCode: code };
    }
    if (code !== undefined) {
      return { errorCategory: `non_zero_exit_${code}`, exitCode: code };
    }
    return { errorCategory: 'command_execution_failure' };
  }

  if (/ENOENT|no such file|不存在|not found/i.test(content)) {
    return { errorCategory: 'file_or_dir_not_found' };
  }
  if (/EACCES|permission denied|拒绝访问/i.test(content)) {
    return { errorCategory: 'permission_denied' };
  }
  if (/EEXIST|already exists|已存在/i.test(content)) {
    return { errorCategory: 'target_already_exists' };
  }
  if (/parse error|syntax error|语法错误/i.test(content)) {
    return { errorCategory: 'content_syntax_error' };
  }
  return { errorCategory: 'tool_execution_exception' };
}

/**
 * Agent 主循环：流式生成 → 执行工具 → 结果回传，直至模型不再调用工具。
 * 单一轮次入口，由上层（engine 的会话服务）驱动。
 */
export async function runAgentLoop(options: LoopOptions): Promise<LoopResult> {
  const {
    delegatedTasks,
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
    countContextTokens,
    keepRecentTurns = 2,
    workspaceLock,
    policy,
    backgroundTasks,
    onFileChange,
    permissionRules,
    questions,
    onBeforeCompaction,
    onMessage,
  } = options;

  let pendingRecoveries: Array<{ observation: DecisionObservation; name: string; input: unknown }> = [];
  let reasoningObs: DecisionObservation | undefined;
  let lastCompletedStep = 0;
  let activeCalls: ToolCallBlock[] = [];
  let settledCalls = new Set<ToolCallBlock>();
  try {
    const readFiles = new Set<string>();
    for (let step = 0; step < maxSteps; step++) {
      lastCompletedStep = step;
      if (signal.aborted) return finish('aborted');

      // 在发出请求之前核对容量，覆盖纯文本会话、首次请求和缺少 usage 的网关。
      if (contextWindow && countContextTokens) {
        const tokens = await countContextTokens({ messages, system: systemPrompt, tools: tools.listSpecs() });
        if (signal.aborted) return finish('aborted');
        await compactContext(tokens, true);
      }

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
      if (signal.aborted) return finish('aborted');
      const request: StreamRequest = {
        messages,
        tools: tools.listSpecs(),
        system: systemPrompt,
        reasoningEffort: reasoningEffort || undefined,
      };
      let streaming = true;
      let turn: Awaited<ReturnType<Provider['stream']>>;
      try {
        turn = await provider.stream(request, {
          signal,
          emit: (pe) => {
            if (!streaming || signal.aborted) return;
            if (pe.type === 'text_delta') emit({ type: 'text_delta', delta: pe.delta });
            else if (pe.type === 'reasoning_delta')
              emit({ type: 'reasoning_delta', delta: pe.delta });
            else if (pe.type === 'tool_call_preparing') emit(pe);
          },
        });
      } finally {
        streaming = false;
      }

      if (signal.aborted) return finish('aborted');
      const assistantMessage = stamp({ role: 'assistant', blocks: turn.blocks });
      messages.push(assistantMessage);
      const calls = extractToolCalls(turn.blocks);
      activeCalls = calls;
      settledCalls = new Set();
      onMessage?.(assistantMessage);
      emit({ type: 'step_end', usage: turn.usage });

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
        await compactContext(turn.usage?.inputTokens ?? 0);
        return finish('completed');
      }

      // 注册工具声明交互边界；不能证明同批预生成调用独立，边界前后的调用均暂不执行。
      const boundary = calls.find((call) => tools.get(call.name)?.interactionBoundary);
      // 先明确撤销其余调用，再等待交互；等待期间的回读也不能把旧计划当作已执行。
      const executionCalls = boundary ? [...calls.filter((call) => call !== boundary), boundary] : calls;
      for (const call of executionCalls) {
        emit({ type: 'tool_call_start', call });
        if (signal.aborted || (boundary && call !== boundary)) {
          recordToolResult(call, unexecuted(signal.aborted
            ? '当前回合已停止，本调用未执行。'
            : '本批次存在用户交互，本调用未执行。请先读取交互结果，再根据实际回答重新规划并生成新的工具参数。'));
          if (call === calls[0]) {
            const outcome: DecisionOutcome = { status: 'unknown', evidence: 'Tool batch interrupted or deferred at interaction boundary' };
            toolRoutingFollowup?.outcome(outcome);
            recoveryFollowup?.outcome(outcome);
          }
          continue;
        }
        const execution = await executeTool(tools, call.name, call.input, {
          delegatedTasks,
          questions,
          host,
          workspace,
          signal,
          approval,
          readFiles,
          shell,
          workspaceLock,
          policy,
          backgroundTasks,
          callId: call.id,
          messageId: assistantMessage.id,
          onFileChange,
          permissionRules,
          onExecutionStart: () => emit({ type: 'tool_execution_start', callId: call.id }),
        });
        if (signal.aborted) {
          // 保留实际执行许可与计时，但停止后的迟到结果不能进入后续模型上下文。
          recordToolResult(call, { ...execution, isError: true, content: '当前回合已停止，本调用的迟到结果未提交。' });
          return finish('aborted');
        }
        const toolOutcome = getToolExecutionOutcome(call.name, execution);
        if (toolRoutingFollowup && call === calls[0]) {
          toolRoutingFollowup.outcome(toolOutcome);
        }
        if (recoveryFollowup && call === calls[0]) {
          recoveryFollowup.outcome(toolOutcome);
        }

        // 决策点 2：工具执行错误恢复旁路（TODOS #40 recovery）
        // 提炼纯净的结构化错误事实分类，为模型自愈提供区分度，同时物理隔离原始日志防止泄密
        if (execution.isError && policy) {
          const errFact = extractStructuredErrorFact(call.name, execution.content);
          const observation = startDecisionObservation(policy, {
              taskFamily: 'recovery',
              instruction: 'Decide the best recovery strategy after tool execution failure.',
              state: {
                summary: `Tool '${call.name}' failed: ${errFact.errorCategory}`,
                history: [call.name],
              },
              candidates: [
                { id: 'retry_same', text: 'Retry the exact same command or input' },
                { id: 'modify_input', text: 'Modify arguments or input parameters before retrying' },
                { id: 'search_dir', text: 'Search directory or read other files to locate missing context' },
                { id: 'ask_user', text: 'Ask user for clarification or instructions' },
                { id: 'stop', text: 'Stop execution and report error' },
              ],
              metadata: {
                toolName: call.name,
                errorCategory: errFact.errorCategory,
                exitCode: errFact.exitCode,
              },
            });
          if (observation) pendingRecoveries.push({ observation, name: call.name, input: call.input });
        }

        recordToolResult(call, execution);
      }
      if (signal.aborted) return finish('aborted');

      await compactContext(turn.usage?.inputTokens ?? 0);
    }
    return finish(
      'error',
      `已达单次任务最大步数（${maxSteps}），已停止。可将任务拆分后继续。`,
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return finish('aborted');
    }
    if (signal.aborted && !(err instanceof Error && err.name === 'ProcessStopError')) return finish('aborted');
    const message = err instanceof Error ? err.message : String(err);
    return finish('error', message);
  }

  async function compactContext(inputTokens: number, estimated = false): Promise<void> {
      // 决策点 3：上下文压缩前瞻旁路（TODOS #40 context_management）
      let contextObservation: DecisionObservation | undefined;
      if (contextWindow && inputTokens && policy) {
        const ratio = inputTokens / contextWindow;
        contextObservation = startDecisionObservation(policy, {
            taskFamily: 'context_management',
            instruction: 'Decide whether to prune or compact context history.',
            state: {
              summary: `Current token usage: ${inputTokens}/${contextWindow} (${Math.round(ratio * 100)}%)`,
              history: messages.slice(-2).map((m) => m.role),
            },
            candidates: [
              { id: 'keep', text: 'Keep current history as is' },
              { id: 'prune_tools', text: 'Prune historical tool outputs only' },
              { id: 'compact_all', text: 'Compact early history messages into summary' },
            ],
            metadata: { inputTokens, contextWindow, ratio, estimated },
          });
      }

      let contextAction: 'keep' | 'prune_tools' | 'compact_all' = 'keep';
      // 上下文超限保护（TODOS #31）：若本轮输入的 Token 超过设定阈值，触发智能阶梯压缩
      if (
        contextWindow &&
        inputTokens >= contextWindow * autoCompactThreshold
      ) {
        const beforeTokens = inputTokens;
        const countedBefore = countContextTokens
          ? await countContextTokens({ messages, system: systemPrompt, tools: tools.listSpecs() }) : undefined;
        const savesTokens = async (candidate: ChatMessage[]) => {
          if (JSON.stringify(candidate) === JSON.stringify(messages)) return false;
          return !countContextTokens || await countContextTokens({ messages: candidate, system: systemPrompt, tools: tools.listSpecs() }) < countedBefore!;
        };
        const candidate = structuredClone(messages);
        // 自动压缩保留配置轮数内的完整消息；工具裁剪同样只能发生在保护范围之外。
        const compactRes = compactHistoryMessages(candidate, { keepRecentTurns, pruneTools: false });
        const compactSaves = await savesTokens(compactRes.messages);
        if (signal.aborted) return;
        // compacted=false 时也可能已裁剪工具输出，按实际内容提交并保留原文。
        if (compactSaves) {
          onBeforeCompaction?.();
          contextAction = compactRes.compacted ? 'compact_all' : 'prune_tools';
          messages.splice(0, messages.length, ...compactRes.messages);
          emit({
            type: 'context_compacted',
            beforeTokens,
            summary: `上下文${estimated ? '本地估算' : '上次请求用量'}达 ${Math.round((beforeTokens / contextWindow) * 100)}%，${compactRes.compacted ? `已自动归档前序 ${compactRes.discardedTurns} 轮历史并压缩工具长输出` : '已自动裁剪历史工具长输出'}。`,
          });
        } else {
          const fallback = structuredClone(messages);
          const pruneRes = pruneHistoricalToolResults(fallback, { keepRecentTurns });
          if (pruneRes.modified && await savesTokens(fallback) && !signal.aborted) {
            onBeforeCompaction?.();
            messages.splice(0, messages.length, ...fallback);
            contextAction = 'prune_tools';
            emit({
              type: 'context_compacted',
              beforeTokens,
              summary: `上下文用量已达 ${Math.round((beforeTokens / contextWindow) * 100)}%，已压缩保护轮数以外的历史工具长输出。`,
            });
          }
        }
      }
      contextObservation?.actual({ selectedId: contextAction, description: `Context rule: ${contextAction}` });
  }

  function finish(reason: LoopResult['reason'], errorMessage?: string): LoopResult {
    // 中止或异常也为本批每个调用保留结果，不给 Provider 留下悬空 ID。
    for (const call of activeCalls) {
      if (!settledCalls.has(call)) recordToolResult(call, unexecuted('当前回合已结束，本调用未获得完成结果，已中断；请勿将此结果视为执行成功。'));
    }
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
    // 所有循环错误统一在收尾时派发，包括未抛异常的步数耗尽；宿主只转发该事件。
    if (reason === 'error' && errorMessage !== undefined) emit({ type: 'error', message: errorMessage });
    emit({ type: 'done', reason });
    return errorMessage === undefined ? { reason } : { reason, errorMessage };
  }

  function unexecuted(content: string): ToolExecution {
    return { content, approved: false, isError: true, durationMs: 0, timing: { approvalMs: 0 } };
  }

  function recordToolResult(call: ToolCallBlock, execution: ToolExecution): void {
    const resultMessage: ToolResultMessage = {
      role: 'tool_result', toolCallId: call.id, toolName: call.name,
      content: execution.content, isError: execution.isError, approved: execution.approved,
    };
    const stampedResult = stamp(resultMessage);
    messages.push(stampedResult);
    settledCalls.add(call);
    onMessage?.(stampedResult);
    emit({ type: 'tool_result', callId: call.id, toolName: call.name, ...execution });
  }
}
