import type { Tool } from './index.js';

/** 联网搜索后端配置（结构与 engine 的 WebSearchConfig 对齐，core 不反向依赖） */
export interface WebSearchBackendConfig {
  backend: 'searxng' | 'tavily' | 'custom';
  searxngUrl?: string;
  tavilyApiKey?: string;
  /** 自定义 API 地址模板，{query} 会被替换为 URL 编码后的搜索词 */
  customUrl?: string;
  maxResults?: number;
}

export interface SearchHit {
  title: string;
  url: string;
  content: string;
}

const TIMEOUT_MS = 15000;
const MAX_SNIPPET = 500;

/**
 * 联网搜索工具：给不支持原生搜索的模型用的 function calling 工具。
 * 失败一律返回错误文本（而非抛出），让模型自行决策是否继续。
 */
export function createWebSearchTool(config: WebSearchBackendConfig): Tool {
  return {
    spec: {
      name: 'web_search',
      description:
        '联网搜索最新公开信息。适用场景：时效性问题（新闻/价格/版本/日期）、' +
        '你不确定或超出知识截止时间的事实、需要给出处引用的信息。' +
        'query 用具体的搜索关键词而非整句提问，中文内容用中文查询；' +
        '一次搜索一个主题，需要多方面信息时分别调用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
        },
        required: ['query'],
      },
    },
    requiresWorkspace: false,
    async execute(input) {
      const query =
        typeof (input as { query?: unknown })?.query === 'string'
          ? (input as { query: string }).query.trim()
          : '';
      if (!query) return 'web_search 失败: query 不能为空';
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const hits = await runWebSearch(config, query, ctrl.signal);
        if (hits.length === 0) return `web_search: 未搜索到与「${query}」相关的结果`;
        const body = hits
          .map(
            (r, i) =>
              `${i + 1}. 【${r.title}】(${r.url})\n${r.content.slice(0, MAX_SNIPPET)}`,
          )
          .join('\n\n');
        return `「${query}」的搜索结果（${hits.length} 条）:\n\n${body}`;
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.name === 'AbortError'
              ? '请求超时'
              : err.message
            : String(err);
        return `web_search 失败: ${msg}`;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** 执行一次搜索（测试按钮与工具共用） */
export async function runWebSearch(
  config: WebSearchBackendConfig,
  query: string,
  signal: AbortSignal,
): Promise<SearchHit[]> {
  const max = Math.min(Math.max(config.maxResults ?? 5, 1), 10);
  if (config.backend === 'tavily') {
    return tavilySearch(query, max, config.tavilyApiKey ?? '', signal);
  }
  if (config.backend === 'custom') {
    return customSearch(query, max, config.customUrl ?? '', signal);
  }
  return searxngSearch(query, max, config.searxngUrl ?? '', signal);
}

/**
 * 自定义搜索 API：GET 请求，{query} 占位符替换为 URL 编码后的搜索词；
 * 响应兼容 SearXNG JSON（{results:[{title,url,content}]}）或直接的 results 数组。
 */
async function customSearch(
  query: string,
  max: number,
  template: string,
  signal: AbortSignal,
): Promise<SearchHit[]> {
  if (!template.trim() || !template.includes('{query}')) {
    throw new Error('自定义 API 地址需包含 {query} 占位符');
  }
  const url = template.replace('{query}', encodeURIComponent(query));
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`自定义搜索 API HTTP ${res.status}`);
  const data = (await res.json()) as
    | { results?: Array<{ title?: string; url?: string; content?: string }> }
    | Array<{ title?: string; url?: string; content?: string }>;
  const list = Array.isArray(data) ? data : (data.results ?? []);
  return list
    .slice(0, max)
    .map((r) => ({
      title: r.title ?? '(无标题)',
      url: r.url ?? '',
      content: r.content ?? '',
    }))
    .filter((r) => r.url);
}

async function searxngSearch(
  query: string,
  max: number,
  base: string,
  signal: AbortSignal,
): Promise<SearchHit[]> {
  const url = `${base.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}（检查地址是否正确、json 格式是否启用）`);
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (data.results ?? [])
    .slice(0, max)
    .map((r) => ({
      title: r.title ?? '(无标题)',
      url: r.url ?? '',
      content: r.content ?? '',
    }))
    .filter((r) => r.url);
}

async function tavilySearch(
  query: string,
  max: number,
  apiKey: string,
  signal: AbortSignal,
): Promise<SearchHit[]> {
  if (!apiKey) throw new Error('未配置 Tavily API Key');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, max_results: max }),
    signal,
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (data.results ?? [])
    .slice(0, max)
    .map((r) => ({
      title: r.title ?? '(无标题)',
      url: r.url ?? '',
      content: r.content ?? '',
    }))
    .filter((r) => r.url);
}
