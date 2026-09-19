import { Fragment, useEffect, useMemo, useState } from 'react';
import { useStore } from '../useStore.js';
import { TerminalSelect } from './TerminalSelect.js';
import { PROVIDER_PRESETS, providerLabel } from '@easycode/engine';
import type { ProviderEntry, ProviderModel, Settings } from '@easycode/engine';
import type { SettingsSection } from '../store.js';

const KIND_LABELS: Record<Exclude<ProviderEntry['kind'], 'mock'>, string> = {
  'openai-compatible': 'OpenAI 兼容 (/chat/completions)',
  'anthropic': 'Anthropic (/v1/messages)',
};
const MOCK_LABEL = '演示协议 (Mock，无需网络)';

const NAV: Array<{ id: SettingsSection; label: string; group: string }> = [
  { id: 'models', label: '模型服务', group: '配置' },
  { id: 'general', label: '常规', group: '配置' },
  { id: 'about', label: '关于', group: '信息' },
];

export function SettingsPage() {
  const store = useStore();
  const section = store.settingsSection;
  const [draft, setDraft] = useState<Settings | null>(
    store.settings ? structuredClone(store.settings) : null,
  );
  const [selectedId, setSelectedId] = useState<string>(store.settings?.defaultProvider ?? 'zhipu');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newModelName, setNewModelName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // 兜底：打开设置页时若全局设置尚未加载完成，加载完成后初始化草稿
  useEffect(() => {
    if (!draft && store.settings) setDraft(structuredClone(store.settings));
  }, [store.settings, draft]);

  const dirty = useMemo(
    () => !!draft && !!store.settings && JSON.stringify(draft) !== JSON.stringify(store.settings),
    [draft, store.settings],
  );

  const patch = (p: Partial<Settings>): void =>
    setDraft((d) => (d ? { ...d, ...p } : d));
  const patchProvider = (id: string, p: Partial<ProviderEntry>): void =>
    setDraft((d) =>
      d
        ? { ...d, providers: { ...d.providers, [id]: { ...d.providers[id], ...p } } }
        : d,
    );

  const addCustom = (): void => {
    if (!draft) return;
    let n = 1;
    while (draft.providers[`custom-${n}`]) n++;
    const id = `custom-${n}`;
    patch({
      providers: {
        ...draft.providers,
        [id]: {
          kind: 'openai-compatible',
          baseURL: '',
          apiKey: '',
          models: [],
          enabled: true,
          name: `自定义供应商 ${n}`,
        },
      },
    });
    setSelectedId(id);
  };

  const removeCustom = (id: string): void => {
    if (!draft || id in PROVIDER_PRESETS) return;
    const providers = { ...draft.providers };
    delete providers[id];
    const next = { ...draft, providers };
    if (next.defaultProvider === id) next.defaultProvider = 'zhipu';
    setDraft(next);
    setSelectedId(Object.keys(providers)[0] ?? 'zhipu');
  };

  /* ---- 模型列表管理 ---- */

  const modelsOf = (id: string): ProviderModel[] => draft?.providers[id]?.models ?? [];

  const startAddModel = (): void => {
    setAdding(true);
    setNewModelName('');
  };

  const confirmAdd = (id: string): void => {
    const name = newModelName.trim();
    if (!name) return;
    if (modelsOf(id).some((m) => m.name === name)) {
      store.showToast(`模型 ${name} 已存在`);
      return;
    }
    patchProvider(id, { models: [...modelsOf(id), { name, enabled: true }] });
    setAdding(false);
    setNewModelName('');
  };

  const removeModel = (id: string, name: string): void => {
    patchProvider(id, { models: modelsOf(id).filter((m) => m.name !== name) });
  };

  const toggleModel = (id: string, name: string): void => {
    patchProvider(id, {
      models: modelsOf(id).map((m) =>
        m.name === name ? { ...m, enabled: m.enabled === false } : m,
      ),
    });
  };

  const startRename = (name: string): void => {
    setRenaming(name);
    setRenameValue(name);
  };

  const confirmRename = (id: string, oldName: string): void => {
    const name = renameValue.trim();
    if (!name || name === oldName) {
      setRenaming(null);
      return;
    }
    if (modelsOf(id).some((m) => m.name === name)) {
      store.showToast(`模型 ${name} 已存在`);
      return;
    }
    patchProvider(id, {
      models: modelsOf(id).map((m) => (m.name === oldName ? { ...m, name } : m)),
    });
    setRenaming(null);
  };

  const fetchModels = async (id: string): Promise<void> => {
    setFetching(true);
    try {
      const ids = await store.client.listProviderModels(id);
      const existing = new Set(modelsOf(id).map((m) => m.name));
      const fresh = ids
        .filter((x) => !existing.has(x))
        .map((x) => ({ name: x, enabled: true }));
      if (fresh.length === 0) {
        store.showToast('没有新模型可添加');
        return;
      }
      patchProvider(id, { models: [...modelsOf(id), ...fresh] });
      store.showToast(`已获取 ${fresh.length} 个新模型`);
    } catch (err) {
      store.showToast(err instanceof Error ? err.message : String(err));
    } finally {
      setFetching(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    try {
      await store.saveSettings(draft);
      // 默认审批模式立即作用到当前会话的输入区
      if (store.mode !== draft.defaultApprovalMode) {
        await store.setMode(draft.defaultApprovalMode);
      }
      store.showToast('设置已保存');
      setDraft(structuredClone(store.settings!));
    } catch (err) {
      store.showToast(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const enabledEntries = Object.entries(draft?.providers ?? {}).filter(
    ([, p]) => p.enabled !== false,
  );

  if (!draft) {
    return (
      <div className="settings-page">
        <aside className="settings-nav" />
        <div className="settings-content">
          <h1 className="page-title">设置</h1>
          <p className="page-desc">正在加载…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-page">
      <aside className="settings-nav">
        <button className="back-link" onClick={() => store.openChat()}>
          ‹ 返回会话
        </button>
        {NAV.map(({ id, label, group }, i) => (
          <Fragment key={id}>
            {(i === 0 || NAV[i - 1].group !== group) && (
              <div className="nav-group">{group}</div>
            )}
            <button
              className={`nav-item ${section === id ? 'active' : ''}`}
              onClick={() => store.openSettings(id)}
            >
              {label}
            </button>
          </Fragment>
        ))}
      </aside>

      <div className="settings-content">
        {section === 'models' && (
          <>
            <h1 className="page-title">模型服务</h1>
            <div className="page-head">
              <p className="page-desc">管理模型供应商；配置后可在新建会话时选择使用。</p>
              <div className="page-actions">
                {dirty && <span className="dirty-dot" title="有未保存的更改">●</span>}
                {dirty && (
                  <button className="btn" onClick={() => setDraft(structuredClone(store.settings!))}>
                    放弃更改
                  </button>
                )}
                <button className="btn" onClick={addCustom}>＋ 添加自定义供应商</button>
                <button className="btn primary" disabled={!dirty || saving} onClick={() => void save()}>
                  {saving ? '保存中…' : '保存'}
                </button>
              </div>
            </div>

            <div className="models-panel">
              <aside className="provider-list">
                {(['内置预设', '自定义供应商'] as const).map((group) => {
                  const ids = Object.keys(draft.providers).filter((id) =>
                    group === '内置预设' ? id in PROVIDER_PRESETS : !(id in PROVIDER_PRESETS),
                  );
                  if (ids.length === 0) return null;
                  return (
                    <div key={group}>
                      <div className="provider-group">{group}</div>
                      {ids.map((id) => {
                        const p = draft.providers[id];
                        return (
                          <button
                            key={id}
                            className={`provider-item ${id === selectedId ? 'active' : ''} ${p.enabled === false ? 'off' : ''}`}
                            onClick={() => setSelectedId(id)}
                          >
                            <span className="provider-item-name">{providerLabel(id, p)}</span>
                            <span className={`provider-dot ${p.enabled !== false ? 'on' : ''}`} />
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </aside>

              <div className="provider-detail">
                {(() => {
                  const id = selectedId in draft.providers ? selectedId : 'demo';
                  const p = draft.providers[id];
                  const isBuiltin = id in PROVIDER_PRESETS;
                  const isMock = p.kind === 'mock';
                  return (
                    <>
                      <div className="pd-head">
                        <span className="pd-title">{providerLabel(id, p)}</span>
                        <span className="pd-id">{id}</span>
                        <span className="spacer" />
                        <button
                          className={`switch ${p.enabled !== false ? 'on' : ''}`}
                          title={p.enabled !== false ? '已启用（点击停用）' : '已停用（点击启用）'}
                          onClick={() => patchProvider(id, { enabled: p.enabled === false })}
                        >
                          <span className="knob" />
                        </button>
                      </div>

                      <label className="field">
                        <span>显示名称</span>
                        <input
                          value={p.name ?? ''}
                          onChange={(e) => patchProvider(id, { name: e.target.value })}
                          placeholder={id}
                        />
                      </label>

                      <label className="field">
                        <span>API 格式</span>
                        {isMock ? (
                          <input value={MOCK_LABEL} disabled />
                        ) : (
                          <TerminalSelect
                            value={p.kind}
                            options={Object.entries(KIND_LABELS).map(([k, label]) => ({ value: k, label }))}
                            onChange={(k) => patchProvider(id, { kind: k as ProviderEntry['kind'] })}
                          />
                        )}
                      </label>

                      <label className="field">
                        <span>Base URL</span>
                        <input
                          value={p.baseURL}
                          disabled={isMock}
                          onChange={(e) => patchProvider(id, { baseURL: e.target.value })}
                          placeholder="https://..."
                        />
                      </label>

                      <label className="field">
                        <span>API Key</span>
                        <div className="row">
                          <input
                            type={showKey ? 'text' : 'password'}
                            value={p.apiKey ?? ''}
                            disabled={isMock}
                            onChange={(e) => patchProvider(id, { apiKey: e.target.value })}
                            placeholder={isMock ? '演示模式无需 Key' : 'sk-...'}
                          />
                          <button className="btn" onClick={() => setShowKey(!showKey)}>
                            {showKey ? '隐藏' : '显示'}
                          </button>
                        </div>
                      </label>

                      {isMock ? (
                        <p className="hint">演示协议无需配置模型。</p>
                      ) : (
                        <div className="field">
                          <div className="models-head">
                            <span>模型列表</span>
                            <div className="models-head-actions">
                              <button
                                className="btn"
                                disabled={fetching}
                                onClick={() => void fetchModels(id)}
                              >
                                {fetching ? '获取中…' : '自动获取'}
                              </button>
                              <button className="btn" onClick={startAddModel}>＋ 添加模型</button>
                            </div>
                          </div>
                          <div className="models-list">
                            {(p.models ?? []).length === 0 && !adding && (
                              <div className="models-empty">
                                还没有模型。点击「自动获取」从 API 拉取，或「＋ 添加模型」手动添加。
                              </div>
                            )}
                            {(p.models ?? []).map((m) => (
                              <div
                                key={m.name}
                                className={`model-row ${m.enabled === false ? 'off' : ''}`}
                              >
                                {renaming === m.name ? (
                                  <input
                                    className="model-rename"
                                    value={renameValue}
                                    autoFocus
                                    onChange={(e) => setRenameValue(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') confirmRename(id, m.name);
                                      if (e.key === 'Escape') setRenaming(null);
                                    }}
                                  />
                                ) : (
                                  <span className="model-name">{m.name}</span>
                                )}
                                {renaming === m.name ? (
                                  <>
                                    <button className="btn mini-btn" onClick={() => confirmRename(id, m.name)}>确认</button>
                                    <button className="btn mini-btn" onClick={() => setRenaming(null)}>取消</button>
                                  </>
                                ) : (
                                  <>
                                    <button className="btn mini-btn" onClick={() => startRename(m.name)}>改名</button>
                                    <button className="btn mini-btn" onClick={() => removeModel(id, m.name)}>删除</button>
                                    <button
                                      className={`switch ${m.enabled !== false ? 'on' : ''}`}
                                      title={m.enabled !== false ? '已启用（点击停用）' : '已停用（点击启用）'}
                                      onClick={() => toggleModel(id, m.name)}
                                    >
                                      <span className="knob" />
                                    </button>
                                  </>
                                )}
                              </div>
                            ))}
                            {adding && (
                              <div className="model-row">
                                <input
                                  className="model-rename"
                                  placeholder="模型 ID，如 glm-4.6"
                                  value={newModelName}
                                  autoFocus
                                  onChange={(e) => setNewModelName(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') confirmAdd(id);
                                    if (e.key === 'Escape') setAdding(false);
                                  }}
                                />
                                <button className="btn mini-btn" onClick={() => confirmAdd(id)}>确认</button>
                                <button className="btn mini-btn" onClick={() => setAdding(false)}>取消</button>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {!isBuiltin && (
                        <div className="pd-foot">
                          <button className="btn danger" onClick={() => removeCustom(id)}>
                            删除此供应商
                          </button>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          </>
        )}

        {section === 'general' && (
          <>
            <h1 className="page-title">常规</h1>
            <div className="page-head">
              <p className="page-desc">新会话的默认行为。</p>
              <div className="page-actions">
                {dirty && <span className="dirty-dot" title="有未保存的更改">●</span>}
                {dirty && (
                  <button className="btn" onClick={() => setDraft(structuredClone(store.settings!))}>
                    放弃更改
                  </button>
                )}
                <button className="btn primary" disabled={!dirty || saving} onClick={() => void save()}>
                  {saving ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
            <div className="general-panel">
              <label className="field">
                <span>新会话默认模型服务</span>
                <TerminalSelect
                  value={draft.defaultProvider}
                  options={enabledEntries.map(([id, p]) => ({ value: id, label: providerLabel(id, p) }))}
                  onChange={(v) => patch({ defaultProvider: v })}
                />
              </label>
              <div className="field">
                <span>默认审批模式</span>
                <div className="segmented">
                  {(['ask', 'yolo'] as const).map((m) => (
                    <button
                      key={m}
                      className={draft.defaultApprovalMode === m ? 'active' : ''}
                      onClick={() => patch({ defaultApprovalMode: m })}
                    >
                      {m === 'ask' ? '询问（敏感操作需批准）' : 'YOLO（自动放行）'}
                    </button>
                  ))}
                </div>
              </div>
              <p className="hint">
                API Key 保存在本机设置文件中，不会上传。接入 Ollama / LM Studio 等本地服务可完全离线使用。
              </p>
            </div>
          </>
        )}

        {section === 'about' && (
          <>
            <h1 className="page-title">关于</h1>
            <div className="about-panel">
              <div className="about-brand">▚ EASYCODE</div>
              <table className="about-table">
                <tbody>
                  <tr><td>版本</td><td>v0.1.0</td></tr>
                  <tr><td>定位</td><td>轻量、模块化的桌面 Coding Agent</td></tr>
                  <tr>
                    <td>运行环境</td>
                    <td>
                      {document.documentElement.classList.contains('env-tauri')
                        ? 'Tauri (Rust 宿主 + WebView2)'
                        : document.documentElement.classList.contains('env-electron')
                          ? 'Electron'
                          : '浏览器演示'}
                    </td>
                  </tr>
                  <tr><td>已配置供应商</td><td>{Object.keys(draft.providers).length} 个（{enabledEntries.length} 个启用）</td></tr>
                  <tr><td>数据目录</td><td>会话与设置保存在本机用户数据目录</td></tr>
                </tbody>
              </table>
              <p className="hint">Agent 能力：读写文件 · 目录浏览 · 正则搜索 · 执行命令 · 审批门 · 流式输出</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
