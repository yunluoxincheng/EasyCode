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

export interface Settings {
  providers: Record<string, ProviderEntry>;
  projects: ProjectEntry[];
  defaultProvider: string;
  defaultApprovalMode: ApprovalMode;
  /** 发送/流式输出时自动滚到底部；默认开 */
  autoScroll?: boolean;
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
};

export function providerLabel(id: string, entry: ProviderEntry | undefined): string {
  return entry?.name ?? id;
}
