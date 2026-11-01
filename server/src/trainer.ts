import type { Agent, AgentInput, DesignerChangeOp, Pipeline, PipelineInput } from '../../shared/types';
import { DESIGNER_SLUG, TRAINER_SLUG, bfsNodeOrder } from '../../shared/types';
import { AppError, errorMessage } from './errors';
import type { ChatAgentRuntimeOptions, ChatRoleSpec, ChatToolDeps, ChatToolMeta } from './chat';
import { ChatAgentRuntime } from './chat';
import type { Runtime } from './runtime';
import type { Store } from './store';
import type { ResolvedTool, ToolResult } from './tools';
import {
  AGENT_FIELDS_PROPERTIES,
  REF_AGENT,
  REF_SKILL,
  REF_TOOL,
  applyChangeOp,
  assertNotSystemAgent,
  changeBranch,
  validateChangeOps,
} from './designer';
import { optionalString, requireString, truncateText } from './chat';

const nowIso = (): string => new Date().toISOString();

/**
 * 测试流水线的固定名称：训练师的 start_test_task 把它临时指向目标智能体。
 * 任务启动时固化流水线快照，因此每次改指向都不影响进行中与历史测试任务。
 */
const TRAINING_PIPELINE_NAME = '智能体训练台';

const TRAINING_PIPELINE_DESCRIPTION =
  '（系统维护）智能体训练师的测试流水线：每次测试任务会把唯一起点指向被训练的智能体，单节点即终点，完成后等待用户验收。请勿手工编辑，不影响其它流水线。';

/** 训练师的默认档案：仅首次创建时使用；之后它的定义由人类在智能体页维护。 */
const TRAINER_DEFAULT_DEFINITION: AgentInput = {
  name: '智能体训练师',
  description:
    '单智能体训练师：与用户对话澄清需求，从 0 打造并持续训练单个智能体——创建、测试、根据反馈优化，直到稳定交付。',
  responsibilities:
    '你专职训练单个智能体：\n' +
    '1. 与用户对话，澄清要打造的智能体：它接收什么输入、职责与工作目标是什么、交付要求是什么；\n' +
    '2. 从 0 撰写智能体提示词，配置自定义工具、技能与模型参数，先讲思路、用户认可后再创建或修改；\n' +
    '3. 每次创建或修改生效后立即启动一轮测试任务，跟踪执行状态与结果；\n' +
    '4. 测试完成后请用户评审交付物，根据反馈继续优化，循环训练直到用户满意。',
  deliverable: '',
  guide:
    '先澄清、再讲思路、认可即动手、改完必测：新建或修改智能体之前，必须先用几句话讲清要做哪些调整与关键思路，用户认可后再 apply_changes；' +
    '变更生效后立即 start_test_task 启动测试任务，任务结束后请用户在任务页评审交付物并给出反馈，按反馈优化后进入下一轮测试；' +
    '智能体的提示词完全从 0 撰写，必须明确写清接收哪些输入、职责与工作目标、交付要求；' +
    '内置工具由系统统一授予所有智能体，不能删除或修改，也不要在提示词里安排内置工具的开关。',
  model: null,
  temperature: 0.3,
  tools: {
    builtin: [
      'bash',
      'pwsh',
      'read',
      'write',
      'edit',
      'glob',
      'grep',
      'list_dir',
      'read_image',
      'web_search',
      'web_fetch',
    ],
    custom: [],
  },
  skillIds: [],
  accent: '#34d399',
};

/* ------------------------------------------------------------------ */
/* system prompt                                                       */
/* ------------------------------------------------------------------ */

/**
 * 训练师的系统提示词：单智能体教练——没有系统级视野，不注入任何系统清单；
 * 训练对象由用户指定，面对已有智能体用 get_agent 查看当前定义。
 */
