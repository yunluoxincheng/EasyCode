import { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';
import type { TurnItem, TurnEntry, UserItem } from '../store.js';
import { createBuiltinTools, type Host } from '@easycode/core';
import {
  buildSystemPrompt,
  supportsNativeWebSearch,
  validWebSearchBackend,
} from '@easycode/engine';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';

/** 精确 token 计数：o200k_base 编码（OpenAI 当前分词规范，对其他模型也是良好近似） */
function count(text: string): number {
  if (!text) return 0;
  return encode(text).length;
}
function fmtTk(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : n.toLocaleString();
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

const DEFAULT_WINDOW = 1_000_000;
/** 紧凑态进度环（TODOS #20）：半径与周长，SVG 逆时针从顶部起描 */
const RING_R = 5.5;
const RING_C = 2 * Math.PI * RING_R;

/** 上下文容量 chip + 面板（ZCode 同款）：当前会话在模型上下文窗口中的精确占用；紧凑态收敛为进度环 + 悬停浮出看板（TODOS #20） */
export function ContextChip({ compact = false }: { compact?: boolean }) {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const session = store.activeSession;
  if (!session) return null;

  const provider = store.settings?.providers[session.providerId];
  // 优先取该模型在设置里配置的上下文窗口，再退回供应商级/默认 1M
  const effectiveModel =
    session.model || (provider?.models ?? []).find((m) => m.enabled !== false)?.name || '';
  const modelCfg = (provider?.models ?? []).find((m) => m.name === effectiveModel);
  const windowTok = modelCfg?.contextWindow ?? provider?.contextWindow ?? DEFAULT_WINDOW;

  // 分类精确计数（全面使用 WeakMap 多级缓存，消除长会话重复 BPE 分词）
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

  // 系统工具计数：按会话模型实际会注册的工具（联网搜索按分流结果计入）
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

  // 静态系统提示词与工具规格缓存：避免每次组件重绘都重复序列化与分词数万 Token
  const staticCacheKey = `${effectiveModel}:${provider?.kind}:${session.workspaceRoot}:${searchOn}:${useNativeSearch}:${wsCfg?.backend}`;
  if (!staticTokensCache || staticTokensCache.key !== staticCacheKey) {
    const toolsTok = count(JSON.stringify(createBuiltinTools(builtinSearch).listSpecs()));
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

  const other = store.items.length * 4; // 每条消息的角色/框架开销
  rows.push({ label: '其他', tokens: other });

  const used = rows.reduce((a, r) => a + r.tokens, 0);
  const pct = Math.min(100, (used / windowTok) * 100);

  // 平均缓存命中率 = 累计缓存 / 累计输入
  const su = store.sessionUsage;
  const cacheRate =
    su.input > 0 && su.cached > 0 ? `${((su.cached / su.input) * 100).toFixed(1)}%` : '0%';

  return (
    <div
      className="usage-wrap"
      ref={ref}
      onMouseEnter={compact ? () => setOpen(true) : undefined}
      onMouseLeave={compact ? () => setOpen(false) : undefined}
    >
      <button
        className="chip ctx-chip"
        title={
          compact
            ? `上下文容量 ${fmtTk(used)} / ${fmtTk(windowTok)} tk（${pct.toFixed(1)}%）· 悬停查看`
            : '上下文容量'
        }
        onClick={() => setOpen(!open)}
      >
        {compact ? (
          <svg className="ctx-ring" width="14" height="14" viewBox="0 0 14 14" aria-label="上下文容量">
            <circle className="ctx-ring-bg" cx="7" cy="7" r={RING_R} />
            <circle
              className="ctx-ring-fill"
              cx="7"
              cy="7"
              r={RING_R}
              strokeDasharray={RING_C}
              strokeDashoffset={RING_C * (1 - Math.min(pct, 100) / 100)}
            />
          </svg>
        ) : (
          <>⧉ {fmtTk(used)}</>
        )}
        {!compact && <span className="usage-caret">▾</span>}
      </button>
      {open && (
        <div className="usage-pop ctx-pop">
          <div className="ctx-title">上下文容量</div>
          <div className="ctx-big">
            {fmtTk(used)} / {fmtTk(windowTok)}{' '}
            <span className="ctx-pct">({pct.toFixed(1)}%)</span>
          </div>
          <div className="ctx-bar">
            <div className="ctx-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="ctx-rows">
            {rows.map((r, i) => {
              const rpct = used > 0 ? (r.tokens / used) * 100 : 0;
              return (
                <div className="ctx-row" key={r.label}>
                  <span className="ctx-dot" style={{ background: ROW_COLORS[i % ROW_COLORS.length] }} />
                  <span className="ctx-label">{r.label}</span>
                  <span className="ctx-val">
                    {rpct.toFixed(1)}% · {fmtTk(r.tokens)}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="ctx-cache">
            <span className="ctx-cache-label">平均缓存命中率</span>
            <span className="ctx-cache-val">{cacheRate}</span>
          </div>
        </div>
      )}
    </div>
  );
}

const ROW_COLORS = ['#4da3ff', '#3fb96a', '#d9a53a', '#8b93a5'];
