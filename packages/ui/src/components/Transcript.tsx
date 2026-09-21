import { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';
import { renderMarkdown } from '../markdown.js';
import { renderAnsi } from '../ansi.js';
import { diffLines, type TodoItem } from '@easycode/core';
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

/** 思考过程折叠卡片：统一终端极客风、支持吸顶、一键复制与字符统计 */
function Thinking({ text, live }: { text: string; live?: boolean }) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const open = userToggled !== null ? userToggled : Boolean(live);
  const charCount = text.length;
  const summaryText = charCount >= 1000 ? `${(charCount / 1000).toFixed(1)}k 字推理` : `${charCount} 字推理`;

  return (
    <div className={`thinking-card ${open ? 'open' : 'closed'}`}>
      <button
        className="thinking-head"
        onClick={() => setUserToggled(!open)}
        type="button"
        title={open ? '收起思考过程' : '展开思考过程'}
      >
        <span className={`thinking-badge ${live ? 'live' : ''}`}>
          {live ? '[ THINK · 思考中... ]' : '[ THINK ]'}
        </span>
        <span className="thinking-title">思考过程</span>
        <span className="thinking-summary">{summaryText}</span>
        <span className="spacer" />
        <span className="thinking-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="thinking-body">
          <div className="thinking-toolbar">
            <span className="thinking-toolbar-label">// 推理思考内容</span>
            <CopyButton text={text} />
          </div>
          <div className="thinking-content">{text}</div>
        </div>
      )}
    </div>
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
  todo_write: '任务清单',
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
    case 'todo_write': {
      const todos = Array.isArray(i.todos) ? i.todos : [];
      const done = todos.filter((t: any) => t?.status === 'completed').length;
      return `进度 ${done}/${todos.length}`;
    }
    default:
      return JSON.stringify(i).slice(0, 80);
  }
}

