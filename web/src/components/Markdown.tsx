import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../lib/format';

export function Markdown({ children, className }: { children: string; className?: string }) {
  if (!children?.trim()) {
    return <span className="muted">（空内容）</span>;
  }
  return (
    <div className={cn('markdown', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          input: ({ node: _node, ...props }) => <input {...props} disabled />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
