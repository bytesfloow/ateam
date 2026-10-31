import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { VERSION } from '../config';
import { asyncHandler, parseBody } from '../http';
import type { ApiDeps } from './deps';

const resetSchema = z.object({ confirm: z.literal(true) });

export function createSystemRouter(deps: ApiDeps): Router {
  const { store, runtime, designer } = deps;
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      uptime: Math.round(process.uptime()),
    });
  });

  router.get('/status', (_req, res) => {
    res.json({
      status: { ...runtime.getStatus(), designerBusy: designer.busy },
      stats: store.getStats(),
    });
  });

  router.get('/stats', (_req, res) => {
    res.json({ stats: store.getStats() });
  });

  router.get('/events', (req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify({ type: 'hello', version: VERSION, at: new Date().toISOString() })}\n\n`);

    const unsubscribe = runtime.events.subscribe((event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* connection closed */
      }
    });
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 15_000);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });

  router.post(
    '/reset',
    asyncHandler(async (req, res) => {
      parseBody(req, resetSchema);
      const result = await runtime.resetAll();
      await designer.resetAll();
      res.json({ result });
    }),
  );

  router.post(
    '/demo/seed',
    asyncHandler((_req, res) => {
      if (store.findActiveTask()) {
        res.status(409).json({ error: '有任务正在进行，无法创建示例' });
        return;
      }
      if (store.listAgents().length > 0) {
        res.status(409).json({ error: '当前已有智能体，无法创建示例' });
        return;
      }

      const skill = store.createSkill({
        name: '结构化交付',
        description: '把工作成果整理成「目标 - 过程 - 结论 - 风险」的清晰交付文档。',
        content: `# 结构化交付

当你要产出一份文档、方案或报告时，遵循以下结构：

## 1. 目标
用 1-3 句话说明本次交付要解决的问题与成功标准。

## 2. 过程与依据
说明你做了哪些工作、使用了哪些输入、关键判断依据是什么。

## 3. 结论 / 交付物
给出可直接使用的成果。若包含文件，列出文件路径与用途。

## 4. 风险与待确认项
列出不确定之处、依赖项和建议的下一步。

## 写作要求
- 先结论后细节。
- 避免空话，尽量给出具体、可验证的内容。
- 文件使用 UTF-8，Markdown 格式。
`,
      });

      const planner = store.createAgent({
        name: '策划师',
        description: '把用户任务拆解成清晰的目标、计划与验收标准。',
        accent: '#6d8cff',
        responsibilities: `把用户任务拆解成清晰的目标、计划与验收标准，产出可直接执行的计划文档。
1. 通读用户任务与输入文件（都在你的工作区 inbox\\ 下），明确目标、范围、约束与信息缺口。
2. 把任务拆解为分步执行计划，每一步写清输入、产出与完成标准。
3. 识别关键风险，信息不足时做出合理假设并显式写出。`,
        deliverable: `output\\ 目录下的一份 Markdown 计划文档 plan.md：包含目标与验收标准、分步执行计划（每步的输入、产出、完成标准）、风险与假设清单；另附 README.md 说明文件清单与阅读顺序。形式为 Markdown 文档。`,
        guide: `需求分析与策划岗位的工作要求：
1. 明确目标、范围、约束与验收标准。
2. 给出分步骤的执行计划，标注关键风险。
3. 如果任务信息不足，先检查你的工作区 inbox\\user\\ 中的输入文件，仍不足时做出合理假设并显式写出。
4. 产出要具体，避免泛泛而谈。
5. 全部成果放进 output\\ 目录，并在目录内写一份 README.md 说明计划要点，然后交接该目录。`,
      });

      const maker = store.createAgent({
        name: '执行者',
        description: '根据计划完成实际产出，必要时查阅技能与上游交付文件。',
        accent: '#34d399',
        responsibilities: `按上一环节的计划完成实际产出，交付可直接使用的成果文件。
1. 阅读上游交付的计划与 README（inbox\\ 下），确认本环节的产出要求。
2. 按计划逐步产出实际成果（文档、代码或数据），不要只写口头描述。
3. 对照计划的完成标准自检，每项要求都要有对应产出。
4. 发现计划有问题时仍交付当前版本，并在 README 中说明偏差。`,
        deliverable: `output\\ 目录下的成果文件（Markdown 文档、代码或数据文件，以计划为准），并附 README.md 说明每个文件是什么、与计划的对应关系。必须是实际文件，不要只交付口头描述。`,
        guide: `执行岗位的工作要求：
1. 先阅读上游交付文件夹（你的工作区 inbox\\ 下）中的计划与 README，确认目标与验收标准；用户投放的输入文件在你的工作区 inbox\\user\\ 目录。
2. 在你的任务工作区中产出可交付的文件（Markdown、代码或数据，建议放 output\\），不要只写口头描述。
3. 文件命名清晰，并在 output\\README.md 里说明产出了什么、放在哪里，然后交接该目录。
4. 如果发现计划有问题，仍需交付当前版本，并在 README.md 中说明偏差。
5. 使用「结构化交付」技能组织文档。`,
      });

      const reviewer = store.createAgent({
        name: '审校官',
        description: '审阅上一环节的产出，检查完整性、一致性与可执行性。',
        accent: '#f59e0b',
        responsibilities: `审阅上一环节的产出并给出验收结论，汇总用户可直接验收的最终交付。
1. 对照原始任务与上游交付，逐项检查完整性、一致性与可执行性。
2. 指出具体问题：位置、原因与修改建议，不要只写“建议优化”。
3. 给出明确的通过结论；不合格时列出必须修改的条目与风险。`,
        deliverable: `output\\ 目录下的一份 Markdown 审校报告 review.md：逐项检查结果、问题清单（位置 + 原因 + 建议）、明确的通过结论。本环节是流水线终点，整个 output\\ 目录将交给用户验收。`,
        guide: `审校岗位的工作要求：
1. 对照原始任务逐项检查，上游产出文件已复制到你的工作区 inbox\\ 下。
2. 指出具体问题（位置 + 原因 + 修改建议），不要只说“建议优化”。
3. 如果产出合格，给出明确的通过结论；如有风险，列出风险与建议。
4. 审校报告与通过结论都写成交付文件放进 output\\，交接该目录；这是流水线终点，交付文件夹会交给用户验收。
5. 使用「结构化交付」技能组织审校报告。`,
      });

      store.updateAgent(maker.id, { skillIds: [skill.id] });
      store.updateAgent(reviewer.id, { skillIds: [skill.id] });

      const planNode = randomUUID();
      const makeNode = randomUUID();
      const reviewNode = randomUUID();
      const pipeline = store.createPipeline({
        name: '策划-执行-审校',
        description: '先把需求拆成计划，再按计划产出文件，最后由审校环节汇总并交给用户验收。',
        nodes: [
          { id: planNode, agentId: planner.id, isStart: true, x: 0, y: 120 },
          { id: makeNode, agentId: maker.id, x: 280, y: 120 },
          { id: reviewNode, agentId: reviewer.id, x: 560, y: 120 },
        ],
        edges: [
          {
            from: planNode,
            to: makeNode,
            triggerPrompt:
              '策划师已完成需求分析与计划，交付目录：{deliverables}（含计划与 README）。请阅读后按计划产出实际成果，放入你的 output\\ 目录并交接该目录。原始任务：{task}',
          },
          {
            from: makeNode,
            to: reviewNode,
            triggerPrompt:
              '执行者已完成产出，交付目录：{deliverables}。请对照原始任务逐项审校，输出审校报告并写入 output\\ 目录后交接。原始任务：{task}',
          },
        ],
      });

      runtime.publish({ type: 'config.updated', detail: 'demo.seeded' });
      res.status(201).json({ agents: store.listAgents(), skills: store.listSkills(), pipeline });
    }),
  );

  return router;
}
