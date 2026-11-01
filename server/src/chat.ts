import type {
  Agent,
  AgentInput,
  AttachedImage,
  DesignerMessage,
  DesignerProfile,
  DesignerSession,
  DesignerSessionDetail,
  DesignerSessionSummary,
  DesignerToolInfo,
  RealtimeEvent,
} from '../../shared/types';
import { BUILTIN_TOOL_NAMES, DESIGNER_MAX_ATTACHMENTS, DESIGNER_SLUG, TRAINER_SLUG } from '../../shared/types';
import type { ChatRoleKind, ChatMessageInput } from './store';
import { AppError, errorMessage } from './errors';
import type { RuntimeEvents } from './events';
import type { Runtime } from './runtime';
import {
  CONTEXT_COMPRESS_RATIO,
  messageCost,
  planHistoryCompression,
  truncateLargeToolMessages,
} from './runtime';
import {
  BUILTIN_TOOL_INFOS,
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

/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */

const MAX_MESSAGE_CHARS = 50_000;
const ATTACHMENT_NOTE_HEADER =
  '\n\n【本次消息携带的附件（相对当前工作目录的路径，用相应工具读取）】\n';

export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

export function requireString(value: unknown, field: string, max: number): string {
  const text = String(value ?? '').trim();
  if (!text) throw new AppError(400, `缺少 ${field}`);
  return truncateText(text, max);
}

export function optionalString(value: unknown, max: number): string {
  return typeof value === 'string' ? truncateText(value.trim(), max) : '';
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderAttachmentNote(attachments: DesignerMessage['meta']['attachments']): string {
  if (!attachments || attachments.length === 0) return '';
  const lines = attachments.map((item) => {
    const size = formatAttachmentSize(item.size);
    return `- ${item.path}${item.image ? '（图片，可用 read_image 查看）' : ''}｜${item.name ?? ''}｜${size}`;
  });
  return `${ATTACHMENT_NOTE_HEADER}${lines.join('\n')}`;
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
  // 用户消息：附件不进入正文落库，但发给模型时要附上路径清单，由角色用文件工具自行读取。
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
function renderDialogueForSummary(messages: DesignerMessage[], roleLabel: string): string {
  const lines: string[] = [];
  let total = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const role =
      message.role === 'user' ? '用户' : message.role === 'assistant' ? roleLabel : `工具·${message.name ?? '未知'}`;
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
function buildSummaryPrompt(roleLabel: string, previous: string, dialogue: string): string {
  const parts = [
    `你是${roleLabel}会话的摘要助手。请把下面的「待压缩对话」压缩成一份「前情提要」，它将替代这些对话，作为${roleLabel}后续对话的背景知识。`,
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
export function planChatCompression(options: {
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

/* ------------------------------------------------------------------ */
/* role spec                                                           */
/* ------------------------------------------------------------------ */

/** 专属工具的展示元数据（详情页用；与实际注册进模型的工具同源）。 */
export interface ChatToolMeta {
  name: string;
  description: string;
}

export interface ChatToolDeps {
  store: Store;
  sessionId: string;
  /** 当前回合里触发工具调用的助手消息 id：变更与卡片渲染位置的关联。 */
  link: { messageId: string | null };
  publish: (event: Omit<RealtimeEvent, 'at'>) => void;
  /** 任务运行时：训练师的「启动测试任务」类工具需要；设计师没有这个依赖。 */
  runtime?: Runtime;
}

/** 一个对话角色的差异化配置：提示词、工具、事件名与默认档案。 */
export interface ChatRoleSpec {
  kind: ChatRoleKind;
  /** 文案里的角色名（如「设计师」「训练师」）。 */
  label: string;
  /** 工具展示的来源标识（DesignerToolInfo.source 的第三类值）。 */
  toolSource: 'designer';
  events: {
    session: RealtimeEvent['type'];
    message: RealtimeEvent['type'];
    status: RealtimeEvent['type'];
    delta: RealtimeEvent['type'];
    reasoning: RealtimeEvent['type'];
    proposal: RealtimeEvent['type'];
  };
  defaultDefinition: AgentInput;
  assembleSystemPrompt(store: Store, agent: Agent, workspaceDir: string): string;
  makeTools(deps: ChatToolDeps, metas?: ChatToolMeta[]): ResolvedTool[];
}

export interface ChatAgentRuntimeOptions {
  store: Store;
  events: RuntimeEvents;
  providerFactory?: () => LlmProvider;
  /** 任务运行时（可注入）：训练师的测试任务工具通过它启动/终止任务；设计师不需要。 */
  taskRuntime?: Runtime;
}

interface ChatBusy {
  sessionId: string;
  controller: AbortController;
}

/**
 * 对话型角色（流水线设计师 / 智能体训练师）的通用运行时：与任务型 Runtime 不同，
 * 它是「对话驱动」的——没有任务、环节与交接；用户消息进来后跑一个 ReAct 循环，
 * 以文本回复结束。对系统的全部修改只能经角色的 apply_changes 工具执行并留档。
 */
export class ChatAgentRuntime {
  readonly store: Store;
  readonly events: RuntimeEvents;
  protected readonly spec: ChatRoleSpec;
  private readonly providerFactory?: () => LlmProvider;
  private busyEntry: ChatBusy | null = null;
  /** 手动「压缩上下文」进行中：期间拒绝新消息与重复压缩。 */
  private compressing = false;

  constructor(spec: ChatRoleSpec, options: ChatAgentRuntimeOptions) {
    this.spec = spec;
    this.store = options.store;
    this.events = options.events;
    this.providerFactory = options.providerFactory;
    this.taskRuntime = options.taskRuntime;
    // 启动即清理「没有对应会话」的遗留上传目录（升级迁移清空会话后的兜底）。
    this.store.chatPurgeOrphanUploads(spec.kind);
  }

  /** 确保角色智能体与系统级工作目录存在；服务启动时调用。 */
  ensureReady(): Agent {
    this.store.chatEnsureWorkspace(this.spec.kind);
    const agent = this.store.chatEnsureAgent(this.spec.kind, this.spec.defaultDefinition);
    return this.afterEnsureAgent(agent);
  }

  /** 角色可覆写的钩子：对刚确保存在的智能体做一次性档案迁移（如设计师的旧文案刷新）。 */
  protected afterEnsureAgent(agent: Agent): Agent {
    return agent;
  }

  get busy(): boolean {
    return this.busyEntry !== null;
  }

  get busySessionId(): string | null {
    return this.busyEntry?.sessionId ?? null;
  }

  listSessions(): DesignerSessionSummary[] {
    return this.store.chatListSessions(this.spec.kind);
  }

  createSession(title?: string): DesignerSession {
    return this.store.chatCreateSession(this.spec.kind, title);
  }

  deleteSession(id: string): DesignerSession {
    if (this.busyEntry?.sessionId === id) {
      throw new AppError(409, `${this.spec.label}正在这个会话中回复，请先停止再删除`);
    }
    const session = this.store.chatDeleteSession(this.spec.kind, id);
    // 会话的上传附件随会话一起清理。
    this.store.chatDeleteUploads(this.spec.kind, id);
    return session;
  }

  getSessionDetail(id: string): DesignerSessionDetail {
    const session = this.store.chatGetSession(this.spec.kind, id);
    if (!session) throw new AppError(404, '会话不存在');
    return {
      session,
      messages: this.store.chatListMessages(this.spec.kind, id),
      proposals: this.store.chatListProposals(this.spec.kind, id),
      busy: this.busyEntry?.sessionId === id,
    };
  }

  /**
   * 角色详情：实时拼装的系统提示词（含系统清单与工作规则）、实际下发给模型的工具、
   * 启用的技能与运行时信息（模型 / 思考级别 / 上下文窗口）。与模型每次请求收到的内容同源。
   */
  getProfile(): DesignerProfile {
    const agent = this.ensureReady();
    const workspace = this.store.chatEnsureWorkspace(this.spec.kind);
    const systemPrompt = this.spec.assembleSystemPrompt(this.store, agent, workspace);

    const builtinInfo = new Map(BUILTIN_TOOL_INFOS.map((info) => [info.name, info]));
    const isBuiltin = (name: string): boolean => (BUILTIN_TOOL_NAMES as readonly string[]).includes(name);
    // 生效工具 = 统一授予的内置/自定义工具（去掉流水线专用的 handoff）+ 角色专属管理工具。
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
    const metas: ChatToolMeta[] = [];
    this.spec.makeTools(
      { store: this.store, sessionId: '', link: { messageId: null }, publish: () => {} },
      metas,
    );
    const tools: DesignerToolInfo[] = [
      ...effective,
      ...metas.map((meta): DesignerToolInfo => ({ ...meta, source: this.spec.toolSource })),
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
      throw new AppError(409, `${this.spec.label}正在处理上一条消息，请等它回复完毕或先点击停止`);
    }
    if (this.compressing) {
      throw new AppError(409, '正在压缩上下文，请稍候，完成后再发送消息');
    }
    const session = this.store.chatGetSession(this.spec.kind, sessionId);
    if (!session) throw new AppError(404, '会话不存在');
    const text = String(content ?? '').trim();
    if (text.length > MAX_MESSAGE_CHARS) {
      throw new AppError(400, `消息长度不能超过 ${MAX_MESSAGE_CHARS} 个字符`);
    }
    if (!Array.isArray(attachments)) throw new AppError(400, 'attachments 必须是数组');
    if (attachments.length > DESIGNER_MAX_ATTACHMENTS) {
      throw new AppError(400, `一条消息最多携带 ${DESIGNER_MAX_ATTACHMENTS} 个附件`);
    }
    const resolved = attachments.map((ref) =>
      this.store.chatResolveUpload(
        this.spec.kind,
        sessionId,
        String(ref?.path ?? ''),
        typeof ref?.name === 'string' ? ref.name : undefined,
      ),
    );
    if (!text && resolved.length === 0) {
      throw new AppError(400, '消息内容不能为空');
    }

    const appended = this.store.chatAppendMessage(this.spec.kind, sessionId, {
      role: 'user',
      content: text,
      meta: resolved.length > 0 ? { kind: 'turn_input', attachments: resolved } : { kind: 'turn_input' },
    });
    this.store.chatRenameSessionFromMessage(this.spec.kind, sessionId, text);
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

  /** 一键清空：中断回复并清空角色的会话、消息、变更记录与工作目录（角色智能体本身保留）。 */
  async resetAll(): Promise<void> {
    this.stop();
    if (this.busyEntry) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    this.store.chatResetData(this.spec.kind);
    this.store.chatResetWorkspace(this.spec.kind);
    this.events.publish({ type: 'reset' });
  }

  /* ---------------------------------------------------------------- */
  /* 单会话：压缩上下文 / 清空对话记录                                    */
  /* ---------------------------------------------------------------- */

  /** 当前唯一会话（取最近更新的一条）；还没有任何会话时返回 null。 */
  private currentSession(): DesignerSession | null {
    return this.store.chatListSessions(this.spec.kind)[0] ?? null;
  }

  /**
   * 清空对话记录：删除当前会话——消息、全部变更（含待确认的）随外键级联删除，
   * 该会话上传的附件一并清理；工作目录里的文件与已应用的系统变更不受影响。
   * 清空后回到无会话状态，下一条消息自动创建全新会话。
   */
  clearConversation(): void {
    const session = this.currentSession();
    if (!session) return;
    if (this.busyEntry?.sessionId === session.id) {
      throw new AppError(409, `${this.spec.label}正在回复，请先停止再清空对话`);
    }
    this.store.chatDeleteSession(this.spec.kind, session.id);
    this.store.chatDeleteUploads(this.spec.kind, session.id);
    this.events.publish({ type: this.spec.events.session });
  }

  /**
   * 手动压缩上下文（摘要式）：把较早的对话轮次交给模型总结成「前情提要」并落库，
   * 之后的请求只带「提要 + 未压缩的最近消息」；界面聊天记录不受影响。
   * 返回本次压缩的消息条数；0 表示当前用量未超水位、无需压缩。
   */
  async compressConversation(): Promise<{ compressed: number }> {
    if (this.busyEntry) {
      throw new AppError(409, `${this.spec.label}正在回复，请等本轮结束或先停止，再压缩上下文`);
    }
    if (this.compressing) {
      throw new AppError(409, '正在压缩上下文，请稍候');
    }
    const session = this.currentSession();
    if (!session) throw new AppError(404, '还没有对话，无需压缩');

    const agent = this.ensureReady();
    const workspace = this.store.chatEnsureWorkspace(this.spec.kind);
    const stored = this.store.chatListMessages(this.spec.kind, session.id);
    const { history, systemPrompt, currentCost, anchor } = buildCompressionContext({
      stored,
      compactedSeq: session.compactedSeq,
      summary: session.summary,
      systemPromptBase: this.spec.assembleSystemPrompt(this.store, agent, workspace),
    });
    const llmConfig = this.store.getLlmConfig();
    const dropCount = planChatCompression({
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
      this.store.chatCompactSession(this.spec.kind, session.id, { compactedSeq, summary });
      this.events.publish({ type: this.spec.events.session });
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
    const prompt = buildSummaryPrompt(this.spec.label, previous, renderDialogueForSummary(dropped, this.spec.label));
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
    this.events.publish({ type: this.spec.events.status, sessionId, detail });
  }

  private publishMessage(message: DesignerMessage): void {
    this.events.publish({ type: this.spec.events.message, sessionId: message.sessionId, messageId: message.id });
  }

  private appendMessage(sessionId: string, input: ChatMessageInput): DesignerMessage {
    const message = this.store.chatAppendMessage(this.spec.kind, sessionId, input);
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

    const workspace = this.store.chatEnsureWorkspace(this.spec.kind);
    const link: { messageId: string | null } = { messageId: null };
    // handoff 由 makeBuiltinTools 强制注入（流水线环节专用）；对话角色没有任务与交付，
    // 必须过滤掉，否则模型（尤其测试中的 MockProvider 替身）会反复调用它形成无限工具循环。
    const resolvedTools = [
      ...resolveTools(this.store, agent).filter((tool) => tool.spec.function.name !== 'handoff'),
      ...this.spec.makeTools({
        store: this.store,
        sessionId,
        link,
        publish: (event) => this.events.publish(event),
        runtime: this.taskRuntime,
      }),
    ];
    const toolMap = new Map(resolvedTools.map((tool) => [tool.spec.function.name, tool]));
    const toolSpecs = resolvedTools.map((tool) => tool.spec);

    // 会话上的压缩水位与前情提要：seq ≤ 水位的较早消息不再进入请求，由提要承担背景。
    const session = this.store.chatGetSession(this.spec.kind, sessionId);
    const compactedSeq = session?.compactedSeq ?? 0;
    const { history, systemPrompt, currentCost, anchor } = buildCompressionContext({
      stored: this.store.chatListMessages(this.spec.kind, sessionId),
      compactedSeq,
      summary: session?.summary ?? '',
      systemPromptBase: this.spec.assembleSystemPrompt(this.store, agent, workspace),
    });
    // 载荷相对成本随「本轮内存中丢弃」递减，保证后续轮次/超限重试的折算仍然自洽。
    let effectiveCost = currentCost;
    const planDrop = (maxContextTokens: number): number =>
      planChatCompression({ history, systemPrompt, anchor, currentCost: effectiveCost, maxContextTokens });
    const spliceDropped = (count: number): void => {
      for (const message of history.splice(0, count)) effectiveCost -= messageCost(message);
    };
    const model = agent.model || llmConfig.model;
    const temperature = agent.temperature ?? llmConfig.temperature;

    // 对话角色没有任务工作区与流水线位置；这些字段仅为满足内置文件工具的上下文签名。
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
      node: { id: this.spec.kind === 'designer' ? DESIGNER_SLUG : TRAINER_SLUG, agentId: agent.id, isStart: true, x: 0, y: 0 },
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

      // 流式上屏：每次请求内去重后把累计正文/思考推给前端（<prefix>.delta / <prefix>.reasoning）。
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
                this.events.publish({ type: this.spec.events.delta, sessionId, text });
              }
              const reasoning = progress.reasoningText;
              if (reasoning && reasoning !== lastDeltaReasoning) {
                lastDeltaReasoning = reasoning;
                this.events.publish({ type: this.spec.events.reasoning, sessionId, text: reasoning });
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
                // 存档并写回模型历史，否则角色永远"看不到"用户上传的图片。
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

  /** 任务运行时（可注入）：训练师的测试任务工具通过它启动/终止任务。 */
  private taskRuntime?: Runtime;
}