/** 若工具是文件写入/编辑，给出结构化 diff 视图 */
function ToolDiff({ name, input }: { name: string; input: unknown }) {
  const i = (input ?? {}) as Record<string, unknown>;
  if (typeof i.path !== 'string') return null;

  if (name === 'write_file') {
    const lines = String(i.content ?? '').split('\n');
    const displayLines = lines.slice(0, 200);
    return (
      <div className="diff">
        <div className="diff-head">
          <span className="diff-path">{i.path}</span>
          <span className="diff-tag write">新文件 · {lines.length} 行</span>
        </div>
        <div className="diff-lines">
          {displayLines.map((l, idx) => (
            <div key={idx} className="diff-line add">
              <span className="diff-no new">{idx + 1}</span>
              <span className="diff-prefix">+</span>
              <span className="diff-text">{l}</span>
            </div>
          ))}
          {lines.length > 200 && (
            <div className="diff-fold">… 其余 {lines.length - 200} 行已省略</div>
          )}
        </div>
      </div>
    );
  }

  if (name === 'edit_file') {
    const oldStr = typeof i.old_string === 'string' ? i.old_string : '';
    const newStr = typeof i.new_string === 'string' ? i.new_string : '';
    const isReplaceAll = Boolean(i.replace_all);
    const diff = diffLines(oldStr, newStr);
    const delCount = diff.filter((d) => d.type === 'del').length;
    const addCount = diff.filter((d) => d.type === 'add').length;

    let oldNo = 1;
    let newNo = 1;
    const displayDiff = diff.slice(0, 300);

    return (
      <div className="diff">
        <div className="diff-head">
          <span className="diff-path">{i.path}</span>
          <span className="diff-tag edit">修改代码</span>
          {isReplaceAll && <span className="diff-badge-all">全局替换</span>}
          <span className="diff-stats">
            {delCount > 0 && <span className="diff-stat-del">-{delCount}</span>}
            {addCount > 0 && <span className="diff-stat-add">+{addCount}</span>}
          </span>
        </div>
        <div className="diff-lines">
          {displayDiff.map((d, idx) => {
            let oLine = '';
            let nLine = '';
            if (d.type === 'same') {
              oLine = String(oldNo++);
              nLine = String(newNo++);
            } else if (d.type === 'del') {
              oLine = String(oldNo++);
            } else if (d.type === 'add') {
              nLine = String(newNo++);
            }
            return (
              <div key={idx} className={`diff-line ${d.type}`}>
                <span className="diff-no old">{oLine}</span>
                <span className="diff-no new">{nLine}</span>
                <span className="diff-prefix">
                  {d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' '}
                </span>
                <span className="diff-text">{d.text}</span>
              </div>
            );
          })}
          {diff.length > 300 && (
            <div className="diff-fold">… 其余 {diff.length - 300} 行差异已折叠</div>
          )}
        </div>
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
          {/* 文件修改类工具已有结构化 Diff 视窗，raw JSON 输入纯属重复且挤占视线（TODOS #23） */}
          {item.name !== 'write_file' && item.name !== 'edit_file' && (
            <div className="kv">
              <span className="k">输入</span>
              <pre>{JSON.stringify(item.input, null, 2)}</pre>
            </div>
          )}
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

/** run_command 拟终端控制台卡片（TODOS #21） */
function TerminalCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const i = (item.input ?? {}) as { command?: string; timeout_ms?: number };
  const command = String(i.command ?? '');

  // 解析第一行退出码并与输出文本分离
  const parsed = (() => {
    if (item.result === undefined) return null;
    const match = item.result.match(/^退出码:\s*(\d+|signal)\r?\n?/);
    if (!match) return { exitCode: null, isSuccess: item.status === 'ok', text: item.result };
    const exitCode = match[1];
    const isSuccess = exitCode === '0';
    const text = item.result.slice(match[0].length);
    return { exitCode, isSuccess, text };
  })();

  const isRunning = item.status === 'running';
  const statusClass = isRunning
    ? 'running'
    : parsed
      ? parsed.isSuccess
        ? 'ok'
        : 'error'
      : item.status;

  return (
    <div className={`term-card status-${statusClass} ${open ? 'open' : 'closed'}`}>
      <button className="term-head" onClick={() => setOpen(!open)} type="button">
        <span className={`term-status-badge ${statusClass}`}>
          {isRunning ? 'RUN' : parsed ? (parsed.isSuccess ? 'OK' : 'ERR') : statusClass.toUpperCase()}
        </span>
        <span className="term-cmd-preview">$ {command}</span>
        {parsed?.exitCode !== null && parsed?.exitCode !== undefined && (
          <span className={`term-exit-badge ${parsed.isSuccess ? 'ok' : 'err'}`}>
            exit: {parsed.exitCode}
          </span>
        )}
        {item.durationMs !== undefined && <span className="term-duration">{item.durationMs}ms</span>}
        <span className="spacer" />
        <span className="term-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="term-body">
          <div className="term-bar">
            <span className="term-bar-title">// 控制台输出</span>
            {parsed?.text && <CopyButton text={parsed.text} />}
          </div>
          <div className="term-screen">
            {isRunning && !parsed && (
              <div className="term-running-line">
                <span className="term-prompt">$</span> {command} <span className="term-cursor">█</span>
              </div>
            )}
            {parsed && (
              parsed.text.trim().length > 0 ? (
                <pre className="term-pre">{renderAnsi(parsed.text)}</pre>
              ) : (
                <div className="term-empty">(命令已执行完成，控制台无输出)</div>
              )
            )}
          </div>
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
        {(item.name === 'write_file' || item.name === 'edit_file') && (
          <ToolDiff name={item.name} input={item.input} />
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

/** 任务清单卡片：以极客面板展示待办、进行中、已完成的步骤与总进度 */
function TodoCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(true);
  const i = (item.input ?? {}) as { todos?: TodoItem[] };
  const todos = Array.isArray(i.todos) ? i.todos : [];
  const completed = todos.filter((t) => t.status === 'completed').length;
  const inProgress = todos.filter((t) => t.status === 'in_progress').length;
  const total = todos.length;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className={`todo-card ${open ? 'open' : 'closed'} ${item.status === 'error' ? 'err' : ''}`}>
      <button className="todo-head" onClick={() => setOpen(!open)} type="button">
        <span className="todo-status-tag">
          {inProgress > 0 ? (
            <span className="todo-tag-live">◍ 进度 {completed}/{total}</span>
          ) : completed === total && total > 0 ? (
            <span className="todo-tag-done">✓ 已完成 {completed}/{total}</span>
          ) : (
            <span className="todo-tag-pending">○ 进度 {completed}/{total}</span>
          )}
        </span>
        <span className="todo-title">任务清单</span>
        <span className="todo-percent">{percent}%</span>
        <span className="spacer" />
        <span className="todo-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="todo-body">
          <div className="todo-list">
            {todos.map((todo, idx) => {
              const statusClass = `status-${todo.status}`;
              const icon =
                todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◍' : '○';
              return (
                <div key={idx} className={`todo-row ${statusClass}`}>
                  <span className={`todo-icon ${statusClass}`}>{icon}</span>
                  <span className="todo-text">{todo.content}</span>
                  {todo.priority && (
                    <span className={`todo-pri pri-${todo.priority}`}>
                      [{todo.priority.toUpperCase()}]
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {item.status === 'error' && item.result && (
            <div className="todo-error-hint">{item.result}</div>
          )}
        </div>
      )}
    </div>
  );
}

function ItemView({ item }: { item: AssistantItem | ToolItem | ApprovalItem | ErrorItem }) {
  switch (item.kind) {
    case 'assistant': {
      // 思考过程已统一汇聚在回合顶部单一呈现，此处仅渲染助手实际回复的正文文本；无文本时不渲染空外框
      const textBlocks = item.blocks.filter((b) => b.type === 'text' && b.text.trim().length > 0);
      if (textBlocks.length === 0) return null;
      return (
        <div className="msg assistant">
          <div className="msg-content">
            {textBlocks.map((b: ViewBlock, idx: number) => (
              <Md key={idx} text={b.text} />
            ))}
          </div>
        </div>
      );
    }
    case 'tool':
      if (item.name === 'todo_write') {
        // 独立视窗内移除重复的 TodoCard，仅保留顶部吸顶任务清单与回合折叠态汇总
        return null;
      }
      if (item.name === 'run_command') {
        return <TerminalCard item={item} />;
      }
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
      className="msg-icon"
      title={copied ? '已复制' : '复制'}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

/** 用户消息：气泡框 + 时间/复制/编辑（编辑仅最近一条且非运行中） */
function UserView({ item, canEdit }: { item: UserItem; canEdit: boolean }) {
  const store = useStore();
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const time = item.ts
    ? new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  const save = (): void => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== item.text) {
      void store.editAndResend(item.id, draft);
    }
  };

  if (editing) {
    return (
      <div className="msg user editing" data-anchor={item.id}>
        <textarea
          className="msg-edit-area"
          value={draft}
          autoFocus
          rows={Math.min(10, Math.max(3, draft.split('\n').length + 1))}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              save();
            }
            if (e.key === 'Escape') setEditing(false);
          }}
        />
        <div className="msg-meta">
          <span className="msg-time">Enter 保存并重新生成 · Esc 取消</span>
          <button className="msg-copy" onClick={() => setEditing(false)}>
            取消
          </button>
          <button className="msg-copy" onClick={save}>
            保存
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="msg user" data-anchor={item.id}>
      <div className="msg-content">{item.text}</div>
      <div className="msg-meta">
        {time && <span className="msg-time">{time}</span>}
        <button
          className="msg-icon"
          title={copied ? '已复制' : '复制'}
          onClick={() => {
            void navigator.clipboard.writeText(item.text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? '✓' : '⧉'}
        </button>
        {canEdit && (
          <button className="msg-icon" title="编辑并重新生成" onClick={() => setEditing(true)}>
            ✎
          </button>
        )}
      </div>
    </div>
  );
}

/** 实时动作指示器（TODOS #21） */
function LiveTicker() {
  const store = useStore();
  const [elapsed, setElapsed] = useState('0.0');
  const activeTool = store.activeTool;
  const pendingApproval = store.pendingApproval;
  const startedAt = activeTool?.startedAt;

  useEffect(() => {
    if (!startedAt) {
      setElapsed('0.0');
      return;
    }
    const update = () => {
      const sec = Math.max(0, (Date.now() - startedAt) / 1000).toFixed(1);
      setElapsed(sec);
    };
    update();
    const timer = setInterval(update, 100);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (pendingApproval) {
    const label = TOOL_LABELS[pendingApproval.name] ?? pendingApproval.name;
    return (
      <div className="live-ticker waiting">
        <span className="live-ticker-prefix">❯</span>
        <span className="live-ticker-badge wait">[{label}]</span>
        <span className="live-ticker-text">等待用户审批操作...</span>
        <span className="live-ticker-cursor">█</span>
      </div>
    );
  }

  if (activeTool) {
    const label = TOOL_LABELS[activeTool.name] ?? activeTool.name;
    const summary = inputSummary(activeTool.name, activeTool.input);
    return (
      <div className="live-ticker running">
        <span className="live-ticker-prefix">❯</span>
        <span className="live-ticker-badge run">[{label}]</span>
        <span className="live-ticker-text">正在执行: {summary}</span>
        <span className="live-ticker-time">(已耗时 {elapsed}s)</span>
        <span className="live-ticker-cursor">█</span>
      </div>
    );
  }

  return (
    <div className="live-ticker streaming">
      <span className="live-ticker-prefix">❯</span>
      <span className="live-ticker-text">Agent 正在思考并组织回答...</span>
      <span className="live-ticker-cursor">█</span>
    </div>
  );
}

/** 任务清单常驻吸顶栏（TODOS #18） */
function StickyTodoBar() {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const todos = store.activeTodos;

  if (!todos || todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === 'completed').length;
  const inProgress = todos.filter((t) => t.status === 'in_progress').length;
  const current = todos.find((t) => t.status === 'in_progress');
  const total = todos.length;
  const allDone = completed === total && total > 0;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className={`sticky-todo ${open ? 'open' : 'closed'}`}>
      <button
        className="sticky-todo-bar"
        onClick={() => setOpen(!open)}
        type="button"
        title={open ? '收起任务清单' : '展开查看任务详情'}
      >
        <span className={`sticky-todo-badge ${allDone ? 'done' : inProgress > 0 ? 'live' : 'pending'}`}>
          {allDone ? '✓' : '◍'} 任务进度 {completed}/{total} · {percent}%
        </span>
        <span className="sticky-todo-current">
          {current ? `正在进行: ${current.content}` : allDone ? '全部任务已完成' : '就绪'}
        </span>
        <span className="spacer" />
        <span className="sticky-todo-chevron">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="sticky-todo-dropdown">
          <div className="todo-list">
            {todos.map((todo, idx) => {
              const statusClass = `status-${todo.status}`;
              const icon =
                todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◍' : '○';
              return (
                <div key={idx} className={`todo-row ${statusClass}`}>
                  <span className={`todo-icon ${statusClass}`}>{icon}</span>
                  <span className="todo-text">{todo.content}</span>
                  {todo.priority && (
                    <span className={`todo-pri pri-${todo.priority}`}>
                      [{todo.priority.toUpperCase()}]
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** 回合块：头部（用时）+ 折叠的过程 + 常显的最终结果 */
function TurnView({ turn }: { turn: TurnItem }) {
  const store = useStore();
  const live = store.running && turn.durationMs === undefined;
  const expanded = live ? true : !turn.collapsed;
  const [liveElapsed, setLiveElapsed] = useState(Date.now() - turn.startedAt);

  // 运行态平滑计时器：每 500ms 自动自增刷新，彻底解决事件间隔期间计时卡顿
  useEffect(() => {
    if (!live) return;
    const update = () => setLiveElapsed(Date.now() - turn.startedAt);
    update();
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [live, turn.startedAt]);

  const elapsed = turn.durationMs ?? (live ? liveElapsed : Date.now() - turn.startedAt);
  const finalText = finalTextOf(turn);
  const errors = turn.items.filter((i): i is ErrorItem => i.kind === 'error');
  const bodyRef = useRef<HTMLDivElement>(null);
  const localAtBottomRef = useRef(true);

  // 汇总整个回合的所有思考过程，只保留单个统一的 Thinking 折叠块
  const allThinking = turn.items
    .filter((i): i is AssistantItem => i.kind === 'assistant')
    .flatMap((a) => a.blocks)
    .filter((b) => b.type === 'thinking')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n\n---\n\n');

  // 局部独立滚动视窗自动贴底（仅在当前活跃 live 且未手动向上翻看时）
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !live || !expanded || !localAtBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [turn.items.length, store.version, live, expanded]);

  const onBodyScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const isAtBottom = el.scrollTop >= el.scrollHeight - el.clientHeight - 40;
    localAtBottomRef.current = isAtBottom;
  };

  const onBodyWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    if (e.deltaY < 0) {
      localAtBottomRef.current = false;
    }
  };

  const latestTodoTool = turn.items
    .slice()
    .reverse()
    .find((i): i is ToolItem => i.kind === 'tool' && i.name === 'todo_write');
  const turnTodos = (() => {
    if (!latestTodoTool) return null;
    const i = (latestTodoTool.input ?? {}) as { todos?: TodoItem[] };
    const list = Array.isArray(i.todos) ? i.todos : [];
    if (list.length === 0) return null;
    const completed = list.filter((t) => t.status === 'completed').length;
    const inProgress = list.find((t) => t.status === 'in_progress');
    return {
      completed,
      total: list.length,
      current: inProgress?.content,
      allDone: completed === list.length,
    };
  })();

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
        <div
          className="turn-body"
          ref={bodyRef}
          onScroll={onBodyScroll}
          onWheel={onBodyWheel}
        >
          {live && <LiveTicker />}
          {allThinking ? <Thinking text={allThinking} live={live} /> : null}
          {turn.items.map((it) => (
            <ItemView key={it.id} item={it} />
          ))}
        </div>
      )}
      {!expanded && (
        <div className="turn-final">
          {turnTodos && (
            <div className="turn-todo-summary">
              <span className={`turn-todo-badge ${turnTodos.allDone ? 'done' : 'live'}`}>
                {turnTodos.allDone ? '✓' : '◍'} 任务进度 {turnTodos.completed}/{turnTodos.total}
              </span>
              <span className="turn-todo-current">
                {turnTodos.current ? `进行中: ${turnTodos.current}` : '全部任务已完成'}
              </span>
            </div>
          )}
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
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [hover, setHover] = useState<{ top: number; text: string } | null>(null);
  const [railH, setRailH] = useState(0);

  // 发送/切换会话：平滑贴底并恢复跟随（过程输出的自动贴底转移至当前回合的局部独立视窗中，防止主视口拉走用户提问）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !store.autoScrollOn) return;
    el.scrollTop = el.scrollHeight;
    store.setAtBottom(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.scrollTick, store.activeId]);

  // 滚动位置 → 贴底状态（贴近底部=跟随；离开=自由阅读）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      const max = el.scrollHeight - el.clientHeight;
      store.setAtBottom(el.scrollTop >= max - 80);
    };
    // 滚轮向上：立即脱离跟随（避免子容器如 .turn-body 的内部滚动误触发外层脱离跟随）
    const onWheel = (e: WheelEvent): void => {
      if ((e.target as HTMLElement)?.closest?.('.turn-body')) return;
      if (e.deltaY < 0) store.setAtBottom(false);
    };
    el.addEventListener('scroll', onScroll);
    el.addEventListener('wheel', onWheel);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
    };
  }, []);

  // 代码块一键复制事件委托（响应 Markdown 生成的 .code-copy-btn）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent): void => {
      const btn = (e.target as HTMLElement).closest('.code-copy-btn') as HTMLButtonElement | null;
      if (!btn) return;
      const block = btn.closest('.code-block');
      if (!block) return;
      const codeEl = block.querySelector('code');
      const codeText = codeEl?.textContent ?? '';
      if (!codeText) return;
      void navigator.clipboard.writeText(codeText).then(() => {
        btn.textContent = '✓ 已复制';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = '⧉ 复制';
          btn.classList.remove('copied');
        }, 1500);
      });
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, []);

  /** 收集对话 exchanges：一条用户消息 + 其后的模型回合 = 一个刻度 */
  const measure = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const items = store.items;
    const list: Exchange[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind !== 'user') continue;
      const next = items[i + 1];
      const turn = next && next.kind === 'turn' ? next : undefined;
      const lines = (turn ? finalTextOf(turn) : '').split('\n');
      list.push({
        userId: it.id,
        userText: it.text,
        preview:
          it.text +
          '\n\n' +
          lines.slice(0, 2).join('\n') +
          (lines.length > 2 ? '\n…' : ''),
        anchorId: it.id,
      });
    }
    setExchanges(list);
  };

  useEffect(() => {
    measure();
  }, [store.version, store.activeId]);

  /** 滚动时高亮当前视口所在的 exchange，并刷新轨道可用高度 */
  useEffect(() => {
    const el = scrollRef.current;
    const rail = railRef.current;
    if (!el || !rail) return;
    const update = (): void => {
      setRailH(rail.clientHeight);
      const nodes = [...el.querySelectorAll<HTMLElement>('[data-anchor]')];
      if (nodes.length === 0) return;
      const probe = el.scrollTop + el.clientHeight * 0.35;
      let idx = 0;
      nodes.forEach((n, i) => {
        const top = n.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
        if (top <= probe) idx = i;
      });
      setHighlight(idx);
    };
    update();
    el.addEventListener('scroll', update);
    const ro = new ResizeObserver(update);
    ro.observe(rail);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [exchanges, store.activeId]);

  const jumpTo = (anchorId: string): void => {
    scrollRef.current
      ?.querySelector(`[data-anchor="${anchorId}"]`)
      ?.scrollIntoView({ behavior: 'auto', block: 'start' });
  };

  // 刻度条垂直居中；放不下时随滚动滑移，让当前刻度保持在中间
  const spacing = 14;
  const total = exchanges.length * spacing;
  let railOffset = 0;
  if (railH > 0) {
    if (total > railH) {
      const mid = highlight * spacing + spacing / 2;
      railOffset = Math.min(Math.max(mid - railH / 2, 0), total - railH);
    } else {
      railOffset = (railH - total) / 2;
    }
  }

  return (
    <main className="transcript has-rail">
      <div
        className="rail"
        ref={railRef}
        onMouseMove={(e) => {
          // 波浪效果：靠近指针的刻度放大变亮，随距离衰减
          const rail = railRef.current;
          if (!rail) return;
          const my = e.clientY - rail.getBoundingClientRect().top;
          rail.querySelectorAll<HTMLElement>('.rail-tick').forEach((t) => {
            const center = parseFloat(t.style.top || '0') + 1.5;
            const w = Math.max(0, 1 - Math.abs(center - my) / 70);
            const width = 10 + w * 8;
            t.style.width = `${width}px`;
            t.style.height = `${3 + w * 3}px`;
            t.style.left = `${6 - width / 2}px`;
            t.style.opacity = String(0.55 + w * 0.45);
          });
        }}
        onMouseLeave={() => {
          const rail = railRef.current;
          if (!rail) return;
          rail.querySelectorAll<HTMLElement>('.rail-tick').forEach((t) => {
            t.style.width = '';
            t.style.height = '';
            t.style.left = '';
            t.style.opacity = '';
          });
          setHover(null);
        }}
      >
        {exchanges.map((ex, i) => (
          <div
            key={ex.anchorId}
            className={`rail-tick ${i === Math.min(highlight, exchanges.length - 1) ? 'current' : ''}`}
            style={{ top: `${railOffset + i * spacing + spacing / 2}px` }}
            title={ex.userText}
            onMouseEnter={() => setHover({ top: railOffset + i * spacing + spacing / 2, text: ex.preview })}
            onMouseLeave={() => setHover(null)}
            onClick={() => jumpTo(ex.anchorId)}
          />
        ))}
        {hover && (
          <div className="rail-preview" style={{ top: `${hover.top - 7}px` }}>
            {hover.text}
          </div>
        )}
      </div>
      {!store.atBottom && store.items.length > 0 && (
        <button
          className="jump-bottom"
          title="回到底部"
          onClick={() => {
            const el = scrollRef.current;
            if (!el) return;
            el.scrollTop = el.scrollHeight;
            store.setAtBottom(true);
          }}
        >
          ↓
        </button>
      )}
      <div className="transcript-scroll" ref={scrollRef}>
        <StickyTodoBar />
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
        {store.items.map((item) => {
          if (item.kind === 'user') {
            const isLastUser =
              !store.running &&
              store.items.lastIndexOf(item) === store.items.length - 1 - (store.items.length > 1 && store.items[store.items.length - 1].kind === 'turn' ? 1 : 0);
            return <UserView key={item.id} item={item} canEdit={isLastUser} />;
          }
          if (item.kind === 'turn') return <TurnView key={item.id} turn={item} />;
          return null; // TurnEntry 兜底条目不会出现在顶层：回合聚合总是先建容器
        })}
        <div ref={bottomRef} />
      </div>
    </main>
  );
}

interface Exchange {
  userId: string;
  userText: string;
  preview: string;
  anchorId: string;
}
