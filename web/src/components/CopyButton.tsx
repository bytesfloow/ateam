import { Copy } from 'lucide-react';
import { useToast } from '../lib/toast';

export function CopyButton({ value, label = '复制', className }: { value: string; label?: string; className?: string }) {
  const toast = useToast();
  return (
    <button
      type="button"
      className={className ?? 'button button--ghost button--sm'}
      onClick={() => {
        navigator.clipboard
          .writeText(value)
          .then(() => toast.success('已复制到剪贴板'))
          .catch(() => toast.error('复制失败'));
      }}
    >
      <Copy size={14} />
      {label}
    </button>
  );
}
