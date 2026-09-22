import { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';
import type { UserItem } from '../store.js';
import { ProjectSwitcher } from './ProjectSwitcher.js';
import { ModelEffortPicker } from './ModelEffortPicker.js';
import { UsageChip } from './UsageChip.js';
import { ContextChip } from './ContextChip.js';

/** 自适应撑高的高度上限（TODOS #20）：约 8 行，超出后出纵向滚动条 */
const TA_MAX_HEIGHT = 181;
/** 顶部栏宽度低于该值时，用量/容量 chip 收敛为紧凑态（TODOS #20） */
const BAR_COMPACT_WIDTH = 640;

export function Composer() {
  const store = useStore();
  const session = store.activeSession;
  const [text, setText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [compact, setCompact] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const inputWrapRef = useRef<HTMLDivElement>(null);
  const mentionListRef = useRef<HTMLDivElement>(null);

  /** @文件 mention 悬浮检索状态 */
  const [mention, setMention] = useState<{
    open: boolean;
    query: string;
    startIndex: number;
    selectedIndex: number;
    files: string[];
    loading: boolean;
  }>({
    open: false,
    query: '',
    startIndex: -1,
    selectedIndex: 0,
    files: [],
    loading: false,
  });

  /** ↑/↓ 浏览历史的状态：会话切换或发送后重置 */
  const historyRef = useRef<{ list: string[]; index: number; draft: string } | null>(null);

  useEffect(() => {
    historyRef.current = null;
    setMention({
      open: false,
      query: '',
      startIndex: -1,
      selectedIndex: 0,
      files: [],
      loading: false,
    });
  }, [store.activeId]);

  /** 自适应撑高（TODOS #20）：按内容即时量高，CSS min/max-height 兜底 2~8 行；发送清空后自动收缩 */
  const resize = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, TA_MAX_HEIGHT)}px`;
  };

  useEffect(() => {
    resize();
    // 窗口宽度变化会改变折行，高度需重算
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [text]);

  /** 顶部栏响应式收敛（TODOS #20）：可用宽度紧张时次要信息收缩为紧凑态，优先保障模式与模型控件 */
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const measure = () => setCompact(el.clientWidth < BAR_COMPACT_WIDTH);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // 窗口尺寸变化兜底（侧栏开合等场景由 ResizeObserver 覆盖）
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  /** 把拖入的文件路径插入光标位置（TODOS #20） */
  const insertPaths = (paths: string[]) => {
    if (paths.length === 0) return;
    const snippet = paths.map((p) => (/[\s"]/.test(p) ? `"${p}"` : p)).join('\n');
    const ta = taRef.current;
    if (!ta) {
      setText((prev) => prev + snippet);
      return;
    }
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    setText(ta.value.slice(0, start) + snippet + ta.value.slice(end));
    requestAnimationFrame(() => {
      ta.focus();
      const caret = start + snippet.length;
      ta.selectionStart = ta.selectionEnd = caret;
    });
  };

  // Tauri 宿主：dragDrop 由窗口级接管（DOM drop 事件不触发），监听 onDragDropEvent 拿真实路径
  const insertRef = useRef(insertPaths);
  useEffect(() => {
    insertRef.current = insertPaths;
  });
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((ev) => {
          const payload = ev.payload;
          const el = inputWrapRef.current;
          if (!el) return;
          if (payload.type === 'leave') {
            setDragOver(false);
            return;
          }
          // 事件坐标为物理像素，换算为 CSS 像素后与输入区包围盒求交
          const dpr = window.devicePixelRatio || 1;
          const x = payload.position.x / dpr;
          const y = payload.position.y / dpr;
          const rect = el.getBoundingClientRect();
          const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
          if (payload.type === 'enter' || payload.type === 'over') {
            setDragOver(inside);
          } else if (payload.type === 'drop') {
            setDragOver(false);
            if (inside && payload.paths.length > 0) insertRef.current(payload.paths);
          }
        }),
      )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const submit = () => {
    const t = text;
    setText('');
    historyRef.current = null;
    setMention({
      open: false,
      query: '',
      startIndex: -1,
      selectedIndex: 0,
      files: [],
      loading: false,
    });
    store.send(t);
  };

  const checkMention = (val: string, caretPos: number) => {
    const before = val.slice(0, caretPos);
    const lastAt = before.lastIndexOf('@');
    if (lastAt === -1) {
      if (mention.open) setMention((m) => ({ ...m, open: false }));
      return;
    }
    // 检查 @ 前字符：必须是首字符、空格、标点或括号
    if (lastAt > 0 && !/[\s([{"'`<:;]/.test(val[lastAt - 1])) {
      if (mention.open) setMention((m) => ({ ...m, open: false }));
      return;
    }
    const query = before.slice(lastAt + 1);
    // query 不能包含空白或换行
    if (/[\s\r\n]/.test(query)) {
      if (mention.open) setMention((m) => ({ ...m, open: false }));
      return;
    }
    setMention((m) => ({
      ...m,
      open: true,
      query,
      startIndex: lastAt,
    }));
  };

  const selectFile = (filePath: string) => {
    const ta = taRef.current;
    if (!ta) return;
    const start = mention.startIndex;
    const caret = ta.selectionStart ?? (start + mention.query.length + 1);
    const replacement = `@${filePath} `;
    const newText = text.slice(0, start) + replacement + text.slice(caret);
    setText(newText);
    setMention({
      open: false,
      query: '',
      startIndex: -1,
      selectedIndex: 0,
      files: [],
      loading: false,
    });
    requestAnimationFrame(() => {
      ta.focus();
      const nextPos = start + replacement.length;
      ta.selectionStart = ta.selectionEnd = nextPos;
    });
  };

  // 防抖检索工作区文件列表
  useEffect(() => {
    if (!mention.open || !session?.id) return;
    if (!session.workspaceRoot) {
      setMention((m) => ({ ...m, files: [], loading: false }));
      return;
    }
    const timer = setTimeout(async () => {
      try {
        setMention((m) => ({ ...m, loading: true }));
        const list = await store.client.listWorkspaceFiles(session.id, mention.query);
        setMention((m) => ({ ...m, files: list, loading: false, selectedIndex: 0 }));
      } catch {
        setMention((m) => ({ ...m, files: [], loading: false }));
      }
    }, 60);
    return () => clearTimeout(timer);
  }, [mention.open, mention.query, session?.id, session?.workspaceRoot]);

  // 键盘移动选中项时保持滚动条在视口内
  useEffect(() => {
    if (!mention.open || mention.files.length === 0) return;
    const listEl = mentionListRef.current;
    const itemEl = listEl?.querySelector('.mention-item.selected') as HTMLElement | null;
    if (listEl && itemEl) {
      const listTop = listEl.scrollTop;
      const listBottom = listTop + listEl.clientHeight;
      const itemTop = itemEl.offsetTop;
      const itemBottom = itemTop + itemEl.offsetHeight;
      if (itemTop < listTop) {
        listEl.scrollTop = itemTop;
      } else if (itemBottom > listBottom) {
        listEl.scrollTop = itemBottom - listEl.clientHeight;
      }
    }
  }, [mention.selectedIndex, mention.open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 优先响应 @文件 补全浮层的键盘导航
    if (mention.open) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setMention((m) => ({ ...m, open: false }));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        if (mention.files.length > 0) {
          setMention((m) => ({
            ...m,
            selectedIndex: (m.selectedIndex - 1 + m.files.length) % m.files.length,
          }));
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        if (mention.files.length > 0) {
          setMention((m) => ({
            ...m,
            selectedIndex: (m.selectedIndex + 1) % m.files.length,
          }));
        }
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.nativeEvent.isComposing) {
        if (mention.files.length > 0 && mention.files[mention.selectedIndex]) {
          e.preventDefault();
          e.stopPropagation();
          selectFile(mention.files[mention.selectedIndex]);
          return;
        }
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
      return;
    }
    // ↑/↓ 浏览已发送消息：光标在首行/末行时生效（多行编辑不受影响）
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const ta = e.currentTarget;
      const pos = ta.selectionStart ?? 0;
      const atFirst = !ta.value.slice(0, pos).includes('\n');
      const atLast = !ta.value.slice(pos).includes('\n');
      if (e.key === 'ArrowUp' && !atFirst) return;
      if (e.key === 'ArrowDown' && !atLast) return;

      const list = store.items
        .filter((i): i is UserItem => i.kind === 'user')
        .map((i) => i.text)
        .reverse();
      if (list.length === 0) return;

      if (!historyRef.current) historyRef.current = { list, index: -1, draft: ta.value };
      const h = historyRef.current;
      const next = h.index + (e.key === 'ArrowUp' ? 1 : -1);
      if (next < -1 || next >= h.list.length) {
        e.preventDefault();
        return;
      }
      h.index = next;
      const value = next === -1 ? h.draft : h.list[next];
      setText(value);
      e.preventDefault();
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (el) el.selectionStart = el.selectionEnd = el.value.length;
      });
    }
  };

  /** 非 Tauri 宿主（Electron / 浏览器演示）：HTML5 drop 事件提取文件路径 */
  const filePathOf = (f: File): string => {
    const legacy = f as File & { path?: string };
    if (legacy.path) return legacy.path;
    const bridge = (
      window as unknown as { easycode?: { getPathForFile?: (f: File) => string } }
    ).easycode;
    try {
      if (bridge?.getPathForFile) return bridge.getPathForFile(f);
    } catch {
      /* 取不到路径时退回文件名 */
    }
    return f.name;
  };

  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  };

  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  };

  const onDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    setDragOver(false);
    insertPaths(files.map(filePathOf));
  };

  return (
    <div className="composer">
      <div className="composer-bar" ref={barRef}>
        <div
          className="segmented compact mode-switch"
          role="group"
          aria-label="审批模式"
          title="审批模式：询问 = 写文件/执行命令需批准；YOLO = 自动放行"
        >
          <button
            className={store.mode === 'ask' ? 'active' : ''}
            onClick={() => store.setMode('ask')}
          >
            询问
          </button>
          <button
            className={store.mode === 'yolo' ? 'active' : ''}
            onClick={() => store.setMode('yolo')}
          >
            YOLO
          </button>
        </div>
        {session && <ProjectSwitcher />}
        {session && <ModelEffortPicker />}
        {session && <UsageChip compact={compact} />}
        {session && <ContextChip compact={compact} />}
        <span className="spacer" />
        {store.running && <span className="running-dot" title="Agent 运行中" />}
      </div>
      <div
        className={`composer-input ${dragOver ? 'drag-over' : ''}`}
        ref={inputWrapRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {mention.open && (
          <div className="mention-pop" ref={mentionListRef}>
            <div className="mention-head">
              <span className="mention-tag">[ @ 文件引用 ]</span>
              <span className="mention-hint">
                {!session?.workspaceRoot
                  ? '未绑定工作区'
                  : mention.loading
                    ? '检索中...'
                    : mention.files.length === 0
                      ? '无匹配文件'
                      : `↑↓ 移动 · Tab/Enter 补全 (${mention.files.length})`}
              </span>
            </div>
            {!session?.workspaceRoot ? (
              <div className="mention-empty">
                当前会话未绑定项目工作区，点击上方「＋ 绑定项目」即可引用代码文件
              </div>
            ) : mention.files.length === 0 && !mention.loading ? (
              <div className="mention-empty">未检索到与 "{mention.query}" 匹配的文件</div>
            ) : (
              <div className="mention-list">
                {mention.files.map((file, idx) => {
                  const isSelected = idx === mention.selectedIndex;
                  const lastSlash = file.lastIndexOf('/');
                  const fileName = lastSlash === -1 ? file : file.slice(lastSlash + 1);
                  const dirPath = lastSlash === -1 ? '' : file.slice(0, lastSlash + 1);
                  return (
                    <div
                      key={file}
                      className={`mention-item ${isSelected ? 'selected' : ''}`}
                      onMouseEnter={() => setMention((m) => ({ ...m, selectedIndex: idx }))}
                      onMouseDown={(e) => {
                        e.preventDefault(); // 防止 textarea 失焦
                        selectFile(file);
                      }}
                    >
                      <span className="mention-cursor">{isSelected ? '❯' : ' '}</span>
                      <span className="mention-name">{fileName}</span>
                      {dirPath && <span className="mention-dir">{dirPath}</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => {
            const nextVal = e.target.value;
            const caret = e.target.selectionStart ?? nextVal.length;
            setText(nextVal);
            checkMention(nextVal, caret);
          }}
          onClick={(e) => {
            const ta = e.currentTarget;
            checkMention(ta.value, ta.selectionStart ?? ta.value.length);
          }}
          onKeyUp={(e) => {
            // 忽略已由 onKeyDown 劫持的方向键和回车
            if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
            const ta = e.currentTarget;
            checkMention(ta.value, ta.selectionStart ?? ta.value.length);
          }}
          onKeyDown={onKeyDown}
          placeholder={
            !session
              ? '先在左侧新建一个会话…'
              : session.workspaceRoot
                ? `输入 @ 快速引用文件，Enter 发送，Shift+Enter 换行`
                : '直接对话即可；要操作文件请先点击上方「＋ 绑定项目」'
          }
          disabled={!session || store.running}
          rows={2}
        />
        {dragOver && <div className="drop-hint">⊘ 松开插入文件路径</div>}
        {store.running ? (
          <button className="btn danger send" onClick={() => store.stop()}>
            ■ 停止
          </button>
        ) : (
          <button
            className="btn primary send"
            onClick={submit}
            disabled={!session || !text.trim()}
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}
