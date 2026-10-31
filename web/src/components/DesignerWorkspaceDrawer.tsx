import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  Download,
  FileText,
  FolderOpen,
  FolderUp,
  Image as ImageIcon,
  RefreshCw,
} from 'lucide-react';
import type { DesignerWorkspaceEntry } from '@shared/types';
import { api } from '../api';
import { Drawer } from './Drawer';
import { EmptyState } from './EmptyState';
import { FilePreviewBody, FilePreviewFooter } from './FilePreviewBody';
import { Modal } from './Modal';
import { Spinner } from './Spinner';
import { cn, formatBytes } from '../lib/format';

/** 前端展示用：按扩展名判断是否图片（决定列表图标）。 */
function isImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(name);
}

function EntryIcon({ entry }: { entry: DesignerWorkspaceEntry }) {
  if (entry.type === 'dir') return <FolderOpen size={15} />;
  return isImageName(entry.name) ? <ImageIcon size={15} /> : <FileText size={15} />;
}

/** 设计师工作目录文件预览弹窗（与交付物预览同一套能力）。 */
function WorkspaceFilePreviewModal({
  path,
  open,
  onClose,
}: {
  path: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['designer-workspace-file', path],
    queryFn: () => api.getDesignerWorkspacePreview(path!),
    enabled: open && Boolean(path),
    staleTime: 5_000,
  });

  useEffect(() => {
    // 关闭时清掉缓存，保证每次打开都重新读取最新文件内容。
    if (!open && path) {
      queryClient.removeQueries({ queryKey: ['designer-workspace-file', path] });
    }
  }, [open, path, queryClient]);

  const file = query.data?.file ?? null;
  const rawUrl = useMemo(
    () => (path ? api.designerWorkspaceUrl(path, 'raw') : ''),
    [path],
  );
  const downloadUrl = useMemo(
    () => (path ? api.designerWorkspaceUrl(path, 'download') : ''),
    [path],
  );

  return (
    <Modal
      open={open && Boolean(path)}
      onClose={onClose}
      width={860}
      title={
        <span className="deliverable-preview-title">
          <FileText size={16} />
          {file?.name ?? path?.split('/').pop() ?? '文件预览'}
        </span>
      }
      description={
        <span className="deliverable-preview-meta">
          {file ? `${formatBytes(file.size)} · ${file.mimeType}` : ''}
        </span>
      }
      footer={
        path ? (
          <FilePreviewFooter path={path} name={path.split('/').pop() ?? path} downloadUrl={downloadUrl} onClose={onClose} />
        ) : undefined
      }
    >
      {query.isLoading ? (
        <div className="loading-panel">
          <Spinner size={20} />
          正在加载文件…
        </div>
      ) : query.isError || !file ? (
        <div className="error-panel">{(query.error as Error)?.message ?? '文件加载失败'}</div>
      ) : (
        <FilePreviewBody file={file} rawUrl={rawUrl} downloadUrl={downloadUrl} />
      )}
    </Modal>
  );
}

/**
 * 设计师工作目录抽屉：只读浏览 `workspaces\designer\` 的目录结构，
 * 支持逐级进入（面包屑）、刷新与常见格式在线预览 / 下载。
 */
export function DesignerWorkspaceDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [path, setPath] = useState('');
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  // 每次打开都回到根目录，避免停留在已被清空 / 删除的层级。
  useEffect(() => {
    if (open) {
      setPath('');
      setPreviewPath(null);
    }
  }, [open]);

  const query = useQuery({
    queryKey: ['designer-workspace', path],
    queryFn: () => api.listDesignerWorkspace(path),
    enabled: open,
    staleTime: 0,
  });
  const listing = query.data?.listing ?? null;

  const crumbs = useMemo(() => (path ? path.split('/') : []), [path]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={720}
      title={
        <span className="drawer-title">
          <FolderOpen size={16} />
          设计师 · 工作目录
        </span>
      }
      description="设计师的系统级专属工作目录（跨会话持久）。这里只读浏览与预览；需要整理文件时直接在对话里告诉设计师。"
      footer={
        <div className="drawer-footer-row">
          <button
            type="button"
            className="button button--secondary"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            {query.isFetching ? <Spinner size={14} /> : <RefreshCw size={14} />}
            刷新
          </button>
          <button type="button" className="button button--ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      }
    >
      <nav className="ws-breadcrumb" aria-label="目录路径">
        <button
          type="button"
          className={cn('ws-crumb', path === '' && 'ws-crumb--active')}
          onClick={() => setPath('')}
          disabled={path === ''}
        >
          designer
        </button>
        {crumbs.map((segment, index) => {
          const target = crumbs.slice(0, index + 1).join('/');
          const active = target === path;
          return (
            <span key={target} className="ws-crumb-step">
              <ChevronRight size={13} />
              <button
                type="button"
                className={cn('ws-crumb', active && 'ws-crumb--active')}
                onClick={() => setPath(target)}
                disabled={active}
              >
                {segment}
              </button>
            </span>
          );
        })}
      </nav>

      {query.isLoading ? (
        <div className="loading-panel">
          <Spinner size={20} />
          正在读取目录…
        </div>
      ) : query.isError ? (
        <div className="error-panel">{(query.error as Error)?.message ?? '目录读取失败'}</div>
      ) : !listing || listing.entries.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title="目录是空的"
          description="设计师还没有在这里存放文件。上传的对话附件会出现在 uploads\ 下；也可以在对话里让设计师把草稿写进工作目录。"
          compact
        />
      ) : (
        <div className="ws-list">
          {path ? (
            <button type="button" className="ws-row ws-row--up" onClick={() => setPath(crumbs.slice(0, -1).join('/'))}>
              <FolderUp size={15} />
              <span className="ws-row-name">返回上一级</span>
            </button>
          ) : null}
          {listing.entries.map((entry) =>
            entry.type === 'dir' ? (
              <button
                key={entry.path}
                type="button"
                className="ws-row"
                title={entry.path}
                onClick={() => setPath(entry.path)}
              >
                <EntryIcon entry={entry} />
                <span className="ws-row-name">{entry.name}</span>
                <span className="ws-row-size">文件夹</span>
              </button>
            ) : (
              <div key={entry.path} className="ws-row" role="button" tabIndex={0}
                title={entry.path}
                onClick={() => setPreviewPath(entry.path)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') setPreviewPath(entry.path);
                }}
              >
                <EntryIcon entry={entry} />
                <span className="ws-row-name">{entry.name}</span>
                <span className="ws-row-size">{formatBytes(entry.size)}</span>
                <a
                  className="icon-button ws-row-download"
                  title="下载文件"
                  aria-label={`下载 ${entry.name}`}
                  href={api.designerWorkspaceUrl(entry.path, 'download')}
                  download={entry.name}
                  onClick={(event) => event.stopPropagation()}
                >
                  <Download size={14} />
                </a>
              </div>
            ),
          )}
          {listing.truncated ? (
            <div className="callout callout--warning ws-truncated">
              内容过多，仅显示前 {listing.entries.length} 项；可在对话里让设计师整理这个目录。
            </div>
          ) : null}
        </div>
      )}

      <WorkspaceFilePreviewModal
        path={previewPath}
        open={previewPath !== null}
        onClose={() => setPreviewPath(null)}
      />
    </Drawer>
  );
}
