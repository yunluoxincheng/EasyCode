import type { Host } from '../host.js';
import { validateToolInput, type JsonSchema, type ValidationResult } from '../jsonschema.js';
import type { ApprovalManager } from '../approval.js';
import { startDecisionObservation, type DecisionPolicy, type DecisionOutcome } from '../policy.js';
import {
  describeCommandParseRisk,
  describePermissionRule,
  evaluatePermission,
  normalizeShellCommand,
  PATH_PATTERN_TOOLS,
  resolveApprovalRequirement,
  resolveWorkspaceRelative,
  type PermissionRule,
} from '../permissions.js';
import { resolveRealPathInWorkspace, sameAbsolutePath } from '../path-guard.js';
import type { BackgroundTaskManager } from '../tasks.js';
import { readFileTool, writeFileTool, editFileTool, listDirTool } from './fs.js';
import { searchFilesTool } from './search.js';
import { runCommandTool } from './shell.js';
import { readTaskLogsTool, stopTaskTool } from './tasks.js';
import { todoWriteTool } from './todo.js';
import { askUserTool } from './questions.js';
import type { UserQuestionManager } from '../questions.js';
import { createWebSearchTool, type WebSearchBackendConfig } from './websearch.js';
import {
  gitStatusTool,
  gitDiffTool,
  getGitStatus,
  getGitDiff,
  stageGitFiles,
  discardGitChanges,
  type GitStatusSummary,
  type GitFileChange,
  type GitDiffResult,
} from './git.js';

export { todoWriteTool } from './todo.js';
export { readTaskLogsTool, stopTaskTool } from './tasks.js';
export { createWebSearchTool, runWebSearch } from './websearch.js';
export type { WebSearchBackendConfig, SearchHit } from './websearch.js';
export {
  gitStatusTool,
  gitDiffTool,
  getGitStatus,
  getGitDiff,
  stageGitFiles,
  discardGitChanges,
};
export type { GitStatusSummary, GitFileChange, GitDiffResult };

/** 工具暴露给模型的规格 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface FileChangeEvent {
  callId?: string;
  relPath: string;
  absPath: string;
  existedBefore: boolean;
  beforeContent: string | null;
  afterContent: string;
}

export interface ToolContext {
  questions?: UserQuestionManager;
  host: Host;
  workspace: string;
  signal: AbortSignal;
  /** 本轮已成功读取的文件绝对路径集合；edit_file / 覆盖已有文件的 write_file 强制先读（防盲改） */
  readFiles?: Set<string>;
  /** 命令行终端 Shell：auto=自动选择，也可指定 git-bash / pwsh / powershell / cmd */
  shell?: string;
  /** 工作区并发互斥锁（TODOS #29）：同工作区多会话并发时，敏感工具（写文件/终端命令）排队执行 */
  workspaceLock?: { withLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> };
  /** 决策小模型策略接口（TODOS #40）：用于敏感风控评估或影子记录 */
  policy?: DecisionPolicy;
  /** 后台任务管理器（TODOS #37）：run_command background / read_task_logs / stop_task 依赖 */
  backgroundTasks?: BackgroundTaskManager;
  /** 当前工具调用 ID（用于关联回合快照，TODOS #36） */
  callId?: string;
  /** 文件写操作完成后的快照回调（TODOS #36）：携带写前原始内容与写后新内容 */
  onFileChange?: (change: FileChangeEvent) => Promise<void> | void;
  /** 权限规则（TODOS #47）：全局 + 项目级规则的并集，命中即优先于审批模式生效 */
  permissionRules?: PermissionRule[];
  /** 守卫/审批及排队结束，实际工具函数运行前通知。 */
  onExecutionStart?: () => void;
}

export interface Tool {
  spec: ToolSpec;
  /** 外部注册工具可注入标准校验器；不改变内置工具的轻量参数契约。 */
  validateInput?: (input: unknown) => ValidationResult<Record<string, unknown>>;
  /** 敏感操作在 ask 模式下需用户批准 */
  sensitive?: boolean;
  /** 是否依赖工作区（默认 true）；false 则未绑定项目的会话也可执行（如联网搜索） */
  requiresWorkspace?: boolean;
  execute(input: unknown, ctx: ToolContext): Promise<string>;
}

