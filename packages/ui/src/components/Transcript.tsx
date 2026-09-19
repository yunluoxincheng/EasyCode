import { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';
import { renderMarkdown } from '../markdown.js';
import { diffLines } from '@easycode/core';
import type { TranscriptItem, ViewBlock } from '../store.js';

/** Markdown 渲染（含代码块样式钩子） */
function Md({ text }: { text: string }) {
  return <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

/** 思考过程：可折叠的暗色引用块 */
function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="thinking" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>思考过程</summary>
      <div className="thinking-body">{text}</div>
    </details>
  );
}

const TOOL_LABELS: Record<string, string> = {
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  list_dir: '列出目录',
  search_files: '搜索文件',
  run_command: '执行命令',
};

/** 工具输入摘要（单行） */
function inputSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return String(i.path ?? '');
    case 'list_dir':
      return String(i.path ?? '.');
    case 'search_files':
      return String(i.pattern ?? '');
    case 'run_command':
      return String(i.command ?? '');
    default:
      return JSON.stringify(i).slice(0, 80);
  }
}

/** 若工具是文件写入/编辑，给出 diff 视图 */
function ToolDiff({ name, input }: { name: string; input: unknown }) {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === 'write_file' && typeof i.path === 'string') {
    const lines = String(i.content ?? '').split('\n');
    return (
      <div className="diff">
        <div className="diff-head">{i.path} · 新文件 · {lines.length} 行</div>
        <pre>{lines.slice(0, 200).map((l) => `+ ${l}`).join('\n')}</pre>
      </div>
    );
  }
  return null;
}

/** 工具调用卡片 */
function ToolCard({ item }: { item: Extract<TranscriptItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const statusIcon =
    item.status === 'running' ? 'RUN' : item.status === 'ok' ? 'OK' : item.status === 'denied' ? 'DENY' : 'ERR';
  return (
    <div className={`tool-card status-${item.status} ${open ? 'open' : ''}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className={`tool-status ${item.status}`}>{statusIcon}</span>
        <span className="tool-name">{TOOL_LABELS[item.name] ?? item.name}</span>
        <span className="tool-summary">{inputSummary(item.name, item.input)}</span>
        {item.durationMs !== undefined && <span className="tool-duration">{item.durationMs}ms</span>}
        <span className="tool-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-body">
          <ToolDiff name={item.name} input={item.input} />
          <div className="kv">
            <span className="k">输入</span>
            <pre>{JSON.stringify(item.input, null, 2)}</pre>
          </div>
          {item.result !== undefined && (
            <div className="kv">
              <span className="k">结果</span>
              <pre className={item.status === 'error' ? 'err' : ''}>{item.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 审批卡片（内联在时间线里） */
function ApprovalCard({ item }: { item: Extract<TranscriptItem, { kind: 'approval' }> }) {
  const store = useStore();
  const i = (item.input ?? {}) as Record<string, unknown>;
  const headline =
    item.name === 'run_command'
      ? `执行命令：${String(i.command ?? '')}`
      : `${TOOL_LABELS[item.name] ?? item.name}：${String(i.path ?? '')}`;
  return (
    <div className={`approval-card ${item.status}`}>
      <div className="approval-head">需要你的批准 · {TOOL_LABELS[item.name] ?? item.name}</div>
      <div className="approval-body">
        <code>{headline}</code>
        {item.name === 'write_file' && typeof i.content === 'string' && (
          <pre className="approval-content">{i.content.slice(0, 2000)}</pre>
        )}
      </div>
      {item.status === 'pending' ? (
        <div className="approval-actions">
          <button className="btn danger" onClick={() => store.respondApproval(item.requestId, false)}>
            拒绝
          </button>
          <button className="btn primary" onClick={() => store.respondApproval(item.requestId, true)}>
            批准执行
          </button>
        </div>
      ) : (
        <div className={`approval-state ${item.status}`}>
          {item.status === 'approved' ? '已批准' : '已拒绝'}
        </div>
      )}
    </div>
  );
}

function ItemView({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg user">
          <div className="msg-content">{item.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className="msg assistant">
          <div className="msg-content">
            {item.blocks.map((b: ViewBlock, idx: number) =>
              b.type === 'thinking' ? (
                <Thinking key={idx} text={b.text} />
              ) : (
                <Md key={idx} text={b.text} />
              ),
            )}
          </div>
        </div>
      );
    case 'tool':
      return <ToolCard item={item} />;
    case 'approval':
      return <ApprovalCard item={item} />;
    case 'error':
      return <div className="error-line">{item.message}</div>;
  }
}

export function Transcript() {
  const store = useStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [store.items]);

  return (
    <main className="transcript">
      {store.items.length === 0 && (
        <div className="hero">
          <h1>EasyCode</h1>
          <p>轻量、模块化的桌面 Coding Agent</p>
          <ul>
            <li>绑定一个工作区，用自然语言描述任务</li>
            <li>Agent 会读文件、搜索、改代码、跑命令</li>
            <li>敏感操作需要你批准（可在设置切换 YOLO 模式）</li>
          </ul>
        </div>
      )}
      {store.items.map((item) => (
        <ItemView key={item.id} item={item} />
      ))}
      <div ref={bottomRef} />
    </main>
  );
}
