import { Download, FileQuestion, FolderOpen, Image as ImageIcon } from 'lucide-react';
import type { DeliverablePreview } from '@shared/types';
import { CopyButton } from './CopyButton';
import { Markdown } from './Markdown';

/**
 * 文件在线预览正文（交付物 / 设计师工作目录共用）：
 * - Markdown 按富文本渲染，其他文本按等宽纯文本展示（超长截断时提示下载查看全文）；
 * - 图片 / PDF 直接内嵌展示；其余二进制提供下载入口。
 */
export function FilePreviewBody({
  file,
  rawUrl,
  downloadUrl,
}: {
  file: DeliverablePreview;
  rawUrl: string;
  downloadUrl: string;
}) {
  const markdown = file.kind === 'text' && /\.(md|markdown)$/i.test(file.path);
  if (file.kind === 'text') {
    return (
      <div className="deliverable-preview-body">
        {markdown ? (
          <Markdown className="deliverable-preview-markdown">{file.content ?? ''}</Markdown>
        ) : (
          <pre className="deliverable-preview-text">{file.content ?? ''}</pre>
        )}
        {file.truncated ? (
          <div className="callout callout--warning deliverable-preview-truncated">
            <FileQuestion size={15} />
            文件较大，仅展示前 512 KB 内容；完整内容请下载后查看。
          </div>
        ) : null}
      </div>
    );
  }
  if (file.kind === 'image') {
    return (
      <div className="deliverable-preview-body deliverable-preview-body--center">
        <img className="deliverable-preview-image" src={rawUrl} alt={file.name} />
      </div>
    );
  }
  if (file.kind === 'pdf') {
    return (
      <div className="deliverable-preview-body">
        <iframe className="deliverable-preview-frame" src={rawUrl} title={file.name} />
      </div>
    );
  }
  return (
    <div className="deliverable-preview-body deliverable-preview-body--center deliverable-preview-binary">
      <div className="empty-icon">
        <ImageIcon size={22} />
      </div>
      <strong>该文件是二进制格式，暂不支持在线预览</strong>
      <p>可以下载到本地查看原始内容。</p>
      <a className="button button--secondary button--sm" href={downloadUrl} download={file.name}>
        <FolderOpen size={14} />
        下载文件
      </a>
    </div>
  );
}

/** 预览弹窗通用底栏：完整路径 + 复制路径 / 下载 / 关闭。 */
export function FilePreviewFooter({
  path,
  name,
  downloadUrl,
  onClose,
}: {
  path: string;
  name: string;
  downloadUrl: string;
  onClose: () => void;
}) {
  return (
    <div className="deliverable-preview-footer">
      <code className="deliverable-preview-path" title={path}>
        {path}
      </code>
      <div className="deliverable-preview-actions">
        <CopyButton value={path} label="复制路径" />
        <a className="button button--secondary button--sm" href={downloadUrl} download={name}>
          <Download size={14} />
          下载
        </a>
        <button type="button" className="button button--primary button--sm" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}
