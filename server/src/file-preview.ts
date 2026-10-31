import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import type { DeliverablePreview, DeliverablePreviewKind } from '../../shared/types';

/** 文本预览的字节数上限；超过则截断并在响应中标记 truncated。 */
export const TEXT_PREVIEW_LIMIT = 512 * 1024;

export const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

export const TEXT_MIME: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.xml': 'application/xml',
  '.yml': 'application/yaml',
  '.yaml': 'application/yaml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.jsx': 'text/plain',
  '.py': 'text/plain',
  '.sh': 'text/plain',
  '.bat': 'text/plain',
  '.cmd': 'text/plain',
  '.ps1': 'text/plain',
  '.sql': 'text/plain',
  '.ini': 'text/plain',
  '.toml': 'text/plain',
  '.conf': 'text/plain',
};

/** 常见二进制扩展名：即使内容碰巧是合法 UTF-8 也不当文本预览。 */
export const BINARY_EXTENSIONS = new Set([
  '.zip', '.gz', '.tar', '.rar', '.7z', '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.pdf',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.flac', '.woff', '.woff2', '.ttf', '.eot',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.db', '.sqlite', '.wasm',
]);

/** 归一化相对路径用于比对：统一正斜杠、去掉多余的 . / 段。 */
export function normalizeRelPath(input: string): string {
  return path.posix.normalize(input.replace(/\\/g, '/').trim());
}

export function detectKindAndMime(filePath: string): { kind: DeliverablePreviewKind; mimeType: string } {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return { kind: 'pdf', mimeType: 'application/pdf' };
  if (ext in IMAGE_MIME) return { kind: 'image', mimeType: IMAGE_MIME[ext] };
  if (ext in TEXT_MIME) return { kind: 'text', mimeType: TEXT_MIME[ext] };
  if (BINARY_EXTENSIONS.has(ext)) return { kind: 'binary', mimeType: 'application/octet-stream' };
  // 未知扩展名：由内容判断（合法 UTF-8 且不含 NUL 视为文本）。
  return { kind: 'text', mimeType: 'text/plain' };
}

/** 内容嗅探：读出的缓冲必须是完整合法的 UTF-8 且不含 NUL 才认为是文本。 */
export function looksLikeText(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/** 从截断点回退，丢弃结尾不完整的 UTF-8 序列（最多回退 3 字节找到序列首字节）。 */
function trimPartialUtf8(slice: Buffer): Buffer {
  let start = slice.length;
  for (let back = 0; back < 4 && start - 1 - back >= 0; back += 1) {
    const byte = slice[start - 1 - back];
    if ((byte & 0b1100_0000) === 0b1000_0000) continue; // 续字节，继续回退
    // 找到序列首字节（或 ASCII 字节）：按首字节判断该序列应有的字节数。
    const expected = byte >= 0b1111_0000 ? 4 : byte >= 0b1110_0000 ? 3 : byte >= 0b1100_0000 ? 2 : 1;
    if (back + 1 < expected) start = start - 1 - back; // 序列不完整，整段丢弃
    break;
  }
  return slice.subarray(0, start);
}

export function decodeTextPreview(buffer: Buffer): { content: string; truncated: boolean } {
  let slice = buffer;
  let truncated = false;
  if (slice.length > TEXT_PREVIEW_LIMIT) {
    // 避免在多字节字符中间截断产生乱码：把结尾不完整的 UTF-8 序列去掉。
    slice = trimPartialUtf8(slice.subarray(0, TEXT_PREVIEW_LIMIT));
    truncated = true;
  }
  let text = slice.toString('utf-8');
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  return { content: text, truncated };
}

export function contentDisposition(fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * 以 inline（raw）或附件（download）方式直出文件原始字节。
 * 与 preview 模式共用：图片 / PDF 的在线展示走 raw，其余格式给用户下载入口。
 */
export function sendRawFile(res: Response, absolute: string, fileName: string, mode: 'raw' | 'download'): void {
  const detected = detectKindAndMime(absolute);
  res.setHeader('Cache-Control', 'no-store');
  if (mode === 'download') {
    res.setHeader('Content-Disposition', contentDisposition(fileName));
    res.type(detected.mimeType === 'text/markdown' ? 'application/octet-stream' : detected.mimeType);
  } else {
    res.type(detected.mimeType);
  }
  res.send(fs.readFileSync(absolute));
}

/**
 * 计算一个文件的在线预览 payload：
 * 文本返回截断受控的内容；图片 / PDF 由前端改用 raw 地址展示；其余按二进制处理。
 */
export function previewPayload(
  absolute: string,
  meta: { path: string; name: string; size: number },
): DeliverablePreview {
  const detected = detectKindAndMime(absolute);
  let kind = detected.kind;
  let mimeType = detected.mimeType;
  let content: string | undefined;
  let truncated: boolean | undefined;

  if (kind === 'text') {
    const buffer = fs.readFileSync(absolute);
    if (!looksLikeText(buffer)) {
      kind = 'binary';
      mimeType = 'application/octet-stream';
    } else {
      const decoded = decodeTextPreview(buffer);
      content = decoded.content;
      truncated = decoded.truncated;
    }
  }

  const payload: DeliverablePreview = { ...meta, kind, mimeType };
  if (content !== undefined) payload.content = content;
  if (truncated) payload.truncated = truncated;
  return payload;
}
