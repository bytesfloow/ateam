import type {
  Agent,
  AgentInput,
  AttachedImage,
  CustomTool,
  DesignerAttachment,
  DesignerChangeOp,
  DesignerMessage,
  DesignerProfile,
  DesignerSession,
  DesignerSessionDetail,
  DesignerSessionSummary,
  DesignerToolInfo,
  Pipeline,
  PipelineInput,
  RealtimeEvent,
  Skill,
} from '../../shared/types';
import { BUILTIN_TOOL_NAMES, DESIGNER_MAX_ATTACHMENTS, DESIGNER_SLUG, bfsNodeOrder } from '../../shared/types';
import { AppError, errorMessage } from './errors';
import type { RuntimeEvents } from './events';
import {
  CONTEXT_COMPRESS_RATIO,
  messageCost,
  planHistoryCompression,
  truncateLargeToolMessages,
} from './runtime';
import {
  BUILTIN_TOOL_INFOS,
  assertValidToolCode,
  assertValidToolSchema,
  resolveTools,
  type ResolvedTool,
  type ToolContext,
  type ToolResult,
} from './tools';
import type { Store } from './store';
import {
  createProvider,
  isContextOverflowError,
  type LlmMessage,
  type LlmProvider,
  type LlmRequestMeta,
  type LlmResponse,
  type LlmToolCall,
} from './llm';

const nowIso = (): string => new Date().toISOString();

const MAX_MESSAGE_CHARS = 50_000;

/** 一条消息最多携带的附件数。 */
export const MAX_MESSAGE_ATTACHMENTS = DESIGNER_MAX_ATTACHMENTS;

/** 模型看到的附件路径清单（附在用户消息正文之后，不落库、不进前端展示）。 */
const ATTACHMENT_NOTE_HEADER =
  '\n\n---\n[系统说明] 用户随本条消息上传了以下附件，文件已保存到你的工作目录（路径相对工作目录，文本用 read 读取，图片用 read_image 读取）：';

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 把附件清单渲染成给模型看的路径说明。 */
function renderAttachmentNote(attachments: DesignerAttachment[]): string {
  const lines = attachments.map((item) => `- ${item.name} → ${item.path}（${formatAttachmentSize(item.size)}）`);
  return `${ATTACHMENT_NOTE_HEADER}\n${lines.join('\n')}`;
}

/**
 * 旧版「提案 + 界面确认」流程的默认档案文案（原样保留用于一次性迁移比对）：
 * 已有库里设计师档案若仍是这三段原文，启动时自动刷新为新默认；人类改过的字段不动。
 */
const LEGACY_DESIGNER_DESCRIPTION =
  '系统的流水线设计师与管理员：与用户对话澄清需求，以提案方式搭建和优化智能体、流水线、工具与技能。';
const LEGACY_DESIGNER_RESPONSIBILITIES =
  '你代替人类用户管理整套智能体流水线系统：\n' +
  '1. 与用户对话，澄清用户想要的自动化流程、角色分工与交付物；\n' +
  '2. 设计高质量的角色定义（职责、交付要求、工作指南、工具配置）与流水线连接（任务触发提示词、交接条件）；\n' +
  '3. 以提案方式创建和优化智能体、流水线、自定义工具与技能，所有变更经用户确认后由系统执行；\n' +
  '4. 查看智能体提交的系统反馈，把有价值的反馈转化为改进提案。';
const LEGACY_DESIGNER_GUIDE =
  '先讨论后提案：需求不清时先提问澄清，方案复杂时先在回复里给出设计要点，与用户达成一致后再提交提案；' +
  '提案中的每项变更都要完整自包含、能独立执行成功；优先复用已有的智能体、工具与技能，避免重复建设；' +
  '变更生效后建议用户试运行验证，用 list_tasks / get_task 查看运行记录、用 list_feedback 收集智能体的反馈，持续迭代优化。';

/** 设计师的默认档案：仅首次创建时使用；之后它的定义由人类在智能体页维护。 */
const DESIGNER_DEFAULT_DEFINITION: AgentInput = {
  name: '流水线设计师',
  description: '系统的流水线设计师与管理员：与用户对话澄清需求、讲清设计思路，经用户认可后直接搭建和优化智能体、流水线、工具与技能。',
  responsibilities:
    '你代替人类用户管理整套智能体流水线系统：\n' +
    '1. 与用户对话，澄清用户想要的自动化流程、角色分工与交付物，有疑问就问，直到需求清晰；\n' +
    '2. 设计高质量的角色定义（职责、交付要求、工作指南、工具配置）与流水线连接（任务触发提示词、交接条件）；\n' +
    '3. 把设计思路简明讲给用户听，经用户认可后直接创建和优化智能体、流水线、自定义工具与技能，全程以对话完成；\n' +
    '4. 查看智能体提交的系统反馈，把有价值的反馈转化为改进。',
  deliverable: '',
  guide:
    '先问清楚、再讲思路、认可即动手：需求有疑问就提问澄清，需求清晰后用几句话讲出设计重点（角色分工、流转顺序、交付物、对现有系统的影响），' +
    '用户认可思路后立即执行变更，不再等任何确认操作；讲思路只讲重点，用户想深入细节会自己追问；' +
    '每项变更都要完整自包含、能独立执行成功；优先复用已有的智能体、工具与技能，避免重复建设；' +
    '变更生效后建议用户试运行验证，用 list_tasks / get_task 查看运行记录、用 list_feedback 收集智能体的反馈，持续迭代优化。',
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
  accent: '#a78bfa',
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

function toLlmMessage(message: DesignerMessage): LlmMessage {
  if (message.role === 'assistant') {
    if (message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content || null,
        toolCalls: message.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
      };
    }
    return { role: 'assistant', content: message.content };
  }
  if (message.role === 'tool') {
    return { role: 'tool', content: message.content, toolCallId: message.toolCallId ?? '', name: message.name ?? undefined };
  }
  // 用户消息：附件不进入正文落库，但发给模型时要附上路径清单，由设计师用文件工具自行读取。
  const attachments = message.meta.attachments ?? [];
  return {
    role: 'user',
    content: attachments.length > 0 ? `${message.content}${renderAttachmentNote(attachments)}` : message.content,
  };
}

/* ------------------------------------------------------------------ */
/* 上下文摘要压缩（手动「压缩上下文」按钮）                                */
/* ------------------------------------------------------------------ */

/** 单条消息进入摘要输入的字符上限（正文从宽、工具输出从严）。 */
const SUMMARY_MESSAGE_LIMITS: Record<DesignerMessage['role'], number> = {
  user: 6_000,
  assistant: 6_000,
  tool: 1_000,
};

/** 摘要输入的总体字符预算：保证总结请求本身能装进模型上下文（落选的更早内容以省略说明代替）。 */
const SUMMARY_TOTAL_CHAR_LIMIT = 240_000;

/** 前情提要正文的上限（超出截断，防止摘要本身膨胀占满上下文）。 */
export const SUMMARY_MAX_CHARS = 4_000;

/** 把「前情提要」并入系统提示词：被压缩的早段对话不再进入消息历史，改由这段提要承担背景。 */
function withSummarySection(systemPrompt: string, summary: string): string {
  const text = summary.trim();
  if (!text) return systemPrompt;
  return `${systemPrompt}\n\n## 前情提要（更早对话的要点，已压缩；细节以最近对话为准）\n${text}`;
}

/**
 * 把被压缩的消息渲染成摘要输入：从最新往回收集，保证最近的上下文完整；
 * 超出总预算的更早内容用省略说明代替（每条消息先按角色截断）。
 */
function renderDialogueForSummary(messages: DesignerMessage[]): string {
  const lines: string[] = [];
  let total = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const role =
      message.role === 'user' ? '用户' : message.role === 'assistant' ? '设计师' : `工具·${message.name ?? '未知'}`;
    const text = truncateText(message.content.trim(), SUMMARY_MESSAGE_LIMITS[message.role]) || '（无文本内容）';
    const line = `[${role}] ${text}`;
    if (lines.length > 0 && total + line.length > SUMMARY_TOTAL_CHAR_LIMIT) {
      lines.unshift('…[更早的对话因过长被省略，仅保留以上内容]…');
      break;
    }
    lines.unshift(line);
    total += line.length;
  }
  return lines.join('\n\n');
}

/** 组装摘要请求的提示词；已有前情提要时要求模型合并成一份新的自包含提要。 */
function buildSummaryPrompt(previous: string, dialogue: string): string {
  const parts = [
    '你是流水线设计师会话的摘要助手。请把下面的「待压缩对话」压缩成一份「前情提要」，它将替代这些对话，作为设计师后续对话的背景知识。',
    '要求：',
    '1. 保留：用户的目标与关键需求、双方已确认的决策与约定、重要结论与未完成事项、提到的智能体/流水线/工具/技能等对象名称、用户的偏好与限制条件。',
    '2. 舍弃：寒暄与重复内容；工具调用的原始输出只保留结论要点。',
    '3. 用简体中文分点陈述，总长不超过 600 字；只输出提要正文，不要开场白、解释或按语。',
    '4. 只依据对话内容归纳，不要补充对话中不存在的信息。',
  ];
  const previousText = previous.trim();
  if (previousText) {
    parts.push(`【已有前情提要】请把它与「待压缩对话」合并成一份新的、自包含的提要：\n${truncateText(previousText, SUMMARY_MAX_CHARS)}`);
  }
  parts.push(`【待压缩对话】\n${dialogue}`);
  return parts.join('\n');
}

/**
 * 规划一次摘要压缩应丢弃的消息条数（从最老的用户轮次组开始，与自动压缩同一算法）：
 * 用「上次实测 token 用量」按相对成本折算当前载荷的预估用量（knownTokens'），
 * 再复用 planHistoryCompression 判断是否超水位。无实测锚点时返回 0（发过消息才有真值）。
 *
 * @param anchor.measuredCost 上次实测请求的载荷相对成本（系统提示词 + 该次实际包含的消息），
 *                            由 runLoop 在写入用量时以 meta.compactedSeq 留档还原。
 */
export function planDesignerCompression(options: {
  history: LlmMessage[];
  systemPrompt: string;
  anchor: { tokens: number; measuredCost: number } | null;
  currentCost: number;
  maxContextTokens: number;
}): number {
  const { history, systemPrompt, anchor, currentCost, maxContextTokens } = options;
  if (!anchor || anchor.tokens <= 0 || history.length === 0 || currentCost <= 0) return 0;
  const knownTokens = Math.round(anchor.tokens * (currentCost / Math.max(1, anchor.measuredCost)));
  return planHistoryCompression({
    history,
    systemPrompt,
    knownTokens,
    thresholdTokens: maxContextTokens * CONTEXT_COMPRESS_RATIO,
  });
}

/** 压缩规划的输入输出：发给模型的 history、带提要的系统提示词、成本与实测锚点。 */
interface CompressionContext {
  history: LlmMessage[];
  systemPrompt: string;
  currentCost: number;
  anchor: { tokens: number; measuredCost: number } | null;
}

/**
 * 组装压缩规划的上下文：按压缩水位过滤历史、注入前情提要，并还原「上次实测请求」的
 * 载荷成本。上次载荷 = 系统提示词 + 该次请求实际包含的消息（seq ≤ 用量消息 seq 且
 * > 当时的压缩水位）；旧数据没有留档时按 0 处理，方向是高估上次载荷 → 少压不误删。
 */
