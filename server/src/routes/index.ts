import { Router } from 'express';
import { createAgentsRouter } from './agents';
import type { ApiDeps } from './deps';
import { createDesignerRouter } from './designer';
import { createTrainerRouter } from './trainer';
import { createFeedbackRouter } from './feedback';
import { createSkillsRouter, createToolsRouter } from './library';
import { createPipelinesRouter } from './pipelines';
import { createSettingsRouter } from './settings';
import { createSystemRouter } from './system';
import { createTasksRouter } from './tasks';

export function createApiRouter(deps: ApiDeps): Router {
  const router = Router();
  router.use('/', createSystemRouter(deps));
  router.use('/agents', createAgentsRouter(deps));
  router.use('/pipelines', createPipelinesRouter(deps));
  router.use('/skills', createSkillsRouter(deps));
  router.use('/tools', createToolsRouter(deps));
  router.use('/tasks', createTasksRouter(deps));
  router.use('/feedback', createFeedbackRouter(deps));
  router.use('/settings', createSettingsRouter(deps));
  router.use('/designer', createDesignerRouter(deps));
  router.use('/trainer', createTrainerRouter(deps));
  router.use((_req, res) => {
    res.status(404).json({ error: '接口不存在' });
  });
  return router;
}
