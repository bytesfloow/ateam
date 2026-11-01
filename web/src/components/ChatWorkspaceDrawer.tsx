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

/** 对话角色工作目录抽屉的文案包。 */
export interface ChatWorkspaceCopy {
  /** 根面包屑名（designer / trainer）。 */
  root: string;
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  truncatedHint: string;
}

/** 工作目录文件预览弹窗（与交付物预览同一套能力）。 */
function WorkspaceFilePreviewModal({
  kind,
  path,
  open,
  onClose,
}: {
  kind: 'designer' | 'trainer';
  path: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: [`${kind}-workspace-file`, path],
    queryFn: () =>
      kind === 'designer'
        ? api.getDesignerWorkspacePreview(path!)
        : api.getTrainerWorkspacePreview(path!),
    enabled: open && Boolean(path),
    staleTime: 5_000,
  });

  useEffect(() => {
    // 关闭时清掉缓存，保证每次打开都重新读取最新文件内容。
    if (!open && path) {
      queryClient.removeQueries({ queryKey: [`${kind}-workspace-file`, path] });
    }
  }, [kind, open, path, queryClient]);

  const file = query.data?.file ?? null;
  const rawUrl = useMemo(
    () => (path ? (kind === 'designer' ? api.designerWorkspaceUrl(path, 'raw') : api.trainerWorkspaceUrl(path, 'raw')) : ''),
    [kind, path],
  );
  const downloadUrl = useMemo(
    () => (path ? (kind === 'designer' ? api.designerWorkspaceUrl(path, 'download') : api.trainerWorkspaceUrl(path, 'download')) : ''),
    [kind, path],
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
 * 对话角色（设计师 / 训练师）工作目录抽屉：只读浏览 workspaces/<kind>/ 的目录结构，
 * 支持逐级进入（面包屑）、刷新与常见格式在线预览 / 下载。
 */
export function ChatWorkspaceDrawer({
  kind,
  copy,
  open,
  onClose,
}: {
  kind: 'designer' | 'trainer';
  copy: ChatWorkspaceCopy;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [path, setPath] = useState('');
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  useEffect(() => {
    if (open) setPath('');
  }, [open]);

  const crumbs = useMemo(() => path.split('/').filter(Boolean), [path]);

  const query = useQuery({
    queryKey: [`${kind}-workspace`, path],
    enabled: open,
    queryFn: () =>
      kind === 'designer' ? api.listDesignerWorkspace(path) : api.listTrainerWorkspace(path),
  });
  const listing = query.data?.listing;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={720}
      title={
        <span className="drawer-title">
          <FolderOpen size={16} />
          {copy.title}
        </span>
      }
      description={copy.description}
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
          {copy.root}
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
          title={copy.emptyTitle}
          description={copy.emptyDescription}
          compact
        />
      ) : (
        <div className="ws-list">
          {listing.entries.map((entry) => (
            <div
              key={entry.path}
              className={cn('ws-row', entry.type === 'dir' && 'ws-row--dir')}
              role={entry.type === 'dir' ? 'button' : undefined}
              tabIndex={entry.type === 'dir' ? 0 : undefined}
              onClick={() => {
                if (entry.type === 'dir') setPath(entry.path);
                else setPreviewPath(entry.path);
              }}
              onKeyDown={(event) => {
                if (entry.type === 'dir' && (event.key === 'Enter' || event.key === ' ')) {
                  setPath(entry.path);
                }
              }}
            >
              <span className="ws-row-icon">
                <EntryIcon entry={entry} />
              </span>
              <span className="ws-row-name" title={entry.path}>
                {entry.name}
              </span>
              <span className="ws-row-size">{entry.type === 'dir' ? '' : formatBytes(entry.size)}</span>
              {entry.type === 'dir' ? <FolderUp size={14} className="ws-row-arrow" /> : null}
              {entry.type === 'file' ? (
                <div className="ws-row-actions">
                  <a
                    className="icon-button ws-row-download"
                    title="下载文件"
                    aria-label={`下载 ${entry.name}`}
                    href={
                      kind === 'designer'
                        ? api.designerWorkspaceUrl(entry.path, 'download')
                        : api.trainerWorkspaceUrl(entry.path, 'download')
                    }
                    download={entry.name}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Download size={14} />
                  </a>
                </div>
              ) : null}
            </div>
          ))}
          {listing.truncated ? (
            <div className="callout callout--warning ws-truncated">{copy.truncatedHint}</div>
          ) : null}
        </div>
      )}

      <WorkspaceFilePreviewModal
        kind={kind}
        path={previewPath}
        open={previewPath !== null}
        onClose={() => setPreviewPath(null)}
      />
    </Drawer>
  );
}