function buildCompressionContext(options: {
  stored: DesignerMessage[];
  compactedSeq: number;
  summary: string;
  systemPromptBase: string;
}): CompressionContext {
  const { stored, compactedSeq, summary, systemPromptBase } = options;
  const systemPrompt = withSummarySection(systemPromptBase, summary);
  const history = stored.filter((message) => message.seq > compactedSeq).map(toLlmMessage);
  const systemCost = messageCost({ role: 'system', content: systemPrompt });
  const currentCost = systemCost + history.reduce((sum, message) => sum + messageCost(message), 0);

  let anchor: { tokens: number; measuredCost: number } | null = null;
  for (let index = stored.length - 1; index >= 0; index -= 1) {
    const usage = stored[index].meta.usage;
    if (!usage) continue;
    const tokens = usage.promptTokens + usage.completionTokens;
    if (tokens <= 0) break;
    const compactedAtMeasure = stored[index].meta.compactedSeq ?? 0;
    const measured = stored.filter(
      (message) => message.seq <= stored[index].seq && message.seq > compactedAtMeasure,
    );
    if (measured.length === 0) break;
    const measuredCost =
      systemCost + measured.map(toLlmMessage).reduce((sum, message) => sum + messageCost(message), 0);
    anchor = { tokens, measuredCost };
    break;
  }
  return { history, systemPrompt, currentCost, anchor };
}

function requireString(value: unknown, field: string, max: number): string {
  const text = String(value ?? '').trim();
  if (!text) throw new AppError(400, `缺少 ${field}`);
  return truncateText(text, max);
}

function optionalString(value: unknown, max: number): string {
  return typeof value === 'string' ? truncateText(value.trim(), max) : '';
}

/**
 * 智能体负载里的技能与自定义工具引用兼容「名称或 id」：
 * 应用变更前统一解析成 id（store 层按 id 校验存在性）。
 */
