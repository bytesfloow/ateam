import { Router } from 'express';
import { z } from 'zod';
import { testModelConnection } from '../llm';
import { asyncHandler, parseBody } from '../http';
import type { ApiDeps } from './deps';

const settingsSchema = z.object({
  llm: z
    .object({
      baseUrl: z.string().optional(),
      model: z.string().optional(),
      temperature: z.number().optional(),
      deepThinking: z.boolean().optional(),
      thinkingLevel: z.string().optional(),
      maxContextTokens: z.number().optional(),
      requestTimeoutMs: z.number().optional(),
      apiKey: z.string().nullable().optional(),
    })
    .optional(),
  runtime: z
    .object({
      toolTimeoutMs: z.number().optional(),
      commandTimeoutMs: z.number().optional(),
      maxToolOutputChars: z.number().optional(),
      maxFeedbackSnapshotMessages: z.number().optional(),
    })
    .optional(),
  webSearch: z
    .object({
      searchBaseUrl: z.string().optional(),
      searchApiKey: z.string().nullable().optional(),
    })
    .optional(),
});

const testSchema = z.object({
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.string().nullable().optional(),
  deepThinking: z.boolean().optional(),
  thinkingLevel: z.string().optional(),
});

export function createSettingsRouter(deps: ApiDeps): Router {
  const { store, runtime } = deps;
  const router = Router();

  router.get(
    '/',
    asyncHandler((_req, res) => {
      res.json({ settings: store.getAppSettings() });
    }),
  );

  router.put(
    '/',
    asyncHandler((req, res) => {
      const settings = store.updateSettings(parseBody(req, settingsSchema));
      runtime.publish({ type: 'settings.updated' });
      runtime.publish({ type: 'config.updated', detail: 'settings.updated' });
      res.json({ settings });
    }),
  );

  router.post(
    '/test',
    asyncHandler(async (req, res) => {
      const input = parseBody(req, testSchema);
      const current = store.getLlmConfig();
      const apiKey = input.apiKey === undefined || input.apiKey === null ? current.apiKey : input.apiKey;
      const result = await testModelConnection({
        baseUrl: input.baseUrl ?? current.baseUrl,
        apiKey,
        model: input.model ?? current.model,
        temperature: 0,
        deepThinking: input.deepThinking ?? current.deepThinking,
        thinkingLevel: input.thinkingLevel ?? current.thinkingLevel,
        requestTimeoutMs: current.requestTimeoutMs,
      });
      res.json(result);
    }),
  );

  return router;
}
