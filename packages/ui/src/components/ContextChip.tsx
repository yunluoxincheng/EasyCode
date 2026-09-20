import { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';
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

const DEFAULT_WINDOW = 1_000_000;

/** 上下文容量 chip + 面板（ZCode 同款）：当前会话在模型上下文窗口中的精确占用 */
export function ContextChip() {
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
  // 分类精确计数
  const rows: Array<{ label: string; tokens: number }> = [];
  let msgTokens = 0;
  const countTurnItems = (items: { kind: string }[]): void => {
    for (const it of items) {
      if (it.kind === 'assistant') {
        for (const b of (it as unknown as { blocks: { type: string; text: string }[] }).blocks) {
          msgTokens += count(b.text);
        }
      } else if (it.kind === 'tool') {
        const t = it as unknown as { input: unknown; result?: string };
        msgTokens += count(JSON.stringify(t.input ?? {}));
        msgTokens += count(t.result ?? '');
      } else if (it.kind === 'approval') {
        msgTokens += count(JSON.stringify((it as unknown as { input: unknown }).input ?? {}));
      }
    }
  };
  for (const it of store.items) {
    if (it.kind === 'user') msgTokens += count(it.text);
    else if (it.kind === 'turn') countTurnItems(it.items);
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
  rows.push({ label: '系统工具', tokens: count(JSON.stringify(createBuiltinTools(builtinSearch).listSpecs())) });

  const stubHost = {
    paths: { sep: navigator.platform.includes('Win') ? '\\' : '/' },
  } as unknown as Host;
  rows.push({
    label: '系统提示词',
    tokens: count(buildSystemPrompt(stubHost, session.workspaceRoot, { webSearch: searchOn })),
  });

  const other = store.items.length * 4; // 每条消息的角色/框架开销
  rows.push({ label: '其他', tokens: other });

  const used = rows.reduce((a, r) => a + r.tokens, 0);
  const pct = Math.min(100, (used / windowTok) * 100);

  // 平均缓存命中率 = 累计缓存 / 累计输入
  const su = store.sessionUsage;
  const cacheRate =
    su.input > 0 && su.cached > 0 ? `${((su.cached / su.input) * 100).toFixed(1)}%` : '0%';

  return (
    <div className="usage-wrap" ref={ref}>
      <button className="chip ctx-chip" title="上下文容量" onClick={() => setOpen(!open)}>
        ⧉ {fmtTk(used)}
        <span className="usage-caret">▾</span>
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