export function assembleTrainerSystemPrompt(store: Store, agent: Agent, workspaceDir: string): string {
  return [
    `你是「智能体训练师」（${agent.name}），只专注于**一个**智能体：从 0 创建、持续训练，把它调教到能稳定交付、让用户满意。`,
    '你的视野只有这一个智能体和它的测试任务——系统里其他部分（别的智能体、任务、配置）不在你的职责内；要训练谁、它现在什么样，由用户告诉你，面对已有的智能体先用 get_agent 查看它的当前定义。',
    '全程以对话完成：用户描述需求，你澄清、给思路、执行变更、启动测试、跟进结果、请用户评审，循环迭代。',
    '',
    '# 训练规则（必须遵守）',
    '1. 【提示词从 0 写】你创建或重写智能体时，提示词完全从 0 撰写，不要沿用任何现成格式或模板。',
    '   写出的提示词必须明确说清三件事：',
    '   - 输入：这个智能体接收哪些输入（用户会给它什么、以什么形式）；',
    '   - 职责与工作目标：它要做什么、做到什么程度、用什么工作方法；',
    '   - 交付要求：产出什么、以什么形式、验收标准是什么。',
    '2. 【先讲思路再动手】每次新建或修改智能体（含它的工具与技能）之前，先用几句话向用户讲清你打算做哪些调整、关键思路是什么，等用户认可后再调用 apply_changes 执行；用户没认可就不要动手。',
    '3. 【改完必测、测完必评】每次创建或修改智能体生效后，立即用 start_test_task 启动一轮测试任务，不要等用户催；任务执行完成后，明确请用户到任务页查看交付物并给出评审反馈；你根据反馈优化智能体，然后继续启动下一轮测试，直到用户满意为止。',
    '',
    '# 智能体的能力边界（系统约定）',
    '- 所有智能体默认自动携带全部系统内置工具（文件、命令行、联网搜索等），这部分由系统统一授予，不能删除也不能修改；你能配置的是：提示词、自定义工具、技能、模型、温度。',
    '- 智能体的运行框架（专属工作目录、上下文管理、终点交付与验收）由系统统一处理，不要在提示词里交代这些机制，提示词只写角色本身的事情。',
    '- 同一批变更里可以先创建工具/技能、再创建引用它们的智能体；不要引用后序才创建的对象。',
    '',
    '# 测试任务',
    '- start_test_task 给目标智能体发起一轮测试任务；同一时间只允许一个活动任务，若已有任务在跑，先请用户在任务页处理（验收完成或终止）再启动。',
    '- 测试任务执行中用 list_tasks 跟踪状态；结束后用 get_task 查看完整运行记录（各环节输入输出、实际下发的系统提示词、消息记录）。',
    '- 任务停在「等待用户验收」表示智能体已交付终点产物：请用户到任务页查看交付物（final\\ 目录与输出说明），回来告诉你反馈，你再决定是否优化。',
    '- 你自己不能替用户验收或完成任务；修改与重测都要基于用户的反馈。',
    '',
    '# 工作方式',
    '- 对话保持简洁：讲重点，不堆术语；用户追问时再展开细节。',
    '- 讲思路时说清楚：要新建还是修改哪个智能体、提示词的核心设计（输入/职责/交付）、要新增或复用哪些工具与技能、模型与温度怎么定。',
    '- 你的专属工作目录（系统级、跨会话持久，不属于任何任务）：' + workspaceDir,
    '- 文件工具的相对路径以它为基准，可用来写训练记录、测试用例草稿等；任务产物不在你的工作区里，用 get_task 查看结构化记录。',
    '',
    '# 环境信息',
    `- 操作系统：${process.platform}`,
    `- 当前时间：${nowIso()}`,
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* trainer tools                                                       */
/* ------------------------------------------------------------------ */

const TRAINER_APPLY_CHANGES_DESCRIPTION =
  '应用一次训练变更（新建/修改/删除智能体、自定义工具、技能），按顺序立即执行、马上生效，用户无需再点任何确认按钮。' +
  '调用前提：调整思路已经向用户讲清并获认可；用户还没认可时不要调用。' +
  'changes 每一项的结构见参数 schema（按 op 判别的 9 种变更，只涉及智能体、自定义工具与技能）。' +
  '引用已有对象一律用名称字段（agentName / toolName / skillName）；' +
  '同一变更内「先创建、后引用」按变更顺序解析，可以直接引用前序变更创建的对象，但不要引用后序才创建的对象、也不要先创建又删除同一对象。' +
  '不能对系统角色（包括你自己）发起变更。' +
  '部分失败时已成功的项保持生效，工具结果会说明失败原因与已生效清单。';

const TRAINER_LIST_TASKS_DESCRIPTION =
  '查看你启动的测试任务（按开始时间倒序）：任务内容、状态、进度与错误。用于跟踪测试任务的执行状态。';

const TRAINER_GET_TASK_DESCRIPTION =
  '查看一次测试任务的完整运行记录：环节链路（输入、输出、交接文件夹与错误）；给出 turn_id 可再细看该环节实际下发的系统提示词与完整消息记录。只能查看训练师启动的测试任务。';

const TRAINER_LIST_TASKS_PARAMS = {
  type: 'object',
  properties: {
    limit: { type: 'number', description: '最多返回条数，默认 20，最大 100' },
    status: {
      type: 'string',
      enum: ['running', 'paused', 'waiting_human', 'completed', 'failed', 'aborted'],
      description: '按状态过滤，可选',
    },
  },
} as const;

const TRAINER_GET_TASK_PARAMS = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '任务 id（可用 list_tasks 查到，支持只写前 8 位）' },
    turn_id: { type: 'string', description: '可选：环节 id（支持前缀）；给出时额外展示该环节的系统提示词与消息记录' },
  },
  required: ['id'],
} as const;

