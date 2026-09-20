import { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';
import { fmtCtx } from '../format.js';

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** composer 右侧：Provider + 模型选择（含跨服务切换）+ 思考强度滑杆 */
export function ModelEffortPicker() {
  const store = useStore();
  const session = store.activeSession;
  const [open, setOpen] = useState<'model' | 'effort' | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!session) return null;

  const settings = store.settings;
  const currentEntry = settings?.providers[session.providerId];

  // 当前会话实际生效模型
  const effectiveModel =
    session.model ||
    (currentEntry?.models ?? []).find((m) => m.enabled !== false)?.name ||
    '';
  const modelCfg = (currentEntry?.models ?? []).find((m) => m.name === effectiveModel);
  const currentProviderLabel = store.providerLabelOf(session.providerId);
  const current = session.model || '默认';

  const effort = session.reasoningEffort || 'medium';
  const effortLevels = modelCfg?.reasoningLevels?.length ? modelCfg.reasoningLevels : EFFORT_LEVELS;

  // 所有启用的 Provider（含模型列表）用于跨服务切换
  const allProviders = Object.entries(settings?.providers ?? {})
    .filter(([, e]) => e.enabled !== false && e.kind !== 'mock')
    .map(([id, e]) => ({
      id,
      label: store.providerLabelOf(id),
      models: (e.models ?? []).filter((m) => m.enabled !== false),
    }))
    .filter((p) => p.models.length > 0);

  const pickModel = (m: string): void => {
    setOpen(null);
    void store
      .setSessionModel(session.id, m)
      .catch((err) => store.showToast(err instanceof Error ? err.message : String(err)));
  };

  const pickProvider = (providerId: string, model: string): void => {
    setOpen(null);
    void store
      .setSessionProvider(session.id, providerId, model)
      .catch((err) => store.showToast(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className="me-picker" ref={ref}>
      <button
        className="chip model-chip"
        title="选择模型 / 服务"
        onClick={() => setOpen(open === 'model' ? null : 'model')}
      >
        {currentProviderLabel} · {current}
        <span className="proj-caret">▾</span>
      </button>
      <button
        className={`chip effort-chip ${effort ? 'on' : ''}`}
        title="思考强度"
        onClick={() => setOpen(open === 'effort' ? null : 'effort')}
      >
        思考 · {effort}
      </button>

      {open === 'model' && (
        <div className="me-pop" role="listbox">
          {/* 当前 Provider 的模型 */}
          {currentEntry && (
            <>
              <div className="me-section">{currentProviderLabel} — 默认</div>
              <button
                className={`me-opt ${session.model === '' ? 'on' : ''}`}
                onClick={() => pickModel('')}
              >
                <span className="me-opt-name">跟随服务默认</span>
                <span className="me-check">{session.model === '' ? '✓' : ''}</span>
              </button>
              {(currentEntry.models ?? [])
                .filter((m) => m.enabled !== false)
                .map((m) => {
                  const ctx = fmtCtx(m.contextWindow);
                  return (
                    <button
                      key={m.name}
                      className={`me-opt ${session.model === m.name ? 'on' : ''}`}
                      onClick={() => pickModel(m.name)}
                    >
                      <span className="me-opt-name">
                        {m.name}
                        {ctx && <span className="model-badge">{ctx}</span>}
                        {(m.inputTypes ?? []).includes('image') && (
                          <span className="model-badge vision">视觉</span>
                        )}
                      </span>
                      <span className="me-check">{session.model === m.name ? '✓' : ''}</span>
                    </button>
                  );
                })}
            </>
          )}

          {/* 其他 Provider 分组 */}
          {allProviders
            .filter((p) => p.id !== session.providerId)
            .map((p) => (
              <div key={p.id}>
                <div className="me-section me-section-other">{p.label}</div>
                {p.models.map((m) => {
                  const ctx = fmtCtx(m.contextWindow);
                  return (
                    <button
                      key={`${p.id}::${m.name}`}
                      className="me-opt me-opt-other"
                      onClick={() => pickProvider(p.id, m.name)}
                    >
                      <span className="me-opt-name">
                        {m.name}
                        {ctx && <span className="model-badge">{ctx}</span>}
                        {(m.inputTypes ?? []).includes('image') && (
                          <span className="model-badge vision">视觉</span>
                        )}
                      </span>
                      <span className="me-check" />
                    </button>
                  );
                })}
              </div>
            ))}

          {allProviders.length === 0 && currentEntry === undefined && (
            <div className="me-empty">该服务还没有模型，到 设置 › 模型服务 中获取</div>
          )}
        </div>
      )}

      {open === 'effort' && (
        <div className="me-pop effort-pop" role="listbox">
          {effortLevels.map((v) => (
            <button
              key={v}
              className={`me-opt ${effort === v ? 'on' : ''}`}
              onClick={() => {
                setOpen(null);
                if (v !== effort) {
                  void store
                    .setSessionEffort(session.id, v)
                    .catch((err) => store.showToast(err instanceof Error ? err.message : String(err)));
                }
              }}
            >
              <span className="me-opt-name">{v}</span>
              <span className="me-check">{effort === v ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
