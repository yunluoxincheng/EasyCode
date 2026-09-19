import type { Host } from '../host.js';
import { validateToolInput, type JsonSchema } from '../jsonschema.js';
import type { ApprovalManager } from '../approval.js';
import { readFileTool, writeFileTool, editFileTool, listDirTool } from './fs.js';
import { searchFilesTool } from './search.js';
import { runCommandTool } from './shell.js';

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
}

export interface Tool {
  spec: ToolSpec;
  /** 敏感操作在 ask 模式下需用户批准 */
  sensitive?: boolean;
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

/** 内置工具集（文件读写/编辑/列目录/搜索/命令）。宿主能力在 execute 时注入。 */
export function createBuiltinTools(): ToolRegistry {
  const registry = new ToolRegistry();
  return registry
    .register(readFileTool)
    .register(writeFileTool)
    .register(editFileTool)
    .register(listDirTool)
    .register(searchFilesTool)
    .register(runCommandTool);
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
  if (!ctx.workspace) {
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
  // 仅敏感工具（写文件/执行命令）在 ask 模式下需要审批，只读工具直接放行
  const approved = registry.isSensitive(name)
    ? await ctx.approval.request(name, validated.value)
    : true;
  if (!approved) {
    return {
      content:
        '用户拒绝了此操作。请不要重复尝试同一操作，向用户说明你的意图或改用其他方案。',
      approved: false,
      isError: false,
      durationMs: Date.now() - started,
    };
  }
  try {
    const content = await tool.execute(validated.value, ctx);
    return { content, approved: true, isError: false, durationMs: Date.now() - started };
  } catch (err) {
    return {
      content: `工具执行失败: ${err instanceof Error ? err.message : String(err)}`,
      approved: true,
      isError: true,
      durationMs: Date.now() - started,
    };
  }
}
