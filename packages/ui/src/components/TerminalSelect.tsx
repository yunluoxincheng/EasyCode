import { useEffect, useRef, useState } from 'react';

export interface TermSelectOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  options: TermSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

/** 终端风下拉：自绘弹出菜单（原生 select 的弹出层无法贴合主题） */
export function TerminalSelect({ value, options, onChange, disabled, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const openMenu = (): void => {
    setHighlight(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  const pick = (v: string): void => {
    onChange(v);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(options.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter' && highlight >= 0 && options[highlight]) {
      e.preventDefault();
      pick(options[highlight].value);
    }
  };

  const current = options.find((o) => o.value === value);

  return (
    <div className={`tsel ${open ? 'open' : ''} ${disabled ? 'disabled' : ''}`} ref={ref}>
      <button
        type="button"
        className="tsel-head"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className={`tsel-value ${current ? '' : 'placeholder'}`}>
          {current?.label ?? placeholder ?? value}
        </span>
        <span className="tsel-chevron">{open ? '▴' : '▾'}</span>
      </button>
      {open && options.length > 0 && (
        <div className="tsel-menu" role="listbox">
          {options.map((o, i) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`tsel-opt ${o.value === value ? 'on' : ''} ${i === highlight ? 'hl' : ''}`}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => pick(o.value)}
            >
              <span className="tsel-mark">{o.value === value ? '▸' : ''}</span>
              <span className="tsel-opt-label">{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
