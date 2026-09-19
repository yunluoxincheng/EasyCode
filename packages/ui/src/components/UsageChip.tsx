import { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';
import type { Usage } from '@easycode/core';

function fmtTk(n: number | undefined): string {
  const v = n ?? 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

/** token 用量 chip + 明细 popover（累计输入/输出/合计/步数/最近一步） */
export function UsageChip() {
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

  const u: Usage | null = store.lastUsage;
  if (!u) return null;

  const su = store.sessionUsage;
  const total = (su.input ?? 0) + (su.output ?? 0);

  return (
    <div className="usage-wrap" ref={ref}>
      <button
        className="chip usage-chip"
        title="用量明细"
        onClick={() => setOpen(!open)}
      >
        ↑{fmtTk(u.inputTokens)} ↓{fmtTk(u.outputTokens)} tk
        <span className="usage-caret">▾</span>
      </button>
      {open && (
        <div className="usage-pop">
          <div className="usage-pop-title">用量明细</div>
          <table className="usage-table">
            <tbody>
              <tr><td>累计输入</td><td>{su.input.toLocaleString()} tk</td></tr>
              <tr><td>累计输出</td><td>{su.output.toLocaleString()} tk</td></tr>
              <tr><td>累计合计</td><td>{total.toLocaleString()} tk</td></tr>
              <tr><td>步数</td><td>{su.steps}</td></tr>
              <tr className="hl">
                <td>最近一步</td>
                <td>↑{u.inputTokens ?? 0} ↓{u.outputTokens ?? 0} tk</td>
              </tr>
            </tbody>
          </table>
          <p className="hint">累计为本会话所有请求之和</p>
        </div>
      )}
    </div>
  );
}
