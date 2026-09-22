import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../useStore.js';
import type { UserItem } from '../store.js';
import { ProjectSwitcher } from './ProjectSwitcher.js';
import { ModelEffortPicker } from './ModelEffortPicker.js';
import { UsageChip } from './UsageChip.js';
import { ContextChip } from './ContextChip.js';
import { RulesChip } from './RulesChip.js';
import { BUILTIN_SLASH_COMMANDS, type SlashCommand } from '../commands/index.js';
import { downloadFile, getExportFilename, sessionToMarkdown } from '../utils/exportSession.js';

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
  const slashListRef = useRef<HTMLDivElement>(null);

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

  /** / 快捷指令悬浮状态（TODOS #32） */
  const [slash, setSlash] = useState<{
    open: boolean;
    query: string;
    startIndex: number;
    selectedIndex: number;
    customCommands: SlashCommand[];
  }>({
    open: false,
    query: '',
    startIndex: -1,
    selectedIndex: 0,
    customCommands: [],
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
    setSlash((s) => ({
      ...s,
      open: false,
      query: '',
      startIndex: -1,
      selectedIndex: 0,
    }));
  }, [store.activeId]);

  // 加载工作区自定义指令（.easycode/prompts/*.md）
  useEffect(() => {
    if (!session?.id || !session.workspaceRoot || !store.client.listCustomPrompts) {
      setSlash((s) => ({ ...s, customCommands: [] }));
      return;
    }
    store.client
      .listCustomPrompts(session.id)
      .then((customs) => {
        const mapped: SlashCommand[] = (customs || []).map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description,
          kind: 'prompt',
          category: 'custom',
          badge: '[自定义]',
          template: c.template,
        }));
        setSlash((s) => ({ ...s, customCommands: mapped }));
      })
      .catch(() => {
        setSlash((s) => ({ ...s, customCommands: [] }));
      });
  }, [session?.id, session?.workspaceRoot]);

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

  const submit = async () => {
    const raw = text.trim();

    // 检查是否以已知的 /command 开头（支持 Tab 补全后按 Enter 或直接手敲 /command 发送）
    if (raw.startsWith('/')) {
      const token = raw.split(/\s+/)[0].toLowerCase();
      const matched = allCommands.find(
        (c) => c.name.toLowerCase() === token || c.id.toLowerCase() === token.slice(1),
      );
      if (matched) {
        if (matched.kind === 'action') {
          setText('');
          historyRef.current = null;
          setSlash((s) => ({ ...s, open: false }));
          if (matched.id === 'clear') {
            store.showToast('已清空当前输入内容');
            return;
          }
          if (matched.id === 'compact') {
            if (!session?.id) return;
            try {
              await store.client.trimSessionHistory(session.id);
              store.showToast('已完成上下文压缩与阶段记忆归档');
            } catch (err) {
              store.showToast(err instanceof Error ? err.message : '压缩失败', 'err');
            }
            return;
          }
          if (matched.id === 'fork') {
            if (!session?.id) return;
            try {
              const forked = await store.client.forkSession(session.id);
              await store.loadSessions();
              await store.selectSession(forked.id);
              store.showToast(`已成功分叉出新会话分支: ${forked.title}`);
            } catch (err) {
              store.showToast(err instanceof Error ? err.message : '分叉失败', 'err');
            }
            return;
          }
          if (matched.id === 'export') {
            if (!session?.id) return;
            try {
              const fullData = await store.client.getSession(session.id);
              const md = sessionToMarkdown(fullData);
              const filename = getExportFilename(fullData.meta.title || '会话导出', 'md');
              downloadFile(filename, md, 'text/markdown;charset=utf-8');
              store.showToast(`已导出会话 Markdown: ${filename}`);
            } catch (err) {
              store.showToast(err instanceof Error ? err.message : '导出失败', 'err');
            }
            return;
          }
        } else if (matched.kind === 'prompt') {
          // 模板类：提取追加的参数，拼装高密度 Prompt 后发送
          const extra = raw.slice(token.length).trim();
          const finalMsg = extra
            ? `${matched.template}\n\n补充说明与参数：${extra}`
            : (matched.template ?? raw);
          setText('');
          historyRef.current = null;
          setSlash((s) => ({ ...s, open: false }));
          store.send(finalMsg);
          return;
        }
      }
    }

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
    setSlash((s) => ({
      ...s,
      open: false,
      query: '',
      startIndex: -1,
      selectedIndex: 0,
    }));
    store.send(t);
  };

  // 合并自定义指令与内置指令（TODOS #32）
  const allCommands = useMemo(() => {
    return [...slash.customCommands, ...BUILTIN_SLASH_COMMANDS];
  }, [slash.customCommands]);

  // 过滤后的指令列表
  const filteredCommands = useMemo(() => {
    const q = slash.query.trim().toLowerCase();
    if (!q) return allCommands;
    return allCommands.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q),
    );
  }, [allCommands, slash.query]);

  const checkSlash = (val: string, caretPos: number) => {
    const before = val.slice(0, caretPos);
    const lastSlash = before.lastIndexOf('/');
    if (lastSlash === -1) {
      if (slash.open) setSlash((s) => ({ ...s, open: false }));
      return;
    }
    // 检查 / 前字符：必须是首字符、空格或换行
    if (lastSlash > 0 && !/[\s\r\n]/.test(val[lastSlash - 1])) {
      if (slash.open) setSlash((s) => ({ ...s, open: false }));
      return;
    }
    const query = before.slice(lastSlash + 1);
    // query 不能包含空白或换行
    if (/[\s\r\n]/.test(query)) {
      if (slash.open) setSlash((s) => ({ ...s, open: false }));
      return;
    }
    // 互斥：关闭 mention
    if (mention.open) setMention((m) => ({ ...m, open: false }));
    setSlash((s) => ({
      ...s,
      open: true,
      query,
      startIndex: lastSlash,
      selectedIndex: 0,
    }));
  };

  /** 按 Tab 补全：将指令名添加到输入框中，不直接执行动作或发送，留给用户掌控 */
  const insertCommandName = (cmd: SlashCommand) => {
    const ta = taRef.current;
    const start = slash.startIndex;
    const caret = ta?.selectionStart ?? (start + slash.query.length + 1);
    const replacement = `${cmd.name} `;
    const newText = text.slice(0, start) + replacement + text.slice(caret);
    setText(newText);
    setSlash((s) => ({
      ...s,
      open: false,
      query: '',
      startIndex: -1,
      selectedIndex: 0,
    }));
    requestAnimationFrame(() => {
      if (ta) {
        ta.focus();
        const nextPos = start + replacement.length;
        ta.selectionStart = ta.selectionEnd = nextPos;
      }
    });
  };

  /** 按 Enter 确认：执行动作类指令，或展开提示词模板 */
  const executeCommand = async (cmd: SlashCommand) => {
    const ta = taRef.current;
    const start = slash.startIndex;
    const caret = ta?.selectionStart ?? (start + slash.query.length + 1);

    setSlash((s) => ({
      ...s,
      open: false,
      query: '',
      startIndex: -1,
      selectedIndex: 0,
    }));

    if (cmd.kind === 'action') {
      // 动作类指令：从当前输入中剔除 "/query"
      const newText = text.slice(0, start) + text.slice(caret);
      setText(newText.trimStart());

      if (cmd.id === 'clear') {
        setText('');
        historyRef.current = null;
        store.showToast('已清空当前输入内容');
        return;
      }
      if (cmd.id === 'compact') {
        if (!session?.id) return;
        try {
          await store.client.trimSessionHistory(session.id);
          store.showToast('已完成上下文压缩与阶段记忆归档');
        } catch (err) {
          store.showToast(err instanceof Error ? err.message : '压缩失败', 'err');
        }
        return;
      }
      if (cmd.id === 'fork') {
        if (!session?.id) return;
        try {
          const forked = await store.client.forkSession(session.id);
          await store.loadSessions();
          await store.selectSession(forked.id);
          store.showToast(`已成功分叉出新会话分支: ${forked.title}`);
        } catch (err) {
          store.showToast(err instanceof Error ? err.message : '分叉失败', 'err');
        }
        return;
      }
      if (cmd.id === 'export') {
        if (!session?.id) return;
        try {
          const fullData = await store.client.getSession(session.id);
          const md = sessionToMarkdown(fullData);
          const filename = getExportFilename(fullData.meta.title || '会话导出', 'md');
          downloadFile(filename, md, 'text/markdown;charset=utf-8');
          store.showToast(`已导出会话 Markdown: ${filename}`);
        } catch (err) {
          store.showToast(err instanceof Error ? err.message : '导出失败', 'err');
        }
        return;
      }
    } else {
      // Prompt 模板类：替换输入框中的 /query 并后置空格，聚焦光标在末尾
      const templateText = (cmd.template ?? '') + ' ';
      const newText = text.slice(0, start) + templateText + text.slice(caret);
      setText(newText);
      requestAnimationFrame(() => {
        if (ta) {
          ta.focus();
          const nextPos = start + templateText.length;
          ta.selectionStart = ta.selectionEnd = nextPos;
        }
      });
    }
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
    // 互斥：关闭 slash
    if (slash.open) setSlash((s) => ({ ...s, open: false }));
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
    if (!listEl) return;
    const items = listEl.querySelectorAll<HTMLElement>('.mention-item');
    const itemEl = items[mention.selectedIndex];
    if (itemEl) {
      if (typeof itemEl.scrollIntoView === 'function') {
        itemEl.scrollIntoView({ block: 'nearest' });
      } else {
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
    }
  }, [mention.selectedIndex, mention.open]);

  // 键盘移动指令选中项时保持滚动条在视口内 (TODOS #32)
  useEffect(() => {
    if (!slash.open || filteredCommands.length === 0) return;
    const listEl = slashListRef.current;
    if (!listEl) return;
    const items = listEl.querySelectorAll<HTMLElement>('.command-item');
    const itemEl = items[slash.selectedIndex];
    if (itemEl) {
      if (typeof itemEl.scrollIntoView === 'function') {
        itemEl.scrollIntoView({ block: 'nearest' });
      } else {
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
    }
  }, [slash.selectedIndex, slash.open, filteredCommands.length]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 优先响应 / 快捷指令浮层的键盘导航 (TODOS #32)
    if (slash.open) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setSlash((s) => ({ ...s, open: false }));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        if (filteredCommands.length > 0) {
          setSlash((s) => ({
            ...s,
            selectedIndex:
              (s.selectedIndex - 1 + filteredCommands.length) % filteredCommands.length,
          }));
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        if (filteredCommands.length > 0) {
          setSlash((s) => ({
            ...s,
            selectedIndex: (s.selectedIndex + 1) % filteredCommands.length,
          }));
        }
        return;
      }
      // Tab 仅补全指令名称至输入框，不直接执行动作
      if (e.key === 'Tab' && !e.shiftKey && !e.nativeEvent.isComposing) {
        const cmd = filteredCommands[slash.selectedIndex];
        if (cmd) {
          e.preventDefault();
          e.stopPropagation();
          insertCommandName(cmd);
          return;
        }
      }
      // Enter 确认触发：执行动作或展开模板
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        const cmd = filteredCommands[slash.selectedIndex];
        if (cmd) {
          e.preventDefault();
          e.stopPropagation();
          executeCommand(cmd);
          return;
        }
      }
    }

    // 响应 @文件 补全浮层的键盘导航
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
        {session && <RulesChip compact={compact} />}
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
          <div className="mention-pop">
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
              <div className="mention-list" ref={mentionListRef}>
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
        {slash.open && (
          <div className="command-pop">
            <div className="command-head">
              <span className="command-tag">[ / 快捷指令 ]</span>
              <span className="command-hint">
                {filteredCommands.length === 0
                  ? '无匹配指令'
                  : `↑↓ 移动 · Tab 补全 · Enter 执行 (${filteredCommands.length})`}
              </span>
            </div>
            {filteredCommands.length === 0 ? (
              <div className="command-empty">未匹配到与 "/{slash.query}" 对应的快捷指令</div>
            ) : (
              <div className="command-list" ref={slashListRef}>
                {filteredCommands.map((cmd, idx) => {
                  const isSelected = idx === slash.selectedIndex;
                  return (
                    <div
                      key={cmd.id}
                      className={`command-item ${isSelected ? 'selected' : ''}`}
                      onMouseEnter={() => setSlash((s) => ({ ...s, selectedIndex: idx }))}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        executeCommand(cmd);
                      }}
                    >
                      <span className="command-cursor">{isSelected ? '❯' : ' '}</span>
                      <span className="command-name">{cmd.name}</span>
                      <span className="command-desc">{cmd.description}</span>
                      <span className={`command-badge ${cmd.category}`}>{cmd.badge}</span>
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
            checkSlash(nextVal, caret);
          }}
          onClick={(e) => {
            const ta = e.currentTarget;
            const caret = ta.selectionStart ?? ta.value.length;
            checkMention(ta.value, caret);
            checkSlash(ta.value, caret);
          }}
          onKeyUp={(e) => {
            // 忽略已由 onKeyDown 劫持的方向键和回车
            if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
            const ta = e.currentTarget;
            const caret = ta.selectionStart ?? ta.value.length;
            checkMention(ta.value, caret);
            checkSlash(ta.value, caret);
          }}
          onKeyDown={onKeyDown}
          placeholder={
            !session
              ? '先在左侧新建一个会话…'
              : session.workspaceRoot
                ? `输入 / 快捷指令，@ 引用文件，Enter 发送，Shift+Enter 换行`
                : '直接对话即可；输入 / 快捷指令；操作文件请先点击上方「＋ 绑定项目」'
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
