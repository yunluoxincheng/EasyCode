import { useState } from 'react';
import { useStore } from '../useStore.js';

/** 创建项目对话框（图三）：项目名称 + 源文件夹 */
export function CreateProjectDialog() {
  const store = useStore();
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);

  const close = (): void => store.closeCreateProject();

  const create = async (): Promise<void> => {
    if (!folder) return;
    setBusy(true);
    try {
      await store.createProject(name, folder);
      close();
      store.showToast('项目已创建');
    } catch (err) {
      store.showToast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal create-project">
        <header>
          <h2>创建项目</h2>
          <button className="icon-btn" onClick={close} aria-label="关闭">✕</button>
        </header>
        <div className="settings-body">
          <label className="field">
            <span>项目名称</span>
            <input
              value={name}
              autoFocus
              placeholder="项目名称"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && folder) void create();
              }}
            />
          </label>
          <div className="field">
            <span>源文件夹</span>
            <div className={`folder-drop ${folder ? 'has' : ''}`}>
              {folder ? (
                <div className="folder-picked">
                  <span className="folder-path">{folder}</span>
                  <button className="btn mini-btn" onClick={() => setFolder('')}>移除</button>
                </div>
              ) : (
                <>
                  <div className="folder-hint">在此电脑上添加文件夹</div>
                  <button
                    className="btn"
                    onClick={async () => {
                      const dir = await store.client.pickWorkspace();
                      if (dir) setFolder(dir);
                    }}
                  >
                    添加
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
        <footer>
          <button className="btn ghost" onClick={close}>取消</button>
          <button className="btn primary" disabled={!folder || busy} onClick={() => void create()}>
            {busy ? '创建中…' : '创建项目'}
          </button>
        </footer>
      </div>
    </div>
  );
}
