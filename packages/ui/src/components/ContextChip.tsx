import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../useStore.js';
import { estimateSessionTokens } from '../context-tokens.js';

function fmtTk(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : n.toLocaleString();
}

/** 紧凑态进度环（TODOS #20）：半径与周长，SVG 逆时针从顶部起描 */
const RING_R = 5.5;
const RING_C = 2 * Math.PI * RING_R;

/** 上下文容量 chip + 面板（ZCode 同款）：当前会话在模型上下文窗口中的精确占用；紧凑态收敛为进度环 + 悬停浮出看板（TODOS #20） */
export function ContextChip({ compact = false }: { compact?: boolean }) {
  const store = useStore();
  const session = store.activeSession;
  const activeId = session?.id;
  const running = store.running;
  const [open, setOpen] = useState(false);
  const [sampledVersion, setSampledVersion] = useState(store.version);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeId || !running) return;
    // 固定周期采样而非每个 delta 重置防抖，持续输出时也能更新，
    // 尾部增量即使暂时停止也会在下一次采样中计入。
    const timer = setInterval(() => setSampledVersion(store.version), 200);
    return () => clearInterval(timer);
  }, [store, activeId, running]);

  const displayVersion = running ? sampledVersion : store.version;
  // 只缓存显示值；模型切换仍直接调用同步 estimateSessionTokens()。
  // 结构/配置/会话/运行状态改变时越过采样周期，立即刷新。
  const estimate = useMemo(() => estimateSessionTokens(store), [
    store,
    activeId,
    session?.providerId,
    session?.model,
    session?.workspaceRoot,
    store.settings,
    store.mcpCatalogVersion,
    store.structureVersion,
    running,
    displayVersion,
  ]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!session) return null;

  const { used, windowTok, pct, rows } = estimate;
  const isWarn = pct >= 80 && pct < 95;
  const isDanger = pct >= 95;
  const userTurns = store.items.filter((it) => it.kind === 'user').length;

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
        className={`chip ctx-chip ${isDanger ? 'ctx-danger' : isWarn ? 'ctx-warn' : ''}`}
        title={
          compact
            ? `上下文容量 ${fmtTk(used)} / ${fmtTk(windowTok)} tk（${pct.toFixed(1)}%）${
                isDanger ? ' · 严重超限风险' : isWarn ? ' · 接近警戒线' : ''
              } · 悬停查看`
            : '上下文容量'
        }
        onClick={() => setOpen(!open)}
      >
        {compact ? (
          <svg
            className={`ctx-ring ${isDanger ? 'danger' : isWarn ? 'warn' : ''}`}
            width="14"
            height="14"
            viewBox="0 0 14 14"
            aria-label="上下文容量"
          >
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
          <>
            {isDanger ? '🚨 ' : isWarn ? '⚠ ' : '⧉ '}
            {fmtTk(used)}
          </>
        )}
        {!compact && <span className="usage-caret">▾</span>}
      </button>
      {open && (
        <div className="usage-pop ctx-pop">
          <div className="ctx-title">上下文容量</div>
          <div className="ctx-big">
            {fmtTk(used)} / {fmtTk(windowTok)}{' '}
            <span className={`ctx-pct ${isDanger ? 'danger' : isWarn ? 'warn' : ''}`}>
              ({pct.toFixed(1)}%)
            </span>
          </div>

          {isDanger && (
            <div className="ctx-pop-alert danger">
              🚨 上下文已接近极限（{pct.toFixed(1)}%），请立即压缩以防调用崩溃！
            </div>
          )}
          {!isDanger && isWarn && (
            <div className="ctx-pop-alert warn">
              ⚠ 上下文使用率已达 {pct.toFixed(1)}% 推荐安全阈值，建议压缩
            </div>
          )}

          <div className="ctx-bar">
            <div
              className={`ctx-bar-fill ${isDanger ? 'danger' : isWarn ? 'warn' : ''}`}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
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
          <div className="ctx-pop-foot">
            <button
              className="proj-foot-item ctx-compact-btn"
              disabled={store.running || userTurns <= 1}
              title={
                userTurns <= 1
                  ? '单轮对话无需压缩'
                  : '智能归档早期轮次并修剪旧工具长输出，释放 Token 空间'
              }
              onClick={() => {
                setOpen(false);
                void store.compressContext();
              }}
            >
              ✄ 压缩上下文（归档早期历史）
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const ROW_COLORS = ['#4da3ff', '#3fb96a', '#d9a53a', '#8b93a5'];
