import type { Agent, AgentInput, DesignerChangeOp } from '../../shared/types';
import { DESIGNER_SLUG, TRAINER_SLUG } from '../../shared/types';
import { AppError, errorMessage } from './errors';
import type { ChatAgentRuntimeOptions, ChatRoleSpec, ChatToolDeps, ChatToolMeta } from './chat';
import { ChatAgentRuntime } from './chat';
import type { Runtime } from './runtime';
import type { Store } from './store';
import type { ResolvedTool, ToolResult } from './tools';
import {
  REF_SKILL,
  REF_TOOL,
  applyChangeOp,
  assertNotSystemAgent,
  changeBranch,
  normalizeAgentInput,
  validateChangeOps,
} from './designer';
import { optionalString, requireString, truncateText } from './chat';

const nowIso = (): string => new Date().toISOString();

/** 训练师的默认档案：仅首次创建时使用；之后它的定义由人类在智能体页维护。 */
const TRAINER_DEFAULT_DEFINITION: AgentInput = {
  name: '智能体训练师',
  description:
    '单智能体训练师：与用户对话澄清需求，从 0 打造并持续训练单个智能体——创建、试运行、根据反馈优化，直到稳定交付。',
  responsibilities:
    '你专职训练单个智能体：\n' +
    '1. 与用户对话，澄清要打造的智能体：它接收什么输入、职责与工作目标是什么、交付要求是什么；\n' +
    '2. 撰写智能体的完整提示词，配置自定义工具、技能与模型参数，先讲思路、用户认可后再创建或修改；\n' +
    '3. 每次创建或修改生效后立即发起一轮试运行，跟踪执行状态与结果；\n' +
    '4. 试运行完成后请用户评审交付物，根据反馈继续优化，循环训练直到用户满意。',
  deliverable: '',
  guide:
    '先澄清、再讲思路、认可即动手、改完必测：新建或修改智能体之前，必须先用几句话讲清要做哪些调整与关键思路，用户认可后再 apply_changes；' +
    '变更生效后立即 start_test_task 发起试运行，请用户评审交付物后再决定是否继续优化。',
  prompt: null,
  model: null,
  temperature: null,
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
 * 训练师的系统提示词：单智能体教练。正向描述工作流与规则，
 * 当前训练对象状态由训练位（store 持久化）注入，不依赖对话上下文。
 */
export function assembleTrainerSystemPrompt(store: Store, agent: Agent, workspaceDir: string): string {
  const focus = store.trainerFocusAgent();
  const focusLines = focus
    ? [
        `你正在训练「${focus.name}」${focus.description ? `：${focus.description}` : ''}。`,
        '用 get_agent 查看它的完整定义（提示词原文与配置）。',
      ]
    : [
        '当前没有正在训练的智能体。先与用户澄清需求，思路获认可后用 apply_changes 创建。',
        '创建后（以及用户点名让你接手某个智能体时），用 get_agent 查看训练对象的完整定义（提示词原文与配置）。',
      ];

  return [
    `你是「${agent.name}」，专职训练**一个**智能体：撰写它的提示词、配置能力、发起试运行、根据用户反馈迭代，直到它能稳定完成用户的目标。`,
    '全程以对话推进：用户描述需求，你澄清、给思路、执行变更、发起试运行、跟进结果、请用户评审，循环迭代。',
    '',
    '# 当前训练对象',
    ...focusLines,
    '',
    '# 工作规则',
    '1. 【先讲思路再动手】每次新建或修改智能体（含它的工具与技能）之前，先用几句话向用户讲清你打算做哪些调整、关键思路是什么，等用户认可后再调用 apply_changes 执行；用户没认可就不要动手。',
    '2. 【改完必测】每次创建或修改智能体生效后，立即用 start_test_task 发起一轮试运行，不要等用户催。',
    '3. 【测完必评】试运行任务停在「等待用户验收」后，请用户到任务页查看交付物并给出评审反馈；你根据反馈优化智能体，然后继续下一轮试运行，直到用户满意为止。',
    '',
    '# 你要训练的智能体',
    '- 它的定义 = 一份完整的系统提示词（写清它是什么角色、接收什么输入、要做什么、交付什么、怎么工作）+ 工具与技能配置 + 模型参数。',
    '- 内置工具（文件、命令行、联网搜索等）由系统统一授予所有智能体，不能删除也不能修改；你能配置的是：提示词、自定义工具、技能、模型、温度。',
    '- 试运行的工作机制（专属工作区、提交交付、人工评审）由系统处理，不要写进提示词；提示词只写角色本身的事情。',
    '- 同一批变更里可以先创建工具/技能、再创建引用它们的智能体；不要引用后序才创建的对象。',
    '',
    '# 试运行任务',
    '- start_test_task 给当前训练的智能体发起一轮试运行：同一时间只能有一个未结束的试运行任务，已有任务未结束时先请用户在任务页处理（验收或终止）。',
    '- 试运行执行中用 list_tasks 跟踪状态；结束后用 get_task 查看运行记录（输入输出、实际下发的系统提示词、消息记录）。',
    '- 你自己不能替用户验收或完成任务；修改与重测都要基于用户的反馈。',
    '',
    '# 工作方式',
    '- 对话保持简洁：讲重点，不堆术语；用户追问时再展开细节。',
    '- 讲思路时说清楚：提示词的核心设计（输入/职责/交付）、要新增或复用哪些工具与技能、模型与温度怎么定。',
    '- 你的专属工作目录（系统级、跨会话持久，不属于任何任务）：' + workspaceDir,
    '- 文件工具的相对路径以它为基准，可用来写训练记录、测试用例草稿等；试运行产物不在你的工作区里，用 get_task 查看结构化记录。',
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
  '智能体变更始终作用于当前训练对象：create_agent 创建后自动成为训练对象；用户点名要你接手别的智能体时，在 update_agent 里带上它的名称即可切换。' +
  '引用工具与技能一律用名称字段（toolName / skillName）；' +
  '同一变更内「先创建、后引用」按变更顺序解析，可以直接引用前序变更创建的对象，但不要引用后序才创建的对象、也不要先创建又删除同一对象。' +
  '不能对系统角色（包括你自己）发起变更。' +
  '部分失败时已成功的项保持生效，工具结果会说明失败原因与已生效清单。';

const TRAINER_LIST_TASKS_DESCRIPTION =
  '查看你发起的试运行任务（按开始时间倒序）：任务内容、状态与错误。用于跟踪试运行的执行状态。';

const TRAINER_GET_TASK_DESCRIPTION =
  '查看一次试运行任务的完整运行记录：运行输入、输出、提交的交付目录与错误；给出 turn_id 可再细看实际下发的系统提示词与完整消息记录。只能查看你发起的试运行任务。';

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
    turn_id: { type: 'string', description: '可选：运行 id（支持前缀）；给出时额外展示实际下发的系统提示词与消息记录' },
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
  // 训练师只看得见试运行任务（kind='test'）：其余任务与它无关。
  const testTasks = () => store.listTasks(200).filter((task) => task.kind === 'test');
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
    '查看当前训练的智能体的完整定义：系统提示词原文、模型与温度、工具与技能配置。修改前先看现状。',
    { type: 'object', properties: {} },
    () => {
      const agent = store.trainerFocusAgent();
      if (!agent) {
        return '当前没有正在训练的智能体。先与用户澄清需求，思路获认可后用 apply_changes 创建。';
      }
      const toolNames = (agent.tools.custom ?? [])
        .map((toolRef) => store.getCustomTool(toolRef)?.name ?? toolRef)
        .filter(Boolean);
      const skillNames = agent.skillIds.map((skillRef) => store.getSkill(skillRef)?.name ?? skillRef).filter(Boolean);
      return [
        `# ${agent.name}（id=${agent.id.slice(0, 8)}）`,
        `- 一句话描述：${agent.description || '（无）'}`,
        `- 模型：${agent.model || '（全局默认）'} ｜ 温度：${agent.temperature ?? '（全局默认）'}`,
        `- 自定义工具：${toolNames.length > 0 ? toolNames.join('、') : '（无）'}`,
        `- 技能：${skillNames.length > 0 ? skillNames.join('、') : '（无）'}`,
        `## 系统提示词原文\n${agent.prompt || '（还没有撰写提示词——不能试运行，请先补全）'}`,
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
        // 智能体变更补全引用（训练位 / 切换目标）后，与工具技能共用一套校验逻辑。
        return normalizeTrainerChange(store, item as DesignerChangeOp, index);
      });
      // 前置校验（含先建后引的覆盖层模拟）由与设计师共用的一套逻辑完成。
      validateChangeOps(store, changes);

      // 训练思路已获用户认可：立即按顺序执行，变更记录（含结果）落库展示给用户。
      const applied: string[] = [];
      let failure: string | null = null;
      for (const [index, change] of changes.entries()) {
        try {
          applied.push(applyTrainerChange(store, change));
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
        '按训练规则：现在用 start_test_task 启动一轮试运行，完成后请用户评审交付物。'
      );
    },
  );

  add(
    'start_test_task',
    '给当前训练的智能体发起一轮试运行并立即启动。同一时间只能有一个未结束的试运行任务。按训练规则，每次创建或修改智能体之后都要立即发起试运行。',
    {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '试运行任务内容：一段直接交给该智能体的任务描述，尽量贴近用户的真实使用场景，能检验提示词的效果',
        },
      },
      required: ['task'],
    },
    (args) => {
      const agent = store.trainerFocusAgent();
      if (!agent) {
        throw new AppError(409, '当前没有正在训练的智能体。先创建智能体（或用 update_agent 接管用户点名的智能体），再发起试运行');
      }
      if (!agent.prompt) {
        throw new AppError(409, `「${agent.name}」还没有撰写系统提示词，先补全 prompt 再试运行`);
      }
      const taskText = requireString(args.task, '试运行任务 task', 8000);
      const detail = runtime.startTestTask({ agentId: agent.id, task: taskText });
      return [
        `试运行已启动：${detail.id.slice(0, 8)}（智能体：${agent.name}，状态：${detail.status}）`,
        `任务内容：${truncateText(taskText, 300)}`,
        '用 list_tasks 跟踪执行状态；任务停在「等待用户验收」后，请用户到任务页查看交付物并回来给出评审反馈。',
      ].join('\n');
    },
  );

  add(
    'stop_test_task',
    '终止一个进行中的试运行任务（任务会标记为 aborted 并保留运行记录）。仅在任务卡死、跑偏或用户要求停止时使用；不要用终止代替正常评审流程。',
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
        ? testTasks().find((task) => task.id.startsWith(idRef))
        : testTasks().find((task) => task.status !== 'completed' && task.status !== 'failed' && task.status !== 'aborted');
      if (!target) throw new AppError(404, `找不到可终止的试运行任务「${idRef || '（当前活动试运行任务）'}」`);
      const reason = optionalString(args.reason, 500) || '训练师终止了这轮试运行';
      const detail = runtime.terminateTask(target.id, reason);
      return `任务 ${detail.id.slice(0, 8)} 已终止（状态：${detail.status}）。向用户说明原因，确认下一步：调整智能体后再测，或换个试运行任务。`;
    },
  );

  add('list_tasks', TRAINER_LIST_TASKS_DESCRIPTION, TRAINER_LIST_TASKS_PARAMS, (args) => {
    const limit = Math.min(Math.max(Math.round(Number(args.limit ?? 20)) || 20, 1), 100);
    const status = optionalString(args.status, 30);
    const items = testTasks()
      .filter((task) => !status || task.status === status)
      .slice(0, limit);
    if (items.length === 0) {
      return `还没有试运行任务记录。用 start_test_task 启动一轮试运行。`;
    }
    return [
      `共 ${items.length} 条试运行任务（新 → 旧）：`,
      ...items.map((task) => {
        const agent = task.currentAgentName ? ` ｜ 智能体：${task.currentAgentName}` : '';
        const error = task.error ? `\n  ⚠️ ${truncateText(task.error, 300)}` : '';
        return (
          `- [${task.id.slice(0, 8)}] ${task.createdAt.slice(0, 16).replace('T', ' ')} ｜ ${task.status}${agent}\n` +
          `  任务：${truncateText(task.task.replace(/\s+/g, ' ').trim(), 300)}${error}`
        );
      }),
      '用 get_task 可查看某次任务的运行记录。',
    ].join('\n');
  });

  add('get_task', TRAINER_GET_TASK_DESCRIPTION, TRAINER_GET_TASK_PARAMS, (args) => {
    const idRef = String(args.id ?? '').trim();
    if (!idRef) throw new AppError(400, '缺少任务 id');
    const summary = testTasks().find((task) => task.id.startsWith(idRef));
    if (!summary) throw new AppError(404, `找不到试运行任务「${idRef}」，可用 list_tasks 查看试运行任务列表`);
    const task = store.getTaskDetail(summary.id);
    if (!task) throw new AppError(404, `找不到任务「${idRef}」`);

    const lines: string[] = [
      `# 任务 ${task.id.slice(0, 8)}（状态：${task.status}）`,
      `- 智能体：${task.pipelineName || task.currentAgentName || '（未知）'}`,
      `- 任务内容：${truncateText(task.task.replace(/\s+/g, ' ').trim(), 800)}`,
      '- 说明：本任务使用启动时的配置快照，之后对智能体的修改不影响这条记录。',
      ...(task.error ? [`- 任务级错误：${truncateText(task.error, 500)}`] : []),
      `- 运行记录（${task.turns.length} 次）：`,
    ];
    for (const turn of task.turns) {
      const submitted = turn.handoffFolder
        ? ` ｜ 提交 ${turn.handoffFolder.deliveredPath}（${turn.handoffFolder.files} 个文件，${turn.handoffFolder.bytes} 字节）`
        : '';
      const error = turn.error ? ` ｜ 错误：${truncateText(turn.error, 300)}` : '';
      lines.push(
        [
          `  ## 第 ${turn.seq} 次运行：${turn.agentName}（${turn.status}，运行 id=${turn.id.slice(0, 8)}）${submitted}${error}`,
          `  输入：${turn.input ? truncateText(turn.input.replace(/\s+/g, ' ').trim(), 500) : '（无）'}`,
          `  输出：${turn.output ? truncateText(turn.output.replace(/\s+/g, ' ').trim(), 500) : '（无文本输出）'}`,
        ].join('\n'),
      );
    }

    const turnRef = optionalString(args.turn_id, 40);
    if (turnRef) {
      const turn = task.turns.find((item) => item.id.startsWith(turnRef));
      if (!turn) throw new AppError(404, `任务里找不到运行「${turnRef}」`);
      const conversation = store.getTurnConversation(turn.id);
      const messages = conversation ? store.listMessages(conversation.id, 200) : [];
      const systemPrompt = store.getTurnSystemPrompt(turn.id);
      lines.push(
        `# 第 ${turn.seq} 次运行（${turn.agentName}）详情`,
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

/**
 * 训练师视角的智能体字段：完整提示词形态，没有四件套（任务说明/交付要求/工作指南）——
 * 那是流水线智能体的模板字段，训练师不感知。
 */
const TRAINER_AGENT_FIELDS: Record<string, unknown> = {
  name: { type: 'string', description: '智能体名称（必填，全局唯一）' },
  description: { type: 'string', description: '一句话描述' },
  prompt: { type: 'string', description: '智能体的完整系统提示词：写清它是什么角色、接收什么输入、要做什么、交付什么、怎么工作' },
  model: { type: ['string', 'null'], description: '覆盖模型名；留空用全局默认' },
  temperature: { type: ['number', 'null'], description: '覆盖温度（0-2）' },
  tools: {
    type: 'object',
    description: '工具配置（内置工具由系统统一授予，无需配置）',
    properties: {
      custom: { type: 'array', items: { type: 'string' }, description: '启用的自定义工具名列表，按需挑选' },
    },
  },
  skillIds: { type: 'array', items: { type: 'string' }, description: '启用的技能名或 id 列表' },
};

/** 从训练师的变更负载里挑出允许写入的字段（剥离四件套等流水线字段与未知字段）。 */
function trainerAgentInput(payload: Record<string, unknown>): Partial<AgentInput> {
  const pick = (key: string): unknown => (payload[key] === undefined ? undefined : payload[key]);
  const input: Partial<AgentInput> = {};
  if (pick('name') !== undefined) input.name = String(pick('name'));
  if (pick('description') !== undefined) input.description = String(pick('description'));
  if (pick('prompt') !== undefined) input.prompt = pick('prompt') as string | null;
  if (pick('model') !== undefined) input.model = pick('model') as string | null;
  if (pick('temperature') !== undefined) input.temperature = pick('temperature') as number | null;
  if (pick('tools') !== undefined && typeof pick('tools') === 'object' && pick('tools') !== null) {
    input.tools = pick('tools') as AgentInput['tools'];
  }
  if (pick('skillIds') !== undefined) input.skillIds = pick('skillIds') as string[];
  return input;
}

/**
 * 把训练师的智能体变更规范化为校验可用的形态：update/delete 不带引用时
 * 自动补上「当前训练位」；update 带 name 时视为切换目标（按名称引用）。
 * 校验（validateChangeOps）与执行（applyTrainerChange）都使用规范化后的变更。
 */
function normalizeTrainerChange(store: Store, change: DesignerChangeOp, index: number): DesignerChangeOp {
  if (change.op !== 'update_agent' && change.op !== 'delete_agent') return change;
  const raw = change as unknown as Record<string, unknown>;
  const switchName = optionalString(raw.name, 200);
  if (switchName) {
    return { ...change, agentName: switchName } as DesignerChangeOp;
  }
  const focus = store.trainerFocusAgent();
  if (!focus) {
    throw new AppError(
      409,
      `changes[${index}]：当前没有正在训练的智能体；先 create_agent，或在 update_agent 里带上要接管的智能体名称（name）`,
    );
  }
  return { ...change, agentId: focus.id } as DesignerChangeOp;
}

/**
 * 执行训练师的一项变更：智能体变更始终作用于训练位（create 后自动占用；
 * update 可带名称切换训练对象；delete 清空训练位），工具与技能直接复用设计师的执行逻辑。
 */
function applyTrainerChange(store: Store, change: DesignerChangeOp): string {
  switch (change.op) {
    case 'create_agent': {
      const payload = (change.agent ?? {}) as unknown as Record<string, unknown>;
      const prompt = String(payload.prompt ?? '').trim();
      if (!prompt) throw new AppError(400, 'create_agent 必须撰写完整系统提示词（prompt）');
      const input = trainerAgentInput(payload);
      if (!input.name) throw new AppError(400, 'create_agent 必须提供智能体名称（name）');
      const created = store.createAgent(normalizeAgentInput(store, input as AgentInput));
      store.setTrainerFocusAgentId(created.id);
      return `已创建智能体「${created.name}」并设为当前训练对象`;
    }
    case 'update_agent': {
      // 可带名称切换训练对象：用户点名要训练另一个智能体时使用。
      const switchRef = optionalString((change as unknown as Record<string, unknown>).name, 200);
      const current = store.trainerFocusAgent();
      if (switchRef) {
        const target = store.getAgent(switchRef) ?? store.getAgentByName(switchRef);
        if (!target) throw new AppError(404, `找不到要接管的智能体「${switchRef}」——确认名称是否正确`);
        assertNotSystemAgent(target);
        if (store.agentIsInPipeline(target.id)) {
          throw new AppError(409, `「${target.name}」已加入流水线，不能接管为训练对象`);
        }
        if (!current || current.id !== target.id) {
          store.setTrainerFocusAgentId(target.id);
        }
      } else if (!current) {
        throw new AppError(409, '当前没有正在训练的智能体：创建一个，或在 update_agent 里带上名称接管用户点名的智能体');
      }
      const focus = store.trainerFocusAgent()!;
      const payload = (change.agent ?? {}) as unknown as Record<string, unknown>;
      const input = trainerAgentInput(payload);
      // 名称重命名交给 store 层；不传 name 就保持原名。
      if (input.name === undefined) input.name = focus.name;
      const updated = store.updateAgent(focus.id, normalizeAgentInput(store, input));
      if (!updated.prompt) {
        return `已更新智能体「${updated.name}」（注意：还没有系统提示词，试运行前需要先补全）`;
      }
      return `已更新智能体「${updated.name}」`;
    }
    case 'delete_agent': {
      const focus = store.trainerFocusAgent();
      if (!focus) throw new AppError(409, '当前没有正在训练的智能体可删除');
      store.deleteAgent(focus.id);
      store.setTrainerFocusAgentId(null);
      return `已删除智能体「${focus.name}」，当前没有训练对象`;
    }
    default: {
      // 工具与技能：与设计师同一套执行逻辑（含系统校验）。
      return applyChangeOp(store, change);
    }
  }
}

/** 训练师的变更 schema：智能体是训练师形态（完整提示词，无四件套模板字段）。 */
export const TRAINER_CHANGE_ITEM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  oneOf: [
    changeBranch('create_agent', '新建智能体（自动成为当前训练对象）', { agent: { type: 'object', description: '智能体的完整定义', properties: TRAINER_AGENT_FIELDS, required: ['name', 'prompt'] } }, ['agent']),
    changeBranch(
      'update_agent',
      '修改当前训练的智能体（只覆盖 agent 里给出的字段）；带 name 时把训练对象切换为该名称的智能体',
      {
        name: { type: 'string', description: '要接管的智能体名称（可选）：用户点名让你接手时填写' },
        agent: { type: 'object', description: '要覆盖的字段（结构同 create_agent 的 agent，均可选）', properties: TRAINER_AGENT_FIELDS },
      },
      ['agent'],
    ),
    changeBranch('delete_agent', '删除当前训练的智能体', {}, []),
    changeBranch('create_tool', '新建自定义工具', { tool: { type: 'object', description: '自定义工具的完整定义' } }, ['tool']),
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
 * 训练师通过 start_test_task 发起单智能体试运行任务（不经流水线）。
 */
export class TrainerRuntime extends ChatAgentRuntime {
  constructor(options: TrainerRuntimeOptions) {
    super(TRAINER_SPEC, options);
  }
}