/** 训练师专属工具的展示元数据（详情页用；与实际注册进模型的工具同源）。 */
export interface TrainerToolMeta extends ChatToolMeta {}

interface TrainerToolDeps extends ChatToolDeps {
  /** 任务运行时：start_test_task / stop_test_task 需要。 */
  runtime: Runtime;
}

/** metas 传入时同步登记每个工具的名称与描述，供详情展示复用，避免两处维护。 */
function makeTrainerTools(deps: TrainerToolDeps, metas?: TrainerToolMeta[]): ResolvedTool[] {
  const { store } = deps;
  // 训练师只看得见自己启动的测试任务：系统里其他任务（用户手工发起等）不在视野内。
  const trainingTasks = () => store.listTasks(200).filter((task) => task.pipelineName === TRAINING_PIPELINE_NAME);
  const runtime = deps.runtime;
  const tools: ResolvedTool[] = [];
  const add = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    execute: (args: Record<string, unknown>) => Promise<string | ToolResult> | string | ToolResult,
  ): void => {
    metas?.push({ name, description });
    tools.push({
      spec: { type: 'function', function: { name, description, parameters } },
      execute: async (args) => execute(args),
    });
  };

  add(
    'get_agent',
    '查看你正在训练的智能体的完整档案：提示词原文（输入/职责与工作目标/交付要求）、模型与温度、工具与技能配置。修改前先看现状；系统角色不可查看。',
    {
      type: 'object',
      properties: { name: { type: 'string', description: '智能体名称或 id' } },
      required: ['name'],
    },
    (args) => {
      const ref = String(args.name ?? '').trim();
      if (!ref) throw new AppError(400, '缺少智能体名称');
      const agent = store.getAgent(ref) ?? store.getAgentByName(ref);
      if (!agent) throw new AppError(404, `找不到智能体「${ref}」——确认名称是否正确，或用 apply_changes 的 create_agent 新建`);
      if (agent.slug === TRAINER_SLUG || agent.slug === DESIGNER_SLUG) {
        throw new AppError(403, `「${agent.name}」是系统角色，不在训练范围`);
      }
      const toolNames = (agent.tools.custom ?? [])
        .map((toolRef) => store.getCustomTool(toolRef)?.name ?? toolRef)
        .filter(Boolean);
      const skillNames = agent.skillIds.map((skillRef) => store.getSkill(skillRef)?.name ?? skillRef).filter(Boolean);
      return [
        `# ${agent.name}（id=${agent.id.slice(0, 8)}）`,
        `- 一句话描述：${agent.description || '（无）'}`,
        `- 任务说明：${agent.responsibilities || '（空）'}`,
        `- 交付要求：${agent.deliverable || '（空，用系统默认说明）'}`,
        `- 工作指南：${agent.guide || '（空）'}`,
        `- 模型：${agent.model || '（全局默认）'} ｜ 温度：${agent.temperature ?? '（全局默认）'}`,
        `- 自定义工具：${toolNames.length > 0 ? toolNames.join('、') : '（无）'}`,
        `- 技能：${skillNames.length > 0 ? skillNames.join('、') : '（无）'}`,
      ].join('\n');
    },
  );

  add(
    'apply_changes',
    TRAINER_APPLY_CHANGES_DESCRIPTION,
    {
      type: 'object',
      properties: {
        title: { type: 'string', description: '变更标题（一句话概括这次变更）' },
        summary: { type: 'string', description: '变更说明：要达成什么、训练思路、对智能体行为的影响' },
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          description: '变更清单，按顺序执行；每项结构见 items schema（按 op 判别的 9 种变更）',
          items: TRAINER_CHANGE_ITEM_SCHEMA,
        },
      },
      required: ['title', 'summary', 'changes'],
    },
    (args) => {
      const title = requireString(args.title, '变更标题 title', 120);
      const summary = requireString(args.summary, '变更说明 summary', 2000);
      const rawChanges = args.changes;
      if (!Array.isArray(rawChanges) || rawChanges.length === 0) {
        throw new AppError(400, 'changes 必须是非空数组');
      }
      const changes: DesignerChangeOp[] = rawChanges.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new AppError(400, `changes[${index}] 必须是对象`);
        }
        const op = String((item as Record<string, unknown>).op ?? '');
        if (!ALLOWED_OPS.has(op)) {
          throw new AppError(400, `changes[${index}].op「${op || '（空）'}」不在训练师的变更范围内（智能体/自定义工具/技能共 9 种）`);
        }
        return item as DesignerChangeOp;
      });
      // 前置校验（含先建后引的覆盖层模拟）由与设计师共用的一套逻辑完成。
      validateChangeOps(store, changes);

      // 训练思路已获用户认可：立即按顺序执行，变更记录（含结果）落库展示给用户。
      const applied: string[] = [];
      let failure: string | null = null;
      for (const [index, change] of changes.entries()) {
        try {
          applied.push(applyChangeOp(store, change));
        } catch (error) {
          const prefix = applied.length > 0 ? `前 ${applied.length} 项已生效：${applied.join('；')}。` : '';
          failure = `第 ${index + 1} 项变更失败：${errorMessage(error)}。${prefix}`;
          break;
        }
      }

      // 变更记录落库展示（变更卡片渲染在该条助手消息下方）。
      const record = store.chatCreateProposal('trainer', {
        sessionId: deps.sessionId,
        messageId: deps.link.messageId,
        title,
        summary,
        changes,
        status: failure ? 'failed' : 'applied',
        error: failure ?? undefined,
      });
      deps.publish({ type: 'trainer.proposal', sessionId: deps.sessionId, proposalId: record.id });
      deps.publish({ type: 'config.updated' });
      if (failure) {
        return (
          `变更中断，已生效的部分保持生效（编号 ${record.id.slice(0, 8)}）。${failure}` +
          '请向用户如实说明已生效与失败的内容，修正后把剩余部分作为新的 apply_changes 重新执行。'
        );
      }
      return (
        `变更已全部生效（编号 ${record.id.slice(0, 8)}，共 ${applied.length} 项）：${applied.join('；')}。` +
        '按训练规则：现在用 start_test_task 启动一轮测试任务，完成后请用户评审交付物。'
      );
    },
  );

  add(
    'start_test_task',
    '给指定智能体发起一轮测试任务：系统会搭一个单环节测试任务并立即启动。同一时间只允许一个活动任务。按训练规则，每次创建或修改智能体之后都要用它启动测试。',
    {
      type: 'object',
      properties: {
        agent: { type: 'string', description: '要测试的智能体名称或 id（通常是刚创建/修改的那个）' },
        task: {
          type: 'string',
          description: '测试任务内容：一段直接交给该智能体的任务描述，尽量贴近用户的真实使用场景，能检验提示词里的输入、职责与交付要求',
        },
      },
      required: ['agent', 'task'],
    },
    (args) => {
      const agentRef = requireString(args.agent, '智能体 agent', 200);
      const agent = store.getAgent(agentRef) ?? store.getAgentByName(agentRef);
      if (!agent) throw new AppError(404, `找不到智能体「${agentRef}」——确认名称是否正确`);
      assertNotSystemAgent(agent);
      const taskText = requireString(args.task, '测试任务 task', 8000);

      const active = store.findActiveTask();
      if (active) {
        const state =
          active.status === 'paused' ? '已暂停' : active.status === 'waiting_human' ? '等待用户验收' : '执行中';
        throw new AppError(409, `已有未结束的任务（${state}），请先让用户在任务页处理（验收完成或终止）再启动测试`);
      }

      const pipeline = upsertTrainingPipeline(store, agent);
      const detail = runtime.startTask({ pipelineId: pipeline.id, task: taskText });
      return [
        `测试任务已启动：${detail.id.slice(0, 8)}（智能体：${agent.name}，状态：${detail.status}）`,
        `任务内容：${truncateText(taskText, 300)}`,
        '用 list_tasks 跟踪执行状态；任务停在「等待用户验收」后，请用户到任务页查看交付物（final\\ 目录）并回来给出评审反馈。',
      ].join('\n');
    },
  );

  add(
    'stop_test_task',
    '终止一个进行中的测试任务（任务会标记为 aborted 并保留运行记录）。仅在任务卡死、跑偏或用户要求停止时使用；不要用终止代替正常评审流程。',
    {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id（支持前 8 位）；省略时默认当前活动任务' },
        reason: { type: 'string', description: '终止原因（会记录在任务上）' },
      },
    },
    (args) => {
      const idRef = optionalString(args.id, 40);
      const target = idRef
        ? trainingTasks().find((task) => task.id.startsWith(idRef))
        : trainingTasks().find((task) => task.status !== 'completed' && task.status !== 'failed' && task.status !== 'aborted');
      if (!target) throw new AppError(404, `找不到可终止的测试任务「${idRef || '（当前活动测试任务）'}」`);
      const reason = optionalString(args.reason, 500) || '训练师终止了这轮测试';
      const detail = runtime.terminateTask(target.id, reason);
      return `任务 ${detail.id.slice(0, 8)} 已终止（状态：${detail.status}）。向用户说明原因，确认下一步：调整智能体后再测，或换个测试任务。`;
    },
  );

  add('list_tasks', TRAINER_LIST_TASKS_DESCRIPTION, TRAINER_LIST_TASKS_PARAMS, (args) => {
    const limit = Math.min(Math.max(Math.round(Number(args.limit ?? 20)) || 20, 1), 100);
    const status = optionalString(args.status, 30);
    const items = trainingTasks()
      .filter((task) => !status || task.status === status)
      .slice(0, limit);
    if (items.length === 0) {
      return `还没有测试任务记录。用 start_test_task 启动一轮测试。`;
    }
    return [
      `共 ${items.length} 条任务（新 → 旧）：`,
      ...items.map((task) => {
        const step = task.pipelineTotal > 0 ? ` ｜ 进度 ${task.pipelineStep}/${task.pipelineTotal}` : '';
        const agent = task.currentAgentName ? ` ｜ 当前：${task.currentAgentName}` : '';
        const error = task.error ? `\n  ⚠️ ${truncateText(task.error, 300)}` : '';
        return (
          `- [${task.id.slice(0, 8)}] ${task.createdAt.slice(0, 16).replace('T', ' ')} ｜ ${task.status}${step}${agent} ｜ ${task.turnCount} 个环节\n` +
          `  任务：${truncateText(task.task.replace(/\s+/g, ' ').trim(), 300)}${error}`
        );
      }),
      '用 get_task 可查看某次任务的环节链路与各环节的输入输出。',
    ].join('\n');
  });

  add('get_task', TRAINER_GET_TASK_DESCRIPTION, TRAINER_GET_TASK_PARAMS, (args) => {
    const idRef = String(args.id ?? '').trim();
    if (!idRef) throw new AppError(400, '缺少任务 id');
    const summary = trainingTasks().find((task) => task.id.startsWith(idRef));
    if (!summary) throw new AppError(404, `找不到测试任务「${idRef}」，可用 list_tasks 查看测试任务列表`);
    const task = store.getTaskDetail(summary.id);
    if (!task) throw new AppError(404, `找不到任务「${idRef}」`);

    const flow = task.pipeline
      ? bfsNodeOrder(task.pipeline)
          .map((node) => store.getAgent(node.agentId)?.name ?? '（已删除）')
          .join(' → ')
      : '';
    const lines: string[] = [
      `# 任务 ${task.id.slice(0, 8)}（状态：${task.status}）`,
      `- 描述：${truncateText(task.task.replace(/\s+/g, ' ').trim(), 800)}`,
      `- 环节链路：${flow}`,
      '- 说明：本任务使用启动时的配置快照，之后对智能体的修改不影响这条记录。',
      ...(task.error ? [`- 任务级错误：${truncateText(task.error, 500)}`] : []),
      `- 环节（${task.turns.length} 个）：`,
    ];
    for (const turn of task.turns) {
      const handoff = turn.handoffFolder
        ? ` ｜ 交接 ${turn.handoffFolder.deliveredPath}（${turn.handoffFolder.files} 个文件，${turn.handoffFolder.bytes} 字节）`
        : '';
      const target = turn.target
        ? ` ｜ 交给 ${turn.target.type === 'human' ? '用户（终点交付）' : turn.target.agentName}`
        : '';
      const error = turn.error ? ` ｜ 错误：${truncateText(turn.error, 300)}` : '';
      lines.push(
        [
          `  ## 环节 ${turn.seq}：${turn.agentName}（${turn.status}，环节 id=${turn.id.slice(0, 8)}）${handoff}${target}${error}`,
          `  输入：${turn.input ? truncateText(turn.input.replace(/\s+/g, ' ').trim(), 500) : '（无）'}`,
          `  输出：${turn.output ? truncateText(turn.output.replace(/\s+/g, ' ').trim(), 500) : '（无文本输出）'}`,
        ].join('\n'),
      );
    }

    const turnRef = optionalString(args.turn_id, 40);
    if (turnRef) {
      const turn = task.turns.find((item) => item.id.startsWith(turnRef));
      if (!turn) throw new AppError(404, `任务里找不到环节「${turnRef}」`);
      const conversation = store.getTurnConversation(turn.id);
      const messages = conversation ? store.listMessages(conversation.id, 200) : [];
      const systemPrompt = store.getTurnSystemPrompt(turn.id);
      lines.push(
        `# 环节 ${turn.seq}（${turn.agentName}）详情`,
        `- 实际下发的系统提示词：\n${truncateText(systemPrompt ?? '（尚未执行，无留档）', 20_000)}`,
        `- 消息记录（${messages.length} 条）：`,
        ...messages.map((message) => {
          const calls =
            message.role === 'assistant' && message.toolCalls.length > 0
              ? `（调用工具：${message.toolCalls.map((call) => call.name).join('、')}）`
              : '';
          const label = message.role === 'tool' ? `tool(${message.name ?? ''})` : message.role;
          return `  - [${label}]${calls} ${truncateText(message.content.replace(/\s+/g, ' ').trim(), 600)}`;
        }),
      );
    }
    return lines.join('\n');
  });

  return tools;
}