/** 工具注册表：扩展点之一，新增工具 = register 一次，核心代码零改动 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): this {
    if (this.tools.has(tool.spec.name)) {
      throw new Error(`工具重复注册: ${tool.spec.name}`);
    }
    this.tools.set(tool.spec.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  listSpecs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }

  isSensitive(name: string): boolean {
    return this.tools.get(name)?.sensitive ?? false;
  }
}

/**
 * 内置工具集（文件读写/编辑/列目录/搜索/命令）。宿主能力在 execute 时注入。
 * 传入 webSearch 配置时额外注册联网搜索工具（给不支持原生搜索的模型）。
 */
export function createBuiltinTools(options?: {
  webSearch?: WebSearchBackendConfig;
}): ToolRegistry {
  const registry = new ToolRegistry();
  registry
    .register(readFileTool)
    .register(writeFileTool)
    .register(editFileTool)
    .register(listDirTool)
    .register(searchFilesTool)
    .register(runCommandTool)
    .register(readTaskLogsTool)
    .register(stopTaskTool)
    .register(todoWriteTool)
    .register(askUserTool)
    .register(gitStatusTool)
    .register(gitDiffTool);
  if (options?.webSearch) registry.register(createWebSearchTool(options.webSearch));
  return registry;
}

/** 把模型给的工作区相对路径解析为绝对路径，并强制限制在工作区内 */
export function resolveWorkspacePath(
  workspace: string,
  relative: string,
  host: Host,
): string {
  const root = host.paths.resolve(workspace);
  // 与权限规则共用同一套解析入口（TODOS #47 审查返工）：
  // 包含性校验/大小写语义只实现一次，避免「权限层认为越界、文件层却能访问」的语义漂移
  const rel = resolveWorkspaceRelative(workspace, relative, host.paths);
  if (rel === null) {
    throw new Error(`路径越界: ${relative} 不在工作区 ${root} 内`);
  }
  return host.paths.isAbsolute(relative)
    ? host.paths.resolve(relative)
    : host.paths.resolve(workspace, relative);
}

export interface ToolExecution {
  content: string;
  approved: boolean;
  isError: boolean;
  durationMs: number;
  /** executionMs 缺省表示工具函数未运行，0 则表示已运行但不足 1ms。 */
  timing?: { approvalMs: number; executionMs?: number };
}

/** 固定安全 Shell 动词白名单，未识别动词一律收敛至 shell_other，绝不透传私有文本 */
const KNOWN_SHELL_VERBS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'npx', 'cargo', 'rustc', 'go', 'python', 'python3', 'pip',
  'node', 'deno', 'bun', 'tsc', 'make', 'cmake', 'docker', 'kubectl',
  'cat', 'head', 'tail', 'less', 'ls', 'dir', 'echo', 'grep', 'find', 'curl', 'wget',
  'rm', 'del', 'erase', 'mkdir', 'rmdir', 'cp', 'copy', 'mv', 'move', 'chmod', 'chown',
  'kill', 'pkill', 'taskkill', 'ps', 'tar', 'zip', 'unzip', 'sed', 'awk',
]);

/** 常见文本与代码扩展名白名单 */
const KNOWN_FILE_EXTS = new Set([
  'ts', 'js', 'tsx', 'jsx', 'json', 'md', 'css', 'html', 'py', 'rs', 'go',
  'java', 'c', 'cpp', 'h', 'hpp', 'toml', 'yaml', 'yml', 'sh', 'bash', 'txt', 'xml', 'sql',
]);

