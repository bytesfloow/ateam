import type { ReactNode } from 'react';
import { cn, type Tone } from '../lib/format';

interface BadgeProps {
  tone?: Tone;
  children: ReactNode;
  dot?: boolean;
  className?: string;
}

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'badge--neutral',
  accent: 'badge--accent',
  success: 'badge--success',
  warning: 'badge--warning',
  danger: 'badge--danger',
  info: 'badge--info',
};

export function Badge({ tone = 'neutral', children, dot = false, className }: BadgeProps) {
  return (
    <span className={cn('badge', TONE_CLASS[tone], className)}>
      {dot ? <span className="badge-dot" /> : null}
      {children}
    </span>
  );
}
