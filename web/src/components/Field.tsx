import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { cn } from '../lib/format';

/**
 * 字段说明气泡：label 右侧的 info 图标，点击后在其下方弹出描述。
 * 气泡相对最近的 position:relative 祖先（.field-label / .toggle-title-row）左对齐，
 * 保证窄屏不溢出视口右缘。
 */
export function InfoHint({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="info-hint" ref={wrapRef}>
      <button
        type="button"
        className={cn('info-hint-btn', open && 'is-open')}
        aria-label="字段说明"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Info size={13} />
      </button>
      {open ? (
        <div className="info-popover" role="tooltip">
          {children}
        </div>
      ) : null}
    </div>
  );
}

interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

export function Field({ label, hint, error, required, className, children }: FieldProps) {
  return (
    <div className={cn('field', className)}>
      {label ? (
        <div className="field-label">
          <span className="field-label-text">{label}</span>
          {required ? <span className="field-required">*</span> : null}
          {hint ? <InfoHint>{hint}</InfoHint> : null}
        </div>
      ) : null}
      {children}
      {error ? <div className="field-error">{error}</div> : null}
      {hint && !label ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}
