import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param, parseBody } from '../http';
import { assembleSystemPrompt, assembleTestSystemPrompt } from '../prompt';
import { AGENT_PROMPT_MAX, PROMPT_FIELD_MAX } from '../store';
import type { ApiDeps } from './deps';

const toolsSchema = z.object({
  builtin: z.array(z.string()).optional(),
  custom: z.array(z.string()).optional(),
});

const promptFieldsSchema = {
  responsibilities: z.string().max(PROMPT_FIELD_MAX).optional(),
  deliverable: z.string().max(PROMPT_FIELD_MAX).optional(),
  guide: z.string().max(PROMPT_FIELD_MAX).optional(),
  /** 训练型智能体的完整系统提示词；传非空值即训练型（不能加入流水线）。 */
  prompt: z.string().max(AGENT_PROMPT_MAX).nullable().optional(),
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
  agentId: z.string().optional(),
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

  /** 训练型智能体（prompt 形态）的提示词预览：主体为 prompt 原文 + 最小运行注入。 */
  router.post(
    '/preview-test-prompt',
    asyncHandler((req, res) => {
      const input = parseBody(req, previewPromptSchema);
      // 预览未保存的草稿：草稿字段优先；缺省回落到已存智能体（按 agentId）的当前值。
      const stored = input.agentId ? (store.getAgent(input.agentId) ?? null) : null;
      const draftPrompt = input.prompt !== undefined ? input.prompt : stored?.prompt ?? '';
      const draft = {
        ...(stored ?? {
          id: '',
          name: input.name?.trim() || '（未命名智能体）',
          slug: '',
          description: input.description?.trim() ?? '',
          responsibilities: input.responsibilities?.trim() || input.description?.trim() || '',
          deliverable: input.deliverable?.trim() ?? '',
          guide: input.guide?.trim() ?? '',
          model: null,
          temperature: null,
          tools: { builtin: [], custom: [] },
          skillIds: [],
          accent: '#6d8cff',
          createdAt: '',
          updatedAt: '',
        }),
        name: input.name?.trim() || stored?.name || '（未命名智能体）',
        description: input.description?.trim() ?? stored?.description ?? '',
        prompt: draftPrompt,
        tools: { builtin: [], custom: input.tools?.custom ?? stored?.tools.custom ?? [] },
        skillIds: input.skillIds ?? stored?.skillIds ?? [],
      };
      const prompt = assembleTestSystemPrompt(store, draft, null);
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