/** 从敏感操作输入中提取纯净的结构化操作类别事实，绝不暴露具体参数、路径或命令内容 */
export function extractStructuredOperationFact(name: string, rawInput: unknown): { operationCategory: string; targetExt?: string } {
  const input = typeof rawInput === 'object' && rawInput !== null ? (rawInput as Record<string, unknown>) : {};
  if (name === 'run_command') {
    // 命令归一化（剥离环境变量前缀、解包 shell 包装）与权限规则共用同一实现，
    // 杜绝两套归一化规则漂移（TODOS #40 / #47）
    const cmd = normalizeShellCommand(input.command);
    // 提取首词并严格校验白名单，非白名单一律归为 shell_other
    const verbMatch = /^[a-zA-Z0-9_-]+/.exec(cmd);
    const rawVerb = verbMatch ? verbMatch[0].toLowerCase() : '';
    const rootVerb = KNOWN_SHELL_VERBS.has(rawVerb) ? rawVerb : 'other';
    return { operationCategory: `shell_${rootVerb}` };
  }
  if (name === 'write_file' || name === 'edit_file') {
    const p = typeof input.path === 'string' ? input.path.trim() : '';
    const extMatch = /\.([a-zA-Z0-9]+)$/.exec(p);
    const rawExt = extMatch ? extMatch[1].toLowerCase() : '';
    const ext = KNOWN_FILE_EXTS.has(rawExt) ? rawExt : 'other';
    const isConfig = /(?:config|rc|json|ya?ml|toml|env|lock)$/i.test(p);
    return { operationCategory: `fs_${name}_${ext}${isConfig ? '_cfg' : ''}`, targetExt: ext };
  }
  return { operationCategory: `tool_${name}` };
}

/** 只判断工具调用本身的可观测结果，不推断整个 Agent 任务是否成功。 */
export function getToolExecutionOutcome(name: string, execution: ToolExecution): DecisionOutcome {
  if (!execution.approved) return { status: 'unknown', evidence: 'Tool was not executed' };
  if (execution.isError) return { status: 'failure', evidence: 'Tool execution failed' };
  if (name === 'run_command') {
    const exit = /^退出码: (\d+|signal)(?:\n|$)/.exec(execution.content)?.[1];
    if (!exit) return { status: 'unknown', evidence: 'Command exit code unavailable' };
    return {
      status: exit === '0' ? 'success' : 'failure',
      evidence: `Command exit code: ${exit}`,
    };
  }
  return { status: 'success', evidence: 'Tool call completed without exception' };
}

