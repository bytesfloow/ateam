import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param, parseBody } from '../http';
import { assembleSystemPrompt } from '../prompt';
import { PROMPT_FIELD_MAX } from '../store';
import type { ApiDeps } from './deps';

const toolsSchema = z.object({
  builtin: z.array(z.string()).optional(),
  custom: z.array(z.string()).optional(),
});

const promptFieldsSchema = {
  responsibilities: z.string().max(PROMPT_FIELD_MAX).optional(),
  deliverable: z.string().max(PROMPT_FIELD_MAX).optional(),
  guide: z.string().max(PROMPT_FIELD_MAX).optional(),
};

const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().max(300).optional(),
  ...promptFieldsSchema,
  // 任务说明必填；预览接口沿用 promptFieldsSchema 的宽松版本，草稿未填完时也能实时预览。
  responsibilities: z.string().trim().min(1, '请填写任务说明').max(PROMPT_FIELD_MAX),
  model: z.string().max(100).nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  tools: toolsSchema.optional(),
  skillIds: z.array(z.string()).max(50).optional(),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

const updateAgentSchema = createAgentSchema.partial();

const previewPromptSchema = z.object({
  name: z.string().max(40).optional(),
  description: z.string().max(300).optional(),
  ...promptFieldsSchema,
  tools: toolsSchema.optional(),
  skillIds: z.array(z.string()).max(50).optional(),
});

export function createAgentsRouter(deps: ApiDeps): Router {
  const { store, runtime } = deps;
  const router = Router();

  router.get(
    '/',
    asyncHandler((_req, res) => {
      res.json({ agents: store.listAgents() });
    }),
  );

  /** 用与运行时完全相同的拼装逻辑，预览草稿的完整系统提示词。 */
  router.post(
    '/preview-prompt',
    asyncHandler((req, res) => {
      const input = parseBody(req, previewPromptSchema);
      const prompt = assembleSystemPrompt(
        store,
        {
          name: input.name?.trim() || '（未命名智能体）',
          description: input.description?.trim() ?? '',
          responsibilities: input.responsibilities?.trim() || input.description?.trim() || '',
          deliverable: input.deliverable?.trim() ?? '',
          guide: input.guide?.trim() ?? '',
          tools: { builtin: input.tools?.builtin ?? [], custom: input.tools?.custom ?? [] },
          skillIds: input.skillIds ?? [],
        },
        null,
        null,
      );
      res.json({ prompt });
    }),
  );

  router.post(
    '/',
    asyncHandler((req, res) => {
      const input = parseBody(req, createAgentSchema);
      const agent = store.createAgent(input);
      runtime.publish({ type: 'config.updated', detail: 'agent.created', agentId: agent.id });
      res.status(201).json({ agent });
    }),
  );

  router.get(
    '/:id',
    asyncHandler((req, res) => {
      const agent = store.getAgent(param(req, 'id'));
      if (!agent) {
        res.status(404).json({ error: '智能体不存在' });
        return;
      }
      res.json({ agent });
    }),
  );

  router.patch(
    '/:id',
    asyncHandler((req, res) => {
      const id = param(req, 'id');
      const input = parseBody(req, updateAgentSchema);
      const agent = store.updateAgent(id, input);
      runtime.publish({ type: 'config.updated', detail: 'agent.updated', agentId: id });
      res.json({ agent });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler((req, res) => {
      const id = param(req, 'id');
      store.deleteAgent(id);
      runtime.publish({ type: 'config.updated', detail: 'agent.deleted', agentId: id });
      res.status(204).end();
    }),
  );

  return router;
}
