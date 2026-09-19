import { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';

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
  const models = (entry?.models ?? []).filter((m) => m.enabled !== false).map((m) => m.name);
  const current = session.model || '默认';
  const effort = session.reasoningEffort || 'medium';

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
          {models.map((m) => (
            <button
              key={m}
              className={`me-opt ${session.model === m ? 'on' : ''}`}
              onClick={() => pickModel(m)}
            >
              <span className="me-opt-name">{m}</span>
              <span className="me-check">{session.model === m ? '✓' : ''}</span>
            </button>
          ))}
          {models.length === 0 && (
            <div className="me-empty">该服务还没有模型，到 设置 › 模型服务 中获取</div>
          )}
        </div>
      )}

      {open === 'effort' && (
        <div className="me-pop effort-pop" role="listbox">
          {EFFORT_LEVELS.map((v) => (
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
