import { useState } from 'react';
import type { TestRunItem } from '../store.js';

/**
 * 测试自愈循环单轮结果卡片（TODOS #39）：
 * 极客终端风展示轮次、命令、用时、通过/失败统计与失败用例清单，可展开原始日志尾部。
 */
export function TestRunCard({ item }: { item: TestRunItem }) {
  const [open, setOpen] = useState(false);
  const summary = item.summary;
  const running = item.status === 'running';
  const ok = item.status === 'passed';
  const exitLabel =
    item.exitCode === undefined || item.exitCode === null
      ? ''
      : ` · exit ${item.exitCode}`;
  const counts: string[] = [];
  if (summary?.passed !== undefined) counts.push(`通过 ${summary.passed}`);
  if (summary?.failed !== undefined) counts.push(`失败 ${summary.failed}`);
  if (summary?.total !== undefined) counts.push(`共 ${summary.total}`);
  const duration =
    item.durationMs === undefined ? '' : ` · ${(item.durationMs / 1000).toFixed(1)}s`;
  const failures = summary?.failures ?? [];

  return (
    <div className={`testrun-card ${running ? 'running' : ok ? 'passed' : 'failed'}`}>
      <button
        className="testrun-head"
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={item.outputTail ? '展开/收起原始测试输出' : '本轮无原始输出'}
      >
        <span className="testrun-caret">{open ? '▾' : '▸'}</span>
        <span className="testrun-badge">
          [ TEST {item.round}/{item.maxRounds} ]
        </span>
        <span className="testrun-cmd" title={item.command}>
          {item.command}
        </span>
        <span className="spacer" />
        {running ? (
          <span className="testrun-status waiting">◍ 运行中…</span>
        ) : (
          <span className={`testrun-status ${ok ? 'ok' : 'err'}`}>
            {ok ? '✓ 全部通过' : '✕ 存在失败'}
            {counts.length > 0 ? ` · ${counts.join(' / ')}` : ''}
            {exitLabel}
            {duration}
          </span>
        )}
      </button>
      {item.focus && <div className="testrun-focus">聚焦范围: {item.focus}</div>}
      {failures.length > 0 && (
        <div className="testrun-failures">
          <div className="testrun-failures-title">失败用例（{failures.length}）</div>
          <ul>
            {failures.map((name, idx) => (
              <li key={idx} title={name}>
                {name}
              </li>
            ))}
          </ul>
        </div>
      )}
      {open && (
        <div className="testrun-output">
          <div className="testrun-output-head">
            <span>原始输出（尾部）</span>
            <span className="testrun-output-src">探测来源: {item.source}</span>
          </div>
          <pre>{item.outputTail?.trim() || '（本轮无输出）'}</pre>
        </div>
      )}
    </div>
  );
}