/** 训练师允许的变更操作：智能体、自定义工具与技能——不含流水线。 */
const ALLOWED_OPS = new Set([
  'create_agent',
  'update_agent',
  'delete_agent',
  'create_tool',
  'update_tool',
  'delete_tool',
  'create_skill',
  'update_skill',
  'delete_skill',
]);

/** 训练师的变更 schema：与设计师同构，只保留智能体/工具/技能 9 种。 */
export const TRAINER_CHANGE_ITEM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  oneOf: [
    changeBranch('create_agent', '新建智能体（提示词完全从 0 撰写）', { agent: { type: 'object', description: '智能体的完整定义', properties: AGENT_FIELDS_PROPERTIES, required: ['name'] } }, ['agent']),
    changeBranch('update_agent', '修改智能体（只覆盖 agent 里给出的字段）', { ...REF_AGENT, agent: { type: 'object', description: '要覆盖的字段（结构同 create_agent 的 agent，均可选）' } }, ['agent']),
    changeBranch('delete_agent', '删除智能体（仍被使用中时会被系统拒绝）', { ...REF_AGENT }, []),
    changeBranch('create_tool', '新建自定义工具', { tool: { type: 'object', description: '自定义工具的完整定义' }, }, ['tool']),
    changeBranch('update_tool', '修改自定义工具（只覆盖 tool 里给出的字段）', { ...REF_TOOL, tool: { type: 'object', description: '要覆盖的字段（结构同 create_tool 的 tool，均可选）' } }, ['tool']),
    changeBranch('delete_tool', '删除自定义工具', { ...REF_TOOL }, []),
    changeBranch('create_skill', '新建技能', {
      skill: {
        type: 'object',
        description: '新技能的完整定义',
        properties: {
          name: { type: 'string', description: '技能名称（必填，全局唯一）' },
          description: { type: 'string', description: '技能描述' },
          content: { type: 'string', description: 'SKILL.md 正文' },
        },
        required: ['name'],
      },
    }, ['skill']),
    changeBranch('update_skill', '修改技能（只覆盖 skill 里给出的字段）', { ...REF_SKILL, skill: { type: 'object', description: '要覆盖的字段（结构同 create_skill 的 skill，均可选）' } }, ['skill']),
    changeBranch('delete_skill', '删除技能', { ...REF_SKILL }, []),
  ],
};

