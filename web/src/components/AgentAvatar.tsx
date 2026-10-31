import type { CSSProperties } from 'react';
import { cn, initials } from '../lib/format';

export function AgentAvatar({
  name,
  accent,
  size = 'md',
  className,
}: {
  name: string;
  accent?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}) {
  return (
    <span
      className={cn('agent-avatar', `agent-avatar--${size}`, className)}
      style={{ '--agent-accent': accent || '#7c9cff' } as CSSProperties}
      title={name}
    >
      {initials(name)}
    </span>
  );
}