function normalizeAgentInput<T extends Partial<AgentInput>>(store: Store, input: T): T {
  const skillIds = Array.isArray(input.skillIds)
    ? input.skillIds.map((ref) => {
        if (typeof ref !== 'string') return ref;
        const byId = store.getSkill(ref);
        if (byId) return byId.id;
        const byName = store
          .listSkills()
          .find((skill) => skill.name.toLowerCase() === ref.toLowerCase());
        if (!byName) throw new AppError(404, `智能体引用的技能「${ref}」不存在`);
        return byName.id;
      })
    : undefined;
  const custom = input.tools && Array.isArray(input.tools.custom)
    ? input.tools.custom.map((ref) => {
        const byId = store.getCustomTool(ref);
        if (byId) return byId.id;
        const byName = store.listCustomTools().find((tool) => tool.name === ref);
        if (!byName) throw new AppError(404, `智能体引用的自定义工具「${ref}」不存在`);
        return byName.id;
      })
    : undefined;
  return {
    ...input,
    ...(skillIds ? { skillIds } : {}),
    ...(input.tools || custom ? { tools: { ...input.tools, ...(custom ? { custom } : {}) } } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* system prompt                                                       */
/* ------------------------------------------------------------------ */

/**
 * 设计师的系统提示词：与流水线智能体不同，它没有任务工作区与交接关系，
 * 取而代之的是系统清单（全局视角）、变更规则与系统级工作目录。
 */
export function assembleDesignerSystemPrompt(store: Store, agent: Agent, workspaceDir: string): string {
  const agents = store.listAgents().filter((item) => item.slug !== DESIGNER_SLUG);
  const pipelines = store.listPipelines();
  const tools = store.listCustomTools();
  const skills = store.listSkills();
  const openFeedback = store.countOpenFeedback();

  const inventory: string[] = [];
  if (agents.length === 0) {
    inventory.push('- 智能体：还没有，系统里只有你自己。');
  } else {
    inventory.push(`## 智能体（${agents.length}）`);
    for (const agent of agents) {
      inventory.push(`- ${agent.name}：${agent.description || '（无描述）'}`);
    }
  }
  if (pipelines.length === 0) {
    inventory.push('- 流水线：还没有。');
  } else {
    inventory.push(`## 流水线（${pipelines.length}）`);
    for (const pipeline of pipelines) {
      const flow = bfsNodeOrder(pipeline)
        .map((node) => store.getAgent(node.agentId)?.name ?? '（已删除）')
        .join(' → ');
      inventory.push(`- ${pipeline.name}：${flow}${pipeline.description ? ` ｜ ${pipeline.description}` : ''}`);
    }
  }
  if (tools.length === 0) {
    inventory.push('- 自定义工具：还没有（内置工具见下方规则，不可修改）。');
  } else {
    inventory.push(`## 自定义工具（${tools.length}）`);
    for (const tool of tools) {
      inventory.push(`- ${tool.name}：${tool.description || '（无描述）'}`);
    }
  }
  if (skills.length === 0) {
    inventory.push('- 技能：还没有。');
  } else {
    inventory.push(`## 技能（${skills.length}）`);
    for (const skill of skills) {
      inventory.push(`- ${skill.name}：${skill.description || '（无描述）'}`);
    }
  }
  inventory.push(`## 待处理反馈：${openFeedback} 条（用 list_feedback 查看详情）`);

  const responsibilities = agent.responsibilities.trim() || DESIGNER_DEFAULT_DEFINITION.responsibilities!;

  return [
    `你是「${agent.name}」，这套单机智能体流水线系统的流水线设计师与系统管理员，代替人类用户管理整个系统。`,
    '',
    '# 职责',
    responsibilities,
    agent.guide.trim() ? `\n# 工作方式\n${agent.guide.trim()}` : '',
    '',
    '# 系统现状（全局视角，详情可用工具查看）',
    ...inventory,
    '',
    '# 任务型智能体的工作模式（你设计的对象）',
    '- 一个环节 = 一次独立运行：智能体每次接手都是一个全新会话，环节之间没有记忆，信息只能靠「交接文件夹 + 触发提示词」传递。不要指望下游知道上游没写出来的东西。',
    '- 每个智能体在一个任务内拥有独立工作区：inbox\\ 下是它的全部输入（user\\ 子目录是用户投放的文件，上游交付按发送方分子目录），产出建议放 output\\；交接对象看不到它未交接的目录。',
    '- 交付方式只有一种：调用 handoff 交接一个文件夹（整目录复制给下游，同名自动加 -v2 后缀、绝不覆盖）；要向下游说明的内容写成交接目录里的 README.md；终点环节的交付文件夹进入任务 final\\ 目录，由用户验收。',
    '- 工具：内置工具（文件、Shell、联网、handoff、submit_feedback 等）由系统统一授予所有任务型智能体，不需要也不能按环节裁剪；load_skill 只在为智能体配置了技能时出现。handoff 是环节间交接专用工具，只有任务环节才有。你只需按需为智能体挑选自定义工具与技能，让它们充分发挥能力。',
    '- 模型参数（model、temperature）可按智能体覆盖，不填用全局默认。',
    '- 运行时系统会自动注入：流水线定位与上下游、本环节出边的交接条件、任务工作区路径、工具与技能清单。职责、交付要求与指南里不要重复这些内容，写了也是冗余。',
    '',
    '# 流水线的运作方式',
    '- 启动：用户在「任务」页选择一条流水线、填写任务描述（可上传输入文件）后发起；任务原文直接作为起点环节的第一条用户消息。同一时间系统只允许一个活动任务。',
    '- 推进：某环节调用 handoff 后，系统把交付目录整目录复制到下游工作区 inbox\\<发送方slug>\\ 下，再把该连线上的「任务触发提示词」替换占位符后作为下游的第一条用户消息并自动启动它。占位符：{deliverables}=交付目录在下游工作区的路径、{task}=任务原文、{sender}=上游名称。',
    '- 分支：节点有多条出边时，每条出边的交接条件会注入该节点的系统提示词，由它判断后用 handoff 的 target 指定交给谁；没有合适交接对象时它应不交接并如实说明卡点。',
    '- 异常：环节执行失败、没有产生有效交接或被中断时，任务暂停停在该环节，用户可以「重试本环节」（可附补充指示）或终止任务；终点环节交付后任务进入等待验收，由用户确认完成或重试。',
    '- 约束：任务启动时固化流水线快照，之后修改流水线不影响进行中与历史任务；单任务最多 200 个环节（防循环）；不支持并行分支，返工靠把连线指回上游实现。',
    '- 图校验（变更被拒的常见原因，提交前自查）：恰好一个显式起点；所有节点从起点可达；至少一个终点（无出线节点）；每条连线必填触发提示词；多出边节点的每条出边必填交接条件；同一智能体在一条流水线内只能出现一次；最多 30 个节点、300 条连线；你自己不能作为流水线节点。',
    '',
    '# 试运行与迭代',
    '- 试运行由用户在「任务」页发起：你不能自己启动任务，也不要声称已经替用户验证过流水线；设计完成后应主动建议用户试运行。',
    '- 用户试运行后，用 list_tasks 查看任务与状态，用 get_task 复盘环节链路、每环节的输入/输出/交接与错误（必要时给 get_task 传 turn_id 细看某环节的系统提示词与消息记录），据此向用户说明问题并给出修正思路。',
    '- 反馈闭环：智能体干活时会把踩过的坑与建议通过 submit_feedback 提交上来；用 list_feedback 读取（传 id 可看全文），把有价值的转成改进思路，与用户达成一致后直接执行，处理完用 resolve_feedback 关闭，保持待处理清单干净。',
    '- 迭代节奏：小步修改（一次聚焦一个环节或一条连线）→ 请用户再跑一次试运行 → 根据运行记录确认收敛后再继续。智能体可能被多条流水线复用，修改它会同时影响所有引用它的流水线。',
    '',
    '# 设计要领',
    '- 职责单一、粒度适中：一个环节一个角色；环节太碎交接成本高，太粗单次跑不完。职责里写清「输入从哪读、产出放哪、做到什么程度」。',
    '- 触发提示词是下游收到的唯一指令，要写成完整的任务书：背景、要做什么、从 {deliverables} 读什么、产出什么；并提醒下游先查看自己的 inbox\\。',
    '- 交接条件写「什么情况下交给谁」：可判定、分支之间互斥、合并起来覆盖全部情况。',
    '- 交付要求写清形式与验收标准（文件格式、命名、放哪个目录），终点环节要面向「用户验收」来写；默认约定产出放 output\\ 并附 README.md。',
    '',
    '# 工作规则',
    '1. 与用户的协作全程以对话完成，用户不需要点击任何确认按钮。节奏是：需求有疑问就先提问澄清（一次把关键问题问完：分工、顺序、交付物、边界），需求清晰后先简明讲出设计思路（角色分工、流转顺序、交付物、对现有系统的影响，只讲重点，用户想深入细节会自己追问），用户认可思路后立即调用 apply_changes 执行。',
    '2. 用户没有认可思路之前不要调用 apply_changes；用户对思路提出异议或补充时，先调整思路、重新讲给用户听，达成一致后再执行。执行成功后向用户简要汇报结果并建议试运行；不要在用户认可前声称变更已生效。',
    '3. 一次变更聚焦一个目标。每项变更必须完整自包含：创建智能体时写全职责、交付要求与工作指南；创建流水线时为每条连线写好任务触发提示词，多出边的节点为每条出边写清交接条件。',
    '4. update_pipeline 是整图替换：先 get_pipeline 查看现状，再提交完整的新图（所有节点与连线），不要只提交增量。',
    '5. 流水线的 nodes 中 agentId 字段可以直接填智能体名称；连线 from/to 填节点 id；没有起点标记或不可达、缺触发提示词的变更会被系统拒绝。',
    '6. 任务型智能体的内置工具（bash、pwsh、read、write、edit、glob、grep、list_dir、read_image、web_search、web_fetch、handoff、load_skill、submit_feedback）由系统统一授予，不可裁剪也不可修改；其中 handoff 是流水线环节专用的交接工具，只注入给任务环节，你没有也不需要它。智能体档案里的内置工具开关字段已不生效（保留仅为兼容）。你只能通过 apply_changes 管理自定义工具与技能。',
    '7. 不能通过 apply_changes 修改或删除你自己（流水线设计师）；你的定义由人类维护。',
    '8. 查看详情用 get_agent / get_pipeline / get_skill / get_custom_tool / list_feedback；引用已有对象时变更里用名称字段（agentName、pipelineName、toolName、skillName）。同一变更内「先创建、后引用」按变更顺序解析：后项可以直接引用前项新建的技能、智能体、工具或流水线；引用只能指向系统已有对象或前序变更创建的对象，不要引用后序才创建的对象，也不要在同一变更里先创建又删除同一对象。',
    '9. apply_changes 按顺序执行：某项失败时，前面已成功的项保持生效，系统会返回错误信息与已生效清单；向用户如实说明进度，修正失败项后把剩余部分作为新的 apply_changes 重新执行，不要声称失败项已生效。',
    '10. 变更规模限制：一次最多 20 项变更；智能体名称 1-40 字符且全局唯一，一句话描述不超过 300 字符；自定义工具名以小写字母开头（只能含小写字母、数字、下划线）；职责、交付要求、工作指南、触发提示词、交接条件均不超过 2 万字符。',
    '',
    '# 工作区',
    `- 你的专属工作目录（系统级、跨会话持久，不属于任何任务）：${workspaceDir}`,
    '- 文件工具的相对路径以它为基准。可用来写设计草稿、方案对比、系统改进清单等；这里的内容不会交付给任务流水线。',
    '- 任务运行产物不在你的工作区里：它们在 workspaces\\tasks\\<任务ID>\\ 下（input\\ 用户输入、final\\ 终点交付、<智能体slug>\\ 各环节工作区）。用文件工具传绝对路径可以直接查看，但任务的结构化记录请用 list_tasks / get_task。',
    '',
    '# 环境信息',
    `- 操作系统：${process.platform}`,
    `- 当前时间：${nowIso()}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* change application                                                  */
/* ------------------------------------------------------------------ */

function assertNotDesigner(agent: Agent): void {
  if (agent.slug === DESIGNER_SLUG) {
    throw new AppError(409, '不能通过 apply_changes 修改或删除「流水线设计师」自己');
  }
}

function resolveAgentRef(store: Store, ref: { agentId?: string; agentName?: string }, action: string): Agent {
  const byId = ref.agentId ? store.getAgent(ref.agentId) : null;
  if (byId) return byId;
  const name = (ref.agentName ?? ref.agentId ?? '').trim();
  const byName = store.getAgentByName(name);
  if (byName) return byName;
  throw new AppError(404, `找不到要${action}的智能体「${name || ref.agentId || '未指定'}」`);
}

function resolvePipelineRef(store: Store, ref: { pipelineId?: string; pipelineName?: string }): Pipeline {
  const byId = ref.pipelineId ? store.getPipeline(ref.pipelineId) : null;
  if (byId) return byId;
  const name = (ref.pipelineName ?? ref.pipelineId ?? '').trim();
  const byName = store
    .listPipelines()
    .find((pipeline) => pipeline.name.toLowerCase() === name.toLowerCase());
  if (byName) return byName;
  throw new AppError(404, `找不到要操作的流水线「${name || ref.pipelineId || '未指定'}」`);
}

function resolveToolRef(store: Store, ref: { toolId?: string; toolName?: string }): CustomTool {
  const byId = ref.toolId ? store.getCustomTool(ref.toolId) : null;
  if (byId) return byId;
  const name = (ref.toolName ?? ref.toolId ?? '').trim();
  const byName = store
    .listCustomTools()
    .find((tool) => tool.name.toLowerCase() === name.toLowerCase());
  if (byName) return byName;
  throw new AppError(404, `找不到要操作的自定义工具「${name || ref.toolId || '未指定'}」`);
}

function resolveSkillRef(store: Store, ref: { skillId?: string; skillName?: string }): Skill {
  const byId = ref.skillId ? store.getSkill(ref.skillId) : null;
  if (byId) return byId;
  const name = (ref.skillName ?? ref.skillId ?? '').trim();
  const byName = store
    .listSkills()
    .find((skill) => skill.name.toLowerCase() === name.toLowerCase());
  if (byName) return byName;
  throw new AppError(404, `找不到要操作的技能「${name || ref.skillId || '未指定'}」`);
}

/** 流水线 nodes 的 agentId 字段兼容智能体名称：应用变更前统一解析成真实 id。 */
function resolvePipelineInput(store: Store, input: PipelineInput): PipelineInput {
  return {
    ...input,
    nodes: (Array.isArray(input.nodes) ? input.nodes : []).map((node, index) => {
      const ref = String(node?.agentId ?? '').trim();
      const agent = store.getAgent(ref) ?? store.getAgentByName(ref);
      if (!agent) {
        throw new AppError(404, `流水线第 ${index + 1} 个节点找不到智能体「${ref || '未指定'}」`);
      }
      return { ...node, agentId: agent.id };
    }),
  };
}

/** 执行变更里的一项变更，返回给用户的执行结果说明。原样抛出 AppError。 */
export function applyChangeOp(store: Store, change: DesignerChangeOp): string {
  switch (change.op) {
    case 'create_agent': {
      const created = store.createAgent(normalizeAgentInput(store, change.agent));
      return `已创建智能体「${created.name}」`;
    }
    case 'update_agent': {
      const agent = resolveAgentRef(store, change, '修改');
      assertNotDesigner(agent);
      const updated = store.updateAgent(agent.id, normalizeAgentInput(store, change.agent));
      return `已更新智能体「${updated.name}」`;
    }
    case 'delete_agent': {
      const agent = resolveAgentRef(store, change, '删除');
      assertNotDesigner(agent);
      store.deleteAgent(agent.id);
      return `已删除智能体「${agent.name}」`;
    }
    case 'create_pipeline': {
      const created = store.createPipeline(resolvePipelineInput(store, change.pipeline));
      return `已创建流水线「${created.name}」（${created.nodes.length} 个节点）`;
    }
    case 'update_pipeline': {
      const existing = resolvePipelineRef(store, change);
      const updated = store.updatePipeline(existing.id, resolvePipelineInput(store, change.pipeline));
      return `已更新流水线「${updated.name}」（${updated.nodes.length} 个节点）`;
    }
    case 'delete_pipeline': {
      const existing = resolvePipelineRef(store, change);
      store.deletePipeline(existing.id);
      return `已删除流水线「${existing.name}」`;
    }
    case 'create_tool': {
      assertValidToolCode(String(change.tool.code ?? ''));
      assertValidToolSchema(change.tool.parameters ?? { type: 'object', properties: {} });
      const created = store.createTool(change.tool);
      return `已创建自定义工具「${created.name}」`;
    }
    case 'update_tool': {
      const existing = resolveToolRef(store, change);
      if (change.tool.code !== undefined) assertValidToolCode(String(change.tool.code));
      if (change.tool.parameters !== undefined) assertValidToolSchema(change.tool.parameters);
      const updated = store.updateTool(existing.id, change.tool);
      return `已更新自定义工具「${updated.name}」`;
    }
    case 'delete_tool': {
      const existing = resolveToolRef(store, change);
      store.deleteTool(existing.id);
      return `已删除自定义工具「${existing.name}」`;
    }
    case 'create_skill': {
      const created = store.createSkill(change.skill);
      return `已创建技能「${created.name}」`;
    }
    case 'update_skill': {
      const existing = resolveSkillRef(store, change);
      const updated = store.updateSkill(existing.id, change.skill);
      return `已更新技能「${updated.name}」`;
    }
    case 'delete_skill': {
      const existing = resolveSkillRef(store, change);
      store.deleteSkill(existing.id);
      return `已删除技能「${existing.name}」`;
    }
    default:
      throw new AppError(400, `未知的变更类型：${JSON.stringify(change)}`);
  }
}

/* ------------------------------------------------------------------ */
/* designer-only tools                                                 */
/* ------------------------------------------------------------------ */

const APPLY_CHANGES_DESCRIPTION =
  '应用一次结构化变更（新建/修改/删除智能体、流水线、自定义工具、技能），按顺序立即执行、马上生效，用户无需再点任何确认按钮。' +
  '调用前提：需求已澄清、设计思路已经用户认可；用户还没认可思路时不要调用。' +
  'changes 每一项的结构见参数 schema（按 op 判别的 12 种变更）。' +
  '引用已有对象一律用名称字段（agentName / pipelineName / toolName / skillName）；' +
  '同一变更内「先创建、后引用」按变更顺序解析，可以直接引用前序变更创建的对象，但不要引用后序才创建的对象、也不要先创建又删除同一对象；' +
  '不能对流水线设计师自己发起变更；update_pipeline 是整图替换，先 get_pipeline 查看现状再提交完整新图。' +
  '部分失败时已成功的项保持生效，工具结果会说明失败原因与已生效清单。';

/** 智能体定义的参数描述（create_agent 全量必填 name，update_agent 全部可选，避免两份重复）。 */
const AGENT_FIELDS_PROPERTIES: Record<string, unknown> = {
  name: { type: 'string', description: '智能体名称（必填，全局唯一）' },
  description: { type: 'string', description: '一句话描述' },
  responsibilities: { type: 'string', description: '任务说明：要做哪些事、做到什么程度' },
  deliverable: { type: 'string', description: '交付要求：交付什么、以什么形式；留空输出默认说明' },
  guide: { type: 'string', description: '工作指南：工作方法与思考方式' },
  model: { type: ['string', 'null'], description: '覆盖模型名；留空用全局默认' },
  temperature: { type: ['number', 'null'], description: '覆盖温度（0-2）' },
  tools: {
    type: 'object',
    description: '工具配置（内置工具由系统统一授予所有智能体，builtin 字段已不生效，仅为兼容保留）',
    properties: {
      builtin: { type: 'array', items: { type: 'string' }, description: '（已不生效）内置工具由系统统一授予，无需配置' },
      custom: { type: 'array', items: { type: 'string' }, description: '启用的自定义工具名列表，按需挑选' },
    },
  },
  skillIds: { type: 'array', items: { type: 'string' }, description: '启用的技能（名称或 id）列表' },
  accent: { type: 'string', description: '头像色，#RRGGBB' },
};

/** 一个操作分支的快捷构造：op 常量 + 属性 + 必填项（用 const 保证 oneOf 可按 op 判别）。 */
function changeBranch(op: string, opLabel: string, properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: { op: { const: op, description: opLabel }, ...properties },
    required: ['op', ...required],
  };
}

const REF_AGENT = {
  agentId: { type: 'string', description: '智能体 id（与 agentName 二选一）' },
  agentName: { type: 'string', description: '智能体名称（与 agentId 二选一）' },
};
const REF_PIPELINE = {
  pipelineId: { type: 'string', description: '流水线 id（与 pipelineName 二选一）' },
  pipelineName: { type: 'string', description: '流水线名称（与 pipelineId 二选一）' },
};
const REF_TOOL = {
  toolId: { type: 'string', description: '自定义工具 id（与 toolName 二选一）' },
  toolName: { type: 'string', description: '自定义工具名称（与 toolId 二选一）' },
};
const REF_SKILL = {
  skillId: { type: 'string', description: '技能 id（与 skillName 二选一）' },
  skillName: { type: 'string', description: '技能名称（与 skillId 二选一）' },
};

/** apply_changes 的 changes 数组项：12 种变更操作的结构定义（工具描述只讲用途，参数细节统一写在这里）。 */
const PROPOSE_CHANGE_ITEM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description: '一项变更操作，按 op 字段判别类型；字段细节见各分支 schema',
  oneOf: [
    changeBranch('create_agent', '新建智能体', {
      agent: {
        type: 'object',
        description: '新智能体的完整定义',
        properties: AGENT_FIELDS_PROPERTIES,
        required: ['name'],
      },
    }, ['agent']),
    changeBranch('update_agent', '修改智能体（只覆盖 agent 里给出的字段）', {
      ...REF_AGENT,
      agent: {
        type: 'object',
        description: '要覆盖的字段（结构同 create_agent 的 agent，全部可选）',
        properties: AGENT_FIELDS_PROPERTIES,
      },
    }, ['agent']),
    changeBranch('delete_agent', '删除智能体', { ...REF_AGENT }, []),
    changeBranch('create_pipeline', '新建流水线', {
      pipeline: {
        type: 'object',
        description: '新流水线的完整定义',
        properties: {
          name: { type: 'string', description: '流水线名称（必填，全局唯一）' },
          description: { type: 'string', description: '简介' },
          nodes: {
            type: 'array',
            description: '节点（节点即智能体，同一条流水线内每个智能体最多出现一次）',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '节点 id（留空由服务端生成；连线用）' },
                agentId: { type: 'string', description: '智能体名称或 id（必填）' },
                isStart: { type: 'boolean', description: '是否起点；全流水线恰好一个起点' },
                x: { type: 'number', description: '画布横坐标' },
                y: { type: 'number', description: '画布纵坐标' },
              },
              required: ['agentId'],
            },
          },
          edges: {
            type: 'array',
            description: '连线（交接规则）；终点节点 = 没有出线',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string', description: '源节点 id（必填）' },
                to: { type: 'string', description: '目标节点 id（必填）' },
                triggerPrompt: { type: 'string', description: '任务触发提示词（必填），支持占位符 {deliverables} / {task} / {sender}' },
                handoffCondition: { type: 'string', description: '交接条件；源节点有多条出边时每条出边必填' },
              },
              required: ['from', 'to', 'triggerPrompt'],
            },
          },
        },
        required: ['name', 'nodes'],
      },
    }, ['pipeline']),
    changeBranch('update_pipeline', '更新流水线（整图替换：pipeline 必须是包含所有节点与连线的完整新图）', {
      ...REF_PIPELINE,
      pipeline: { type: 'object', description: '完整新图（结构同 create_pipeline 的 pipeline）' },
    }, ['pipeline']),
    changeBranch('delete_pipeline', '删除流水线', { ...REF_PIPELINE }, []),
    changeBranch('create_tool', '新建自定义工具', {
      tool: {
        type: 'object',
        description: '新工具的完整定义',
        properties: {
          name: { type: 'string', description: '工具名：小写字母开头，只能含小写字母、数字、下划线' },
          description: { type: 'string', description: '工具用途说明（给模型看）' },
          parameters: { type: 'object', description: '参数定义（JSON Schema 对象）' },
          code: { type: 'string', description: '工具实现：以 async (args, ctx) => {...} 形式的函数体字符串' },
        },
        required: ['name', 'description', 'parameters', 'code'],
      },
    }, ['tool']),
    changeBranch('update_tool', '修改自定义工具（只覆盖 tool 里给出的字段）', {
      ...REF_TOOL,
      tool: { type: 'object', description: '要覆盖的字段（结构同 create_tool 的 tool，均可选）' },
    }, ['tool']),
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
    changeBranch('update_skill', '修改技能（只覆盖 skill 里给出的字段）', {
      ...REF_SKILL,
      skill: { type: 'object', description: '要覆盖的字段（结构同 create_skill 的 skill，均可选）' },
    }, ['skill']),
    changeBranch('delete_skill', '删除技能', { ...REF_SKILL }, []),
  ],
};

interface DesignerToolDeps {
  store: Store;
  sessionId: string;
  /** 当前回合里触发工具调用的助手消息 id：变更与卡片渲染位置的关联。 */
  link: { messageId: string | null };
  publish: (event: Omit<RealtimeEvent, 'at'>) => void;
}

/** 设计师专属工具的展示元数据（详情页用；与实际注册进模型的工具同源）。 */
export interface DesignerToolMeta {
  name: string;
  description: string;
}

/** metas 传入时同步登记每个工具的名称与描述，供详情展示复用，避免两处维护。 */
function makeDesignerTools(deps: DesignerToolDeps, metas?: DesignerToolMeta[]): ResolvedTool[] {
  const { store } = deps;
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
    '按名称（或 id）查看一个智能体的完整定义：职责、交付要求、工作指南、模型参数、启用的工具与技能、被哪些流水线使用。',
    {
      type: 'object',
      properties: { name: { type: 'string', description: '智能体名称或 id' } },
      required: ['name'],
    },
    (args) => {
      const agent = resolveAgentRef(store, { agentName: String(args.name ?? '') }, '查看');
      const builtin = agent.tools.builtin.join('、') || '（无）';
      const customNames = agent.tools.custom
        .map((id) => store.getCustomTool(id)?.name ?? id)
        .join('、') || '（无）';
      const skillNames = store
        .getSkillsByIds(agent.skillIds)
        .map((skill) => skill.name)
        .join('、') || '（无）';
      const usedIn = store
        .listPipelines()
        .filter((pipeline) => pipeline.nodes.some((node) => node.agentId === agent.id))
        .map((pipeline) => pipeline.name)
        .join('、');
      return [
        `# 智能体：${agent.name}`,
        `- 一句话描述：${agent.description || '（无）'}`,
        `- 任务说明：${agent.responsibilities || '（无）'}`,
        `- 交付要求：${agent.deliverable || '（无，运行时输出默认说明）'}`,
        `- 工作指南：${agent.guide || '（无）'}`,
        `- 模型：${agent.model ?? '（用全局默认）'}；温度：${agent.temperature ?? '（用全局默认）'}`,
        `- 内置工具：${builtin}`,
        `- 自定义工具：${customNames}`,
        `- 技能：${skillNames}`,
        usedIn ? `- 被流水线使用：${usedIn}` : '- 被流水线使用：暂无',
      ].join('\n');
    },
  );

  add(
    'get_pipeline',
    '按名称（或 id）查看一条流水线的完整定义：节点与起点、连线及其任务触发提示词、交接条件。修改流水线前必须先查看现状。',
    {
      type: 'object',
      properties: { name: { type: 'string', description: '流水线名称或 id' } },
      required: ['name'],
    },
    (args) => {
      const pipeline = resolvePipelineRef(store, { pipelineName: String(args.name ?? '') });
      const lines = [
        `# 流水线：${pipeline.name}`,
        pipeline.description ? `- 简介：${pipeline.description}` : '- 简介：（无）',
        `- 流转（按起点 BFS 顺序）：${bfsNodeOrder(pipeline)
          .map((node) => store.getAgent(node.agentId)?.name ?? '（已删除）')
          .join(' → ')}`,
        '- 节点：',
        ...pipeline.nodes.map(
          (node) =>
            `  - id=${node.id} ｜ ${store.getAgent(node.agentId)?.name ?? '（已删除）'}${
              node.isStart ? ' ｜ 起点' : ''
            }`,
        ),
        '- 连线：',
        ...(pipeline.edges.length === 0
          ? ['  （无连线：单节点流水线，终点即唯一节点）']
          : pipeline.edges.map(
              (edge, index) =>
                `  ${index + 1}. ${edge.from} → ${edge.to} ｜ 触发提示词：${edge.triggerPrompt}${
                  edge.handoffCondition ? ` ｜ 交接条件：${edge.handoffCondition}` : ''
                }`,
            )),
      ];
      return lines.join('\n');
    },
  );

  add(
    'get_skill',
    '按名称（或 id）查看一个技能的说明与文件清单（含 SKILL.md 正文），判断是否复用于新方案。',
    {
      type: 'object',
      properties: { name: { type: 'string', description: '技能名称或 id' } },
      required: ['name'],
    },
    (args) => {
      const skill = resolveSkillRef(store, { skillName: String(args.name ?? '') });
      const files =
        skill.files.length === 0
          ? '- 文件：（只有 SKILL.md）'
          : [
              `- 文件（${skill.files.length} 个）：`,
              ...skill.files.map(
                (file) => `  - ${file.path}（${file.script ? '脚本' : file.text ? '文本' : '二进制'}，${file.size} 字节）`,
              ),
            ];
      return [
        `# 技能：${skill.name}`,
        `- 描述：${skill.description || '（无）'}`,
        `- SKILL.md 正文：\n${truncateText(skill.content, 20_000)}`,
        ...files,
      ].join('\n');
    },
  );

  add(
    'get_custom_tool',
    '按名称（或 id）查看一个自定义工具的完整定义：参数 Schema 与函数代码。',
    {
      type: 'object',
      properties: { name: { type: 'string', description: '自定义工具名称或 id' } },
      required: ['name'],
    },
    (args) => {
      const tool = resolveToolRef(store, { toolName: String(args.name ?? '') });
      return [
        `# 自定义工具：${tool.name}`,
        `- 描述：${tool.description || '（无）'}`,
        `- 参数 Schema：\n${JSON.stringify(tool.parameters, null, 2)}`,
        `- 代码：\n${truncateText(tool.code, 30_000)}`,
      ].join('\n');
    },
  );

  add(
    'list_feedback',
    '查看流水线智能体提交的系统反馈（踩过的坑与改进建议），作为系统优化的输入。默认返回待处理（open）的反馈；给出 id 时返回该条反馈的完整内容与上下文快照。',
    {
      type: 'object',
      properties: {
        id: { type: 'string', description: '反馈 id（支持只写前 8 位）；给出时只返回这一条的完整内容' },
        status: { type: 'string', enum: ['open', 'resolved', 'ignored', 'all'], description: '按处理状态过滤，默认 open' },
        limit: { type: 'number', description: '最多返回条数，默认 30，最大 200' },
      },
    },
    (args) => {
      const idRef = optionalString(args.id, 40);
      if (idRef) {
        const feedback = store
          .listFeedback({ limit: 200 })
          .find((item) => item.id.startsWith(idRef));
        if (!feedback) throw new AppError(404, `找不到反馈「${idRef}」，可用列表模式先查看反馈 id`);
        const snapshot = feedback.contextSnapshot;
        return [
          `# 反馈 ${feedback.id.slice(0, 8)}（状态：${feedback.status}）`,
          `- 提交：${feedback.createdAt.slice(0, 16).replace('T', ' ')} ｜ ${feedback.agentName}${feedback.taskName ? ` @${feedback.taskName}` : ''} ｜ 分类 ${feedback.category} ｜ 严重度 ${feedback.severity}`,
          feedback.resolutionNote ? `- 处理备注：${feedback.resolutionNote}` : '- 处理备注：（无）',
          `- 内容：\n${feedback.content}`,
          ...(snapshot
            ? [
                snapshot.task ? `- 关联任务原文：${truncateText(snapshot.task, 2000)}` : '',
                snapshot.turnSeq !== undefined ? `- 环节序号：${snapshot.turnSeq}` : '',
                ...(snapshot.messages.length > 0
                  ? [
                      '- 最近上下文：',
                      ...snapshot.messages.map(
                        (message) =>
                          `  - [${message.role}] ${truncateText(message.content.replace(/\s+/g, ' ').trim(), 300)}`,
                      ),
                    ]
                  : []),
              ]
            : []),
        ]
          .filter((line) => line !== '')
          .join('\n');
      }
      const status = optionalString(args.status, 20) || 'open';
      const limit = Math.min(Math.max(Math.round(Number(args.limit ?? 30)) || 30, 1), 200);
      const items = store.listFeedback({ status: status === 'all' ? undefined : status, limit });
      if (items.length === 0) return `没有${status === 'all' ? '' : `「${status}」状态的`}反馈。`;
      return [
        `共 ${items.length} 条反馈：`,
        ...items.map((feedback) => {
          const taskPart = feedback.taskName ? ` @${feedback.taskName}` : '';
          return `- [${feedback.id.slice(0, 8)}] ${feedback.createdAt.slice(0, 10)} ${feedback.agentName}${taskPart} ｜ ${feedback.category}/${feedback.severity}/${feedback.status}\n  ${truncateText(feedback.content.replace(/\s+/g, ' ').trim(), 600)}`;
        }),
        '给出 id 参数可查看某条反馈的完整内容；处理完毕的反馈用 resolve_feedback 关闭。',
      ].join('\n');
    },
  );

  add(
    'list_tasks',
    '查看任务运行记录（按开始时间倒序）：任务描述、所属流水线、状态、进度与错误。用于了解流水线的实际运行情况，是复盘与迭代优化的入口。',
    {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多返回条数，默认 20，最大 100' },
        status: {
          type: 'string',
          enum: ['running', 'paused', 'waiting_human', 'completed', 'failed', 'aborted'],
          description: '按状态过滤，可选',
        },
      },
    },
    (args) => {
      const limit = Math.min(Math.max(Math.round(Number(args.limit ?? 20)) || 20, 1), 100);
      const status = optionalString(args.status, 30);
      const items = store
        .listTasks(200)
        .filter((task) => !status || task.status === status)
        .slice(0, limit);
      if (items.length === 0) {
        return `没有${status ? `「${status}」状态的` : ''}任务记录。流水线由用户在「任务」页发起，你不能自己启动任务。`;
      }
      return [
        `共 ${items.length} 条任务（新 → 旧）：`,
        ...items.map((task) => {
          const step = task.pipelineTotal > 0 ? ` ｜ 进度 ${task.pipelineStep}/${task.pipelineTotal}` : '';
          const agent = task.currentAgentName ? ` ｜ 当前：${task.currentAgentName}` : '';
          const error = task.error ? `\n  ⚠️ ${truncateText(task.error, 300)}` : '';
          return (
            `- [${task.id.slice(0, 8)}] ${task.createdAt.slice(0, 16).replace('T', ' ')} ｜ ${task.pipelineName || '（流水线已删除）'} ｜ ${task.status}${step}${agent} ｜ ${task.turnCount} 个环节\n` +
            `  任务：${truncateText(task.task.replace(/\s+/g, ' ').trim(), 300)}${error}`
          );
        }),
        '用 get_task 可查看某次任务的环节链路与各环节的输入输出。',
      ].join('\n');
    },
  );

  add(
    'get_task',
    '查看一次任务的完整运行记录：流水线快照与环节链路（每个环节的输入、输出、交接文件夹与错误）；给出 turn_id 可再细看该环节实际下发的系统提示词与完整消息记录。用于复盘试运行、定位问题环节。',
    {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id（可用 list_tasks 查到，支持只写前 8 位）' },
        turn_id: { type: 'string', description: '可选：环节 id（支持前缀）；给出时额外展示该环节的系统提示词与消息记录' },
      },
      required: ['id'],
    },
    (args) => {
      const idRef = String(args.id ?? '').trim();
      if (!idRef) throw new AppError(400, '缺少任务 id');
      const summary = store.listTasks(200).find((task) => task.id.startsWith(idRef));
      if (!summary) throw new AppError(404, `找不到任务「${idRef}」，可用 list_tasks 查看任务列表`);
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
        `- 流水线：${task.pipelineName}${flow ? ` ｜ ${flow}` : ''}`,
        '- 说明：本任务使用启动时的流水线快照，之后对流水线的修改不影响这条记录。',
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
    },
  );

  add(
    'resolve_feedback',
    '处理完一条反馈后关闭它：已转化为改进的标记 resolved，决定不处理的标记 ignored，可附处理备注。保持反馈清单只剩待处理项。',
    {
      type: 'object',
      properties: {
        id: { type: 'string', description: '反馈 id（可用 list_feedback 查到，支持只写前 8 位）' },
        status: { type: 'string', enum: ['resolved', 'ignored'], description: '处理结果' },
        note: { type: 'string', description: '可选：处理备注（如何处理、为什么忽略）' },
      },
      required: ['id', 'status'],
    },
    (args) => {
      const idRef = String(args.id ?? '').trim();
      const status = String(args.status ?? '').trim();
      if (!idRef) throw new AppError(400, '缺少反馈 id');
      if (status !== 'resolved' && status !== 'ignored') {
        throw new AppError(400, 'status 只能是 resolved 或 ignored');
      }
      const feedback = store.listFeedback({ limit: 200 }).find((item) => item.id.startsWith(idRef));
      if (!feedback) throw new AppError(404, `找不到反馈「${idRef}」，可用 list_feedback 查看反馈列表`);
      const note = typeof args.note === 'string' ? args.note.trim() : '';
      const updated = store.updateFeedback(feedback.id, {
        status,
        ...(note ? { resolutionNote: truncateText(note, 2000) } : {}),
      });
      return `反馈 ${updated.id.slice(0, 8)} 已标记为「${updated.status}」。`;
    },
  );

  add(
    'apply_changes',
    APPLY_CHANGES_DESCRIPTION,
    {
      type: 'object',
      properties: {
        title: { type: 'string', description: '变更标题（一句话概括这次变更）' },
        summary: { type: 'string', description: '变更说明：要达成什么、设计思路、对现有系统的影响' },
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          description: '变更清单，按顺序执行；每项结构见 items schema（按 op 判别的 12 种变更）',
          items: PROPOSE_CHANGE_ITEM_SCHEMA,
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
      if (rawChanges.length > 20) throw new AppError(400, '一次最多包含 20 项变更');

      const changes: DesignerChangeOp[] = rawChanges.map((item, index) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          throw new AppError(400, `changes[${index}] 必须是对象`);
        }
        return item as DesignerChangeOp;
      });
      validateChangeOps(store, changes);

      // 设计思路已获用户认可：立即按顺序执行，变更记录（含结果）落库展示给用户。
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

      const record = store.createDesignerProposal({
        sessionId: deps.sessionId,
        messageId: deps.link.messageId,
        title,
        summary,
        changes,
        status: failure ? 'failed' : 'applied',
        error: failure ?? undefined,
      });
      deps.publish({ type: 'designer.proposal', sessionId: deps.sessionId, proposalId: record.id });
      deps.publish({ type: 'config.updated' });
      if (failure) {
        return (
          `变更中断，已生效的部分保持生效（编号 ${record.id.slice(0, 8)}）。${failure}` +
          '请向用户如实说明已生效与失败的内容，修正后把剩余部分作为新的 apply_changes 重新执行。'
        );
      }
      return (
        `变更已全部生效（编号 ${record.id.slice(0, 8)}，共 ${applied.length} 项）：${applied.join('；')}。` +
        '向用户简要汇报结果，并建议试运行验证。'
      );
    },
  );

  return tools;
}

