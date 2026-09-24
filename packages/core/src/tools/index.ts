import type { Host } from '../host.js';
import { validateToolInput, type JsonSchema } from '../jsonschema.js';
import type { ApprovalManager } from '../approval.js';
import { startDecisionObservation, type DecisionPolicy, type DecisionOutcome } from '../policy.js';
import { readFileTool, writeFileTool, editFileTool, listDirTool } from './fs.js';
import { searchFilesTool } from './search.js';
import { runCommandTool } from './shell.js';
import { todoWriteTool } from './todo.js';
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

export interface ToolContext {
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
}

export interface Tool {
  spec: ToolSpec;
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
    .register(todoWriteTool)
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
  const abs = host.paths.isAbsolute(relative)
    ? host.paths.resolve(relative)
    : host.paths.resolve(workspace, relative);
  const root = host.paths.resolve(workspace);
  const inside =
    abs === root ||
    abs.startsWith(root.endsWith(host.paths.sep) ? root : root + host.paths.sep);
  if (!inside) {
    throw new Error(`路径越界: ${relative} 不在工作区 ${root} 内`);
  }
  return abs;
}

export interface ToolExecution {
  content: string;
  approved: boolean;
  isError: boolean;
  durationMs: number;
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
): Promise<ToolExecution> {
  const started = Date.now();
  const tool = registry.get(name);
  if (!tool) {
    return { content: `未知工具: ${name}`, approved: false, isError: true, durationMs: 0 };
  }
  if (!ctx.workspace && tool.requiresWorkspace !== false) {
    return {
      content: '当前会话未绑定工作区，文件与命令工具不可用。请让用户在聊天输入区点击「＋ 绑定项目」选择一个文件夹后重试。',
      approved: true,
      isError: true,
      durationMs: 0,
    };
  }
  const validated = validateToolInput(rawInput, tool.spec.parameters);
  if (!validated.ok) {
    return {
      content: `参数校验失败: ${validated.error}`,
      approved: false,
      isError: true,
      durationMs: 0,
    };
  }
  // 敏感操作语义安全风险评估旁路（TODOS #40 Safety）
  // 对参数做安全脱敏清洗，绝不在 metadata 泄露未脱敏敏感参数（如密码/API密钥/完整代码体）
  const safeParamSummary = typeof validated.value === 'object' && validated.value !== null
    ? Object.fromEntries(
        Object.entries(validated.value as Record<string, unknown>).map(([k, v]) => [
          k,
          /password|token|key|secret|auth|credential|cookie|cert/i.test(k)
            ? '[REDACTED]'
            : typeof v === 'string'
              ? v.slice(0, 100)
              : v,
        ]),
      )
    : undefined;

  const safetyObservation = registry.isSensitive(name) && ctx.policy
    ? startDecisionObservation(ctx.policy, {
      taskFamily: 'safety',
      instruction: 'Assess the semantic risk of executing this action.',
      state: {
        summary: `Tool '${name}' requested with parameters: ${JSON.stringify(safeParamSummary).slice(0, 300)}`,
      },
      candidates: [
        { id: 'allow', text: 'ALLOW: Safe operation' },
        { id: 'ask_approval', text: 'ASK_APPROVAL: Potentially destructive action requiring confirmation' },
        { id: 'block', text: 'BLOCK: Hazardous command, reject immediately' },
      ],
      metadata: { toolName: name, params: safeParamSummary },
    }) : undefined;
  // 仅敏感工具（写文件/执行命令）在 ask 模式下需要审批，只读工具直接放行
  const approved = registry.isSensitive(name)
    ? await ctx.approval.request(name, validated.value)
    : true;
  safetyObservation?.actual({
    // 审批模式是配置，不是 Agent 对语义风险的判断；不可参与模型一致率。
    description: ctx.approval.modeValue === 'ask'
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
    };
  }
  try {
    const run = () => tool.execute(validated.value, ctx);
    const content =
      registry.isSensitive(name) && ctx.workspaceLock
        ? await ctx.workspaceLock.withLock(run, ctx.signal)
        : await run();
    // run_command 退出码非零（或收到 signal 中断）必须视为执行失败
    const isCommandFailure = name === 'run_command' && /^退出码: (?!0(?:\n|$))/.test(content);
    const execution: ToolExecution = {
      content,
      approved: true,
      isError: isCommandFailure,
      durationMs: Date.now() - started,
    };
    safetyObservation?.outcome(getToolExecutionOutcome(name, execution));
    return execution;
  } catch (err) {
    safetyObservation?.outcome({ status: 'failure', evidence: 'Tool execution failed' });
    return {
      content: `工具执行失败: ${err instanceof Error ? err.message : String(err)}`,
      approved: true,
      isError: true,
      durationMs: Date.now() - started,
    };
  }
}
