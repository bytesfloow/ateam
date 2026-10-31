import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param, parseBody } from '../http';
import { assertValidToolCode, assertValidToolSchema, BUILTIN_TOOL_INFOS } from '../tools';
import type { ApiDeps } from './deps';

const skillSchema = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().max(300).optional(),
  content: z.string().max(200_000).optional(),
});

const skillFileSchema = z.object({
  path: z.string().trim().min(1).max(200),
  content: z.string().max(800_000),
  encoding: z.enum(['utf8', 'base64']).optional(),
});

const skillFileRenameSchema = z.object({
  from: z.string().trim().min(1).max(200),
  to: z.string().trim().min(1).max(200),
});

const toolSchema = z.object({
  name: z.string().trim().min(2).max(41),
  description: z.string().trim().min(1).max(500),
  parameters: z.record(z.unknown()),
  code: z.string().min(1).max(100_000),
});

export function createSkillsRouter(deps: ApiDeps): Router {
  const { store, runtime } = deps;
  const router = Router();

  router.get(
    '/',
    asyncHandler((_req, res) => {
      res.json({ skills: store.listSkills() });
    }),
  );

  router.post(
    '/',
    asyncHandler((req, res) => {
      const skill = store.createSkill(parseBody(req, skillSchema));
      runtime.publish({ type: 'config.updated', detail: 'skill.created' });
      res.status(201).json({ skill });
    }),
  );

  router.get(
    '/:id/file',
    asyncHandler((req, res) => {
      const id = param(req, 'id');
      const filePath = typeof req.query.path === 'string' ? req.query.path : '';
      const result = store.readSkillFile(id, filePath);
      if (!result) {
        res.status(404).json({ error: '技能文件不存在' });
        return;
      }
      if (req.query.download === '1') {
        const name = path.posix.basename(result.file.path);
        res.setHeader(
          'Content-Type',
          result.file.text ? 'text/plain; charset=utf-8' : 'application/octet-stream',
        );
        res.setHeader(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        );
        res.end(result.bytes);
        return;
      }
      res.json({
        file: result.file,
        encoding: result.file.text ? 'utf8' : 'base64',
        content: result.file.text ? result.bytes.toString('utf8') : result.bytes.toString('base64'),
      });
    }),
  );

  router.put(
    '/:id/file',
    asyncHandler((req, res) => {
      const skill = store.upsertSkillFile(param(req, 'id'), parseBody(req, skillFileSchema));
      runtime.publish({ type: 'config.updated', detail: 'skill.file.updated' });
      res.json({ skill });
    }),
  );

  router.delete(
    '/:id/file',
    asyncHandler((req, res) => {
      const filePath = typeof req.query.path === 'string' ? req.query.path : '';
      const skill = store.deleteSkillFile(param(req, 'id'), filePath);
      runtime.publish({ type: 'config.updated', detail: 'skill.file.deleted' });
      res.json({ skill });
    }),
  );

  router.post(
    '/:id/file/rename',
    asyncHandler((req, res) => {
      const { from, to } = parseBody(req, skillFileRenameSchema);
      const skill = store.renameSkillFile(param(req, 'id'), from, to);
      runtime.publish({ type: 'config.updated', detail: 'skill.file.renamed' });
      res.json({ skill });
    }),
  );

  router.patch(
    '/:id',
    asyncHandler((req, res) => {
      const skill = store.updateSkill(param(req, 'id'), parseBody(req, skillSchema.partial()));
      runtime.publish({ type: 'config.updated', detail: 'skill.updated' });
      res.json({ skill });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler((req, res) => {
      store.deleteSkill(param(req, 'id'));
      runtime.publish({ type: 'config.updated', detail: 'skill.deleted' });
      res.status(204).end();
    }),
  );

  return router;
}

export function createToolsRouter(deps: ApiDeps): Router {
  const { store, runtime } = deps;
  const router = Router();

  router.get(
    '/',
    asyncHandler((_req, res) => {
      const agents = store.listAgents();
      const usage: Record<string, { id: string; name: string }[]> = {};
      for (const agent of agents) {
        for (const id of agent.tools.custom) {
          usage[id] = usage[id] ?? [];
          usage[id].push({ id: agent.id, name: agent.name });
        }
        // 内置工具以名称作为 usage 键（与自定义工具的 id 空间不冲突）。
        for (const name of agent.tools.builtin) {
          usage[name] = usage[name] ?? [];
          usage[name].push({ id: agent.id, name: agent.name });
        }
      }
      res.json({ tools: store.listCustomTools(), builtin: BUILTIN_TOOL_INFOS, usage });
    }),
  );

  router.post(
    '/',
    asyncHandler((req, res) => {
      const input = parseBody(req, toolSchema);
      assertValidToolSchema(input.parameters);
      assertValidToolCode(input.code);
      const tool = store.createTool(input);
      runtime.publish({ type: 'config.updated', detail: 'tool.created' });
      res.status(201).json({ tool });
    }),
  );

  router.patch(
    '/:id',
    asyncHandler((req, res) => {
      const input = parseBody(req, toolSchema.partial());
      if (input.parameters !== undefined) assertValidToolSchema(input.parameters);
      if (input.code !== undefined) assertValidToolCode(input.code);
      const tool = store.updateTool(param(req, 'id'), input);
      runtime.publish({ type: 'config.updated', detail: 'tool.updated' });
      res.json({ tool });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler((req, res) => {
      store.deleteTool(param(req, 'id'));
      runtime.publish({ type: 'config.updated', detail: 'tool.deleted' });
      res.status(204).end();
    }),
  );

  return router;
}
