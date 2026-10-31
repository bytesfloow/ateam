import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param, parseBody } from '../http';
import type { ApiDeps } from './deps';

const updateFeedbackSchema = z.object({
  status: z.enum(['open', 'resolved', 'ignored']).optional(),
  resolutionNote: z.string().max(2000).optional(),
});

export function createFeedbackRouter(deps: ApiDeps): Router {
  const { store, runtime } = deps;
  const router = Router();

  router.get(
    '/',
    asyncHandler((req, res) => {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const category = typeof req.query.category === 'string' ? req.query.category : undefined;
      const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
      const items = store.listFeedback({ status, category, agentId, limit: 300 });
      res.json({ items, counts: store.feedbackCounts() });
    }),
  );

  router.get(
    '/:id',
    asyncHandler((req, res) => {
      const feedback = store.getFeedback(param(req, 'id'));
      if (!feedback) {
        res.status(404).json({ error: '反馈不存在' });
        return;
      }
      res.json({ feedback });
    }),
  );

  router.patch(
    '/:id',
    asyncHandler((req, res) => {
      const feedback = store.updateFeedback(param(req, 'id'), parseBody(req, updateFeedbackSchema));
      runtime.publish({ type: 'feedback.updated', feedbackId: feedback.id });
      res.json({ feedback });
    }),
  );

  return router;
}
