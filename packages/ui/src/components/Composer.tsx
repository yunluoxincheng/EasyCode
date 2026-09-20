import { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';
import type { UserItem } from '../store.js';
import { ProjectSwitcher } from './ProjectSwitcher.js';
import { ModelEffortPicker } from './ModelEffortPicker.js';
import { UsageChip } from './UsageChip.js';
import { ContextChip } from './ContextChip.js';

export function Composer() {
  const store = useStore();
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  /** ↑/↓ 浏览历史的状态：会话切换或发送后重置 */
  const historyRef = useRef<{ list: string[]; index: number; draft: string } | null>(null);

  useEffect(() => {
    historyRef.current = null;
  }, [store.activeId]);

  const submit = () => {
    const t = text;
    setText('');
    historyRef.current = null;
    store.send(t);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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

  const session = store.activeSession;

  return (
    <div className="composer">
      <div className="composer-bar">
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
        {session && <UsageChip />}
        {session && <ContextChip />}
        <span className="spacer" />
        {store.running && <span className="running-dot" title="Agent 运行中" />}
      </div>
      <div className="composer-input">
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            !session
              ? '先在左侧新建一个会话…'
              : session.workspaceRoot
                ? `描述任务，Enter 发送，Shift+Enter 换行（工作区: ${session.workspaceRoot}）`
                : '直接对话即可；要操作文件请先点击上方「＋ 绑定项目」'
          }
          disabled={!session || store.running}
          rows={3}
        />
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
