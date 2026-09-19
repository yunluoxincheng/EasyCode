import { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';
import { fmtCtx } from '../format.js';

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** composer 右侧：模型选择（图一）+ 思考强度滑杆（图二），均为 ChatGPT 同款 popover */
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
  const entry = store.settings?.providers[session.providerId];
  // 会话模型为空（跟随默认）时取第一个启用模型
  const effectiveModel = session.model || (entry?.models ?? []).find((m) => m.enabled !== false)?.name || '';
  const modelCfg = (entry?.models ?? []).find((m) => m.name === effectiveModel);
  const models = (entry?.models ?? []).filter((m) => m.enabled !== false).map((m) => m.name);
  const current = session.model || '默认';
  const effort = session.reasoningEffort || 'medium';
  // 该模型在设置里定义了推理等级则用之，否则用默认档位
  const effortLevels = modelCfg?.reasoningLevels?.length
    ? modelCfg.reasoningLevels
    : EFFORT_LEVELS;

  const pickModel = (m: string): void => {
    setOpen(null);
    void store
      .setSessionModel(session.id, m)
      .catch((err) => store.showToast(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className="me-picker" ref={ref}>
      <button
        className="chip model-chip"
        title="选择模型"
        onClick={() => setOpen(open === 'model' ? null : 'model')}
      >
        {store.providerLabelOf(session.providerId)} · {current}
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
          <div className="me-section">默认</div>
          <button
            className={`me-opt ${session.model === '' ? 'on' : ''}`}
            onClick={() => pickModel('')}
          >
            <span className="me-opt-name">跟随服务默认</span>
            <span className="me-check">{session.model === '' ? '✓' : ''}</span>
          </button>
          {models.length > 0 && <div className="me-section">推荐模型集</div>}
          {models.map((m) => {
            const cfg = (entry?.models ?? []).find((x) => x.name === m);
            const ctx = fmtCtx(cfg?.contextWindow);
            return (
              <button
                key={m}
                className={`me-opt ${session.model === m ? 'on' : ''}`}
                onClick={() => pickModel(m)}
              >
                <span className="me-opt-name">
                  {m}
                  {ctx && <span className="model-badge">{ctx}</span>}
                  {(cfg?.inputTypes ?? []).includes('image') && (
                    <span className="model-badge vision">视觉</span>
                  )}
                </span>
                <span className="me-check">{session.model === m ? '✓' : ''}</span>
              </button>
            );
          })}
          {models.length === 0 && (
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
