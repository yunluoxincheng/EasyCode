import { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';
import { lookupCatalog } from '@easycode/engine';
import type { ProviderModel, ProviderModelInfo } from '@easycode/engine';

const DEFAULT_WINDOW = 1_000_000;
const DEFAULT_OUTPUT = 65536;

const INPUT_TYPE_LABELS: Array<{ id: string; label: string; locked?: boolean }> = [
  { id: 'text', label: '文本', locked: true },
  { id: 'image', label: '图片' },
  { id: 'video', label: '视频' },
  { id: 'pdf', label: 'PDF' },
];
const CAPABILITY_LABELS: Array<{ id: string; label: string }> = [
  { id: 'structured', label: '结构化输出' },
  { id: 'websearch', label: '原生联网搜索' },
  { id: 'system', label: '对话中系统消息' },
];

function clone(m: ProviderModel): ProviderModel {
  return {
    ...m,
    inputTypes: m.inputTypes ? [...m.inputTypes] : ['text'],
    capabilities: m.capabilities ? [...m.capabilities] : ['system'],
    reasoningLevels: m.reasoningLevels ? [...m.reasoningLevels] : [],
  };
}

/**
 * 编辑模型配置弹窗（图二）：智能配置开关 + 上下文/输出参数 + 高级配置
 * （输入类型、模型能力、推理等级、推理参数映射）。
 * 智能配置开启时自动探测上下文窗口与最大输出，关闭后可手动编辑。
 */
export function ModelConfigDialog(props: {
  model: ProviderModel;
  providerId: string;
  reservedNames: string[];
  /** 探测前的钩子：设置页用它在探测前落盘未保存的草稿 */
  onBeforeDetect?(): Promise<void>;
  onClose(): void;
  onSave(next: ProviderModel): void;
  onDelete(): void;
}) {
  const store = useStore();
  const [draft, setDraft] = useState<ProviderModel>(() => clone(props.model));
  const [smart, setSmart] = useState(props.model.autoConfig !== false);
  const [advanced, setAdvanced] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [addingLevel, setAddingLevel] = useState(false);
  const [levelValue, setLevelValue] = useState('');
  const [saving, setSaving] = useState(false);
  const levelInputRef = useRef<HTMLInputElement>(null);

  const set = (p: Partial<ProviderModel>): void => setDraft((d) => ({ ...d, ...p }));

  /**
   * 智能探测：先取内置规格目录（离线），再叠加供应商 /models 与 models.dev
   * 在线目录的结果；两者都拿不到时保留当前值/默认值兜底。
   * 探测结果为权威值（直接替换），仅保留用户手动勾选的联网搜索。
   */
  const detect = async (silent: boolean): Promise<void> => {
    setDetecting(true);
    try {
      const cat = lookupCatalog(props.model.name);
      let info: ProviderModelInfo | undefined;
      try {
        await props.onBeforeDetect?.();
        info = (await store.client.listProviderModels(props.providerId)).find(
          (m) => m.name === props.model.name,
        );
      } catch {
        // 供应商接口不可用时仅用目录结果
      }
      const contextWindow =
        info?.contextWindow ?? cat?.contextWindow ?? draft.contextWindow ?? DEFAULT_WINDOW;
      const maxOutputTokens =
        info?.maxOutputTokens ?? cat?.maxOutputTokens ?? draft.maxOutputTokens ?? DEFAULT_OUTPUT;
      const inputTypes =
        info?.inputTypes ?? cat?.inputTypes ?? (draft.inputTypes?.length ? draft.inputTypes : ['text']);
      const caps = new Set(
        info?.capabilities || cat?.capabilities
          ? [
              ...(info?.capabilities ?? []),
              ...(cat?.capabilities ?? []),
              ...(draft.capabilities ?? []).filter((c) => c === 'websearch'),
            ]
          : (draft.capabilities ?? []),
      );
      caps.add('system');
      const capabilities = ['structured', 'websearch', 'system'].filter((c) => caps.has(c));
      const reasoningLevels =
        info?.reasoningLevels ?? cat?.reasoningLevels ?? draft.reasoningLevels ?? [];
      set({
        contextWindow,
        maxOutputTokens,
        inputTypes,
        capabilities,
        reasoningLevels,
      });
      if (!silent && !info && !cat) {
        store.showToast('目录中没有该模型的参数，已使用默认值');
      }
    } finally {
      setDetecting(false);
    }
  };

  useEffect(() => {
    if (smart) void detect(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (addingLevel) levelInputRef.current?.focus();
  }, [addingLevel]);

  const toggleSmart = (): void => {
    const next = !smart;
    setSmart(next);
    if (next) {
      // 重新打开智能配置：清空本地值并重新探测
      set({ contextWindow: undefined, maxOutputTokens: undefined });
      void detect(true);
    } else {
      // 转手动：给当前值一个具体数字，便于直接编辑
      setDraft((d) => ({
        ...d,
        contextWindow: d.contextWindow ?? DEFAULT_WINDOW,
        maxOutputTokens: d.maxOutputTokens ?? DEFAULT_OUTPUT,
      }));
    }
  };

  const save = (): void => {
    const name = draft.name.trim();
    if (!name) {
      store.showToast('模型 ID 不能为空');
      return;
    }
    if (props.reservedNames.includes(name)) {
      store.showToast(`模型 ${name} 已存在`);
      return;
    }
    setSaving(true);
    props.onSave({
      ...draft,
      name,
      autoConfig: smart,
      contextWindow: Math.max(1, Math.round(draft.contextWindow ?? DEFAULT_WINDOW)),
      maxOutputTokens: Math.max(1, Math.round(draft.maxOutputTokens ?? DEFAULT_OUTPUT)),
      inputTypes: draft.inputTypes?.length ? draft.inputTypes : ['text'],
      capabilities: draft.capabilities ?? [],
    });
  };

  const confirmLevel = (): void => {
    const v = levelValue.trim().toLowerCase();
    if (v && !draft.reasoningLevels?.includes(v)) {
      set({ reasoningLevels: [...(draft.reasoningLevels ?? []), v] });
    }
    setLevelValue('');
    setAddingLevel(false);
  };

  const removeLevel = (lv: string): void => {
    set({ reasoningLevels: (draft.reasoningLevels ?? []).filter((x) => x !== lv) });
  };

  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div className="modal model-config">
        <header>
          <h2>编辑模型配置</h2>
          <button className="icon-btn" onClick={props.onClose} aria-label="关闭">✕</button>
        </header>
        <div className="settings-body">
          <div className="field">
            <span>智能配置</span>
            <div className="auto-scroll-row">
              <button
                className={`switch ${smart ? 'on' : ''}`}
                title={smart ? '自动探测参数（点击改为手动）' : '手动配置（点击改为自动）'}
                onClick={toggleSmart}
              >
                <span className="knob" />
              </button>
              <span className="auto-scroll-text">
                {detecting ? '探测中…' : smart ? '自动探测参数' : '手动填写'}
              </span>
            </div>
          </div>

          <label className="field">
            <span>模型 ID</span>
            <input
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && save()}
            />
          </label>

          <label className="field">
            <span>上下文窗口</span>
            <input
              type="number"
              value={draft.contextWindow ?? ''}
              disabled={smart}
              placeholder={String(DEFAULT_WINDOW)}
              onChange={(e) => set({ contextWindow: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </label>

          <label className="field">
            <span>最大输出 Token</span>
            <input
              type="number"
              value={draft.maxOutputTokens ?? ''}
              disabled={smart}
              placeholder={String(DEFAULT_OUTPUT)}
              onChange={(e) => set({ maxOutputTokens: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </label>

          <button className="mc-advanced-toggle" onClick={() => setAdvanced(!advanced)}>
            <span className={`mc-caret ${advanced ? 'open' : ''}`}>▸</span> 高级配置
          </button>

          {advanced && (
            <>
              <div className="field">
                <span>输入类型</span>
                <div className="cap-chips">
                  {INPUT_TYPE_LABELS.map(({ id, label, locked }) => {
                    const on = (draft.inputTypes ?? ['text']).includes(id);
                    return (
                      <button
                        key={id}
                        className={`cap-chip ${on ? 'on' : ''} ${locked ? 'locked' : ''}`}
                        title={locked ? '文本输入恒可用' : on ? '已支持（点击移除）' : '不支持（点击添加）'}
                        disabled={locked}
                        onClick={() => {
                          if (locked) return;
                          const cur = new Set(draft.inputTypes ?? ['text']);
                          if (cur.has(id)) cur.delete(id);
                          else cur.add(id);
                          const next = ['text', 'image', 'video', 'pdf'].filter((t) => cur.has(t));
                          set({ inputTypes: next });
                        }}
                      >
                        {on ? '☑' : '☐'} {label}
                        {locked && <span className="cap-lock"> ⌁</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="field">
                <span>模型能力</span>
                <div className="cap-chips">
                  {CAPABILITY_LABELS.map(({ id, label }) => {
                    const on = (draft.capabilities ?? []).includes(id);
                    return (
                      <button
                        key={id}
                        className={`cap-chip ${on ? 'on' : ''}`}
                        title={on ? '已启用（点击关闭）' : '未启用（点击开启）'}
                        onClick={() => {
                          const cur = new Set(draft.capabilities ?? []);
                          if (cur.has(id)) cur.delete(id);
                          else cur.add(id);
                          set({ capabilities: [...cur] });
                        }}
                      >
                        {on ? '☑' : '☐'} {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="field">
                <span>推理等级（从低到高）</span>
                <div className="cap-chips">
                  {(draft.reasoningLevels ?? []).map((lv) => (
                    <span key={lv} className="cap-chip on level-chip">
                      {lv}
                      <button className="level-x" title="移除" onClick={() => removeLevel(lv)}>×</button>
                    </span>
                  ))}
                  {addingLevel ? (
                    <input
                      ref={levelInputRef}
                      className="level-input"
                      value={levelValue}
                      placeholder="等级名"
                      onChange={(e) => setLevelValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') confirmLevel();
                        if (e.key === 'Escape') {
                          setAddingLevel(false);
                          setLevelValue('');
                        }
                      }}
                      onBlur={confirmLevel}
                    />
                  ) : (
                    <button className="cap-chip add" title="添加等级" onClick={() => setAddingLevel(true)}>
                      ＋
                    </button>
                  )}
                </div>
              </div>

              <label className="field">
                <span>推理参数映射</span>
                <textarea
                  className="mono-area"
                  rows={3}
                  value={draft.reasoningMapping ?? ''}
                  placeholder={'如 reasoningLevel == "disabled" 时不下发推理参数'}
                  onChange={(e) => set({ reasoningMapping: e.target.value })}
                />
              </label>
            </>
          )}
        </div>

        <footer className="mc-foot">
          <div className="mc-foot-left">
            <button
              className="btn ghost"
              title="恢复为已保存的配置"
              onClick={() => {
                setDraft(clone(props.model));
                setSmart(props.model.autoConfig !== false);
                setAddingLevel(false);
              }}
            >
              重新表单
            </button>
            <button className="btn ghost danger" onClick={props.onDelete}>删除模型</button>
          </div>
          <div className="mc-foot-right">
            <button className="btn ghost" onClick={props.onClose}>取消</button>
            <button className="btn primary" disabled={saving} onClick={save}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
