import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import {
  sumTokenUsage,
  type TurnDetail,
} from '../../../shared/types';
import { listFolderFiles } from '../handoff';
import { normalizeRelPath, previewPayload, sendRawFile } from '../file-preview';
import { asyncHandler, param, parseBody } from '../http';
import type { ApiDeps } from './deps';

const startTaskSchema = z.object({
  task: z.string().trim().min(1).max(50_000),
  pipelineId: z.string().min(1),
});

const retryTaskSchema = z.object({
  note: z.string().max(8000).optional(),
});

export function createTasksRouter(deps: ApiDeps): Router {
  const { store, runtime } = deps;
  const router = Router();

  /**
   * 读取某一回合交付文件夹中的文件。
   *
   * 交付单元是整个文件夹；只有位于该回合 handoffFolder 目录下的路径才允许访问，
   * 且解析后必须仍位于发送方的任务工作区内；文件内容从发送方工作区读取
   * （交接复制不会移动原始文件）。
   *
   * - `?mode=list`：返回该交付文件夹内的文件清单（路径 / 名称 / 大小）。
   * - `?mode=preview`（默认）：返回 JSON。文本文件带 content；图片/PDF 前端改用 raw 地址。
   * - `?mode=raw`：inline 返回原始字节（图片、PDF 在线展示）。
   * - `?mode=download`：以附件形式下载原始文件。
   */
  router.get(
  '/:id/turns/:turnId/deliverable',
  asyncHandler((req, res) => {
    const taskId = param(req, 'id');
    const turnId = param(req, 'turnId');
    const modeRaw = String(req.query.mode ?? 'preview');
    const mode = ['preview', 'raw', 'download', 'list'].includes(modeRaw) ? modeRaw : 'preview';

    const task = store.getTask(taskId);
    if (!task) {
      res.status(404).json({ error: '任务不存在' });
      return;
    }
    const turn = store.getTurn(turnId);
    if (!turn || turn.taskId !== taskId) {
      res.status(404).json({ error: '回合不存在' });
      return;
    }
    const folder = turn.handoffFolder;
    if (!folder) {
      res.status(404).json({ error: '本回合没有交付文件夹' });
      return;
    }
    const sender = store.getAgent(turn.agentId);
    if (!sender) {
      res.status(404).json({ error: '产生交付物的智能体已被删除，无法定位文件' });
      return;
    }
    const workspaceRoot = store.agentTaskWorkspaceDir(taskId, sender.slug);
    const folderRoot = path.resolve(workspaceRoot, ...normalizeRelPath(folder.path).split('/'));
    if (!folderRoot.startsWith(workspaceRoot + path.sep) || !fs.existsSync(folderRoot)) {
      res.status(404).json({ error: '交付文件夹不存在或已被清理' });
      return;
    }

    if (mode === 'list') {
      const files = listFolderFiles(folderRoot).map((file) => ({
        path: `${normalizeRelPath(folder.path)}/${file.path}`,
        name: file.name,
        size: file.size,
      }));
      res.json({ folder: { path: folder.path, name: folder.name, files: folder.files, bytes: folder.bytes }, files });
      return;
    }

    const relPath = String(req.query.path ?? '').trim();
    if (!relPath) {
      res.status(400).json({ error: '缺少文件路径参数 path' });
      return;
    }
    const normalized = normalizeRelPath(relPath);
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      res.status(400).json({ error: '文件路径不合法' });
      return;
    }
    const folderPrefix = normalizeRelPath(folder.path);
    if (normalized !== folderPrefix && !normalized.startsWith(folderPrefix + '/')) {
      res.status(404).json({ error: '该文件不在本回合的交付文件夹内，无法预览' });
      return;
    }

    const absolute = path.resolve(workspaceRoot, ...normalized.split('/'));
    if (!absolute.startsWith(folderRoot + path.sep) && absolute !== folderRoot) {
      res.status(403).json({ error: '文件路径越界' });
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      res.status(404).json({ error: '交付物文件不存在或已被清理' });
      return;
    }
    if (!stat.isFile()) {
      res.status(400).json({ error: '交付物不是普通文件，无法预览' });
      return;
    }

    const base = {
      path: normalized,
      name: path.posix.basename(normalized),
      size: stat.size,
    };

    if (mode === 'raw' || mode === 'download') {
      sendRawFile(res, absolute, base.name, mode);
      return;
    }

    res.json({ deliverable: previewPayload(absolute, base) });
  }),
);

  router.get(
    '/',
    asyncHandler((req, res) => {
      const rawLimit = Number(req.query.limit ?? 50);
      const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.round(rawLimit))) : 50;
      res.json({ tasks: store.listTasks(limit) });
    }),
  );

  router.post(
    '/',
    asyncHandler((req, res) => {
      const input = parseBody(req, startTaskSchema);
      const task = runtime.startTask(input);
      res.status(201).json({ task });
    }),
  );

  router.get(
    '/:id',
    asyncHandler((req, res) => {
      const task = store.getTaskDetail(param(req, 'id'));
      if (!task) {
        res.status(404).json({ error: '任务不存在' });
        return;
      }
      res.json({ task });
    }),
  );

  router.post(
    '/:id/terminate',
    asyncHandler((req, res) => {
      const task = runtime.terminateTask(param(req, 'id'));
      res.json({ task });
    }),
  );

  /** 人类接手：宣布任务完成。 */
  router.post(
    '/:id/complete',
    asyncHandler((req, res) => {
      const task = runtime.completeTaskByHuman(param(req, 'id'));
      res.json({ task });
    }),
  );

  /** 暂停 / 失败的任务：在当前环节重跑（追加新回合，不改动历史）。 */
  router.post(
    '/:id/retry',
    asyncHandler((req, res) => {
      const input = parseBody(req, retryTaskSchema);
      const task = runtime.retryTask(param(req, 'id'), input);
      res.json({ task });
    }),
  );

  router.get(
    '/:id/turns/:turnId',
    asyncHandler((req, res) => {
      const taskId = param(req, 'id');
      const turnId = param(req, 'turnId');
      const task = store.getTaskDetail(taskId);
      if (!task) {
        res.status(404).json({ error: '任务不存在' });
        return;
      }
      const turn = task.turns.find((item) => item.id === turnId);
      if (!turn) {
        res.status(404).json({ error: '回合不存在' });
        return;
      }
      const conversation = store.getTurnConversation(turn.id);
      // 图片 base64 只服务于模型请求，不回传前端（工具结果文本里已注明图片规格），避免回合详情接口动辄数 MB。
      const messages = (conversation ? store.listMessages(conversation.id, 600) : []).map((message) =>
        message.images.length > 0 ? { ...message, images: [] } : message,
      );
      const detail: TurnDetail = {
        turn,
        messages,
        systemPrompt: store.getTurnSystemPrompt(turn.id),
        usage: sumTokenUsage(messages.map((message) => message.meta.usage)),
      };
      res.json({ detail });
    }),
  );

  return router;
}
