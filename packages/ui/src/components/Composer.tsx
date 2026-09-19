import { useState } from 'react';
import { useStore } from '../useStore.js';

export function Composer() {
  const store = useStore();
  const [text, setText] = useState('');
  const [binding, setBinding] = useState(false);

  const submit = () => {
    const t = text;
    setText('');
    store.send(t);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const session = store.activeSession;
  const wsName = session?.workspaceRoot
    ? session.workspaceRoot.split(/[\\/]/).filter(Boolean).pop()
    : '';

  const bindProject = async (): Promise<void> => {
    if (!session || binding) return;
    setBinding(true);
    try {
      const dir = await store.client.pickWorkspace();
      if (dir) await store.bindWorkspace(session.id, dir);
    } catch (err) {
      store.showToast(err instanceof Error ? err.message : String(err));
    } finally {
      setBinding(false);
    }
  };

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
        {session && (
          <button
            className={`chip chip-ws ${session.workspaceRoot ? '' : 'unbound'}`}
            title={session.workspaceRoot || '未绑定项目——点击选择一个文件夹，启用文件与命令工具'}
            onClick={() => void bindProject()}
          >
            {binding ? '选择中…' : wsName ? `⌂ ${wsName}` : '＋ 绑定项目'}
          </button>
        )}
        {session && (
          <span className="chip model-chip" title={session.workspaceRoot || undefined}>
            {store.providerLabelOf(session.providerId)} · {session.model}
          </span>
        )}
        {store.lastUsage && (
          <span className="chip usage-chip">
            ↑{store.lastUsage.inputTokens ?? '?'} ↓{store.lastUsage.outputTokens ?? '?'} tk
          </span>
        )}
        <span className="spacer" />
        {store.running && <span className="running-dot" title="Agent 运行中" />}
      </div>
      <div className="composer-input">
        <textarea
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
