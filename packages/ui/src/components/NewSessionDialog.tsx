import { useEffect, useState } from 'react';
import { useStore } from '../useStore.js';
import { providerLabel } from '@easycode/engine';
import { TerminalSelect } from './TerminalSelect.js';
import type { Settings } from '@easycode/engine';

/** 新建会话：选工作区 + 选模型服务 + 选模型 */
export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const [settings, setSettings] = useState<Settings | null>(store.settings);
  const [workspace, setWorkspace] = useState('');
  const [providerId, setProviderId] = useState(settings?.defaultProvider ?? 'zhipu');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);

  const entry = settings?.providers[providerId];
  const models = (entry?.models ?? [])
    .filter((m) => m.enabled !== false)
    .map((m) => m.name);
  const isMock = entry?.kind === 'mock';
  const noModels = !isMock && models.length === 0;

  // 切换模型服务时，若已选模型不属于新服务则重置
  useEffect(() => {
    if (model && !models.includes(model)) setModel('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  const pick = async () => {
    const dir = await store.client.pickWorkspace();
    if (dir) setWorkspace(dir);
  };

  const create = async () => {
    if (noModels) return;
    setBusy(true);
    try {
      await store.newSession(workspace.trim(), providerId, model.trim() || undefined);
      onClose();
    } catch (err) {
      store.showToast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal new-session">
        <header>
          <h2>新建会话</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">✕</button>
        </header>
        <div className="settings-body">
          <label className="field">
            <span>工作区目录（可选——留空则纯对话，稍后在输入区绑定）</span>
            <div className="row">
              <input
                value={workspace}
                onChange={(e) => setWorkspace(e.target.value)}
                placeholder="留空直接对话；或选择/输入文件夹路径"
              />
              <button className="btn" onClick={pick}>浏览…</button>
            </div>
          </label>
          <label className="field">
            <span>模型服务</span>
            <TerminalSelect
              value={providerId}
              options={Object.entries(settings?.providers ?? {})
                .filter(([, p]) => p.enabled !== false)
                .map(([id, p]) => ({ value: id, label: providerLabel(id, p) }))}
              onChange={(v) => setProviderId(v)}
            />
          </label>
          <label className="field">
            <span>模型</span>
            {models.length > 0 ? (
              <TerminalSelect
                value={model}
                options={models.map((m) => ({ value: m, label: m }))}
                onChange={(v) => setModel(v)}
                placeholder="留空用第一个启用的模型"
              />
            ) : (
              <input
                value={model}
                disabled={!isMock}
                onChange={(e) => setModel(e.target.value)}
                placeholder={isMock ? '留空即可' : '该服务还没有模型，请在设置中添加'}
              />
            )}
          </label>
          {noModels && (
            <p className="hint">
              「{providerLabel(providerId, entry)}」还没有启用的模型——到 设置 › 模型服务 中「自动获取」或手动添加。
            </p>
          )}
          <p className="hint">
            所有文件与命令操作都将限制在工作区内；写文件和执行命令默认需要你批准。
          </p>
        </div>
        <footer>
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={busy || noModels}
            onClick={create}
          >
            {busy ? '创建中…' : '创建会话'}
          </button>
        </footer>
      </div>
    </div>
  );
}
