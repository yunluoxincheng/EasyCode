import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';
import {
  sessionToMarkdown,
  downloadFile,
  getExportFilename,
} from '../utils/exportSession.js';

interface MenuPos {
  x: number;
  y: number;
}

interface ContextInfo {
  selection?: string;
  codeText?: string;
  userMsgText?: string;
  userMsgId?: string;
  turnId?: string;
  turnText?: string;
}

export function ContextMenu() {
  const store = useStore();
  const [pos, setPos] = useState<MenuPos | null>(null);
  const [ctxInfo, setCtxInfo] = useState<ContextInfo>({});
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // 文本输入控件内（input/textarea）保留原生右键菜单以便输入法与原生粘贴
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        setPos(null);
        return;
      }

      e.preventDefault();

      const selection = window.getSelection()?.toString().trim() || undefined;

      // 检查是否在代码块内部
      const codeBlock = target.closest('.code-block');
      const codeText = codeBlock?.querySelector('code')?.textContent?.trim() || undefined;

      // 检查是否在用户提问消息内部
      const userMsgEl = target.closest('.msg.user') as HTMLElement | null;
      const userMsgId = userMsgEl?.dataset?.anchor;
      let userMsgText: string | undefined;
      if (userMsgId) {
        const item = store.items.find((i) => i.id === userMsgId);
        if (item && item.kind === 'user') {
          userMsgText = item.text;
        }
      }

      // 检查是否在助手回合内部
      const turnEl = target.closest('.turn') as HTMLElement | null;
      const turnId = turnEl?.dataset?.anchor;
      let turnText: string | undefined;
      if (turnId) {
        const item = store.items.find((i) => i.id === turnId);
        if (item && item.kind === 'turn') {
          const textBlocks = item.items
            .filter((ti): ti is Extract<typeof ti, { kind: 'assistant' }> => ti.kind === 'assistant')
            .flatMap((ai) => ai.blocks)
            .filter((b) => b.type === 'text')
            .map((b) => b.text);
          if (textBlocks.length > 0) {
            turnText = textBlocks.join('\n\n');
          }
        }
      }

      setCtxInfo({ selection, codeText, userMsgText, userMsgId, turnId, turnText });
      setPos({ x: e.clientX, y: e.clientY });
    };

    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setPos(null);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPos(null);
      }
    };

    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [store.items]);

  // 边界防溢出微调（防止靠底或靠右被截断）
  useLayoutEffect(() => {
    if (!pos || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    let { x, y } = pos;
    let adjusted = false;

    if (x + rect.width > window.innerWidth - 8) {
      x = Math.max(8, window.innerWidth - rect.width - 8);
      adjusted = true;
    }
    if (y + rect.height > window.innerHeight - 8) {
      y = Math.max(8, window.innerHeight - rect.height - 8);
      adjusted = true;
    }

    if (adjusted) {
      setPos({ x, y });
    }
  }, [pos]);

  if (!pos) return null;

  const handleCopy = (text: string, label: string) => {
    setPos(null);
    void navigator.clipboard.writeText(text).then(() => {
      store.showToast(`已复制${label}`);
    });
  };

  const handleExport = async () => {
    setPos(null);
    if (!store.activeId) return;
    try {
      const data = await store.client.getSession(store.activeId);
      const content = sessionToMarkdown(data);
      const filename = getExportFilename(data.meta.title, 'md');
      downloadFile(filename, content, 'text/markdown;charset=utf-8');
      store.showToast(`已成功导出 Markdown: ${filename}`);
    } catch (err) {
      store.showToast(`导出失败: ${err instanceof Error ? err.message : String(err)}`, 'err');
    }
  };

  const hasContextActions =
    !!ctxInfo.selection || !!ctxInfo.codeText || !!ctxInfo.userMsgText || !!ctxInfo.turnText;

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="context-menu-title">操作菜单</div>

      {/* 选区动作 */}
      {ctxInfo.selection && (
        <button
          className="context-menu-item"
          onClick={() => handleCopy(ctxInfo.selection!, '选中文本')}
        >
          <span className="ctx-icon">⧉</span> 复制选中文本
        </button>
      )}

      {/* 代码块动作 */}
      {ctxInfo.codeText && (
        <button
          className="context-menu-item"
          onClick={() => handleCopy(ctxInfo.codeText!, '代码块')}
        >
          <span className="ctx-icon">⧉</span> 复制代码块
        </button>
      )}

      {/* 用户消息动作 */}
      {ctxInfo.userMsgText && (
        <>
          <button
            className="context-menu-item"
            onClick={() => handleCopy(ctxInfo.userMsgText!, '提问文本')}
          >
            <span className="ctx-icon">⧉</span> 复制用户提问
          </button>
          {ctxInfo.userMsgId && !store.running && (
            <button
              className="context-menu-item"
              onClick={() => {
                setPos(null);
                void store.forkSession({ kind: 'beforeUser', itemId: ctxInfo.userMsgId! });
              }}
            >
              <span className="ctx-icon">⑂</span> 从此处分叉会话
            </button>
          )}
        </>
      )}

      {/* 助手回合动作 */}
      {ctxInfo.turnText && (
        <>
          <button
            className="context-menu-item"
            onClick={() => handleCopy(ctxInfo.turnText!, '回答 Markdown')}
          >
            <span className="ctx-icon">⧉</span> 复制回答 Markdown
          </button>
          {ctxInfo.turnId && !store.running && (
            <button
              className="context-menu-item"
              onClick={() => {
                setPos(null);
                void store.forkSession({ kind: 'afterTurn', itemId: ctxInfo.turnId! });
              }}
            >
              <span className="ctx-icon">⑂</span> 从此回合分叉会话
            </button>
          )}
        </>
      )}

      {hasContextActions && <div className="context-menu-sep" />}

      {/* 全局常用操作 */}
      <button
        className="context-menu-item"
        onClick={() => {
          setPos(null);
          void store.newSession();
        }}
      >
        <span className="ctx-icon">＋</span> 新建会话
      </button>

      {store.activeSession && (
        <button className="context-menu-item" onClick={() => void handleExport()}>
          <span className="ctx-icon">⤓</span> 导出会话 (Markdown)
        </button>
      )}

      {store.activeSession?.workspaceRoot && (
        <button
          className="context-menu-item"
          onClick={() => {
            setPos(null);
            store.openWorkspace(store.activeSession!.workspaceRoot);
          }}
        >
          <span className="ctx-icon">📂</span> 打开工作区目录
        </button>
      )}

      {store.activeSession?.workspaceRoot && (
        <button
          className="context-menu-item"
          onClick={() => {
            setPos(null);
            store.openGitModal();
          }}
        >
          <span className="ctx-icon">⑂</span> 审查工作区 Git 改动
        </button>
      )}

      {store.running && (
        <button
          className="context-menu-item danger"
          onClick={() => {
            setPos(null);
            void store.stop();
          }}
        >
          <span className="ctx-icon">■</span> 停止当前任务
        </button>
      )}

      <div className="context-menu-sep" />

      <button
        className="context-menu-item"
        onClick={() => {
          setPos(null);
          store.openSettings('general');
        }}
      >
        <span className="ctx-icon">⚙</span> 打开应用设置
      </button>
    </div>
  );
}
