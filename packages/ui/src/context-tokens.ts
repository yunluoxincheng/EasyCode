import type { AppStore, TurnItem, TurnEntry, UserItem } from './store.js';
import { createBuiltinTools, type Host } from '@easycode/core';
import { buildSystemPrompt, supportsNativeWebSearch, validWebSearchBackend } from '@easycode/engine';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';

/** 精确 token 计数：o200k_base 编码（OpenAI 当前分词规范，对其他模型也是良好近似） */
function count(text: string): number {
  if (!text) return 0;
  // 会话/文件内容可能含 <|im_start|> 等特殊 token 字面量，默认会抛 "Disallowed special token"，
  // 渲染期异常会卸载整棵 React 树（白屏）。这里只做估算，一律按普通文本计数。
  return encode(text, { disallowedSpecial: new Set() }).length;
}

/** 缓存已定型历史回合（turn.durationMs !== undefined）的总 token 计数 */
const completedTurnTokensCache = new WeakMap<object, number>();
/** 缓存已定型条目/代码块的 token 计数 */
const itemTokensCache = new WeakMap<object, number>();

/** 静态配置（系统工具规格 + 系统提示词）Token 计数缓存 */
interface StaticTokensCache {
  key: string;
  toolsTokens: number;
  promptTokens: number;
}
let staticTokensCache: StaticTokensCache | null = null;

function countTurnItem(it: TurnEntry, isLive: boolean): number {
  if (it.kind === 'tool') {
    // 运行中的工具结果可能变化，完成后结果固定
    if (it.status !== 'running') {
      const cached = itemTokensCache.get(it);
      if (cached !== undefined) return cached;
      const tok = count(JSON.stringify(it.input ?? {})) + count(it.result ?? '');
      itemTokensCache.set(it, tok);
      return tok;
    }
    return count(JSON.stringify(it.input ?? {})) + count(it.result ?? '');
  }

  if (it.kind === 'approval') {
    const cached = itemTokensCache.get(it);
    if (cached !== undefined) return cached;
    const tok = count(JSON.stringify(it.input ?? {}));
    itemTokensCache.set(it, tok);
    return tok;
  }

  if (it.kind === 'assistant') {
    let sum = 0;
    for (let i = 0; i < it.blocks.length; i++) {
      const b = it.blocks[i];
      // 最后一个 block 如果处于当前 live 运行态，可能在流式追加中，不缓存；已闭合 block 长期缓存
      const isLiveBlock = isLive && i === it.blocks.length - 1;
      if (!isLiveBlock) {
        let tok = itemTokensCache.get(b);
        if (tok === undefined) {
          tok = count(b.text);
          itemTokensCache.set(b, tok);
        }
        sum += tok;
      } else {
        sum += count(b.text);
      }
    }
    return sum;
  }

  return 0;
}

function countTurn(turn: TurnItem, isLive: boolean): number {
  if (!isLive && turn.durationMs !== undefined) {
    const cached = completedTurnTokensCache.get(turn);
    if (cached !== undefined) return cached;
  }
  let sum = 0;
  for (const it of turn.items) {
    sum += countTurnItem(it, isLive);
  }
  if (!isLive && turn.durationMs !== undefined) {
    completedTurnTokensCache.set(turn, sum);
  }
  return sum;
}

function countUserItem(it: UserItem): number {
  const cached = itemTokensCache.get(it);
  if (cached !== undefined) return cached;
  const tok = count(it.text);
  itemTokensCache.set(it, tok);
  return tok;
}

export const DEFAULT_WINDOW = 1_000_000;

/** 估算当前会话的总 Token 占用与窗口比例（全量复用多级 WeakMap 缓存） */
export function estimateSessionTokens(
  store: AppStore,
  overrideWindow?: number,
): { used: number; windowTok: number; pct: number; rows: Array<{ label: string; tokens: number }> } {
  const session = store.activeSession;
  if (!session) {
    return { used: 0, windowTok: overrideWindow ?? DEFAULT_WINDOW, pct: 0, rows: [] };
  }

  const provider = store.settings?.providers[session.providerId];
  const effectiveModel =
    session.model || (provider?.models ?? []).find((m) => m.enabled !== false)?.name || '';
  const modelCfg = (provider?.models ?? []).find((m) => m.name === effectiveModel);
  const windowTok =
    overrideWindow ?? modelCfg?.contextWindow ?? provider?.contextWindow ?? DEFAULT_WINDOW;

  const rows: Array<{ label: string; tokens: number }> = [];
  let msgTokens = 0;
  for (const it of store.items) {
    if (it.kind === 'user') {
      msgTokens += countUserItem(it);
    } else if (it.kind === 'turn') {
      const isLive = store.running && it.durationMs === undefined;
      msgTokens += countTurn(it, isLive);
    }
  }
  rows.push({ label: '消息', tokens: msgTokens });

  const wsCfg = store.settings?.webSearch;
  const searchOn =
    (modelCfg?.capabilities ?? ['system']).includes('websearch') && wsCfg?.enabled === true;
  const useNativeSearch =
    searchOn && supportsNativeWebSearch(effectiveModel, provider?.kind ?? 'openai-compatible');
  const builtinSearch =
    searchOn && !useNativeSearch && validWebSearchBackend(wsCfg)
      ? {
          webSearch: {
            backend: wsCfg!.backend,
            searxngUrl: wsCfg!.searxngUrl,
            tavilyApiKey: wsCfg!.tavilyApiKey,
            maxResults: wsCfg!.maxResults,
          },
        }
      : undefined;

  const staticCacheKey = `${effectiveModel}:${provider?.kind}:${session.workspaceRoot}:${searchOn}:${useNativeSearch}:${wsCfg?.backend}:${store.mcpCatalogVersion}`;
  if (!staticTokensCache || staticTokensCache.key !== staticCacheKey) {
    const toolsTok = count(JSON.stringify([...createBuiltinTools(builtinSearch).listSpecs(), ...store.mcpTools]));
    const stubHost = {
      paths: { sep: navigator.platform.includes('Win') ? '\\' : '/' },
    } as unknown as Host;
    const promptTok = count(buildSystemPrompt(stubHost, session.workspaceRoot, { webSearch: searchOn }));
    staticTokensCache = {
      key: staticCacheKey,
      toolsTokens: toolsTok,
      promptTokens: promptTok,
    };
  }
  rows.push({ label: '系统工具', tokens: staticTokensCache.toolsTokens });
  rows.push({ label: '系统提示词', tokens: staticTokensCache.promptTokens });

  const other = store.items.length * 4;
  rows.push({ label: '其他', tokens: other });

  const used = rows.reduce((a, r) => a + r.tokens, 0);
  const pct = Math.min(100, (used / windowTok) * 100);
  return { used, windowTok, pct, rows };
}
