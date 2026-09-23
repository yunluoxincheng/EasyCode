import { Fragment, useEffect, useMemo, useState } from 'react';
import { useStore } from '../useStore.js';
import { updater } from '../updater.js';
import { TerminalSelect } from './TerminalSelect.js';
import { ModelConfigDialog } from './ModelConfigDialog.js';
import { ReflexDashboard } from './ReflexDashboard.js';
import { PROVIDER_PRESETS, providerLabel, validWebSearchBackend } from '@easycode/engine';
import type {
  ModelTestResult,
  ProviderEntry,
  ProviderModel,
  Settings,
  ShellInfo,
  WebSearchConfig,
} from '@easycode/engine';
import type { SettingsSection } from '../store.js';
import { fmtCtx } from '../format.js';

const KIND_LABELS: Record<Exclude<ProviderEntry['kind'], 'mock'>, string> = {
  'anthropic': 'Anthropic Messages (/v1/messages)',
  'openai-compatible': 'Chat Completions (/chat/completions)',
  'responses': 'Responses (/responses)',
};
const MOCK_LABEL = '演示协议 (Mock，无需网络)';

/** 连通性测试图标（脉冲线） */
function IconTest() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 8.5h2.5l2-5 3.5 9 2-4h3" />
    </svg>
  );
}

/** 编辑配置图标（铅笔） */
function IconEdit() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.2 2.3l2.5 2.5-8.3 8.3-3.4.9.9-3.4 8.3-8.3z" />
    </svg>
  );
}

