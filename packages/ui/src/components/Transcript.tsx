import { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';
import { renderMarkdown } from '../markdown.js';
import { diffLines } from '@easycode/core';
import type {
  ApprovalItem,
  AssistantItem,
  ErrorItem,
  ToolItem,
  TranscriptItem,
  TurnItem,
  UserItem,
  ViewBlock,
} from '../store.js';

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
  web_search: '联网搜索',
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
    case 'web_search':
      return String(i.query ?? '');
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
function ToolCard({ item }: { item: ToolItem }) {
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

/** 审批卡片（内联在回合里） */
function ApprovalCard({ item }: { item: ApprovalItem }) {
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

function ItemView({ item }: { item: AssistantItem | ToolItem | ApprovalItem | ErrorItem }) {
  switch (item.kind) {
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

function fmtDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/** 折叠时可见的最终结果：最后一个工具/审批之后的助手文本 */
function finalTextOf(turn: TurnItem): string {
  let out = '';
  for (const it of turn.items) {
    if (it.kind === 'tool' || it.kind === 'approval') out = '';
    else if (it.kind === 'assistant') {
      const text = it.blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text) out += (out ? '\n\n' : '') + text;
    }
  }
  return out.trim();
}

/** 复制按钮：悬停显现，点击后短暂反馈 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-btn"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? '已复制' : '复制'}
    </button>
  );
}

/** 用户消息：气泡 + 时间 + 复制 */
function UserView({ item }: { item: UserItem }) {
  const [copied, setCopied] = useState(false);
  const time = item.ts
    ? new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  return (
    <div className="msg user" data-anchor={item.id}>
      <div className="msg-content">{item.text}</div>
      <div className="msg-meta">
        {time && <span className="msg-time">{time}</span>}
        <button
          className="msg-copy"
          title="复制"
          onClick={() => {
            void navigator.clipboard.writeText(item.text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
    </div>
  );
}

/** 回合块：头部（用时）+ 折叠的过程 + 常显的最终结果 */
function TurnView({ turn }: { turn: TurnItem }) {
  const store = useStore();
  const live = store.running && turn.durationMs === undefined;
  const expanded = live ? true : !turn.collapsed;
  const elapsed = turn.durationMs ?? Date.now() - turn.startedAt;
  const finalText = finalTextOf(turn);
  const errors = turn.items.filter((i): i is ErrorItem => i.kind === 'error');

  return (
    <div className={`turn ${expanded ? 'expanded' : 'collapsed'}`} data-anchor={turn.id}>
      <div className="turn-head">
        <button
          className="turn-head-toggle"
          onClick={() => store.toggleTurn(turn.id)}
          title={expanded ? '折叠过程' : '展开过程'}
        >
          <span className="turn-caret">{expanded ? '▾' : '▸'}</span>
          <span>
            用时 {fmtDuration(elapsed)}
            {live && <span className="turn-live"> · 运行中</span>}
          </span>
        </button>
        <span className="spacer" />
        {finalText && <CopyButton text={finalText} />}
      </div>
      {expanded && (
        <div className="turn-body">
          {turn.items.map((it) => (
            <ItemView key={it.id} item={it} />
          ))}
        </div>
      )}
      {!expanded && (
        <div className="turn-final">
          {finalText ? <Md text={finalText} /> : null}
          {errors.map((e) => (
            <div key={e.id} className="error-line">
              {e.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Transcript() {
  const store = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ frac: number; text: string } | null>(null);
  const [posFrac, setPosFrac] = useState(0);
  const [tickCount, setTickCount] = useState(0);
  const anchorsRef = useRef<{ top: number; text: string }[]>([]);

  // 仅发送消息与切换会话时滚到底部；流式输出/工具事件不滚动（#3）
  useEffect(() => {
    if (!store.autoScrollOn) return;
    bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [store.scrollTick, store.activeId, store.autoScrollOn]);

  /** 测量：锚点位置（预览/跳转用）+ 当前滚动比例（刻度高亮用） */
  const measure = (): void => {
    const el = scrollRef.current;
    const rail = railRef.current;
    if (!el || !rail) return;
    const maxScroll = el.scrollHeight - el.clientHeight;
    setPosFrac(maxScroll > 0 ? el.scrollTop / maxScroll : 0);
    anchorsRef.current = [...el.querySelectorAll<HTMLElement>('[data-anchor]')].map((n) => ({
      top: n.offsetTop,
      // 优先取正文（排除复制按钮等操作文本）
      text: (n.querySelector('.msg-content, .turn-final') ?? n).textContent?.slice(0, 200) ?? '',
    }));
    setTickCount(Math.max(2, Math.floor(rail.clientHeight / 22)));
  };

  useEffect(() => {
    measure();
  }, [store.version, store.activeId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      const maxScroll = el.scrollHeight - el.clientHeight;
      setPosFrac(maxScroll > 0 ? el.scrollTop / maxScroll : 0);
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(rail);
    return () => ro.disconnect();
  }, []);

  /** 该滚动比例处可见的内容锚点文本 */
  const anchorAtFrac = (frac: number): string => {
    const el = scrollRef.current;
    if (!el) return '';
    const maxScroll = el.scrollHeight - el.clientHeight;
    const probe = frac * Math.max(0, maxScroll) + el.clientHeight * 0.4;
    let best = '';
    for (const a of anchorsRef.current) {
      if (a.top <= probe) best = a.text;
      else break;
    }
    return best;
  };

  const scrollToFraction = (frac: number): void => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = frac * Math.max(0, el.scrollHeight - el.clientHeight);
  };

  const count = Math.max(2, tickCount);
  const ticks: number[] = Array.from({ length: count }, (_, i) => i / (count - 1));
  const curIdx = posFrac > 0 ? Math.round(posFrac * (count - 1)) : 0;

  return (
    <main className="transcript has-rail">
      <div className="rail" ref={railRef}>
        {ticks.map((f, i) => (
          <div
            key={f}
            className={`rail-tick ${i === curIdx ? 'current' : ''}`}
            style={{ top: `${f * 100}%` }}
            onMouseEnter={() => setHover({ frac: f, text: anchorAtFrac(f) })}
            onMouseLeave={() => setHover(null)}
            onClick={() => scrollToFraction(f)}
          />
        ))}
        {hover && (
          <div
            className="rail-preview"
            style={{ top: `calc(${Math.min(85, Math.max(3, hover.frac * 100))}% - 12px)` }}
          >
            {hover.text || '（此处无内容）'}
          </div>
        )}
      </div>
      <div className="transcript-scroll" ref={scrollRef}>
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
        {store.items.map((item) =>
          item.kind === 'user' ? (
            <UserView key={item.id} item={item} />
          ) : (
            <TurnView key={item.id} turn={item} />
          ),
        )}
        <div ref={bottomRef} />
      </div>
    </main>
  );
}
