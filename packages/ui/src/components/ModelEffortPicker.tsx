import { useEffect, useRef, useState } from 'react';
import { useStore } from '../useStore.js';

const EFFORT_LEVELS = [
  { value: 'minimal', label: '最低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'max', label: '最高' },
];

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
  const effort = session.reasoningEffort || '';
  const effortLabel = effort ? EFFORT_LEVELS.find((l) => l.value === effort)?.label ?? effort : '默认';

  const pickModel = (m: string): void => {
    setOpen(null);
    void store
      .setSessionModel(session.id, m)
      .catch((err) => store.showToast(err instanceof Error ? err.message : String(err)));
  };

  const pickEffort = (v: string): void => {
    void store
      .setSessionEffort(session.id, v)
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
        思考 · {effortLabel}
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
        <div className="me-pop effort-pop">
          <div className="effort-current">
            <span className="effort-big">{effortLabel}</span>
            <span className="effort-hint">思考强度 · 生效取决于模型是否支持</span>
          </div>
          <input
            className="effort-slider"
            type="range"
            min={0}
            max={EFFORT_LEVELS.length - 1}
            step={1}
            value={EFFORT_LEVELS.findIndex((l) => l.value === effort) === -1 ? 4 : EFFORT_LEVELS.findIndex((l) => l.value === effort)}
            onChange={(e) => pickEffort(EFFORT_LEVELS[Number(e.target.value)].value)}
          />
          <div className="effort-ticks">
            {EFFORT_LEVELS.map((l) => (
              <span key={l.value} className={l.value === effort ? 'on' : ''}>{l.label}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