const NAV: Array<{ id: SettingsSection; label: string; group: string }> = [
  { id: 'models', label: '模型服务', group: '配置' },
  { id: 'websearch', label: '联网搜索', group: '配置' },
  { id: 'general', label: '常规', group: '配置' },
  { id: 'reflex', label: '微模型决策 (Reflex)', group: '模型与分析' },
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
  const [configModel, setConfigModel] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ModelTestResult>>({});
  const [testingSearch, setTestingSearch] = useState(false);

  // 兜底：打开设置页时若全局设置尚未加载完成，加载完成后初始化草稿
  useEffect(() => {
    if (!draft && store.settings) setDraft(structuredClone(store.settings));
  }, [store.settings, draft]);

  const [detectedShells, setDetectedShells] = useState<ShellInfo[]>([]);

  useEffect(() => {
    if (store.client.detectShells) {
      store.client.detectShells().then(setDetectedShells).catch(() => {});
    }
  }, [store.client]);

  const shellOptions = useMemo(() => {
    const autoPick = (() => {
      const order = ['pwsh', 'git-bash', 'powershell', 'cmd'];
      for (const id of order) {
        const item = detectedShells.find((s) => s.id === id);
        if (item && item.available) return item.name;
      }
      return undefined;
    })();

    const autoLabel = autoPick
      ? `自动 (推荐: ${autoPick})`
      : '自动 (按 pwsh 7 → Git Bash → PowerShell → cmd 取最优)';

    const getStatus = (id: string) => {
      const item = detectedShells.find((s) => s.id === id);
      if (!item) return '';
      return item.available ? ' (已检测到)' : ' (未检测到)';
    };

    return [
      { value: 'auto', label: autoLabel },
      { value: 'git-bash', label: `Git Bash${getStatus('git-bash')}` },
      { value: 'pwsh', label: `PowerShell 7${getStatus('pwsh')}` },
      { value: 'powershell', label: `Windows PowerShell${getStatus('powershell')}` },
      { value: 'cmd', label: `Command Prompt (cmd)${getStatus('cmd')}` },
    ];
  }, [detectedShells]);

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
    patchProvider(id, {
      models: [
        ...modelsOf(id),
        {
          name,
          enabled: true,
          autoConfig: true,
          contextWindow: 1_000_000,
          maxOutputTokens: 65536,
          inputTypes: ['text'],
          capabilities: ['system'],
          reasoningLevels: ['low', 'medium', 'high', 'max'],
        },
      ],
    });
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

  /** 有未保存更改时先落盘（测试/探测读取的是已保存的配置） */
  const persistIfNeeded = async (): Promise<void> => {
    if (!draft) return;
    if (JSON.stringify(draft) !== JSON.stringify(store.settings)) {
      await store.saveSettings(draft);
      setDraft(structuredClone(store.settings!));
    }
  };

  /** 测试前先把未保存的草稿落盘，保证测的是当前填写的配置 */
  const testModel = async (id: string, name: string): Promise<void> => {
    setTesting(name);
    try {
      await persistIfNeeded();
      const res = await store.client.testProviderModel(id, name);
      setTestResults((r) => ({ ...r, [`${id}/${name}`]: res }));
      if (res.ok) store.showToast(`连通正常 · ${res.latencyMs}ms`);
      else store.showToast(`连通失败: ${res.error ?? '未知错误'}`, 'err');
    } catch (err) {
      store.showToast(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(null);
    }
  };

  /** 应用模型配置（含改名），返回合并后的新设置；非法时返回 null */
  const applyModelConfig = (id: string, oldName: string, next: ProviderModel): Settings | null => {
    if (!draft) return null;
    if ((draft.providers[id]?.models ?? []).some((m) => m.name === next.name && m.name !== oldName)) {
      store.showToast(`模型 ${next.name} 已存在`);
      return null;
    }
    const models = (draft.providers[id]?.models ?? []).map((m) => (m.name === oldName ? next : m));
    return { ...draft, providers: { ...draft.providers, [id]: { ...draft.providers[id], models } } };
  };

  /* ---- 联网搜索配置 ---- */

  const patchWebSearch = (p: Partial<WebSearchConfig>): void =>
    patch({
      webSearch: {
        enabled: false,
        backend: 'searxng',
        maxResults: 5,
        ...draft?.webSearch,
        ...p,
      },
    });

  const testWebSearch = async (): Promise<void> => {
    setTestingSearch(true);
    try {
      await persistIfNeeded();
      const res = await store.client.testWebSearch();
      if (res.ok) {
        store.showToast(`搜索正常 · ${res.resultCount ?? 0} 条结果 · ${res.latencyMs}ms`);
      } else {
        store.showToast(`搜索失败: ${res.error ?? '未知错误'}`, 'err');
      }
    } catch (err) {
      store.showToast(err instanceof Error ? err.message : String(err));
    } finally {
      setTestingSearch(false);
    }
  };

  const fetchModels = async (id: string): Promise<void> => {
    setFetching(true);
    try {
      const infos = await store.client.listProviderModels(id);
      let updated = 0;
      // 已有模型：自动托管语义——探测结果是权威值，直接替换（手动配置的不动）
      const CAP_CANON = ['structured', 'websearch', 'system'];
      const merged = modelsOf(id).map((m) => {
        const info = infos.find((x) => x.name === m.name);
        if (!info || m.autoConfig === false) return m;
        const next: ProviderModel = { ...m };
        next.contextWindow = info.contextWindow ?? m.contextWindow ?? 1_000_000;
        next.maxOutputTokens = info.maxOutputTokens ?? m.maxOutputTokens ?? 65536;
        if (info.inputTypes) next.inputTypes = info.inputTypes;
        if (info.capabilities) {
          // 保留用户手动勾选的联网搜索（目录无此数据源）
          const caps = new Set([
            ...info.capabilities,
            ...(m.capabilities ?? []).filter((c) => c === 'websearch'),
          ]);
          next.capabilities = CAP_CANON.filter((c) => caps.has(c));
        }
        if (info.reasoningLevels) next.reasoningLevels = [...info.reasoningLevels];
        if (JSON.stringify(next) !== JSON.stringify(m)) updated++;
        return next;
      });
      const existing = new Set(merged.map((m) => m.name));
      const fresh = infos
        .filter((x) => !existing.has(x.name))
        .map((x) => ({
          name: x.name,
          enabled: true,
          autoConfig: true,
          contextWindow: x.contextWindow ?? 1_000_000,
          maxOutputTokens: x.maxOutputTokens ?? 65536,
          inputTypes: x.inputTypes ?? ['text'],
          capabilities: x.capabilities ?? ['system'],
          reasoningLevels: x.reasoningLevels ?? ['low', 'medium', 'high', 'max'],
        }));
      if (fresh.length === 0 && updated === 0) {
        store.showToast('没有新模型可添加');
        return;
      }
      patchProvider(id, { models: [...merged, ...fresh] });
      store.showToast(
        fresh.length > 0
          ? `已获取 ${fresh.length} 个新模型${updated > 0 ? `，更新 ${updated} 个已知模型参数` : ''}`
          : `更新 ${updated} 个模型参数`,
      );
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
      store.showToast(`保存失败: ${err instanceof Error ? err.message : String(err)}`, 'err');
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
                        <>
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
                            {(p.models ?? []).map((m) => {
                              const ctx = fmtCtx(m.contextWindow);
                              const vision = (m.inputTypes ?? []).includes('image');
                              const tr = testResults[`${id}/${m.name}`];
                              return (
                                <div
                                  key={m.name}
                                  className={`model-row ${m.enabled === false ? 'off' : ''}`}
                                >
                                  <span className="model-name">
                                    {m.name}
                                    {ctx && (
                                      <span
                                        className="model-badge"
                                        title={`上下文窗口 ${m.contextWindow?.toLocaleString()} tokens`}
                                      >
                                        {ctx}
                                      </span>
                                    )}
                                    {vision && (
                                      <span className="model-badge vision" title="支持图片输入">
                                        视觉
                                      </span>
                                    )}
                                  </span>
                                  {testing === m.name ? (
                                    <span className="model-test running">···</span>
                                  ) : tr?.ok ? (
                                    <span className="model-test ok">✓ {tr.latencyMs}ms</span>
                                  ) : tr ? (
                                    <span className="model-test fail" title={tr.error}>✗</span>
                                  ) : null}
                                  <button
                                    className="icon-btn sm"
                                    title="连通性测试"
                                    disabled={testing != null}
                                    onClick={() => void testModel(id, m.name)}
                                  >
                                    <IconTest />
                                  </button>
                                  <button
                                    className="icon-btn sm"
                                    title="模型配置"
                                    onClick={() => setConfigModel(m.name)}
                                  >
                                    <IconEdit />
                                  </button>
                                  <button
                                    className={`switch ${m.enabled !== false ? 'on' : ''}`}
                                    title={m.enabled !== false ? '已启用（点击停用）' : '已停用（点击启用）'}
                                    onClick={() => toggleModel(id, m.name)}
                                  >
                                    <span className="knob" />
                                  </button>
                                </div>
                              );
                            })}
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
                        </>
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

            {configModel && (() => {
              const m = modelsOf(selectedId).find((x) => x.name === configModel);
              if (!m) return null;
              return (
                <ModelConfigDialog
                  model={m}
                  providerId={selectedId}
                  reservedNames={modelsOf(selectedId)
                    .filter((x) => x.name !== m.name)
                    .map((x) => x.name)}
                  onBeforeDetect={persistIfNeeded}
                  onClose={() => setConfigModel(null)}
                  onSave={(next) => {
                    const nextSettings = applyModelConfig(selectedId, m.name, next);
                    if (!nextSettings) return;
                    setDraft(nextSettings);
                    setConfigModel(null);
                    void store
                      .saveSettings(nextSettings)
                      .then(() => {
                        setDraft(structuredClone(store.settings!));
                        store.showToast('模型配置已保存');
                      })
                      .catch((err) =>
                        store.showToast(`保存失败: ${err instanceof Error ? err.message : String(err)}`, 'err'),
                      );
                  }}
                  onDelete={() => {
                    removeModel(selectedId, m.name);
                    setConfigModel(null);
                  }}
                />
              );
            })()}
          </>
        )}

        {section === 'websearch' && (
          <>
            <h1 className="page-title">联网搜索</h1>
            <div className="page-head">
              <p className="page-desc">
                给不支持原生搜索的模型提供 web_search 工具；开启后自动获取的模型默认启用联网搜索，
                有原生搜索的模型（GPT/Claude）仍走原生。
              </p>
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
              <div className="field">
                <span>启用联网搜索</span>
                <div className="auto-scroll-row">
                  <button
                    className={`switch ${draft.webSearch?.enabled ? 'on' : ''}`}
                    title={draft.webSearch?.enabled ? '已开启（点击关闭）' : '已关闭（点击开启）'}
                    onClick={() => patchWebSearch({ enabled: draft.webSearch?.enabled === false })}
                  >
                    <span className="knob" />
                  </button>
                  <span className="auto-scroll-text">
                    {draft.webSearch?.enabled ? '开启' : '关闭（所有模型均不联网搜索）'}
                  </span>
                </div>
              </div>

              {draft.webSearch?.enabled && (
                <>
                  <div className="field">
                    <span>搜索后端</span>
                    <TerminalSelect
                      value={draft.webSearch.backend}
                      options={[
                        { value: 'searxng', label: 'SearXNG' },
                        { value: 'tavily', label: 'Tavily' },
                        { value: 'custom', label: '自定义 API' },
                      ]}
                      onChange={(v) => patchWebSearch({ backend: v as WebSearchConfig['backend'] })}
                    />
                  </div>

                  {draft.webSearch.backend === 'searxng' && (
                    <label className="field">
                      <span>SearXNG 地址</span>
                      <input
                        value={draft.webSearch.searxngUrl ?? ''}
                        placeholder="http://localhost:8080"
                        onChange={(e) => patchWebSearch({ searxngUrl: e.target.value })}
                      />
                    </label>
                  )}
                  {draft.webSearch.backend === 'tavily' && (
                    <label className="field">
                      <span>Tavily API Key</span>
                      <input
                        type="password"
                        value={draft.webSearch.tavilyApiKey ?? ''}
                        placeholder="tvly-..."
                        onChange={(e) => patchWebSearch({ tavilyApiKey: e.target.value })}
                      />
                    </label>
                  )}
                  {draft.webSearch.backend === 'custom' && (
                    <label className="field">
                      <span>API 地址</span>
                      <input
                        value={draft.webSearch.customUrl ?? ''}
                        placeholder="https://search.example.com/search?q={query}"
                        onChange={(e) => patchWebSearch({ customUrl: e.target.value })}
                      />
                    </label>
                  )}

                  <label className="field">
                    <span>搜索结果条数</span>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={draft.webSearch.maxResults ?? 5}
                      onChange={(e) =>
                        patchWebSearch({ maxResults: Math.max(1, Math.min(10, Number(e.target.value) || 5)) })
                      }
                    />
                  </label>

                  <div className="field">
                    <span>连通性</span>
                    <div className="auto-scroll-row">
                      <button
                        className="btn"
                        disabled={testingSearch || !validWebSearchBackend(draft.webSearch)}
                        onClick={() => void testWebSearch()}
                      >
                        {testingSearch ? '搜索中…' : '测试搜索'}
                      </button>
                    </div>
                  </div>
                </>
              )}

              <p className="hint">
                {draft.webSearch?.backend === 'tavily'
                  ? 'Tavily API Key 在 tavily.com 免费注册获取（每月 1000 次免费额度）。'
                  : draft.webSearch?.backend === 'custom'
                    ? '自定义 API 为 GET 请求，{query} 会替换为 URL 编码后的搜索词；响应需为 JSON，兼容 SearXNG 的 results 格式（title/url/content）。'
                    : 'SearXNG 需在 settings.yml 的 search.formats 中启用 json 格式；localhost 地址不走应用代理。'}
              </p>
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
              <div className="field">
                <span>发送消息后自动滚到底部</span>
                <div className="auto-scroll-row">
                  <button
                    className={`switch ${draft.autoScroll !== false ? 'on' : ''}`}
                    title={draft.autoScroll !== false ? '已开启（点击关闭）' : '已关闭（点击开启）'}
                    onClick={() => patch({ autoScroll: draft.autoScroll === false })}
                  >
                    <span className="knob" />
                  </button>
                  <span className="auto-scroll-text">{draft.autoScroll !== false ? '开启' : '关闭'}</span>
                </div>
              </div>
              <div className="field">
                <span>任务完成桌面通知</span>
                <div className="auto-scroll-row">
                  <button
                    className={`switch ${draft.desktopNotify !== false ? 'on' : ''}`}
                    title={
                      draft.desktopNotify !== false
                        ? '已开启（点击关闭）——仅窗口不在前台时通知'
                        : '已关闭（点击开启）'
                    }
                    onClick={() => patch({ desktopNotify: draft.desktopNotify === false })}
                  >
                    <span className="knob" />
                  </button>
                  <span className="auto-scroll-text">
                    {draft.desktopNotify !== false ? '开启（仅窗口在后台时）' : '关闭'}
                  </span>
                </div>
              </div>
              <div className="field">
                <span>关闭窗口时最小化到系统托盘</span>
                <div className="auto-scroll-row">
                  <button
                    className={`switch ${draft.closeToTray !== false ? 'on' : ''}`}
                    title={
                      draft.closeToTray !== false
                        ? '已开启（点击关闭，窗口将在关闭时直接退出应用）'
                        : '已关闭（点击开启，关闭窗口隐藏到托盘后台常驻）'
                    }
                    onClick={() => {
                      const next = draft.closeToTray === false;
                      patch({ closeToTray: next });
                      if ('__TAURI_INTERNALS__' in window) {
                        import('@tauri-apps/api/core')
                          .then(({ invoke }) => invoke('set_close_to_tray', { enabled: next }))
                          .catch(() => {});
                      }
                    }}
                  >
                    <span className="knob" />
                  </button>
                  <span className="auto-scroll-text">
                    {draft.closeToTray !== false ? '开启（常驻托盘）' : '关闭（直接退出）'}
                  </span>
                </div>
              </div>
              <div className="field">
                <span>复古 CRT 扫描线</span>
                <div className="auto-scroll-row">
                  <button
                    className={`switch ${draft.crtScanline !== false ? 'on' : ''}`}
                    title={
                      draft.crtScanline !== false
                        ? '已开启（点击关闭，切换为纯黑极简现代终端风）'
                        : '已关闭（点击开启复古微纹理质感）'
                    }
                    onClick={() => patch({ crtScanline: draft.crtScanline === false })}
                  >
                    <span className="knob" />
                  </button>
                  <span className="auto-scroll-text">
                    {draft.crtScanline !== false ? '开启' : '关闭'}
                  </span>
                </div>
              </div>
              <label className="field">
                <span>打开工作区方式</span>
                <TerminalSelect
                  value={draft.openWorkspaceWith ?? 'explorer'}
                  options={[
                    { value: 'explorer', label: '系统文件管理器' },
                    { value: 'vscode', label: 'VS Code' },
                  ]}
                  onChange={(v) => patch({ openWorkspaceWith: v as 'explorer' | 'vscode' })}
                />
              </label>
              <label className="field">
                <span>命令行终端 (Shell)</span>
                <TerminalSelect
                  value={draft.shell ?? 'auto'}
                  options={shellOptions}
                  onChange={(v) => patch({ shell: v as any })}
                />
              </label>
              <label className="field">
                <span>单次任务最大步数</span>
                <input
                  type="number"
                  min={10}
                  max={500}
                  step={5}
                  value={draft.maxSteps ?? 200}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    patch({ maxSteps: isNaN(val) ? 200 : Math.max(10, Math.min(500, val)) });
                  }}
                />
              </label>

              <div className="field">
                <span>上下文超限自动压缩</span>
                <div className="auto-scroll-row">
                  <button
                    className={`switch ${draft.contextCompaction?.autoCompact !== false ? 'on' : ''}`}
                    title={
                      draft.contextCompaction?.autoCompact !== false
                        ? '已开启（当输入 Token 达到设定阈值时自动压缩工具长输出与早期历史）'
                        : '已关闭'
                    }
                    onClick={() =>
                      patch({
                        contextCompaction: {
                          autoCompact: draft.contextCompaction?.autoCompact === false,
                          threshold: draft.contextCompaction?.threshold ?? 0.85,
                          keepRecentTurns: draft.contextCompaction?.keepRecentTurns ?? 2,
                        },
                      })
                    }
                  >
                    <span className="knob" />
                  </button>
                  <span className="auto-scroll-text">
                    {draft.contextCompaction?.autoCompact !== false ? '开启（防 400 超限中断）' : '关闭'}
                  </span>
                </div>
              </div>

              {draft.contextCompaction?.autoCompact !== false && (
                <label className="field">
                  <span>自动压缩触发阈值 (%)</span>
                  <input
                    type="number"
                    min={50}
                    max={95}
                    step={5}
                    value={Math.round((draft.contextCompaction?.threshold ?? 0.85) * 100)}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      const pct = isNaN(val) ? 85 : Math.max(50, Math.min(95, val));
                      patch({
                        contextCompaction: {
                          autoCompact: true,
                          threshold: pct / 100,
                          keepRecentTurns: draft.contextCompaction?.keepRecentTurns ?? 2,
                        },
                      });
                    }}
                  />
                </label>
              )}

              <label className="field">
                <span>全局开发偏好与行为规范 (Global Rules)</span>
                <textarea
                  className="global-rules-textarea"
                  rows={4}
                  placeholder="在此输入跨项目的通用偏好（例如：代码注释与回复一律使用中文；优先使用纯函数；修改已有代码优先用 edit_file 精确替换…）"
                  value={draft.globalRules ?? ''}
                  onChange={(e) => patch({ globalRules: e.target.value })}
                />
              </label>
              <p className="hint">
                全局开发偏好将自动注入系统提示词，与项目专属规范（.easycoderules 等）叠加生效，对所有会话生效且天生抗上下文压缩。
              </p>
              <p className="hint">
                上下文超限自动压缩：当会话单次循环的输入 Token 达到模型窗口的指定比例（默认 85%）时，自动折叠前序工具长输出并归档早期历史，保障长任务平滑推进。
              </p>
              <p className="hint">
                单次任务最大步数：模型与工具交互的最大轮数上限（防死循环与异常空转保险），缺省为 200 步（可调范围 10~500 步）。
              </p>
              <p className="hint">
                Windows 平台优先推荐 Git Bash 或 PowerShell 7，模型可直接执行 Linux/Unix 惯用命令（ls、cat、rm 等）且原生 UTF-8 解码杜绝乱码。
              </p>
              <p className="hint">
                API Key 保存在本机设置文件中，不会上传。接入 Ollama / LM Studio 等本地服务可完全离线使用。
              </p>
            </div>
          </>
        )}

        {section === 'reflex' && (
          <>
            <h1 className="page-title">微模型决策 (Reflex)</h1>
            <ReflexDashboard />
          </>
        )}

        {section === 'about' && (
          <>
            <h1 className="page-title">关于</h1>
            <div className="about-panel">
              <table className="about-table">
                <tbody>
                  <tr><td>版本</td><td>{updater.currentVersion ? `v${updater.currentVersion}` : '开发版'}</td></tr>
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
            </div>
          </>
        )}
      </div>
    </div>
  );
}
