import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import { z } from 'zod';
import { previewPayload, sendRawFile } from '../file-preview';
import { asyncHandler, param, parseBody } from '../http';
import { AppError } from '../errors';
import {
  DESIGNER_UPLOAD_MAX_BYTES,
  type DesignerMessage,
  type DesignerWorkspaceFilePreview,
} from '../../../shared/types';
import type { ApiDeps } from './deps';

const createSessionSchema = z.object({ title: z.string().trim().max(60).optional() });
const sendMessageSchema = z.object({
  content: z.string().max(50_000).optional(),
  attachments: z
    .array(
      z.object({
        /** 存储路径（上传接口返回的 path），相对设计师工作目录。 */
        path: z.string().min(1).max(400),
        /** 原始文件名，仅用于展示。 */
        name: z.string().max(200).optional(),
      }),
    )
    .max(10)
    .optional(),
});

/** 附件预览的 Content-Type（按扩展名；未识别的类型按二进制下载处理）。 */
const UPLOAD_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

function uploadMime(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
  return UPLOAD_MIME[ext] ?? 'application/octet-stream';
}

/** 消息里的图片只为模型请求服务，不回传给前端（与任务对话的处理一致）。 */
function stripImages(message: DesignerMessage): DesignerMessage {
  return { ...message, images: [] };
}

function parseSessionId(value: unknown): string {
  const sessionId = String(value ?? '').trim();
  if (!sessionId) throw new AppError(400, '缺少 sessionId');
  return sessionId;
}

