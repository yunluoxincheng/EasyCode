import type { Host } from '@easycode/core';
import type { ProviderModelInfo } from './settings.js';

/**
 * 模型参数解析（自动标注上下文/最大输出/视觉/能力/推理等级）：
 * 1. 供应商 /models 元数据（最权威，调用方已解析）
 * 2. models.dev 在线目录（本机缓存 7 天，静默失败；含能力与推理档位）
 * 3. 内置规格目录（按官方文档整理的家族规格，离线可用）
 * 4. 名称启发式（仅在目录与内置目录都未命中时推断视觉）
 * 数值类字段逐层兜底；输入类型/能力只信最具体的来源，避免误标。
 */

export interface CatalogMeta {
  contextWindow?: number;
  maxOutputTokens?: number;
  inputTypes?: string[];
  capabilities?: string[];
  reasoningLevels?: string[];
}

interface CatalogEntry extends CatalogMeta {
  pattern: RegExp;
}

const TEXT_IMG_PDF = ['text', 'image', 'pdf'];
const TEXT_IMG_VIDEO = ['text', 'image', 'video'];
const TEXT_IMG_VIDEO_PDF = ['text', 'image', 'video', 'pdf'];

/** 内置规格目录（2026-09 按各家官方文档校订），先专后泛 */
const CATALOG: CatalogEntry[] = [
  /* ---- OpenAI ---- */
  { pattern: /^gpt-5\.6|^gpt-6/, contextWindow: 1_050_000, maxOutputTokens: 128_000, inputTypes: TEXT_IMG_PDF, capabilities: ['structured'], reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { pattern: /^gpt-5\.5/, contextWindow: 1_050_000, maxOutputTokens: 128_000, inputTypes: TEXT_IMG_PDF, capabilities: ['structured'], reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'] },
  { pattern: /^gpt-5/, contextWindow: 400_000, maxOutputTokens: 128_000, inputTypes: TEXT_IMG_PDF, capabilities: ['structured'], reasoningLevels: ['minimal', 'low', 'medium', 'high'] },
  { pattern: /^codex-/, contextWindow: 400_000, maxOutputTokens: 128_000, inputTypes: ['text', 'image'], reasoningLevels: ['low', 'medium', 'high', 'xhigh'] },
  { pattern: /^o[34](-|$)/, contextWindow: 200_000, maxOutputTokens: 100_000, inputTypes: ['text', 'image'] },
  { pattern: /^gpt-4\.1/, contextWindow: 1_000_000, maxOutputTokens: 32_000, inputTypes: ['text', 'image'] },
  { pattern: /^gpt-4o/, contextWindow: 128_000, maxOutputTokens: 16_000, inputTypes: ['text', 'image'] },
  { pattern: /^gpt-4(-|$)/, contextWindow: 128_000, maxOutputTokens: 8_192 },
  { pattern: /^gpt-image/, contextWindow: 128_000, maxOutputTokens: 16_384 },

  /* ---- Anthropic（3 代起全多模态）---- */
  { pattern: /^claude-opus-4-[789]/, contextWindow: 1_000_000, maxOutputTokens: 128_000, inputTypes: TEXT_IMG_PDF, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { pattern: /^claude-(opus|sonnet|haiku)-4/, contextWindow: 200_000, maxOutputTokens: 64_000, inputTypes: TEXT_IMG_PDF, reasoningLevels: ['low', 'medium', 'high'] },
  { pattern: /^claude-/, contextWindow: 200_000, maxOutputTokens: 8_192, inputTypes: ['text', 'image'] },

  /* ---- Google Gemini（全多模态；思考用 budget 而非 effort 档位）---- */
  { pattern: /^gemini-3/, contextWindow: 1_000_000, maxOutputTokens: 65_536, inputTypes: TEXT_IMG_VIDEO_PDF },
  { pattern: /^gemini-2\.5-pro/, contextWindow: 1_000_000, maxOutputTokens: 65_536, inputTypes: TEXT_IMG_VIDEO_PDF },
  { pattern: /^gemini-2/, contextWindow: 1_000_000, maxOutputTokens: 8_192, inputTypes: TEXT_IMG_VIDEO_PDF },

  /* ---- 智谱 GLM-5（GLM-5.3 主体为纯文本；Flash/FlashX 多模态）---- */
  { pattern: /^glm-5\.3-flash|^glm-5\.3-flashx/, contextWindow: 1_048_576, maxOutputTokens: 131_072, inputTypes: TEXT_IMG_VIDEO_PDF, capabilities: ['structured'], reasoningLevels: ['low', 'high', 'max'] },
  { pattern: /^glm-5/, contextWindow: 1_048_576, maxOutputTokens: 131_072, capabilities: ['structured'], reasoningLevels: ['low', 'high', 'max'] },
  { pattern: /^glm-4\.6/, contextWindow: 200_000, maxOutputTokens: 128_000 },
  { pattern: /^glm-4\.5/, contextWindow: 128_000, maxOutputTokens: 96_000 },
  { pattern: /^glm-4v|^glm-4\.5v/, contextWindow: 128_000, maxOutputTokens: 16_384, inputTypes: ['text', 'image'] },
  { pattern: /^glm-4/, contextWindow: 128_000, maxOutputTokens: 4_096 },

  /* ---- DeepSeek（V4 起百万上下文；官方标注支持图片输入）---- */
  { pattern: /^deepseek-(v4|flash)/, contextWindow: 1_000_000, maxOutputTokens: 384_000, inputTypes: ['text', 'image'], capabilities: ['structured'], reasoningLevels: ['low', 'high', 'max'] },
  { pattern: /^deepseek-reasoner/, contextWindow: 131_072, maxOutputTokens: 65_536 },
  { pattern: /^deepseek-(v3|chat)/, contextWindow: 131_072, maxOutputTokens: 8_192 },

  /* ---- Moonshot Kimi ---- */
  { pattern: /^kimi-k3/, contextWindow: 1_048_576, maxOutputTokens: 131_072, inputTypes: TEXT_IMG_VIDEO, capabilities: ['structured'], reasoningLevels: ['low', 'high', 'max'] },
  { pattern: /^kimi-latest/, contextWindow: 262_144, maxOutputTokens: 32_768, inputTypes: ['text', 'image'] },
  { pattern: /^kimi-k2/, contextWindow: 262_144, maxOutputTokens: 32_768 },
  { pattern: /^moonshot-v1.*vision/, contextWindow: 32_768, maxOutputTokens: 8_192, inputTypes: ['text', 'image'] },
  { pattern: /^moonshot-v1/, contextWindow: 32_768, maxOutputTokens: 8_192 },

  /* ---- Qwen ---- */
  { pattern: /^qwen3\.[5-9]-max/, contextWindow: 1_000_000, maxOutputTokens: 131_072 },
  { pattern: /^qwen3\.5/, contextWindow: 262_144, maxOutputTokens: 131_072, capabilities: ['structured'] },
  { pattern: /^qwen.*-vl|^qvq|^qwen.*omni/, contextWindow: 131_072, maxOutputTokens: 32_768, inputTypes: ['text', 'image'] },
  { pattern: /^qwen3/, contextWindow: 131_072, maxOutputTokens: 32_768 },
  { pattern: /^qwen-(max|plus)/, contextWindow: 131_072, maxOutputTokens: 16_384 },

  /* ---- Meta / xAI / Mistral ---- */
  { pattern: /^llama-4/, contextWindow: 1_048_576, maxOutputTokens: 32_768, inputTypes: ['text', 'image'] },
  { pattern: /^llama-3/, contextWindow: 131_072, maxOutputTokens: 8_192 },
  { pattern: /^grok-4/, contextWindow: 262_144, maxOutputTokens: 32_768, inputTypes: ['text', 'image'] },
  { pattern: /^grok.*vision/, contextWindow: 131_072, maxOutputTokens: 8_192, inputTypes: ['text', 'image'] },
  { pattern: /^grok-2/, contextWindow: 131_072, maxOutputTokens: 8_192 },
  { pattern: /^mistral-(large|medium)/, contextWindow: 131_072, maxOutputTokens: 8_192 },
];

/** 按内置目录查找模型规格（离线、同步） */
export function lookupCatalog(modelName: string): CatalogMeta | null {
  const n = modelName.toLowerCase();
  for (const e of CATALOG) {
    if (e.pattern.test(n)) {
      return {
        contextWindow: e.contextWindow,
        maxOutputTokens: e.maxOutputTokens,
        inputTypes: e.inputTypes ? [...e.inputTypes] : undefined,
        capabilities: e.capabilities ? [...e.capabilities] : undefined,
        reasoningLevels: e.reasoningLevels ? [...e.reasoningLevels] : undefined,
      };
    }
  }
  return null;
}

/** 名称启发式：目录与内置目录都未命中时仅推断视觉能力 */
export function inferVisionFromName(modelName: string): boolean {
  const n = modelName.toLowerCase();
  if (/(vision|-vl(-|$)|omni|-4v(-|$)|internvl)/.test(n)) return true;
  return /^(gemini|claude|gpt-4o|gpt-4\.1|gpt-5|gpt-6|kimi-k3|kimi-latest|grok-4|llama-4)/.test(n);
}

/** 生图/视频生成模型：接受图片输入仅用于编辑/参考，不是对话多模态，不标视觉 */
const IMAGE_GENERATION = /(^|\/)(gpt-image|dall-e|imagen|seedream|flux|sora|hidream|qwen-image|cogvideo|wan-2|veo)/;

/* ------------------------------------------------------------------ */
/* models.dev 在线目录（自动托管参数源，本机缓存 7 天）                  */
/* ------------------------------------------------------------------ */

const DIRECTORY_URL = 'https://models.dev/api.json';
const DIRECTORY_TTL = 7 * 24 * 3600 * 1000;
const DIRECTORY_CACHE_VERSION = 4;
const KNOWN_INPUT_TYPES = ['text', 'image', 'video', 'pdf', 'audio'];

export interface DirectoryEntry extends CatalogMeta {
  structuredOutput?: boolean;
  reasoning?: boolean;
}

interface DirectoryCache {
  v: number;
  fetchedAt: string;
  index: Record<string, DirectoryEntry>;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** modalities.input → 规范化输入类型（含 ['text']，表示"该来源明确声明了模态"） */
function parseInputTypes(types: unknown): string[] | undefined {
  if (!Array.isArray(types)) return undefined;
  const out = KNOWN_INPUT_TYPES.filter((t) => types.includes(t));
  return out.length ? out : undefined;
}

/** 官方供应商键：同 id 多条记录时数值以官方为准 */
const VENDOR_PROVIDER_KEYS = new Set([
  'openai', 'anthropic', 'google', 'deepseek', 'z-ai', 'zai', 'zhipu', 'zhipuai', 'bigmodel',
  'zai-coding-plan', 'zhipuai-coding-plan',
  'moonshotai', 'moonshot', 'qwen', 'alibaba', 'xai', 'mistral', 'meta', 'microsoft',
]);

/** 把 models.dev 的 api.json 压成 { 小写模型 id → 参数 } 索引（含去前缀别名） */
function buildDirectoryIndex(data: unknown): Record<string, DirectoryEntry> {
  // 先按 id 收集所有来源的记录，再合成（官方源优先数值，能力取并集）
  const gathered = new Map<string, { entry: DirectoryEntry; vendor: boolean }[]>();
  if (!data || typeof data !== 'object') return {};
  for (const [provKey, prov] of Object.entries(data as Record<string, unknown>)) {
    const models = (prov as { models?: unknown }).models;
    if (!models || typeof models !== 'object') continue;
    for (const [mid, raw] of Object.entries(models as Record<string, unknown>)) {
      const m = raw as {
        limit?: { context?: unknown; output?: unknown };
        modalities?: { input?: unknown };
        structured_output?: unknown;
        reasoning?: unknown;
        reasoning_options?: unknown;
      };
      const entry: DirectoryEntry = {};
      entry.contextWindow = num(m.limit?.context);
      entry.maxOutputTokens = num(m.limit?.output);
      const inputTypes = parseInputTypes(m.modalities?.input);
      if (inputTypes) entry.inputTypes = inputTypes;
      if (typeof m.structured_output === 'boolean') entry.structuredOutput = m.structured_output;
      if (typeof m.reasoning === 'boolean') entry.reasoning = m.reasoning;
      const levels: string[] = [];
      if (Array.isArray(m.reasoning_options)) {
        for (const opt of m.reasoning_options) {
          const values = (opt as { type?: unknown; values?: unknown })?.values;
          if (Array.isArray(values)) {
            for (const v of values) {
              if (typeof v === 'string' && !levels.includes(v)) levels.push(v);
            }
          }
        }
      }
      if (levels.length > 0) entry.reasoningLevels = levels;
      if (
        entry.contextWindow == null &&
        entry.maxOutputTokens == null &&
        !entry.inputTypes &&
        entry.structuredOutput == null &&
        entry.reasoning == null &&
        !entry.reasoningLevels
      ) {
        continue;
      }
      const key = mid.toLowerCase();
      const base = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
      for (const k of new Set([key, base])) {
        const list = gathered.get(k) ?? [];
        list.push({ entry, vendor: VENDOR_PROVIDER_KEYS.has(provKey) });
        gathered.set(k, list);
      }
    }
  }
  const index: Record<string, DirectoryEntry> = {};
  for (const [key, list] of gathered) {
    const vendorEntry = list.find((x) => x.vendor)?.entry;
    const chosen = vendorEntry ?? list[0].entry;
    const merged: DirectoryEntry = {
      contextWindow: chosen.contextWindow,
      maxOutputTokens: chosen.maxOutputTokens,
      structuredOutput: list.some((x) => x.entry.structuredOutput === true) || undefined,
      reasoning: list.some((x) => x.entry.reasoning === true) || undefined,
    };
    if (merged.structuredOutput == null) delete merged.structuredOutput;
    if (merged.reasoning == null) delete merged.reasoning;
    // 输入类型：官方来源一票定音；否则多数投票（个别网关误报不影响整体）
    const types =
      vendorEntry?.inputTypes ??
      majorityVote(list.map((x) => x.entry).filter((x) => x.inputTypes?.length).map((x) => x.inputTypes!));
    if (types?.length) merged.inputTypes = types;
    // 推理档位：官方来源优先，其次取出现最多的那份列表（不并集，避免档位膨胀）
    const levels = vendorEntry?.reasoningLevels ?? commonLevels(list.map((x) => x.entry));
    if (levels?.length) merged.reasoningLevels = levels;
    if (
      merged.contextWindow != null ||
      merged.maxOutputTokens != null ||
      merged.inputTypes ||
      merged.structuredOutput != null ||
      merged.reasoning != null ||
      merged.reasoningLevels
    ) {
      index[key] = merged;
    }
  }
  return index;
}

/** 多数投票：同一输入类型被过半来源报告才采信（['text'] 也是一票） */
function majorityVote(lists: string[][]): string[] | undefined {
  if (lists.length === 0) return undefined;
  if (lists.length === 1) return lists[0];
  const counts = new Map<string, number>();
  for (const types of lists) {
    for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const half = lists.length / 2;
  const out = KNOWN_INPUT_TYPES.filter((t) => t !== 'audio' && (counts.get(t) ?? 0) > half);
  return out.length ? out : lists[0];
}

/** 取出现次数最多的档位列表 */
function commonLevels(entries: DirectoryEntry[]): string[] | undefined {
  const withLevels = entries.filter((x) => x.reasoningLevels?.length);
  if (withLevels.length === 0) return undefined;
  const seen = new Map<string, { count: number; levels: string[] }>();
  for (const x of withLevels) {
    const key = x.reasoningLevels!.join(',');
    const rec = seen.get(key) ?? { count: 0, levels: x.reasoningLevels! };
    rec.count++;
    seen.set(key, rec);
  }
  let best: { count: number; levels: string[] } | null = null;
  for (const rec of seen.values()) if (!best || rec.count > best.count) best = rec;
  return best!.levels;
}

/** 加载在线目录（带本机缓存；网络失败静默回退旧缓存/不可用） */
export async function loadModelDirectory(host: Host): Promise<Map<string, DirectoryEntry> | null> {
  const cacheFile = host.paths.join(host.env.dataDir(), 'models-dev-cache.json');
  let cached: DirectoryCache | null = null;
  try {
    cached = JSON.parse(await host.fs.readFile(cacheFile)) as DirectoryCache;
  } catch {
    // 首次运行无缓存
  }
  const fresh =
    cached?.v === DIRECTORY_CACHE_VERSION &&
    cached?.fetchedAt &&
    Date.now() - Date.parse(cached.fetchedAt) < DIRECTORY_TTL;
  if (!fresh) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(DIRECTORY_URL, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) {
        const index = buildDirectoryIndex(await res.json());
        const next: DirectoryCache = {
          v: DIRECTORY_CACHE_VERSION,
          fetchedAt: new Date().toISOString(),
          index,
        };
        await host.fs.mkdir(host.env.dataDir(), { recursive: true });
        await host.fs.writeFile(cacheFile, JSON.stringify(next));
        cached = next;
      }
    } catch {
      // 网络不可用时沿用旧缓存
    }
  }
  if (cached?.v !== DIRECTORY_CACHE_VERSION || !cached?.index) return null;
  return new Map(Object.entries(cached.index));
}

/**
 * 综合解析单个模型的参数：API 元数据 > 在线目录 > 内置目录 > 名称启发式。
 * 输入类型只取最具体来源（目录命中时不再叠加内置目录，避免误标视觉），
 * "对话中系统消息"为通用能力恒置，"原生联网搜索"目录无数据源、仅用户可设。
 */
export function resolveModelMeta(
  base: { name: string; contextWindow?: number; maxOutputTokens?: number; vision?: boolean },
  directory: Map<string, DirectoryEntry> | null,
): ProviderModelInfo {
  const n = base.name.toLowerCase();
  const dir = directory?.get(n) ?? null;
  const cat = lookupCatalog(n);
  const info: ProviderModelInfo = { name: base.name };

  const ctx = base.contextWindow ?? dir?.contextWindow ?? cat?.contextWindow;
  const out = base.maxOutputTokens ?? dir?.maxOutputTokens ?? cat?.maxOutputTokens;
  if (ctx != null) info.contextWindow = ctx;
  if (out != null) info.maxOutputTokens = out;

  // 输入类型：目录命中 → 只信目录；否则内置目录；最后名称启发式；
  // 什么来源都没有时按纯文本兜底（自动托管语义：每次探测给出权威值）
  const types = new Set<string>();
  if (dir?.inputTypes) for (const t of dir.inputTypes) types.add(t);
  if (base.vision) types.add('image');
  if (types.size === 0 && !dir && cat?.inputTypes) for (const t of cat.inputTypes) types.add(t);
  if (types.size === 0 && !dir && !cat && inferVisionFromName(n)) types.add('image');
  if (IMAGE_GENERATION.test(n)) {
    // 生图模型：图片仅用于编辑/参考，不算对话多模态
    types.clear();
  }
  types.add('text');
  info.inputTypes = KNOWN_INPUT_TYPES.filter((t) => t !== 'audio' && types.has(t));
  info.vision = types.has('image');

  // 能力：结构化输出取目录/内置目录并自动开启（DeepSeek 需要额外参数，不自动开，
  // 由用户手动启用）；联网搜索目录无数据源，仅用户可设
  const caps = new Set<string>(['system']);
  const structuredSupported =
    dir?.structuredOutput === true || (!dir && cat?.capabilities?.includes('structured'));
  if (structuredSupported && !/^deepseek/.test(n)) caps.add('structured');
  info.capabilities = ['structured', 'websearch', 'system'].filter((c) => caps.has(c));

  // 推理档位：目录 effort values > 内置目录家族档位
  const levels = dir?.reasoningLevels ?? cat?.reasoningLevels;
  if (levels) info.reasoningLevels = [...levels];

  return info;
}