/* ------------------------------------------------------------------ */
/* test pipeline（智能体训练台）                                         */
/* ------------------------------------------------------------------ */

/**
 * 把测试流水线「智能体训练台」指向目标智能体：存在就更新为单节点图，不存在就创建。
 * 单节点、无连线 = 该智能体即终点，任务结束停在「等待用户验收」。
 */
function upsertTrainingPipeline(store: Store, agent: Agent): Pipeline {
  const node = { id: 'trainer-run', agentId: agent.id, isStart: true, x: 0, y: 0 };
  const input: PipelineInput = {
    name: TRAINING_PIPELINE_NAME,
    description: TRAINING_PIPELINE_DESCRIPTION,
    nodes: [node],
    edges: [],
  };
  const existing = store.listPipelines().find((pipeline) => pipeline.name === TRAINING_PIPELINE_NAME);
  return existing ? store.updatePipeline(existing.id, input) : store.createPipeline(input);
}

/* ------------------------------------------------------------------ */
/* runtime                                                             */
/* ------------------------------------------------------------------ */

const TRAINER_SPEC: ChatRoleSpec = {
  kind: 'trainer',
  label: '训练师',
  toolSource: 'designer',
  events: {
    session: 'trainer.session',
    message: 'trainer.message',
    status: 'trainer.status',
    delta: 'trainer.delta',
    reasoning: 'trainer.reasoning',
    proposal: 'trainer.proposal',
  },
  defaultDefinition: TRAINER_DEFAULT_DEFINITION,
  assembleSystemPrompt: assembleTrainerSystemPrompt,
  makeTools: makeTrainerTools,
};

export type TrainerRuntimeOptions = ChatAgentRuntimeOptions;

/**
 * 智能体训练师的运行时：与设计师共用通用对话运行时，差别只在提示词与工具集。
 * 训练师不设计流水线，但可以经测试流水线「智能体训练台」启动单智能体测试任务。
 */
export class TrainerRuntime extends ChatAgentRuntime {
  constructor(options: TrainerRuntimeOptions) {
    super(TRAINER_SPEC, options);
  }
}