/** 工具执行管线：校验 → 审批 → 执行 → 统一错误捕获 */
export async function executeTool(
  registry: ToolRegistry,
  name: string,
  rawInput: unknown,
  ctx: ToolContext & { approval: ApprovalManager },
): Promise<ToolExecution & { timing: NonNullable<ToolExecution['timing']> }> {
  const started = Date.now();
  const timing: NonNullable<ToolExecution['timing']> = { approvalMs: 0 };
  const tool = registry.get(name);
  ctx.signal.throwIfAborted();
  if (!tool) {
    return { content: `未知工具: ${name}`, approved: false, isError: true, durationMs: 0, timing };
  }
  if (!ctx.workspace && tool.requiresWorkspace !== false) {
    return {
      content: '当前会话未绑定工作区，文件与命令工具不可用。请让用户在聊天输入区点击「＋ 绑定项目」选择一个文件夹后重试。',
      approved: true,
      isError: true,
      durationMs: 0,
      timing,
    };
  }
  const validated = tool.validateInput ? tool.validateInput(rawInput) : validateToolInput(rawInput, tool.spec.parameters);
  if (!validated.ok) {
    return {
      content: `参数校验失败: ${validated.error}`,
      approved: false,
      isError: true,
      durationMs: 0,
      timing,
    };
  }
  // 真实路径守卫（TODOS #47 第三轮复审 P1）：`paths.resolve()` 只做词法归一化，
  // 不识别符号链接。工作区内 `public/key.txt -> ../private/key.txt` 这类别名会让
  // 针对 `private/**` 的 deny 规则静默失效；指向工作区外部的 symlink 还会绕过
  // 词法 containment。因此文件路径类工具在裁决前必须取得真实目标：
  // 已存在目标消解全部链接，新建文件则校验其最近存在的父目录。
  let permissionInput = validated.value;
  /** 文件类工具经校验后的「真实相对路径」——实际执行必须用它，否则会出现检查/使用不一致 */
  let verifiedRelative: string | undefined;
  /**
   * 经校验的**真实绝对路径**。必须与相对路径一起记下：
   * 若工作区根本身是符号链接，审批期间整个工作区被指向另一个项目时，
   * 两个不同项目里的同名文件会得到相同的 `realRelative`（都是 `config.txt`），
   * 只比较相对路径会漏判（PR #9 第六轮复审 P1）。
   */
  let verifiedAbsolute: string | undefined;
  let rawPathForRecheck: string | undefined;
  if (PATH_PATTERN_TOOLS.has(name) && ctx.workspace) {
    const args = validated.value as Record<string, unknown>;
    const rawPath = typeof args.path === 'string' ? args.path.trim() : '.';
    const real = await resolveRealPathInWorkspace(ctx.host, ctx.workspace, rawPath, ctx.host.paths);
    if (!real.ok) {
      // 无法安全解析时保守拒绝，绝不退化成「当作安全」
      return {
        content:
          `${real.message}。请改用工作区内的普通路径重试；` +
          '若确需访问该位置，请让用户把它纳入工作区或调整权限规则。',
        approved: false,
        isError: false,
        durationMs: Date.now() - started,
        timing,
      };
    }
    // 用真实相对路径参与裁决：别名路径也会命中针对真实目标的规则
    permissionInput = { ...args, path: real.value.realRelative };
    verifiedRelative = real.value.realRelative;
    verifiedAbsolute = real.value.realPath;
    rawPathForRecheck = rawPath;
  }
  // 权限规则裁决（TODOS #47）：deny 直接拒绝、ask 强制审批、allow 免审批；
  // 无规则命中时保持既有「敏感工具在 ask 模式下审批」语义
  const permission = evaluatePermission(
    ctx.permissionRules,
    name,
    permissionInput,
    ctx.workspace,
    ctx.host.paths,
  );
  if (permission?.decision === 'deny') {
    return {
      content:
        `权限规则拒绝执行本次调用（命中 ${describePermissionRule(permission.rule)}）。` +
        '请不要重复尝试同一操作：改用其他方式完成任务，或请用户在设置页「权限规则」中调整该规则。',
      approved: false,
      isError: false,
      durationMs: Date.now() - started,
      timing,
    };
  }
  // 敏感操作语义安全风险评估旁路（TODOS #40 Safety）
  // 提取纯净结构化事实（如 shell_git, shell_rm, fs_write_file_ts），绝不在日志中暴露具体参数明文
  const opFact = registry.isSensitive(name) ? extractStructuredOperationFact(name, validated.value) : undefined;
  const safetyObservation = registry.isSensitive(name) && ctx.policy && opFact
    ? startDecisionObservation(ctx.policy, {
      taskFamily: 'safety',
      instruction: 'Assess the semantic risk of executing this action.',
      state: {
        summary: `Operation category: '${opFact.operationCategory}' requested in workspace`,
      },
      candidates: [
        { id: 'allow', text: 'ALLOW: Safe operation' },
        { id: 'ask_approval', text: 'ASK_APPROVAL: Potentially destructive action requiring confirmation' },
        { id: 'block', text: 'BLOCK: Hazardous command, reject immediately' },
      ],
      metadata: {
        toolName: name,
        operationCategory: opFact.operationCategory,
        targetExt: opFact.targetExt,
      },
    }) : undefined;
  // 规则 allow 时免审批；规则 ask 时即使在 yolo 模式下也强制弹窗；
  // 其余情况仅敏感工具（写文件/执行命令）在 ask 模式下需要审批，只读工具直接放行。
  // 裁决语义统一收敛在 core 的 resolveApprovalRequirement，与引擎内置动作（test_loop）共用，
  // 杜绝两条链路各写一份判断而漂移
  // 命令含无法可靠解析的结构时，归一化结果不可信（可能漏判 deny），
  // 必须走保守审批而不是当作安全放行（PR #9 第九轮复审 P1）
  const commandParseRisk =
    name === 'run_command'
      ? describeCommandParseRisk((validated.value as { command?: unknown }).command)
      : null;
  const requirement = resolveApprovalRequirement(permission, registry.isSensitive(name), {
    parseRisk: commandParseRisk,
  });
  const ruleAsk = requirement.force;
  const ruleAllow = permission?.decision === 'allow';
  // 审批请求展示真实目标：用户看到的是实际会被写入/读取的位置，而不是可能被替换的链接
  const approvalInput =
    verifiedRelative !== undefined
      ? { ...(permissionInput as Record<string, unknown>) }
      : validated.value;
  const approvalStarted = performance.now();
  const approved = requirement.needApproval
    ? await ctx.approval.request(name, approvalInput, {
        force: requirement.force,
        reason: requirement.reason,
        signal: ctx.signal,
      })
    : true;
  timing.approvalMs = Math.max(0, Math.round(performance.now() - approvalStarted));
  safetyObservation?.actual({
    // 审批模式是配置，不是 Agent 对语义风险的判断；不可参与模型一致率。
    // 规则放行/强制询问优先于模式描述，避免把「未发生审批」写成 Approval requested 污染影子统计
    description: ruleAsk
      ? `Permission rule forced approval (${approved ? 'approved' : 'denied'})`
      : ruleAllow
        ? 'Permission rule allowed action'
        : ctx.approval.modeValue === 'ask'
          ? `Approval requested (${approved ? 'approved' : 'denied'})`
          : 'YOLO mode allowed action',
  });
  if (!approved) {
    safetyObservation?.outcome({ status: 'unknown', evidence: 'User denied execution' });
    return {
      content:
        '用户拒绝了此操作。请不要重复尝试同一操作，向用户说明你的意图或改用其他方案。',
      approved: false,
      isError: false,
      durationMs: Date.now() - started,
      timing,
    };
  }
  try {
    // 审批通过后必须复核：审批期间另一个进程可能把符号链接换成别的目标
    // （PR #9 第五轮复审 P1）。单次复检不能彻底消除竞态，但能把
    // 「等待用户点同意」这段最长的窗口收掉；真正的强约束需要宿主级
    // 句柄/O_NOFOLLOW 能力，见 README「安全设计」的边界说明。
    if (
      verifiedRelative !== undefined &&
      ctx.workspace &&
      rawPathForRecheck !== undefined &&
      verifiedAbsolute !== undefined
    ) {
      const recheck = await resolveRealPathInWorkspace(
        ctx.host,
        ctx.workspace,
        rawPathForRecheck,
        ctx.host.paths,
      );
      // 必须比较**绝对**真实目标：只比相对路径会漏掉「整个工作区根被改指到另一个
      // 项目」这种情形（两边都叫 config.txt）。工作区物理身份漂移同样在此暴露。
      const unchanged =
        recheck.ok &&
        recheck.value.realRelative === verifiedRelative &&
        sameAbsolutePath(recheck.value.realPath, verifiedAbsolute, ctx.host.paths.sep);
      if (!unchanged) {
        return {
          content:
            '路径在审批期间发生变化（真实目标或工作区物理位置已被替换），为避免写入/读取非预期位置，本次调用已取消。请重新发起操作。',
          approved: false,
          isError: false,
          durationMs: Date.now() - started,
          timing,
        };
      }
    }
    // 实际 I/O 使用**已验证的真实路径**：不能用原始路径，否则检查与使用落在不同目标上
    const executeInput =
      verifiedRelative !== undefined
        ? { ...(permissionInput as Record<string, unknown>) }
        : validated.value;
    const run = async () => {
      ctx.signal.throwIfAborted();
      ctx.onExecutionStart?.();
      ctx.signal.throwIfAborted();
      const executionStarted = performance.now();
      try {
        return await tool.execute(executeInput, ctx);
      } finally {
        timing.executionMs = Math.max(0, Math.round(performance.now() - executionStarted));
      }
    };
    const content =
      registry.isSensitive(name) && ctx.workspaceLock
        ? await ctx.workspaceLock.withLock(run, ctx.signal)
        : await run();
    // run_command 退出码非零（或收到 signal 中断）必须视为执行失败
    const isCommandFailure = name === 'run_command' && /^退出码: (?!0(?:\n|$))/.test(content);
    const execution = {
      content,
      approved: true,
      isError: isCommandFailure,
      durationMs: Date.now() - started,
      timing,
    } satisfies ToolExecution;
    safetyObservation?.outcome(getToolExecutionOutcome(name, execution));
    return execution;
  } catch (err) {
    if (err instanceof Error && err.name === 'ProcessStopError') throw err;
    safetyObservation?.outcome({ status: 'failure', evidence: 'Tool execution failed' });
    return {
      content: `工具执行失败: ${err instanceof Error ? err.message : String(err)}`,
      approved: true,
      isError: true,
      durationMs: Date.now() - started,
      timing,
    };
  }
}
