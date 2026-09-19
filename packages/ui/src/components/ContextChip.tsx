import { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';
import { createBuiltinTools, type Host } from '@easycode/core';
import { buildSystemPrompt } from '@easycode/engine';

/** 粗略 token 估算：中英混合按 2 字符 ≈ 1 token（入参为字符数） */
function est(chars: number): number {
  return Math.ceil(chars / 2);
}
function fmtTk(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : n.toLocaleString();
}
function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

const ROW_COLORS = ['#4da3ff', '#3fb96a', '#d9a53a', '#8b93a5'];

/** 上下文容量 chip + 面板（ZCode 同款）：当前会话在模型上下文窗口中的占用估算 */
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
  const windowTok = provider?.contextWindow ?? 128000;

  // 分类估算（打开面板时计算一次）
  const rows: Array<{ label: string; tokens: number }> = [];
  let msgChars = 0;
  for (const it of store.items) {
    if (it.kind === 'user') msgChars += it.text.length;
    else if (it.kind === 'assistant')
      for (const b of it.blocks) msgChars += b.text.length;
    else if (it.kind === 'tool') {
      msgChars += JSON.stringify(it.input ?? {}).length;
      msgChars += (it.result ?? '').length;
    } else if (it.kind === 'approval') msgChars += JSON.stringify(it.input ?? {}).length;
  }
  rows.push({ label: '消息', tokens: est(msgChars) });

  const toolChars = JSON.stringify(createBuiltinTools().listSpecs()).length;
  rows.push({ label: '系统工具', tokens: est(toolChars) });

  const stubHost = {
    paths: { sep: navigator.platform.includes('Win') ? '\\' : '/' },
  } as unknown as Host;
  const sysPrompt = buildSystemPrompt(stubHost, session.workspaceRoot);
  rows.push({ label: '系统提示词', tokens: est(sysPrompt.length) });

  const other = store.items.length * 8; // 每条消息的角色/框架开销
  rows.push({ label: '其他', tokens: other });

  const used = rows.reduce((a, r) => a + r.tokens, 0);
  const pct = Math.min(100, (used / windowTok) * 100);

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
          <p className="hint">按 2 字符 ≈ 1 token 估算；在供应商设置中可配置上下文窗口大小{session.workspaceRoot ? '' : '（未绑定项目，消息类工具不可用）'}。</p>
        </div>
      )}
    </div>
  );
}

export { baseName };
