import { useEffect, useState } from 'react';
import type { ToolItem } from '../store.js';
import './task-card.css';

/** 子过程只作只读回放，始终使用文本节点，不能变成主会话消息或可执行输入。 */
export function TaskCard({ item }: { item: ToolItem }) {
  const task = item.delegatedTask;
  const [now, setNow] = useState(Date.now);
  const status = task?.status ?? (item.status === 'running' ? 'running' : item.status === 'ok' ? 'completed' : item.status === 'denied' ? 'denied' : 'error');
  useEffect(() => {
    if (status !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status, task?.id]);
  const input = item.input as { description?: unknown } | undefined;
  const description = task?.description ?? (typeof input?.description === 'string' ? input.description : '只读探索');
  const elapsed = Math.max(0, (task?.finishedAt ?? now) - (task?.startedAt ?? item.startedAt ?? now));
  let summary = task?.summary;
  if (!task && item.status === 'ok' && item.result) {
    try { const result = JSON.parse(item.result); if (typeof result.summary === 'string') summary = result.summary.slice(0, 6000); }
    catch { /* 非结论结果沿用下面的错误/原文显示。 */ }
  }
  const label = status === 'completed' ? '[ OK ] 已完成' : status === 'aborted' ? '[ WAIT ] 已中止'
    : status === 'denied' ? '[ DENY ] 已拒绝' : status === 'error' ? '[ ERR ] 失败' : task ? '[ WAIT ] 探索中' : '[ WAIT ] 准备委派';
  return <section className={`delegated-task-card status-${status}`} aria-label="只读子任务">
    <div className="delegated-task-head">
      <span className="delegated-task-status" role="status">{label}</span>
      <span>只读子任务</span>
      <span className="delegated-task-duration">{task?.recovered ? '恢复时已中断' : `${(elapsed / 1000).toFixed(1)}s`}</span>
    </div>
    <div className="delegated-task-description">{description}</div>
    {task && <div className="delegated-task-usage">{task.usage.steps} 步
      {(task.usage.input > 0 || task.usage.output > 0) && ` · tokens in/out: ${task.usage.input}/${task.usage.output}`}
    </div>}
    {summary && <pre className="delegated-task-summary">{summary}</pre>}
    {(task?.error || (!task && item.result && !summary)) && <pre className="delegated-task-error">{task?.error ?? item.result}</pre>}
    {task && <details className="delegated-task-process">
      <summary>[ 查看子任务过程 ]{task.traceTruncated ? ' · 仅保留最近过程' : ''}</summary>
      <div className="delegated-task-trace" tabIndex={0} role="region" aria-label="子任务只读过程">
        {task.trace.length === 0 ? <div className="delegated-task-empty">暂无过程输出</div> : task.trace.map((entry, index) =>
          <div className="delegated-task-entry" key={`${entry.at}-${index}`}>
            <span className="delegated-task-entry-kind">{entry.kind === 'thinking' ? '思考' : entry.kind === 'text' ? '输出' : entry.kind === 'tool' ? '调用' : entry.kind === 'result' ? '结果' : '错误'}{entry.tool ? ` · ${entry.tool}` : ''}</span>
            <pre>{entry.content}</pre>
          </div>)}
      </div>
    </details>}
    {!task && summary && <div className="delegated-task-empty">结论保留在会话中，过程记录已超出保留范围</div>}
  </section>;
}
