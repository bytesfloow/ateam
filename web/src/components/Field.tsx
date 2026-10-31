import type { ReactNode } from 'react';
import { cn } from '../lib/format';

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
          {label}
          {required ? <span className="field-required">*</span> : null}
        </div>
      ) : null}
      {children}
      {error ? <div className="field-error">{error}</div> : null}
      {hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}