export function createDesignerRouter(deps: ApiDeps): Router {
  const { designer, store } = deps;
  const router = Router();

  router.get(
    '/sessions',
    asyncHandler((_req, res) => {
      res.json({
        sessions: designer.listSessions(),
        busy: designer.busy,
        busySessionId: designer.busySessionId,
      });
    }),
  );

  router.post(
    '/sessions',
    asyncHandler((req, res) => {
      const input = req.body && typeof req.body === 'object' ? parseBody(req, createSessionSchema) : {};
      const session = designer.createSession(input.title);
      res.status(201).json({ session });
    }),
  );

  router.get(
    '/sessions/:id',
    asyncHandler((req, res) => {
      const detail = designer.getSessionDetail(param(req, 'id'));
      res.json({ ...detail, messages: detail.messages.map(stripImages) });
    }),
  );

  router.delete(
    '/sessions/:id',
    asyncHandler((req, res) => {
      const session = designer.deleteSession(param(req, 'id'));
      res.json({ session });
    }),
  );

  router.post(
    '/sessions/:id/messages',
    asyncHandler((req, res) => {
      const sessionId = param(req, 'id');
      const input = parseBody(req, sendMessageSchema);
      designer.sendMessage(sessionId, input.content ?? '', input.attachments ?? []);
      res.status(202).json({ accepted: true, sessionId });
    }),
  );

  /** 设计师详情：实时拼装的系统提示词、生效工具、技能与运行时信息。 */
  router.get(
    '/profile',
    asyncHandler((_req, res) => {
      res.json({ profile: designer.getProfile() });
    }),
  );

  /**
   * 上传对话附件：请求体为原始字节（application/octet-stream），文件保存到
   * 设计师工作目录 uploads/<sessionId>/ 下，随消息发给模型路径清单。
   */
  router.post(
    '/uploads',
    express.raw({ type: '*/*', limit: DESIGNER_UPLOAD_MAX_BYTES + 1024 * 1024 }),
    asyncHandler((req, res) => {
      const sessionId = parseSessionId(req.query.sessionId);
      const name = String(req.query.name ?? '').slice(0, 200);
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new AppError(400, '附件内容为空或不是二进制请求体');
      }
      if (req.body.length > DESIGNER_UPLOAD_MAX_BYTES) {
        throw new AppError(400, `单个附件不能超过 ${Math.round(DESIGNER_UPLOAD_MAX_BYTES / 1024 / 1024)} MB`);
      }
      const attachment = store.saveDesignerUpload(sessionId, name, req.body);
      res.status(201).json({ attachment });
    }),
  );

  /** 读取一个已上传的附件（内联预览；download=1 时作为附件下载）。 */
  router.get(
    '/uploads/file',
    asyncHandler((req, res) => {
      const sessionId = parseSessionId(req.query.sessionId);
      const filePath = typeof req.query.path === 'string' ? req.query.path : '';
      const result = store.readDesignerUpload(sessionId, filePath);
      if (!result) {
        res.status(404).json({ error: '附件不存在' });
        return;
      }
      res.setHeader('Content-Type', uploadMime(result.fileName));
      res.setHeader('Content-Length', result.bytes.length);
      if (req.query.download === '1') {
        res.setHeader(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
        );
      }
      res.end(result.bytes);
    }),
  );

  router.post(
    '/stop',
    asyncHandler((_req, res) => {
      res.json({ stopped: designer.stop() });
    }),
  );

  /**
   * 手动压缩上下文（摘要式）：把较早的对话轮次总结成「前情提要」并落库，
   * 之后的请求只带「提要 + 未压缩的最近消息」。compressed=0 表示无需压缩。
   */
  router.post(
    '/compress',
    asyncHandler(async (_req, res) => {
      res.json(await designer.compressConversation());
    }),
  );

  /** 清空对话记录：删除当前会话（消息、全部提案、上传附件）；工作目录文件与已生效变更保留。 */
  router.post(
    '/clear',
    asyncHandler((_req, res) => {
      designer.clearConversation();
      res.json({ cleared: true });
    }),
  );

  /**
   * 只读浏览设计师的专属工作目录（workspaces\designer\）：
   * - `?mode=list`（默认）：列出某一层目录（path 为空表示根目录）；
   * - `?mode=preview`：文本返回内容（超限截断）；图片 / PDF 返回元数据，前端改用 raw 地址；
   * - `?mode=raw`：inline 返回原始字节（图片、PDF 在线展示）；
   * - `?mode=download`：以附件形式下载原始文件。
   * 所有路径都必须落在设计师工作目录内（防越界）。
   */
  router.get(
    '/workspace',
    asyncHandler((req, res) => {
      const relPath = typeof req.query.path === 'string' ? req.query.path : '';
      const modeRaw = String(req.query.mode ?? 'list');
      const mode = ['list', 'preview', 'raw', 'download'].includes(modeRaw) ? modeRaw : 'list';

      if (mode === 'list') {
        res.json({ listing: store.listDesignerWorkspace(relPath) });
        return;
      }

      const absolute = store.resolveDesignerWorkspacePath(relPath);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absolute);
      } catch {
        res.status(404).json({ error: '文件不存在或已被清理' });
        return;
      }
      if (!stat.isFile()) {
        res.status(400).json({ error: '该路径是目录，无法按文件预览' });
        return;
      }
      const normalized = path
        .relative(path.resolve(store.designerWorkspaceDir()), absolute)
        .split(path.sep)
        .join('/');
      const base = {
        path: normalized,
        name: path.posix.basename(normalized),
        size: stat.size,
      };

      if (mode === 'raw' || mode === 'download') {
        sendRawFile(res, absolute, base.name, mode);
        return;
      }

      const file: DesignerWorkspaceFilePreview = previewPayload(absolute, base);
      res.json({ file });
    }),
  );

  router.post(
    '/proposals/:id/approve',
    asyncHandler((req, res) => {
      const proposal = designer.approveProposal(param(req, 'id'));
      res.json({ proposal });
    }),
  );

  router.post(
    '/proposals/:id/reject',
    asyncHandler((req, res) => {
      const proposal = designer.rejectProposal(param(req, 'id'));
      res.json({ proposal });
    }),
  );

  return router;
}