/* ------------------------------------------------------------------ */
/* change validation（覆盖层：支持同一变更内先创建、后引用）               */
/* ------------------------------------------------------------------ */

/** 覆盖层跟踪的实体类别。 */
type OverlayKind = 'skill' | 'agent' | 'pipeline' | 'tool';

/** create 类变更的目标实体与名称（预扫描与查重用）。 */
function createTargetOf(change: DesignerChangeOp): { kind: OverlayKind; name: string } | null {
  const pick = (value: unknown): string => String(value ?? '').trim();
  switch (change.op) {
    case 'create_skill': {
      const name = pick(change.skill?.name);
      return name ? { kind: 'skill', name } : null;
    }
    case 'create_agent': {
      const name = pick(change.agent?.name);
      return name ? { kind: 'agent', name } : null;
    }
    case 'create_pipeline': {
      const name = pick(change.pipeline?.name);
      return name ? { kind: 'pipeline', name } : null;
    }
    case 'create_tool': {
      const name = pick(change.tool?.name);
      return name ? { kind: 'tool', name } : null;
    }
    default:
      return null;
  }
}

/**
 * 变更内覆盖层：按顺序模拟变更应用，让前置校验能解析「同一变更内先创建、后引用」。
 * - 只认前序变更创建的对象（与应用阶段的顺序语义一致），后向引用会得到明确报错；
 * - 「先建后删」属于矛盾变更、「先删后引」属于悬空引用，都在校验期拦截；
 * - 墓碑同时记录 id 与名称（名称小写归一），后续引用无论用哪种写法都能识别。
 */
