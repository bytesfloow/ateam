import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param, parseBody } from '../http';
import type { ApiDeps } from './deps';

const nodeSchema = z.object({
  id: z.string().max(64).optional(),
  agentId: z.string().min(1),
  isStart: z.boolean().optional(),
  x: z.number().min(-100_000).max(100_000).optional(),
  y: z.number().min(-100_000).max(100_000).optional(),
});

const edgeSchema = z.object({
  id: z.string().max(64).optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  triggerPrompt: z.string().trim().min(1).max(20_000),
  handoffCondition: z.string().max(20_000).optional(),
});

const pipelineSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(500).optional(),
  nodes: z.array(nodeSchema).min(1).max(30),
  edges: z.array(edgeSchema).max(300).optional(),
});

export function createPipelinesRouter(deps: ApiDeps): Router {
  const { store, runtime } = deps;
  const router = Router();

  router.get(
    '/',
    asyncHandler((_req, res) => {
      res.json({ pipelines: store.listPipelines() });
    }),
  );

  router.get(
    '/:id',
    asyncHandler((req, res) => {
      const pipeline = store.getPipeline(param(req, 'id'));
      if (!pipeline) {
        res.status(404).json({ error: '流水线不存在' });
        return;
      }
      res.json({ pipeline });
    }),
  );

  router.post(
    '/',
    asyncHandler((req, res) => {
      const input = parseBody(req, pipelineSchema);
      const pipeline = store.createPipeline(input);
      runtime.publish({ type: 'config.updated', detail: 'pipeline.created' });
      res.status(201).json({ pipeline });
    }),
  );

  router.patch(
    '/:id',
    asyncHandler((req, res) => {
      const input = parseBody(req, pipelineSchema);
      const pipeline = store.updatePipeline(param(req, 'id'), input);
      runtime.publish({ type: 'config.updated', detail: 'pipeline.updated' });
      res.json({ pipeline });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler((req, res) => {
      store.deletePipeline(param(req, 'id'));
      runtime.publish({ type: 'config.updated', detail: 'pipeline.deleted' });
      res.status(204).end();
    }),
  );

  return router;
}
