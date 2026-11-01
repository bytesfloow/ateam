import { cn } from '../lib/format';
import { InfoHint } from './Field';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  id?: string;
}

export function Toggle({ checked, onChange, disabled, label, id }: ToggleProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cn('switch', checked && 'switch--on')}
      onClick={() => onChange(!checked)}
      disabled={disabled}
    >
      <span className="switch-thumb" />
    </button>
  );
}

export function ToggleRow({
  checked,
  onChange,
  title,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <div className={cn('toggle-row', disabled && 'is-disabled')}>
      <div>
        <div className="toggle-title-row">
          <span className="toggle-title">{title}</span>
          {description ? <InfoHint>{description}</InfoHint> : null}
        </div>
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} label={title} />
    </div>
  );
}