class ProposalOverlay {
  /** 全变更 create 预扫描：kind -> 名称(小写) -> 首次创建的变更下标，用于「后向引用」提示。 */
  private readonly creates = new Map<OverlayKind, Map<string, number>>();
  /** 待生效的创建：kind -> 名称(小写) -> 变更下标（删除后移除）。 */
  private readonly pending = new Map<OverlayKind, Map<string, number>>();
  /** 已删除墓碑：kind -> (id 或名称[小写]) -> 删除的变更下标。 */
  private readonly tombs = new Map<OverlayKind, Map<string, number>>();

  constructor(changes: DesignerChangeOp[]) {
    for (const [index, change] of changes.entries()) {
      const target = createTargetOf(change);
      if (!target) continue;
      const key = target.name.toLowerCase();
      const map = this.creates.get(target.kind) ?? new Map<string, number>();
      if (!map.has(key)) map.set(key, index);
      this.creates.set(target.kind, map);
    }
  }

  /** 对象在前序变更中被删除时返回删除下标。 */
  deletedIndex(kind: OverlayKind, refs: (string | undefined)[]): number | undefined {
    const map = this.tombs.get(kind);
    if (!map) return undefined;
    for (const ref of refs) {
      if (!ref) continue;
      const hit = map.get(ref) ?? map.get(ref.toLowerCase());
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  /** 对象由前序变更创建时返回创建下标。 */
  createdIndex(kind: OverlayKind, name: string): number | undefined {
    return this.pending.get(kind)?.get(name.toLowerCase());
  }

  /** 对象由后序变更创建时返回其下标（仅用于报错提示）。 */
  forwardIndex(kind: OverlayKind, name: string): number | undefined {
    return this.creates.get(kind)?.get(name.toLowerCase());
  }

  recordCreate(kind: OverlayKind, name: string, index: number): void {
    const map = this.pending.get(kind) ?? new Map<string, number>();
    map.set(name.toLowerCase(), index);
    this.pending.set(kind, map);
  }

  recordDelete(kind: OverlayKind, refs: (string | undefined)[], index: number): void {
    const map = this.tombs.get(kind) ?? new Map<string, number>();
    for (const ref of refs) {
      if (!ref) continue;
      map.set(ref, index);
      map.set(ref.toLowerCase(), index);
    }
    this.tombs.set(kind, map);
    const pending = this.pending.get(kind);
    if (pending) for (const ref of refs) if (ref) pending.delete(ref.toLowerCase());
  }
}

/** 在 store 里解析一个引用（id 优先、名称兜底），返回命中的对象；与各 resolve*Ref 的口径一致。 */
function getFromStore(store: Store, kind: OverlayKind, value: string): unknown {
  switch (kind) {
    case 'agent':
      return store.getAgent(value) ?? store.getAgentByName(value);
    case 'skill':
      return (
        store.getSkill(value) ??
        store.listSkills().find((skill) => skill.name.toLowerCase() === value.toLowerCase())
      );
    case 'pipeline':
      return (
        store.getPipeline(value) ??
        store.listPipelines().find((pipeline) => pipeline.name.toLowerCase() === value.toLowerCase())
      );
    case 'tool':
      return (
        store.getCustomTool(value) ??
        store.listCustomTools().find((tool) => tool.name.toLowerCase() === value.toLowerCase())
      );
    default:
      return null;
  }
}

/** 引用解析结果：store 命中（携带对象）、变更内创建，或两种失败形态（供报错提示区分）。 */
type RefLookup =
  | { status: 'store'; storeObject: unknown }
  | { status: 'proposal'; createdAtIndex: number }
  | { status: 'deleted'; deletedAtIndex: number }
  | { status: 'missing' };

/**
 * 解析一个对象引用：系统已有（未被本变更删除）或前序变更创建。
 * 不抛错，失败形态交给调用方按场景提示；名称缺省时回落到 id 字段（与应用阶段一致）。
 */
function lookupRef(
  store: Store,
  overlay: ProposalOverlay,
  kind: OverlayKind,
  refs: { id?: string; name?: string },
): RefLookup {
  const id = String(refs.id ?? '').trim();
  const name = String(refs.name ?? refs.id ?? '').trim();
  const removedAt = overlay.deletedIndex(kind, [id, name]);
  if (removedAt !== undefined) return { status: 'deleted', deletedAtIndex: removedAt };
  const inStore = (id ? getFromStore(store, kind, id) : null) ?? (name ? getFromStore(store, kind, name) : null);
  if (inStore) return { status: 'store', storeObject: inStore };
  const created = name ? overlay.createdIndex(kind, name) : undefined;
  if (created !== undefined) return { status: 'proposal', createdAtIndex: created };
  return { status: 'missing' };
}

/** 断言引用可解析，不可解析时抛出带定位提示的 404（区分「后向引用 / 已被删除 / 真不存在」）。 */
function assertRefResolvable(
  store: Store,
  overlay: ProposalOverlay,
  label: string,
  kind: OverlayKind,
  noun: string,
  refs: { id?: string; name?: string },
): RefLookup {
  const result = lookupRef(store, overlay, kind, refs);
  if (result.status === 'store' || result.status === 'proposal') return result;
  const id = String(refs.id ?? '').trim();
  const name = String(refs.name ?? refs.id ?? '').trim();
  const display = name || id || '未指定';
  if (result.status === 'deleted') {
    throw new AppError(404, `${label}: 引用的${noun}「${display}」已在本变更第 ${result.deletedAtIndex + 1} 项被删除`);
  }
  const forward = name ? overlay.forwardIndex(kind, name) : undefined;
  if (forward !== undefined) {
    throw new AppError(
      404,
      `${label}: 引用的${noun}「${display}」在本变更第 ${forward + 1} 项才创建。` +
        '同一变更内按变更顺序解析：请把创建调整到引用之前，或拆成多次变更',
    );
  }
  throw new AppError(404, `${label}: 引用的${noun}「${display}」不存在（系统与本变更前序变更中均无）`);
}

/** create 类变更的名称查重：不能与系统已有对象同名（本变更内被删除的除外），也不能与前序创建重名。 */
function assertCreateNameAvailable(
  store: Store,
  overlay: ProposalOverlay,
  label: string,
  kind: OverlayKind,
  noun: string,
  name: string,
): void {
  if (overlay.deletedIndex(kind, [name]) === undefined && getFromStore(store, kind, name)) {
    throw new AppError(409, `${label}: 已存在同名${noun}「${name}」`);
  }
  const created = overlay.createdIndex(kind, name);
  if (created !== undefined) {
    throw new AppError(409, `${label}: 与本变更第 ${created + 1} 项重复创建同名${noun}「${name}」`);
  }
}

/** 同一变更内「先创建、后删除」同一对象：矛盾变更，直接拒绝。 */
function assertNotCreateThenDelete(
  hit: RefLookup,
  label: string,
  noun: string,
  display: string,
): asserts hit is { status: 'store'; storeObject: unknown } {
  if (hit.status === 'proposal') {
    throw new AppError(
      400,
      `${label}: ${noun}「${display}」在本变更第 ${hit.createdAtIndex + 1} 项刚创建、本项又删除，属于矛盾的变更，请合并或去掉多余项`,
    );
  }
}

/** 校验流水线节点的智能体引用：agentId 兼容名称，需在 store（未被本变更删除）或前序创建中可解析。 */
function assertPipelineNodesResolvable(
  store: Store,
  overlay: ProposalOverlay,
  label: string,
  input: PipelineInput | undefined,
): void {
  const nodes = Array.isArray(input?.nodes) ? input!.nodes : [];
  for (const [nodeIndex, node] of nodes.entries()) {
    const ref = String(node?.agentId ?? '').trim();
    assertRefResolvable(store, overlay, `${label}: 流水线第 ${nodeIndex + 1} 个节点`, 'agent', '智能体', {
      id: ref,
      name: ref,
    });
  }
}

/** 校验智能体负载里的技能与自定义工具引用（兼容名称或 id，支持引用本变更前序创建的对象）。 */
function assertAgentAssetRefs(
  store: Store,
  overlay: ProposalOverlay,
  label: string,
  agent: Partial<AgentInput> | undefined,
): void {
  const skillRefs = Array.isArray(agent?.skillIds) ? agent!.skillIds! : [];
  for (const ref of skillRefs) {
    if (typeof ref !== 'string') continue;
    assertRefResolvable(store, overlay, label, 'skill', '技能', { id: ref, name: ref });
  }
  const toolRefs = Array.isArray(agent?.tools?.custom) ? agent!.tools!.custom! : [];
  for (const ref of toolRefs) {
    if (typeof ref !== 'string') continue;
    assertRefResolvable(store, overlay, label, 'tool', '自定义工具', { id: ref, name: ref });
  }
}

/**
 * 变更创建时的前置校验：按顺序模拟应用，支持「同一变更内先创建、后引用」。
 * - 引用在「store ∪ 变更覆盖层」中解析：可引用系统已有对象（未被本变更删除）或前序变更创建的对象；
 * - 同变更重名、先建后删、先删后引、后向引用都在这里拦截；
 * - 深度校验（图结构、在用对象的删除保护等）仍由应用时 store 执行。
 */
function validateChangeOps(store: Store, changes: DesignerChangeOp[]): void {
  const overlay = new ProposalOverlay(changes);
  for (const [index, change] of changes.entries()) {
    const label = `changes[${index}]`;
    switch (change.op) {
      case 'create_skill': {
        const name = String(change.skill?.name ?? '').trim();
        if (!name) throw new AppError(400, `${label}: create_skill 缺少 skill.name`);
        assertCreateNameAvailable(store, overlay, label, 'skill', '技能', name);
        overlay.recordCreate('skill', name, index);
        break;
      }
      case 'update_skill':
        assertRefResolvable(store, overlay, label, 'skill', '技能', {
          id: change.skillId,
          name: change.skillName,
        });
        break;
      case 'delete_skill': {
        const hit = assertRefResolvable(store, overlay, label, 'skill', '技能', {
          id: change.skillId,
          name: change.skillName,
        });
        assertNotCreateThenDelete(hit, label, '技能', String(change.skillName ?? change.skillId ?? ''));
        const skill = hit.storeObject as Skill;
        overlay.recordDelete('skill', [change.skillId, change.skillName, skill?.id, skill?.name], index);
        break;
      }
      case 'create_agent': {
        const name = String(change.agent?.name ?? '').trim();
        if (!name) throw new AppError(400, `${label}: create_agent 缺少 agent.name`);
        assertCreateNameAvailable(store, overlay, label, 'agent', '智能体', name);
        assertAgentAssetRefs(store, overlay, label, change.agent);
        overlay.recordCreate('agent', name, index);
        break;
      }
      case 'update_agent': {
        const hit = assertRefResolvable(store, overlay, label, 'agent', '智能体', {
          id: change.agentId,
          name: change.agentName,
        });
        if (hit.status === 'store') assertNotDesigner(hit.storeObject as Agent);
        assertAgentAssetRefs(store, overlay, label, change.agent);
        break;
      }
      case 'delete_agent': {
        const hit = assertRefResolvable(store, overlay, label, 'agent', '智能体', {
          id: change.agentId,
          name: change.agentName,
        });
        assertNotCreateThenDelete(hit, label, '智能体', String(change.agentName ?? change.agentId ?? ''));
        const agent = hit.storeObject as Agent;
        assertNotDesigner(agent);
        overlay.recordDelete('agent', [change.agentId, change.agentName, agent?.id, agent?.name], index);
        break;
      }
      case 'create_pipeline': {
        const name = String(change.pipeline?.name ?? '').trim();
        if (!name) throw new AppError(400, `${label}: create_pipeline 缺少 pipeline.name`);
        assertCreateNameAvailable(store, overlay, label, 'pipeline', '流水线', name);
        assertPipelineNodesResolvable(store, overlay, label, change.pipeline);
        overlay.recordCreate('pipeline', name, index);
        break;
      }
      case 'update_pipeline':
        assertRefResolvable(store, overlay, label, 'pipeline', '流水线', {
          id: change.pipelineId,
          name: change.pipelineName,
        });
        assertPipelineNodesResolvable(store, overlay, label, change.pipeline);
        break;
      case 'delete_pipeline': {
        const hit = assertRefResolvable(store, overlay, label, 'pipeline', '流水线', {
          id: change.pipelineId,
          name: change.pipelineName,
        });
        assertNotCreateThenDelete(hit, label, '流水线', String(change.pipelineName ?? change.pipelineId ?? ''));
        const pipeline = hit.storeObject as Pipeline;
        overlay.recordDelete('pipeline', [change.pipelineId, change.pipelineName, pipeline?.id, pipeline?.name], index);
        break;
      }
      case 'create_tool': {
        const name = String(change.tool?.name ?? '').trim();
        if (!name) throw new AppError(400, `${label}: create_tool 缺少 tool.name`);
        if (!/^[a-z][a-z0-9_]{1,40}$/.test(name)) {
          throw new AppError(400, `${label}: 工具名称需以小写字母开头，只能包含小写字母、数字和下划线`);
        }
        assertValidToolCode(String(change.tool?.code ?? ''));
        assertValidToolSchema(change.tool?.parameters ?? { type: 'object', properties: {} });
        assertCreateNameAvailable(store, overlay, label, 'tool', '自定义工具', name);
        overlay.recordCreate('tool', name, index);
        break;
      }
      case 'update_tool':
        assertRefResolvable(store, overlay, label, 'tool', '自定义工具', {
          id: change.toolId,
          name: change.toolName,
        });
        break;
      case 'delete_tool': {
        const hit = assertRefResolvable(store, overlay, label, 'tool', '自定义工具', {
          id: change.toolId,
          name: change.toolName,
        });
        assertNotCreateThenDelete(hit, label, '自定义工具', String(change.toolName ?? change.toolId ?? ''));
        const tool = hit.storeObject as CustomTool;
        overlay.recordDelete('tool', [change.toolId, change.toolName, tool?.id, tool?.name], index);
        break;
      }
      default:
        throw new AppError(400, `${label}: 未知的变更类型 ${(change as { op?: string }).op}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* runtime                                                             */
/* ------------------------------------------------------------------ */

interface DesignerBusy {
  sessionId: string;
  controller: AbortController;
}

export interface DesignerRuntimeOptions {
  store: Store;
  events: RuntimeEvents;
  providerFactory?: () => LlmProvider;
}

/**
 * 流水线设计师的运行时：与任务型 Runtime 不同，它是「对话驱动」的——
 * 没有任务、环节与交接；用户消息进来后跑一个 ReAct 循环，以文本回复结束。
 * 对系统的全部修改只能经 apply_changes 变更、用户确认后由 applyChangeOp 执行。
 */
export class DesignerRuntime {
  readonly store: Store;
  readonly events: RuntimeEvents;
  private readonly providerFactory?: () => LlmProvider;
  private busyEntry: DesignerBusy | null = null;
  /** 手动「压缩上下文」进行中：期间拒绝新消息与重复压缩。 */
  private compressing = false;

  constructor(options: DesignerRuntimeOptions) {
    this.store = options.store;
    this.events = options.events;
    this.providerFactory = options.providerFactory;
    // 启动即清理「没有对应会话」的遗留上传目录（升级迁移清空会话后的兜底）。
    this.store.purgeOrphanDesignerUploads();
  }

  /** 确保设计师智能体与系统级工作目录存在；服务启动时调用。 */
  ensureReady(): Agent {
    this.store.ensureDesignerWorkspace();
    const agent = this.store.ensureDesignerAgent(DESIGNER_DEFAULT_DEFINITION);
    // 旧版「提案 + 界面确认」流程的默认档案会误导对话式新流程：逐字段原样匹配旧默认文案，
    // 命中才刷新（人类改过的字段不动）。一次性迁移，新文案与旧默认不同后即不再触发。
    const patch: Partial<AgentInput> = {};
    if (agent.description === LEGACY_DESIGNER_DESCRIPTION) patch.description = DESIGNER_DEFAULT_DEFINITION.description;
    if (agent.responsibilities === LEGACY_DESIGNER_RESPONSIBILITIES) {
      patch.responsibilities = DESIGNER_DEFAULT_DEFINITION.responsibilities;
    }
    if (agent.guide === LEGACY_DESIGNER_GUIDE) patch.guide = DESIGNER_DEFAULT_DEFINITION.guide;
    return Object.keys(patch).length > 0 ? this.store.updateAgent(agent.id, patch) : agent;
  }

  get busy(): boolean {
    return this.busyEntry !== null;
  }

  get busySessionId(): string | null {
    return this.busyEntry?.sessionId ?? null;
  }

  listSessions(): DesignerSessionSummary[] {
    return this.store.listDesignerSessions();
  }

  createSession(title?: string): DesignerSession {
    return this.store.createDesignerSession(title);
  }

  deleteSession(id: string): DesignerSession {
    if (this.busyEntry?.sessionId === id) {
      throw new AppError(409, '设计师正在这个会话中回复，请先停止再删除');
    }
    const session = this.store.deleteDesignerSession(id);
    // 会话的上传附件随会话一起清理。
    this.store.deleteDesignerUploads(id);
    return session;
  }

  getSessionDetail(id: string): DesignerSessionDetail {
    const session = this.store.getDesignerSession(id);
    if (!session) throw new AppError(404, '会话不存在');
    return {
      session,
      messages: this.store.listDesignerMessages(id),
      proposals: this.store.listDesignerProposals(id),
      busy: this.busyEntry?.sessionId === id,
    };
  }

  /**
   * 设计师详情：实时拼装的系统提示词（含系统清单与工作规则）、实际下发给模型的工具、
   * 启用的技能与运行时信息（模型 / 思考级别 / 上下文窗口）。与模型每次请求收到的内容同源。
   */
  getProfile(): DesignerProfile {
    const agent = this.ensureReady();
    const workspace = this.store.ensureDesignerWorkspace();
    const systemPrompt = assembleDesignerSystemPrompt(this.store, agent, workspace);

    const builtinInfo = new Map(BUILTIN_TOOL_INFOS.map((info) => [info.name, info]));
    const isBuiltin = (name: string): boolean => (BUILTIN_TOOL_NAMES as readonly string[]).includes(name);
    // 生效工具 = 统一授予的内置/自定义工具（去掉流水线专用的 handoff）+ 设计师专属管理工具。
    const effective: DesignerToolInfo[] = resolveTools(this.store, agent)
      .filter((tool) => tool.spec.function.name !== 'handoff')
      .map((tool) => {
        const name = tool.spec.function.name;
        const info = builtinInfo.get(name);
        return {
          name,
          description: tool.spec.function.description,
          source: isBuiltin(name) ? ('builtin' as const) : ('custom' as const),
          ...(info ? { label: info.label, category: info.category } : {}),
        };
      });
    const metas: DesignerToolMeta[] = [];
    makeDesignerTools(
      { store: this.store, sessionId: '', link: { messageId: null }, publish: () => {} },
      metas,
    );
    const tools: DesignerToolInfo[] = [
      ...effective,
      ...metas.map((meta): DesignerToolInfo => ({ ...meta, source: 'designer' })),
    ];

    const llmConfig = this.store.getLlmConfig();
    return {
      agent,
      systemPrompt,
      tools,
      skills: this.store.getSkillsByIds(agent.skillIds),
      runtime: {
        model: agent.model || llmConfig.model,
        deepThinking: llmConfig.deepThinking,
        thinkingLevel: llmConfig.thinkingLevel,
        maxContextTokens: llmConfig.maxContextTokens,
      },
    };
  }

  /**
   * 用户发来一条消息（可携带上传附件的引用）：落库后启动 ReAct 循环（异步执行，结果经事件推送）。
   * 附件已由上传接口保存在本会话的上传目录中，这里只做路径校验并登记进消息 meta；
   * 发给模型的附件路径清单在 toLlmMessage 里渲染。
   */
  sendMessage(
    sessionId: string,
    content: string,
    attachments: { name?: string; path: string }[] = [],
  ): void {
    if (this.busyEntry) {
      throw new AppError(409, '设计师正在处理上一条消息，请等它回复完毕或先点击停止');
    }
    if (this.compressing) {
      throw new AppError(409, '正在压缩上下文，请稍候，完成后再发送消息');
    }
    const session = this.store.getDesignerSession(sessionId);
    if (!session) throw new AppError(404, '会话不存在');
    const text = String(content ?? '').trim();
    if (text.length > MAX_MESSAGE_CHARS) {
      throw new AppError(400, `消息长度不能超过 ${MAX_MESSAGE_CHARS} 个字符`);
    }
    if (!Array.isArray(attachments)) throw new AppError(400, 'attachments 必须是数组');
    if (attachments.length > MAX_MESSAGE_ATTACHMENTS) {
      throw new AppError(400, `一条消息最多携带 ${MAX_MESSAGE_ATTACHMENTS} 个附件`);
    }
    const resolved = attachments.map((ref) =>
      this.store.resolveDesignerUpload(
        sessionId,
        String(ref?.path ?? ''),
        typeof ref?.name === 'string' ? ref.name : undefined,
      ),
    );
    if (!text && resolved.length === 0) {
      throw new AppError(400, '消息内容不能为空');
    }

    const appended = this.store.appendDesignerMessage(sessionId, {
      role: 'user',
      content: text,
      meta: resolved.length > 0 ? { kind: 'turn_input', attachments: resolved } : { kind: 'turn_input' },
    });
    this.store.renameDesignerSessionFromMessage(sessionId, text);
    this.publishMessage(appended);

    const controller = new AbortController();
    this.busyEntry = { sessionId, controller };
    this.publishStatus(sessionId, '正在思考');
    void this.runLoop(sessionId, controller)
      .catch((error) => {
        this.appendErrorNote(sessionId, errorMessage(error));
      })
      .finally(() => {
        this.busyEntry = null;
        this.publishStatus(sessionId, 'idle');
      });
  }

  /** 中断正在进行的回复；没有进行中的回复时返回 false。 */
  stop(): boolean {
    if (!this.busyEntry) return false;
    this.busyEntry.controller.abort();
    return true;
  }

  /** 一键清空：中断回复并清空设计师的会话、消息、变更记录与工作目录（设计师智能体本身保留）。 */
  async resetAll(): Promise<void> {
    this.stop();
    if (this.busyEntry) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    this.store.resetDesignerData();
    this.store.resetDesignerWorkspace();
    this.events.publish({ type: 'reset' });
  }

  /* ---------------------------------------------------------------- */
  /* 单会话：压缩上下文 / 清空对话记录                                    */
  /* ---------------------------------------------------------------- */

  /** 当前唯一会话（取最近更新的一条）；还没有任何会话时返回 null。 */
  private currentSession(): DesignerSession | null {
    return this.store.listDesignerSessions()[0] ?? null;
  }

  /**
   * 清空对话记录：删除当前会话——消息、全部变更（含待确认的）随外键级联删除，
   * 该会话上传的附件一并清理；设计师工作目录里的文件与已应用的系统变更不受影响。
   * 清空后回到无会话状态，下一条消息自动创建全新会话。
   */
  clearConversation(): void {
    const session = this.currentSession();
    if (!session) return;
    if (this.busyEntry?.sessionId === session.id) {
      throw new AppError(409, '设计师正在回复，请先停止再清空对话');
    }
    this.store.deleteDesignerSession(session.id);
    this.store.deleteDesignerUploads(session.id);
    this.events.publish({ type: 'designer.session' });
  }

  /**
   * 手动压缩上下文（摘要式）：把较早的对话轮次交给模型总结成「前情提要」并落库，
   * 之后的请求只带「提要 + 未压缩的最近消息」；界面聊天记录不受影响。
   * 返回本次压缩的消息条数；0 表示当前用量未超水位、无需压缩。
   */
  async compressConversation(): Promise<{ compressed: number }> {
    if (this.busyEntry) {
      throw new AppError(409, '设计师正在回复，请等本轮结束或先停止，再压缩上下文');
    }
    if (this.compressing) {
      throw new AppError(409, '正在压缩上下文，请稍候');
    }
    const session = this.currentSession();
    if (!session) throw new AppError(404, '还没有对话，无需压缩');

    const agent = this.ensureReady();
    const workspace = this.store.ensureDesignerWorkspace();
    const stored = this.store.listDesignerMessages(session.id);
    const { history, systemPrompt, currentCost, anchor } = buildCompressionContext({
      stored,
      compactedSeq: session.compactedSeq,
      summary: session.summary,
      systemPromptBase: assembleDesignerSystemPrompt(this.store, agent, workspace),
    });
    const llmConfig = this.store.getLlmConfig();
    const dropCount = planDesignerCompression({
      history,
      systemPrompt,
      anchor,
      currentCost,
      maxContextTokens: llmConfig.maxContextTokens,
    });
    if (dropCount <= 0) return { compressed: 0 };

    // history 与「seq > 水位」的落库消息一一对应（同序映射），可据此取回被压缩的原文。
    const dropped = stored.filter((message) => message.seq > session.compactedSeq).slice(0, dropCount);
    const compactedSeq = dropped[dropped.length - 1].seq;
    if (!compactedSeq) return { compressed: 0 };

    this.compressing = true;
    this.publishStatus(session.id, '正在压缩上下文');
    try {
      const summary = await this.summarize(agent, session, session.summary, dropped);
      this.store.compactDesignerSession(session.id, { compactedSeq, summary });
      this.events.publish({ type: 'designer.session' });
      return { compressed: dropped.length };
    } finally {
      this.compressing = false;
      this.publishStatus(session.id, 'idle');
    }
  }

  /** 调用一次模型把被压缩的对话总结成「前情提要」（与对话同模型；不带工具、不流式）。 */
  private async summarize(
    agent: Agent,
    session: DesignerSession,
    previous: string,
    dropped: DesignerMessage[],
  ): Promise<string> {
    const llmConfig = this.store.getLlmConfig();
    let provider: LlmProvider;
    try {
      provider = this.providerFactory ? this.providerFactory() : createProvider(llmConfig);
    } catch (error) {
      throw new AppError(502, `压缩失败：${errorMessage(error)}`);
    }
    const prompt = buildSummaryPrompt(previous, renderDialogueForSummary(dropped));
    try {
      const response = await provider.complete({
        model: agent.model || llmConfig.model,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
        tools: [],
        meta: {
          agentName: agent.name,
          taskId: session.id,
          turnId: session.id,
          turnSeq: 0,
          nextAgentNames: [],
          terminal: true,
          iteration: 1,
        },
      });
      const summary = response.content.trim();
      if (!summary) throw new Error('模型返回了空摘要');
      return truncateText(summary, SUMMARY_MAX_CHARS);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, `压缩失败：${errorMessage(error)}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* loop                                                              */
  /* ---------------------------------------------------------------- */

  private publishStatus(sessionId: string, detail: string): void {
    this.events.publish({ type: 'designer.status', sessionId, detail });
  }

  private publishMessage(message: DesignerMessage): void {
    this.events.publish({ type: 'designer.message', sessionId: message.sessionId, messageId: message.id });
  }

  private appendMessage(sessionId: string, input: {
    role: DesignerMessage['role'];
    content: string;
    toolCalls?: LlmToolCall[];
    toolCallId?: string | null;
    name?: string | null;
    images?: AttachedImage[];
    meta?: DesignerMessage['meta'];
  }): DesignerMessage {
    const message = this.store.appendDesignerMessage(sessionId, input);
    this.publishMessage(message);
    return message;
  }

  private appendErrorNote(sessionId: string, error: string): void {
    try {
      this.appendMessage(sessionId, {
        role: 'assistant',
        content: `⚠️ 本次回复执行失败：${error}`,
        meta: { kind: 'assistant', error: true },
      });
    } catch {
      /* 数据可能已被清空 */
    }
  }

  private appendStoppedNote(sessionId: string): void {
    try {
      this.appendMessage(sessionId, {
        role: 'assistant',
        content: '（已按你的要求停止本次回复。）',
        meta: { kind: 'assistant' },
      });
    } catch {
      /* ignore */
    }
  }

  private async runLoop(sessionId: string, controller: AbortController): Promise<void> {
    const signal = controller.signal;
    const agent = this.ensureReady();
    const settings = this.store.getRuntimeSettings();
    const llmConfig = this.store.getLlmConfig();

    let provider: LlmProvider;
    try {
      provider = this.providerFactory ? this.providerFactory() : createProvider(llmConfig);
    } catch (error) {
      this.appendErrorNote(sessionId, errorMessage(error));
      return;
    }

    const workspace = this.store.ensureDesignerWorkspace();
    const link: { messageId: string | null } = { messageId: null };
    // handoff 由 makeBuiltinTools 强制注入（流水线环节专用）；设计师没有任务与交付，
    // 必须过滤掉，否则模型（尤其测试中的 MockProvider 替身）会反复调用它形成无限工具循环。
    const resolvedTools = [
      ...resolveTools(this.store, agent).filter((tool) => tool.spec.function.name !== 'handoff'),
      ...makeDesignerTools({ store: this.store, sessionId, link, publish: (event) => this.events.publish(event) }),
    ];
    const toolMap = new Map(resolvedTools.map((tool) => [tool.spec.function.name, tool]));
    const toolSpecs = resolvedTools.map((tool) => tool.spec);

    // 会话上的压缩水位与前情提要：seq ≤ 水位的较早消息不再进入请求，由提要承担背景。
    const session = this.store.getDesignerSession(sessionId);
    const compactedSeq = session?.compactedSeq ?? 0;
    const { history, systemPrompt, currentCost, anchor } = buildCompressionContext({
      stored: this.store.listDesignerMessages(sessionId),
      compactedSeq,
      summary: session?.summary ?? '',
      systemPromptBase: assembleDesignerSystemPrompt(this.store, agent, workspace),
    });
    // 载荷相对成本随「本轮内存中丢弃」递减，保证后续轮次/超限重试的折算仍然自洽。
    let effectiveCost = currentCost;
    const planDrop = (maxContextTokens: number): number =>
      planDesignerCompression({ history, systemPrompt, anchor, currentCost: effectiveCost, maxContextTokens });
    const spliceDropped = (count: number): void => {
      for (const message of history.splice(0, count)) effectiveCost -= messageCost(message);
    };
    const model = agent.model || llmConfig.model;
    const temperature = agent.temperature ?? llmConfig.temperature;

    // 设计师没有任务工作区与流水线位置；这些字段仅为满足内置文件工具的上下文签名。
    const ctx: ToolContext = {
      store: this.store,
      runtime: { notifyFeedback: (feedback) => this.events.publish({ type: 'feedback.created', feedbackId: feedback.id }) },
      agent,
      workdir: workspace,
      taskId: sessionId,
      turnId: sessionId,
      turnSeq: 0,
      task: '',
      conversationId: sessionId,
      signal,
      settings,
      systemPrompt,
      pipeline: { id: '', name: '', description: '', nodes: [], edges: [], createdAt: '', updatedAt: '' },
      node: { id: DESIGNER_SLUG, agentId: agent.id, isStart: true, x: 0, y: 0 },
      outgoing: [],
      completed: null,
      observations: new Map(),
    };

    const meta: LlmRequestMeta = {
      agentName: agent.name,
      taskId: sessionId,
      turnId: sessionId,
      turnSeq: 0,
      nextAgentNames: [],
      terminal: false,
      iteration: 1,
    };

    // 轮次不设上限：会话只能通过回复完成、终止或错误退出。
    for (let iteration = 1; ; iteration += 1) {
      if (signal.aborted) {
        this.appendStoppedNote(sessionId);
        return;
      }
      this.publishStatus(sessionId, `第 ${iteration} 轮思考中`);
      meta.iteration = iteration;

      const dropped = planDrop(llmConfig.maxContextTokens);
      if (dropped > 0) spliceDropped(dropped);

      // 流式上屏：每次请求内去重后把累计正文/思考推给前端（designer.delta / designer.reasoning）。
      // lastDeltaText / lastDeltaReasoning 在每轮迭代重置——新一轮请求从头累计，文本变短也会正确推送。
      let lastDeltaText = '';
      let lastDeltaReasoning = '';
      let response: LlmResponse | null = null;
      for (let attempt = 1; ; attempt += 1) {
        try {
          response = await provider.complete({
            model,
            temperature,
            messages: [{ role: 'system', content: systemPrompt }, ...history],
            tools: toolSpecs,
            signal,
            meta,
            progressIntervalMs: 120,
            onProgress: (progress) => {
              const text = progress.contentText;
              if (text && text !== lastDeltaText) {
                lastDeltaText = text;
                this.events.publish({ type: 'designer.delta', sessionId, text });
              }
              const reasoning = progress.reasoningText;
              if (reasoning && reasoning !== lastDeltaReasoning) {
                lastDeltaReasoning = reasoning;
                this.events.publish({ type: 'designer.reasoning', sessionId, text: reasoning });
              }
            },
          });
          break;
        } catch (error) {
          if (signal.aborted) {
            this.appendStoppedNote(sessionId);
            return;
          }
          if (attempt < 2 && isContextOverflowError(error)) {
            const aggressive = planDrop(llmConfig.maxContextTokens / 2);
            if (aggressive > 0) {
              spliceDropped(aggressive);
              this.publishStatus(sessionId, `上下文超限，已压缩最早的 ${aggressive} 条消息后重试`);
              continue;
            }
            if (truncateLargeToolMessages(history) > 0) {
              this.publishStatus(sessionId, '上下文超限，已截断过大的工具输出后重试');
              continue;
            }
          }
          this.appendErrorNote(sessionId, errorMessage(error));
          return;
        }
      }
      if (response === null) return;
      if (signal.aborted) {
        this.appendStoppedNote(sessionId);
        return;
      }

      const toolCalls: LlmToolCall[] = response.toolCalls;
      const assistant = this.appendMessage(sessionId, {
        role: 'assistant',
        content: response.content ?? '',
        toolCalls,
        meta: {
          kind: 'assistant',
          usage: response.usage,
          // 留档本条用量对应的压缩水位，供后续压缩规划精确还原「上次请求实际带了哪些消息」。
          compactedSeq,
          // 思考内容仅供展示（单行折叠），截断防超长；不写回模型历史。
          ...(response.reasoning ? { reasoning: truncateText(response.reasoning, 20_000) } : {}),
        },
      });
      link.messageId = assistant.id;
      history.push({
        role: 'assistant',
        content: response.content || null,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });

      if (toolCalls.length === 0) {
        const text = (response.content ?? '').trim();
        if (!text) this.appendErrorNote(sessionId, '模型返回了空回复');
        return;
      }

      for (const call of toolCalls) {
        if (signal.aborted) {
          this.appendStoppedNote(sessionId);
          return;
        }
        this.publishStatus(sessionId, `调用工具 ${call.name}`);
        let resultText = '';
        let resultImages: AttachedImage[] = [];
        let isError = false;
        const tool = toolMap.get(call.name);
        if (!tool) {
          resultText = `工具执行失败：不存在名为「${call.name}」的工具。可用工具：${[...toolMap.keys()].join('、')}`;
          isError = true;
        } else {
          let args: Record<string, unknown> = {};
          try {
            const raw = call.arguments?.trim();
            args = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
            if (typeof args !== 'object' || args === null || Array.isArray(args)) {
              throw new Error('工具参数必须是 JSON 对象');
            }
          } catch (error) {
            resultText = `工具执行失败：参数不是合法 JSON 对象（${errorMessage(error)}）`;
            isError = true;
          }
          if (!isError) {
            try {
              const result = await tool.execute(args, ctx);
              if (typeof result === 'string') {
                resultText = result;
              } else {
                // read_image 等工具会随结果附带图片；与任务运行时一致，图片必须
                // 存档并写回模型历史，否则设计师永远"看不到"用户上传的图片。
                resultText = result.content;
                resultImages = result.images ?? [];
              }
            } catch (error) {
              resultText = `工具执行失败：${errorMessage(error)}`;
              isError = true;
            }
          }
        }
        if (signal.aborted) {
          this.appendStoppedNote(sessionId);
          return;
        }
        const toolMessage = this.appendMessage(sessionId, {
          role: 'tool',
          content: resultText,
          toolCallId: call.id,
          name: call.name,
          images: resultImages,
          meta: { kind: 'tool_result', toolName: call.name, toolStatus: isError ? 'error' : 'ok' },
        });
        history.push({
          role: 'tool',
          content: toolMessage.content,
          toolCallId: call.id,
          name: call.name ?? undefined,
          ...(resultImages.length > 0 ? { images: resultImages } : {}),
        });
      }
    }
  }
}
