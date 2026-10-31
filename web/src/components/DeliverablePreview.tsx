import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { api } from '../api';
import { FilePreviewBody, FilePreviewFooter } from './FilePreviewBody';
import { Modal } from './Modal';
import { Spinner } from './Spinner';
import { formatBytes } from '../lib/format';

export interface DeliverablePreviewModalProps {
  taskId: string;
  turnId: string;
  /** 要预览的交付文件（来自交付文件夹清单）。 */
  file: { path: string; name: string } | null;
  open: boolean;
  onClose: () => void;
}

/**
 * 交付物在线预览弹窗（正文与底栏复用 FilePreviewBody / FilePreviewFooter）。
 */
export function DeliverablePreviewModal({ taskId, turnId, file, open, onClose }: DeliverablePreviewModalProps) {
  const queryClient = useQueryClient();
  const path = file?.path ?? '';
  const query = useQuery({
    queryKey: ['deliverable', taskId, turnId, path],
    queryFn: () => api.getDeliverablePreview(taskId, turnId, path),
    enabled: open && Boolean(taskId && turnId && path),
    staleTime: 15_000,
  });

  useEffect(() => {
    // 关闭时清掉缓存，保证每次打开都重新读取最新文件内容。
    if (!open) {
      queryClient.removeQueries({ queryKey: ['deliverable', taskId, turnId, path] });
    }
  }, [open, taskId, turnId, path, queryClient]);

  const deliverable = query.data?.deliverable;
  const rawUrl = useMemo(
    () => (path ? api.deliverableUrl(taskId, turnId, path, 'raw') : ''),
    [taskId, turnId, path],
  );
  const downloadUrl = useMemo(
    () => (path ? api.deliverableUrl(taskId, turnId, path, 'download') : ''),
    [taskId, turnId, path],
  );

  return (
    <Modal
      open={open && Boolean(file)}
      onClose={onClose}
      width={860}
      title={
        <span className="deliverable-preview-title">
          <FileText size={16} />
          {file?.name ?? '交付物预览'}
        </span>
      }
      description={
        <span className="deliverable-preview-meta">
          {deliverable ? `${formatBytes(deliverable.size)} · ${deliverable.mimeType}` : ''}
        </span>
      }
      footer={
        file ? (
          <FilePreviewFooter path={file.path} name={file.name} downloadUrl={downloadUrl} onClose={onClose} />
        ) : undefined
      }
    >
      {query.isLoading ? (
        <div className="loading-panel">
          <Spinner size={20} />
          正在加载交付物…
        </div>
      ) : query.isError || !deliverable ? (
        <div className="error-panel">{(query.error as Error)?.message ?? '交付物加载失败'}</div>
      ) : (
        <FilePreviewBody file={deliverable} rawUrl={rawUrl} downloadUrl={downloadUrl} />
      )}
    </Modal>
  );
}
