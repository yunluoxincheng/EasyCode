import type { ApprovalMode } from '@easycode/core';

/** 项目：命名的源文件夹，会话归属其下 */
export interface ProjectEntry {
  id: string;
  name: string;
  folder: string;
}

/** 供应商下的一个模型 */
export interface ProviderModel {
  /** 模型 ID（调用 API 时使用） */
  name: string;
  /** 关闭后不出现在新会话的模型选择器中；缺省视为启用 */
  enabled?: boolean;
  /** 上下文窗口（tokens）；缺省 1000000 */
  contextWindow?: number;
  /** 最大输出 tokens；缺省 65536 */
  maxOutputTokens?: number;
  /** 智能配置：上下文/输出/能力自动探测；关闭后字段可手动编辑 */
  autoConfig?: boolean;
  /** 支持的输入类型：text 恒有，image/video/pdf 可选（image 即"视觉"） */
  inputTypes?: string[];
  /** 模型能力：structured（结构化输出）/ websearch（联网搜索）/ system（对话中系统消息） */
  capabilities?: string[];
  /** 推理等级（从低到高）；同时决定 composer 思考强度的可选项 */
  reasoningLevels?: string[];
  /** 推理参数映射表达式（高级项，仅存储与展示） */
  reasoningMapping?: string;
}

/** 从供应商 /models 元数据探测到的模型信息 */
export interface ProviderModelInfo {
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  vision?: boolean;
  /** 已知输入类型（text 恒有；image/video/pdf 可选） */
  inputTypes?: string[];
  /** 模型能力（structured/system；websearch 无数据源，仅用户可设） */
  capabilities?: string[];
  /** 推理档位（从低到高，来自 reasoning_options effort values） */
  reasoningLevels?: string[];
}

/** 单模型连通性测试结果 */
export interface ModelTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** Provider 配置（kind 决定适配器） */
export interface ProviderEntry {
  kind: 'openai-compatible' | 'anthropic' | 'responses' | 'mock';
  baseURL: string;
  apiKey?: string;
  /** 该供应商可用的模型列表 */
  models?: ProviderModel[];
  /** 模型上下文窗口大小（tokens），用于容量估算；缺省 128000 */
  contextWindow?: number;
  /** 显示名称（供应商列表与新会话选择器中优先展示） */
  name?: string;
  /** 关闭后不出现在新会话的模型服务选择器中；缺省视为启用 */
  enabled?: boolean;
}

/** 联网搜索配置：给不支持原生搜索的模型提供 web_search 工具 */
export interface WebSearchConfig {
  /** 总开关：关闭 = 全部不搜索（含 gpt/claude 的原生路径） */
  enabled: boolean;
  backend: 'searxng' | 'tavily' | 'custom';
  /** SearXNG 地址，如 http://localhost:8080（需启用 json 格式） */
  searxngUrl?: string;
  /** Tavily API Key（tvly- 开头） */
  tavilyApiKey?: string;
  /** 自定义 API 地址模板，{query} 会被替换为 URL 编码后的搜索词 */
  customUrl?: string;
  /** 注入结果条数，默认 5（1-10） */
  maxResults?: number;
}

/** 命令行终端 Shell：auto=自动选择（默认），也可指定 git-bash / pwsh / powershell / cmd */
export type ShellType = 'auto' | 'git-bash' | 'pwsh' | 'powershell' | 'cmd';

/** 探测到的终端 Shell 信息 */
export interface ShellInfo {
  id: ShellType;
  name: string;
  path?: string;
  available: boolean;
}

export interface Settings {
  providers: Record<string, ProviderEntry>;
  projects: ProjectEntry[];
  defaultProvider: string;
  defaultApprovalMode: ApprovalMode;
  /** 发送/流式输出时自动滚到底部；默认开 */
  autoScroll?: boolean;
  webSearch?: WebSearchConfig;
  /** Agent 任务完成后发桌面通知（仅窗口不在前台时）；默认开 */
  desktopNotify?: boolean;
  /** 「打开工作区」用的工具：explorer=系统文件管理器（默认）；vscode=VS Code（未安装时提示） */
  openWorkspaceWith?: 'explorer' | 'vscode';
  /** 命令行终端 Shell：auto=自动选择最优（默认）；也可指定 git-bash / pwsh / powershell / cmd */
  shell?: ShellType;
  /** 复古 CRT 扫描线质感；默认开 */
  crtScanline?: boolean;
  /** 单次任务最大步数；缺省 200，范围 10~500 */
  maxSteps?: number;
  /** 侧栏折叠的项目 ID 或文件夹路径集合 */
  collapsedProjects?: string[];
  /** 上下文超限保护与智能自动压缩配置（TODOS #31） */
  contextCompaction?: ContextCompactionConfig;
  /** 关闭窗口时最小化到系统托盘常驻后台（TODOS #5）；默认开 */
  closeToTray?: boolean;
  /** 全局通用开发规范与偏好（TODOS #33） */
  globalRules?: string;
}

export interface ContextCompactionConfig {
  /** 达阈值时是否在循环中自动压缩上下文（默认 true） */
  autoCompact?: boolean;
  /** 触发自动压缩的上下文容量占比阈值（0.5~0.95，默认 0.85 即 85%） */
  threshold?: number;
  /** 自动压缩时保留的最近完整交互轮数（默认 2） */
  keepRecentTurns?: number;
}

/** 内置 Provider 预设：均为 OpenAI 兼容端点（或 Anthropic），API Key 留空由用户填写 */
export const PROVIDER_PRESETS: Record<string, ProviderEntry> = {
  zhipu: {
    kind: 'openai-compatible',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    name: '智谱 GLM',
  },
  deepseek: {
    kind: 'openai-compatible',
    baseURL: 'https://api.deepseek.com',
    name: 'DeepSeek',
  },
  openai: {
    kind: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    name: 'OpenAI',
  },
  moonshot: {
    kind: 'openai-compatible',
    baseURL: 'https://api.moonshot.cn/v1',
    name: 'Moonshot Kimi',
  },
  ollama: {
    kind: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1',
    name: 'Ollama (本地)',
  },
  'lm-studio': {
    kind: 'openai-compatible',
    baseURL: 'http://localhost:1234/v1',
    name: 'LM Studio (本地)',
  },
  anthropic: {
    kind: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    name: 'Anthropic',
  },
};

export const DEFAULT_SETTINGS: Settings = {
  providers: { ...PROVIDER_PRESETS },
  projects: [],
  defaultProvider: 'zhipu',
  defaultApprovalMode: 'ask',
  autoScroll: true,
  crtScanline: true,
  maxSteps: 200,
  collapsedProjects: [],
  contextCompaction: { autoCompact: true, threshold: 0.85, keepRecentTurns: 2 },
  closeToTray: true,
  webSearch: { enabled: false, backend: 'searxng', maxResults: 5 },
  shell: 'auto',
};

export function providerLabel(id: string, entry: ProviderEntry | undefined): string {
  return entry?.name ?? id;
}
