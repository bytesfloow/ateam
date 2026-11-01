import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type {
  Agent,
  AttachedImage,
  Feedback,
  HandoffFolder,
  HandoffTargetResolved,
  Pipeline,
  PipelineEdge,
  PipelineNode,
  RealtimeEvent,
  ResetResult,
  StatusSnapshot,
  TaskDetail,
  TaskStartInput,
  Turn,
} from '../../shared/types';
import {
  findEdge,
  findNode,
  findStartNode,
  incomingEdges,
  outgoingEdges,
  renderTriggerPrompt,
} from '../../shared/types';
import { VERSION } from './config';
import { AppError, errorMessage } from './errors';
import { RuntimeEvents } from './events';
import {
  createProvider,
  isContextOverflowError,
  type LlmMessage,
  type LlmProgress,
  type LlmProvider,
  type LlmResponse,
  type LlmToolCall,
} from './llm';
import type { Store } from './store';
import { assembleSystemPrompt, type PromptPipelineContext } from './prompt';
import { resolveTools, type ResolvedTool, type ToolContext } from './tools';

const nowIso = (): string => new Date().toISOString();

/** 单个任务最多可执行的环节数：用于防止候选下一环节形成死循环。 */
const MAX_TURNS_PER_TASK = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n…（内容过长，已截断 ${text.length - limit} 字符）`;
}

function toLlmMessage(message: {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  toolCallId: string | null;
  name: string | null;
  images: AttachedImage[];
}): LlmMessage {
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
    return {
      role: 'tool',
      content: message.content,
      toolCallId: message.toolCallId ?? '',
      name: message.name ?? undefined,
      ...(message.images.length > 0 ? { images: message.images } : {}),
    };
  }
  return { role: 'user', content: message.content };
}

/**
 * 消息相对成本的粗估（字符数加权；不追求精确 token，只用于按比例分摊实测用量）。
 * 导出供设计师的「摘要压缩」规划复用（与 planHistoryCompression 同一套度量）。
 */
export function messageCost(message: LlmMessage): number {
  const imageChars = (message.images ?? []).reduce((sum, image) => sum + image.dataBase64.length, 0);
  return (
    24 +
    (message.content?.length ?? 0) +
    imageChars +
    (message.toolCalls ? JSON.stringify(message.toolCalls).length : 0) +
    40
  );
}

/** 上下文压缩水位：占「最大上下文长度」的比例，剩余 20% 留给输出与思考 token。 */
export const CONTEXT_COMPRESS_RATIO = 0.8;

/**
 * 基于接口返回的真实 token 用量规划上下文压缩（不做 token 预估）：
 * knownTokens 是上一次调用实测的 prompt + completion 总量（真值），按各消息的相对大小
 * 把这个真值分摊到消息上，从最老的用户轮次组开始丢弃，直到剩余 ≤ thresholdTokens。
 * 返回应从 history 头部移除的消息条数；无实测用量（首次调用）或未超水位时返回 0。
 */
export function planHistoryCompression(options: {
  history: LlmMessage[];
  systemPrompt: string;
  knownTokens: number | null;
  thresholdTokens: number;
}): number {
  const { history, systemPrompt, knownTokens, thresholdTokens } = options;
  if (knownTokens === null || knownTokens <= thresholdTokens || history.length === 0) return 0;
  const costs = history.map(messageCost);
  const systemCost = messageCost({ role: 'system', content: systemPrompt });
  const totalCost = systemCost + costs.reduce((sum, cost) => sum + cost, 0);
  if (totalCost <= 0) return 0;
  const scale = knownTokens / totalCost;
  let remaining = (systemCost + costs.reduce((sum, cost) => sum + cost, 0)) * scale;
  let dropCount = 0;
  while (remaining > thresholdTokens && dropCount < history.length - 1) {
    let nextUser = dropCount + 1;
    while (nextUser < history.length && history[nextUser].role !== 'user') nextUser += 1;
    if (nextUser >= history.length) break;
    for (let i = dropCount; i < nextUser; i += 1) remaining -= costs[i] * scale;
    dropCount = nextUser;
  }
  return dropCount;
}

const TOOL_TRUNCATE_MIN_CHARS = 1_000;
const TOOL_TRUNCATE_KEEP_CHARS = 300;

/**
 * 上下文超限时的兜底压缩：截断过大的工具结果（保留开头并注明截断），返回截断条数。
 * 只修改内存中的发送副本，不改落库记录。
 */
export function truncateLargeToolMessages(history: LlmMessage[]): number {
  let truncated = 0;
  for (const message of history) {
    if (message.role !== 'tool') continue;
    const content = message.content ?? '';
    if (content.length <= TOOL_TRUNCATE_MIN_CHARS) continue;
    message.content = `${content.slice(0, TOOL_TRUNCATE_KEEP_CHARS)}\n\n…[上下文超限，工具输出已截断，原文共 ${content.length} 字符]`;
    truncated += 1;
  }
  return truncated;
}

function buildSystemPrompt(
  store: Store,
  agent: Agent,
  task: { id: string },
  pipeline: Pipeline | null,
  node: PipelineNode | null,
  upstreamNames: string[],
): string {
  const pipelineContext: PromptPipelineContext | null =
    pipeline && node
      ? {
          name: pipeline.name,
          description: pipeline.description,
          members: bfsNodeOrderLite(pipeline).map((item) => {
            const member = store.getAgent(item.agentId);
            return {
              agentName: member?.name ?? '（智能体已删除）',
              description: member?.description ?? '',
              isMe: item.id === node.id,
            };
          }),
          upstream: upstreamNames,
          outgoing: outgoingEdges(pipeline, node.id)
            .map((edge) => ({
              agentName:
                store.getAgent(findNode(pipeline, edge.to)?.agentId ?? '')?.name ?? '（智能体已删除）',
              condition: edge.handoffCondition,
            })),
          terminal: outgoingEdges(pipeline, node.id).length === 0,
        }
      : null;
  return assembleSystemPrompt(
    store,
    {
      name: agent.name,
      description: agent.description,
      responsibilities: agent.responsibilities,
      deliverable: agent.deliverable,
      guide: agent.guide,
      tools: agent.tools,
      skillIds: agent.skillIds,
    },
    {
      taskWorkspace: store.agentTaskWorkspaceDir(task.id, agent.slug),
      inboxDir: store.agentTaskInboxDir(task.id, agent.slug),
    },
    pipelineContext,
  );
}

/** 简单 BFS 顺序（共享的 bfsNodeOrder 对非法图有兜底，这里直接复用其语义即可）。 */
function bfsNodeOrderLite(pipeline: Pipeline): PipelineNode[] {
  const start = findStartNode(pipeline);
  const order: PipelineNode[] = [];
  const visited = new Set<string>();
  if (!start) return pipeline.nodes;
  const queue: PipelineNode[] = [start];
  visited.add(start.id);
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    for (const edge of outgoingEdges(pipeline, node.id)) {
      const next = findNode(pipeline, edge.to);
      if (next && !visited.has(next.id)) {
        visited.add(next.id);
        queue.push(next);
      }
    }
  }
  for (const node of pipeline.nodes) {
    if (!visited.has(node.id)) order.push(node);
  }
  return order;
}

/** 列出某个智能体本任务工作区 inbox\user\ 下的用户输入文件名（目录不存在或不可读时为空）。 */
function listInputFiles(store: Store, taskId: string, agentSlug: string): string[] {
  try {
    return fs
      .readdirSync(store.agentTaskUserInputDir(taskId, agentSlug), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * 组装一个环节的输入：
 * - 起点节点：任务原文（输入文件在系统提示词与 inbox\ 目录里自取）；
 * - 其它节点：进线的「任务触发提示词」，由系统替换 {deliverables} / {task} / {sender} 后原样注入。
 */
function buildTurnInput(params: {
  taskText: string;
  pipeline: Pipeline | null;
  node: PipelineNode | null;
  /** 上一环节（成功交接的那一个环节）；起点/无前置时 null。 */
  previous: Turn | null;
  /** 用户重试时补充的指示。 */
  note?: string;
  inputFiles?: string[];
}): string {
  const { taskText, pipeline, node, previous, note } = params;
  const parts: string[] = [];

  const startNodeId = pipeline ? findStartNode(pipeline)?.id ?? null : null;
  const isStart =
    !!pipeline && !!node
      ? startNodeId
        ? startNodeId === node.id
        : incomingEdges(pipeline, node.id).length === 0
      : !previous;
  if (isStart && !previous) {
    parts.push(taskText);
  } else if (pipeline && node) {
    const edge =
      (previous?.target?.type === 'agent' ? findEdge(pipeline, previous.target.edgeId) : null) ??
      findEdge(pipeline, pipeline.edges.find((item) => item.to === node.id)?.id) ??
      pipeline.edges.find((item) => item.to === node.id) ??
      null;
    if (edge) {
      const folder = previous?.handoffFolder ?? null;
      const senderName = previous?.agentName ?? '';
      parts.push(
        renderTriggerPrompt(edge.triggerPrompt, {
          deliverables: folder?.deliveredPath ?? folder?.path ?? '（上游未交接文件夹）',
          task: taskText,
          sender: senderName,
        }),
      );
    } else {
      // 兜底：连线被删除等异常场景，不阻断任务推进。
      parts.push(
        `上游「${senderFallback(previous)}」已完成交接。交付目录：${previous?.handoffFolder?.deliveredPath ?? '（见你的工作区 inbox\\）'}。请按你的职责继续完成任务。`,
      );
    }
  } else {
    parts.push(taskText);
  }

  const inputFiles = params.inputFiles ?? [];
  if (inputFiles.length > 0) {
    parts.push(
      `【输入文件】\n你的工作区 inbox\\ 下有以下输入文件（用户投放，位于 inbox\\user\\ 下）：\n${inputFiles
        .map((file) => `- inbox/user/${file}`)
        .join('\n')}`,
    );
  }

  if (note && note.trim()) {
    parts.push(`【用户的补充指示】\n${note.trim()}`);
  }
  return parts.join('\n\n');
}

function senderFallback(previous: Turn | null): string {
  return previous?.agentName ?? '上一环节';
}

interface BusyAgent {
  turnId: string;
  taskId: string;
  agentName: string;
  controller: AbortController;
  startedAt: string;
}

interface LoopParams {
  agent: Agent;
  taskId: string;
  turnId: string;
  conversationId: string;
  turnSeq: number;
  task: string;
  systemPrompt: string;
  pipeline: Pipeline;
  node: PipelineNode;
  outgoing: PipelineEdge[];
  generation: number;
  signal?: AbortSignal;
}

interface LoopResult {
  status: 'completed' | 'failed' | 'aborted';
  finalText: string;
  handoff: {
    folder: HandoffFolder;
    target: HandoffTargetResolved;
  } | null;
  error: string | null;
  iterations: number;
}

export interface RuntimeOptions {
  store: Store;
  providerFactory?: () => LlmProvider;
  events?: RuntimeEvents;
}

export class Runtime {
  readonly store: Store;
  readonly events: RuntimeEvents;
  private readonly providerFactory?: () => LlmProvider;
  private readonly busy = new Map<string, BusyAgent>();
  private readonly idleEvents = new EventEmitter();
  private readonly turnControllers = new Map<string, AbortController>();
  private readonly activeLoops = new Set<Promise<unknown>>();
  private generation = 0;
  private resetting = false;

  constructor(options: RuntimeOptions) {
    this.store = options.store;
    this.providerFactory = options.providerFactory;
    this.events = options.events ?? new RuntimeEvents();
    this.idleEvents.setMaxListeners(200);
    this.store.recoverInterruptedTasks();
  }

  /* ---------------------------------------------------------------- */
  /* task lifecycle                                                    */
  /* ---------------------------------------------------------------- */

  startTask(input: TaskStartInput): TaskDetail {
    if (this.resetting) throw new AppError(409, '系统正在重置，请稍后');
    const active = this.store.findActiveTask();
    if (active) {
      const state =
        active.status === 'paused' ? '已暂停' : active.status === 'waiting_human' ? '等待用户验收' : '执行中';
      throw new AppError(409, `已有未结束的任务（${state}），请先处理或终止它`);
    }
    const pipeline = this.store.getPipeline(input.pipelineId);
    if (!pipeline) throw new AppError(404, '流水线不存在');
    const node = findStartNode(pipeline);
    if (!node) throw new AppError(409, '流水线缺少唯一起点，请重新编排连线');
    const agent = this.store.getAgent(node.agentId);
    if (!agent) throw new AppError(409, `起点节点「${node.id}」的智能体已被删除`);

    const taskText = String(input.task ?? '').trim();
    const created = this.store.createTask({ task: taskText, pipeline, node, agent });
    this.store.ensureTaskWorkspace(created.taskId);
    this.store.prepareAgentTaskWorkspace(created.taskId, agent.slug);
    const inputText = buildTurnInput({
      taskText,
      pipeline,
      node,
      previous: null,
      inputFiles: listInputFiles(this.store, created.taskId, agent.slug),
    });
    this.store.updateTurn(created.turnId, { input: inputText });
    this.events.publish({ type: 'task.created', taskId: created.taskId });
    this.events.publish({ type: 'task.updated', taskId: created.taskId });
    void this.executeTurn(created.turnId, this.generation);
    return this.store.getTaskDetail(created.taskId)!;
  }

  /**
   * 暂停（或失败）的任务：停在当前节点重跑。
   *
   * 不修改已有回合，追加新的一个环节由同一智能体重做；输入按「进入本节点的连线」重新渲染
   * （上一环节 = 最近一次成功交接），失败的环节产出的半成品不作为输入。
   */
  retryTask(taskId: string, input: { note?: string } = {}): TaskDetail {
    if (this.resetting) throw new AppError(409, '系统正在重置，请稍后');
    const task = this.store.getTaskDetail(taskId);
    if (!task) throw new AppError(404, '任务不存在');
    if (task.status !== 'paused' && task.status !== 'failed') {
      throw new AppError(409, '只有暂停或失败的任务可以重试');
    }
    const active = this.store.findActiveTask();
    if (active && active.id !== taskId) {
      throw new AppError(409, '已有未结束的任务，请先处理或终止它');
    }
    const pipeline = task.pipeline;
    if (!pipeline) throw new AppError(409, '任务缺少流水线快照，无法重试');
    const node = task.currentNodeId
      ? findNode(pipeline, task.currentNodeId)
      : null;
    if (!node) throw new AppError(409, '找不到任务当前所处的节点，无法重试');
    const agent = this.store.getAgent(node.agentId);
    if (!agent) throw new AppError(409, '当前节点的智能体已被删除，无法重试');

    const previous = [...task.turns].reverse().find((turn) => turn.status === 'completed') ?? null;
    this.store.prepareAgentTaskWorkspace(taskId, agent.slug);
    const created = this.store.createTurn(taskId, agent, node);
    const inputText = buildTurnInput({
      taskText: task.task,
      pipeline,
      node,
      previous,
      inputFiles: listInputFiles(this.store, taskId, agent.slug),
      note: input.note,
    });
    this.store.updateTurn(created.turnId, { input: inputText });
    this.store.updateTask(taskId, { status: 'running', error: null, finishedAt: null });
    this.events.publish({ type: 'task.updated', taskId });
    void this.executeTurn(created.turnId, this.generation);
    return this.store.getTaskDetail(taskId)!;
  }

  /** 人类接手后直接宣布任务完成。 */
  completeTaskByHuman(taskId: string): TaskDetail {
    if (this.resetting) throw new AppError(409, '系统正在重置，请稍后');
    const task = this.store.getTask(taskId);
    if (!task) throw new AppError(404, '任务不存在');
    if (task.status !== 'waiting_human') throw new AppError(409, '当前任务不在等待人类处理状态');
    this.finishTask(taskId, 'completed', null);
    return this.store.getTaskDetail(taskId)!;
  }

  terminateTask(taskId: string, reason = '任务已被用户终止'): TaskDetail {
    const task = this.store.getTask(taskId);
    if (!task) throw new AppError(404, '任务不存在');
    if (task.status !== 'running' && task.status !== 'paused' && task.status !== 'waiting_human') {
      throw new AppError(409, '当前任务已经结束');
    }
    this.abortAgentsForTask(taskId);
    this.turnControllers.get(task.currentTurnId ?? '')?.abort();
    const timestamp = nowIso();
    const detail = this.store.getTaskDetail(taskId);
    this.store.updateTask(taskId, {
      status: 'aborted',
      error: reason,
      finishedAt: timestamp,
    });
    if (detail) {
      for (const turn of detail.turns) {
        if (turn.status === 'running') {
          this.store.updateTurn(turn.id, { status: 'aborted', error: reason, finishedAt: timestamp });
          this.events.publish({ type: 'turn.updated', taskId, turnId: turn.id });
        }
      }
    }
    this.events.publish({ type: 'task.updated', taskId });
    return this.store.getTaskDetail(taskId)!;
  }

  getStatus(): StatusSnapshot {
    const active = this.store.findActiveTask();
    return {
      version: VERSION,
      activeTask: active,
      busyAgents: [...this.busy.entries()].map(([agentId, value]) => ({
        agentId,
        agentName: value.agentName,
        turnId: value.turnId,
      })),
      openFeedback: this.store.countOpenFeedback(),
    };
  }

  async resetAll(): Promise<ResetResult> {
    if (this.resetting) throw new AppError(409, '系统正在重置');
    this.resetting = true;
    this.generation += 1;
    for (const entry of this.busy.values()) entry.controller.abort();
    for (const controller of this.turnControllers.values()) controller.abort();
    try {
      if (this.activeLoops.size > 0) {
        await Promise.race([Promise.allSettled([...this.activeLoops]), sleep(8000)]);
      }
      const counts = this.store.resetRuntimeData();
      this.store.resetTaskWorkspaces();
      this.busy.clear();
      this.turnControllers.clear();
      this.events.publish({ type: 'reset' });
      return counts;
    } finally {
      this.resetting = false;
    }
  }

  notifyFeedback(feedback: Feedback): void {
    this.events.publish({ type: 'feedback.created', feedbackId: feedback.id });
  }

  publish(event: Omit<RealtimeEvent, 'at'>): void {
    this.events.publish(event);
  }

  /* ---------------------------------------------------------------- */
  /* turn execution                                                    */
  /* ---------------------------------------------------------------- */

  private async executeTurn(turnId: string, generation: number): Promise<void> {
    if (this.turnControllers.has(turnId)) return;
    const controller = new AbortController();
    this.turnControllers.set(turnId, controller);
    let taskId: string | null = null;

    try {
      const turn = this.store.getTurn(turnId);
      if (!turn || turn.status !== 'running') return;
      taskId = turn.taskId;
      const task = this.store.getTaskDetail(turn.taskId);
      if (!task || task.status !== 'running') return;
      const pipeline = task.pipeline;
      const node =
        pipeline && turn.nodeId ? findNode(pipeline, turn.nodeId) : null;
      if (!pipeline || !node) {
        this.store.updateTurn(turnId, {
          status: 'failed',
          error: '任务缺少流水线节点信息',
          finishedAt: nowIso(),
        });
        this.events.publish({ type: 'turn.updated', taskId: turn.taskId, turnId });
        this.pauseTask(turn.taskId, '流水线数据缺失，任务无法继续');
        return;
      }
      const agent = this.store.getAgent(turn.agentId);
      if (!agent) {
        this.store.updateTurn(turnId, {
          status: 'failed',
          error: '本节点的智能体已被删除',
          finishedAt: nowIso(),
        });
        this.events.publish({ type: 'turn.updated', taskId: turn.taskId, turnId });
        this.pauseTask(turn.taskId, '本节点的智能体已被删除，请调整流水线后重试');
        return;
      }

      // 上一环节取「最近一次成功交接」的回合：重试时当前节点的失败回合不能当成上一环节。
      const previous =
        [...task.turns].reverse().find((item) => item.seq < turn.seq && item.status === 'completed') ?? null;
      this.store.prepareAgentTaskWorkspace(turn.taskId, agent.slug);
      const input =
        turn.input ||
        buildTurnInput({
          taskText: task.task,
          pipeline,
          node,
          previous,
          inputFiles: listInputFiles(this.store, task.id, agent.slug),
        });
      const upstreamNames = incomingEdges(pipeline, node.id)
        .map((edge) => this.store.getAgent(findNode(pipeline, edge.from)?.agentId ?? '')?.name ?? '')
        .filter(Boolean);
      const systemPrompt = buildSystemPrompt(this.store, agent, task, pipeline, node, upstreamNames);
      // 提示词落库留档：详情页展示的是本环节实际下发给模型的完整内容，事后改智能体不影响历史记录。
      this.store.updateTurn(turnId, {
        input,
        systemPrompt,
        startedAt: turn.startedAt ?? nowIso(),
        error: null,
      });
      this.events.publish({ type: 'turn.updated', taskId: turn.taskId, turnId });

      await this.waitForIdle(agent.id, controller.signal);
      if (generation !== this.generation || controller.signal.aborted) return;
      if (this.store.getTask(turn.taskId)?.status !== 'running') return;

      const conversation = this.store.getTurnConversation(turnId);
      if (!conversation) throw new AppError(500, '回合会话不存在');

      this.store.appendMessage(conversation.id, {
        role: 'user',
        content: input,
        meta: { kind: 'turn_input' },
      });
      this.events.publish({
        type: 'message.appended',
        taskId: turn.taskId,
        turnId,
      });

      const outgoing = outgoingEdges(pipeline, node.id);
      const loop = this.runAgentLoop({
        agent,
        taskId: turn.taskId,
        turnId,
        conversationId: conversation.id,
        turnSeq: turn.seq,
        task: task.task,
        systemPrompt,
        pipeline,
        node,
        outgoing,
        generation,
        signal: controller.signal,
      });
      this.activeLoops.add(loop);
      let result: LoopResult;
      try {
        result = await loop;
      } finally {
        this.activeLoops.delete(loop);
      }

      if (generation !== this.generation) return;
      const current = this.store.getTask(turn.taskId);
      if (!current || current.status === 'aborted') return;

      if (result.status === 'aborted') {
        this.store.updateTurn(turnId, { status: 'aborted', error: '本环节执行被中断', finishedAt: nowIso() });
        this.events.publish({ type: 'turn.updated', taskId: turn.taskId, turnId });
        this.pauseTask(turn.taskId, '本环节执行被中断，可重试或终止任务');
        return;
      }

      if (result.status === 'failed') {
        const message = result.error ?? '执行失败';
        this.store.updateTurn(turnId, { status: 'failed', error: message, finishedAt: nowIso() });
        this.events.publish({ type: 'turn.updated', taskId: turn.taskId, turnId });
        this.pauseTask(turn.taskId, message);
        return;
      }

      const handoff = result.handoff;
      if (!handoff) {
        const message = '本环节没有产生有效交接';
        this.store.updateTurn(turnId, { status: 'failed', error: message, finishedAt: nowIso() });
        this.events.publish({ type: 'turn.updated', taskId: turn.taskId, turnId });
        this.pauseTask(turn.taskId, message);
        return;
      }

      const output = result.finalText;
      const completedTurn: Turn = {
        ...turn,
        status: 'completed',
        output,
        handoffFolder: handoff.folder,
        target: handoff.target,
      };
      this.store.updateTurn(turnId, {
        status: 'completed',
        output,
        handoffFolder: handoff.folder,
        target: handoff.target,
        finishedAt: nowIso(),
        error: null,
      });
      this.events.publish({ type: 'turn.updated', taskId: turn.taskId, turnId });

      if (handoff.target.type === 'human') {
        this.store.updateTask(turn.taskId, { status: 'waiting_human' });
        this.events.publish({ type: 'task.updated', taskId: turn.taskId });
        return;
      }

      const nextNode = handoff.target.nodeId ? findNode(pipeline, handoff.target.nodeId) : null;
      if (!nextNode) {
        this.pauseTask(turn.taskId, '交接目标节点不在流水线中，任务已停在当前节点');
        return;
      }
      const nextAgent = this.store.getAgent(nextNode.agentId);
      if (!nextAgent) {
        this.pauseTask(turn.taskId, '交接对象对应的智能体已被删除，请调整流水线后重试');
        return;
      }
      if (task.turnCount >= MAX_TURNS_PER_TASK) {
        this.pauseTask(
          turn.taskId,
          `任务已执行 ${task.turnCount} 个环节，疑似出现节点循环，已暂停。请检查流水线的连线，或终止任务`,
        );
        return;
      }

      const next = this.store.createTurn(turn.taskId, nextAgent, nextNode);
      const nextInput = buildTurnInput({
        taskText: task.task,
        pipeline,
        node: nextNode,
        previous: completedTurn,
        inputFiles: listInputFiles(this.store, turn.taskId, nextAgent.slug),
      });
      this.store.updateTurn(next.turnId, { input: nextInput });
      this.events.publish({ type: 'task.updated', taskId: turn.taskId });
      void this.executeTurn(next.turnId, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      const message = errorMessage(error);
      if (taskId) {
        const current = this.store.getTask(taskId);
        if (current && current.status === 'running') {
          this.store.updateTurn(turnId, { status: 'failed', error: message, finishedAt: nowIso() });
          this.events.publish({ type: 'turn.updated', taskId, turnId });
          this.pauseTask(taskId, message);
        }
      }
    } finally {
      this.turnControllers.delete(turnId);
    }
  }

  /** 任务停在当前环节：保留当前回合与工作区，由用户决定重试还是终止。 */
  private pauseTask(taskId: string, error: string | null): void {
    const task = this.store.getTask(taskId);
    if (!task || task.status !== 'running') return;
    this.store.updateTask(taskId, { status: 'paused', error, finishedAt: null });
    this.events.publish({ type: 'task.updated', taskId });
  }

  private finishTask(taskId: string, status: 'completed' | 'failed' | 'aborted', error: string | null): void {
    this.store.updateTask(taskId, {
      status,
      error: status === 'completed' ? null : error,
      finishedAt: nowIso(),
    });
    this.events.publish({ type: 'task.updated', taskId });
  }

  private abortAgentsForTask(taskId: string): void {
    for (const entry of this.busy.values()) {
      if (entry.taskId === taskId) entry.controller.abort();
    }
  }

  /* ---------------------------------------------------------------- */
  /* agent ReAct loop                                                  */
  /* ---------------------------------------------------------------- */

  private async runAgentLoop(params: LoopParams): Promise<LoopResult> {
    const { agent } = params;
    const controller = new AbortController();
    const linkExternal = () => controller.abort();
    if (params.signal) {
      if (params.signal.aborted) controller.abort();
      else params.signal.addEventListener('abort', linkExternal, { once: true });
    }

    if (params.generation !== this.generation || this.resetting) {
      return { status: 'aborted', finalText: '', handoff: null, error: '任务已终止', iterations: 0 };
    }

    while (this.busy.has(agent.id)) {
      try {
        await this.waitForIdle(agent.id, controller.signal);
      } catch {
        return { status: 'aborted', finalText: '', handoff: null, error: '任务已终止', iterations: 0 };
      }
      if (params.generation !== this.generation || this.resetting) {
        return { status: 'aborted', finalText: '', handoff: null, error: '任务已终止', iterations: 0 };
      }
    }

    const busyEntry: BusyAgent = {
      turnId: params.turnId,
      taskId: params.taskId,
      agentName: agent.name,
      controller,
      startedAt: nowIso(),
    };
    this.busy.set(agent.id, busyEntry);
    this.events.publish({
      type: 'agent.status',
      taskId: params.taskId,
      turnId: params.turnId,
      agentId: agent.id,
      detail: '开始处理任务',
    });

    let result: LoopResult;
    try {
      result = await this.loopBody(params, agent, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        result = { status: 'aborted', finalText: '', handoff: null, error: '任务已终止', iterations: 0 };
      } else {
        result = {
          status: 'failed',
          finalText: '',
          handoff: null,
          error: errorMessage(error),
          iterations: 0,
        };
      }
    }

    if (params.generation === this.generation) {
      try {
        this.store.updateTurn(params.turnId, {
          iterations: result.iterations,
        });
        this.events.publish({
          type: 'task.updated',
          taskId: params.taskId,
          turnId: params.turnId,
        });
      } catch {
        /* database may have been reset while the loop was unwinding */
      }
    }

    try {
      this.busy.delete(agent.id);
      this.idleEvents.emit(agent.id);
      if (params.generation === this.generation && !this.resetting) {
        this.events.publish({
          type: 'agent.status',
          taskId: params.taskId,
          turnId: params.turnId,
          agentId: agent.id,
          detail: 'idle',
        });
      }
    } finally {
      if (params.signal) params.signal.removeEventListener('abort', linkExternal);
    }
    return result;
  }

  private async loopBody(params: LoopParams, agent: Agent, signal: AbortSignal): Promise<LoopResult> {
    const settings = this.store.getRuntimeSettings();
    const llmConfig = this.store.getLlmConfig();

    let provider: LlmProvider;
    try {
      provider = this.providerFactory ? this.providerFactory() : createProvider(llmConfig);
    } catch (error) {
      return { status: 'failed', finalText: '', handoff: null, error: errorMessage(error), iterations: 0 };
    }

    const resolvedTools = resolveTools(this.store, agent);
    const toolMap = new Map<string, ResolvedTool>(resolvedTools.map((tool) => [tool.spec.function.name, tool]));
    const toolSpecs = resolvedTools.map((tool) => tool.spec);
    const stored = this.store.listMessages(params.conversationId);
    const history: LlmMessage[] = stored.map(toLlmMessage);
    // 上下文大小以接口返回的真实 usage 为真值：取本会话最近一次调用的 prompt + completion 总量。
    let knownTokens: number | null = null;
    for (let i = stored.length - 1; i >= 0; i -= 1) {
      const usage = stored[i].meta.usage;
      if (usage) {
        knownTokens = usage.promptTokens + usage.completionTokens;
        break;
      }
    }
    const thresholdTokens = llmConfig.maxContextTokens * CONTEXT_COMPRESS_RATIO;
    const model = agent.model || llmConfig.model;
    const temperature = agent.temperature ?? llmConfig.temperature;
    const context: ToolContext = {
      store: this.store,
      runtime: this,
      agent,
      // 主工作目录 = 该智能体在本任务中的独立工作区，文件工具相对路径以此为基准
      workdir: this.store.prepareAgentTaskWorkspace(params.taskId, agent.slug),
      taskId: params.taskId,
      turnId: params.turnId,
      turnSeq: params.turnSeq,
      task: params.task,
      conversationId: params.conversationId,
      signal,
      settings,
      systemPrompt: params.systemPrompt,
      pipeline: params.pipeline,
      node: params.node,
      outgoing: params.outgoing,
      completed: null,
      // 回合级读取观测表：write/edit 的「先读后写」守卫依据，随回合结束自然失效。
      observations: new Map(),
    };

    // 轮次不设上限：回合只能通过完成、终止或失败退出。
    for (let iteration = 1; ; iteration += 1) {
      if (signal.aborted) {
        return { status: 'aborted', finalText: '', handoff: null, error: '任务已终止', iterations: iteration - 1 };
      }
      this.store.updateTurn(params.turnId, { iterations: iteration });
      this.events.publish({
        type: 'agent.activity',
        taskId: params.taskId,
        turnId: params.turnId,
        agentId: agent.id,
        detail: `第 ${iteration} 轮思考中`,
      });

      // 上下文压缩：实测用量达到「最大上下文长度」的 80% 时，丢弃最早的对话轮次组。
      const dropped = planHistoryCompression({
        history,
        systemPrompt: params.systemPrompt,
        knownTokens,
        thresholdTokens,
      });
      if (dropped > 0) {
        history.splice(0, dropped);
        this.events.publish({
          type: 'agent.activity',
          taskId: params.taskId,
          turnId: params.turnId,
          agentId: agent.id,
          detail: `上下文已达窗口 80%，压缩丢弃最早的 ${dropped} 条消息`,
        });
      }

      let response: LlmResponse;
      let lastProgressAt = 0;
      const onProgress = (progress: LlmProgress): void => {
        const now = Date.now();
        if (now - lastProgressAt < 1500) return;
        lastProgressAt = now;
        const parts = [`第 ${iteration} 轮生成中`];
        if (progress.reasoningChars > 0) parts.push(`思考 ${progress.reasoningChars} 字`);
        if (progress.toolChars > 0) parts.push(`工具参数 ${progress.toolChars} 字`);
        if (progress.contentChars > 0) parts.push(`正文 ${progress.contentChars} 字`);
        this.events.publish({
          type: 'agent.activity',
          taskId: params.taskId,
          turnId: params.turnId,
          agentId: agent.id,
          detail: parts.join(' · '),
        });
      };
      for (let attempt = 1; ; attempt += 1) {
        try {
          response = await provider.complete({
            model,
            temperature,
            messages: [{ role: 'system', content: params.systemPrompt }, ...history],
            tools: toolSpecs,
            signal,
            onProgress,
            meta: {
              agentName: agent.name,
              taskId: params.taskId,
              turnId: params.turnId,
              turnSeq: params.turnSeq,
              nextAgentNames: params.outgoing.map(
                (edge) => this.store.getAgent(findNode(params.pipeline, edge.to)?.agentId ?? '')?.name ?? '（已删除）',
              ),
              terminal: params.outgoing.length === 0,
              iteration,
            },
          });
          break;
        } catch (error) {
          if (signal.aborted) {
            return { status: 'aborted', finalText: '', handoff: null, error: '任务已终止', iterations: iteration - 1 };
          }
          // 上下文超限兜底：先按更激进的水位丢弃最老轮次；无可丢弃时截断过大的工具输出，然后重试一次。
          if (attempt < 2 && isContextOverflowError(error)) {
            const aggressive = planHistoryCompression({
              history,
              systemPrompt: params.systemPrompt,
              knownTokens,
              thresholdTokens: thresholdTokens / 2,
            });
            if (aggressive > 0) {
              history.splice(0, aggressive);
              this.events.publish({
                type: 'agent.activity',
                taskId: params.taskId,
                turnId: params.turnId,
                agentId: agent.id,
                detail: `上下文超限，已压缩丢弃最早的 ${aggressive} 条消息后重试`,
              });
              continue;
            }
            const truncated = truncateLargeToolMessages(history);
            if (truncated > 0) {
              this.events.publish({
                type: 'agent.activity',
                taskId: params.taskId,
                turnId: params.turnId,
                agentId: agent.id,
                detail: `上下文超限，已截断 ${truncated} 条工具输出后重试`,
              });
              continue;
            }
          }
          return {
            status: 'failed',
            finalText: '',
            handoff: null,
            error: errorMessage(error),
            iterations: iteration,
          };
        }
      }
      if (response.usage) knownTokens = response.usage.promptTokens + response.usage.completionTokens;
      if (signal.aborted) {
        return { status: 'aborted', finalText: '', handoff: null, error: '任务已终止', iterations: iteration - 1 };
      }

      const toolCalls: LlmToolCall[] = response.toolCalls;
      const assistant = this.store.appendMessage(params.conversationId, {
        role: 'assistant',
        content: response.content ?? '',
        toolCalls,
        meta: { kind: 'assistant', usage: response.usage },
      });
      history.push({
        role: 'assistant',
        content: response.content || null,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });
      this.events.publish({
        type: 'message.appended',
        taskId: params.taskId,
        turnId: params.turnId,
        messageId: assistant.id,
      });

      if (toolCalls.length === 0) {
        const text = (response.content ?? '').trim();
        if (!text) {
          return {
            status: 'failed',
            finalText: '',
            handoff: null,
            error: '模型返回了空回复',
            iterations: iteration,
          };
        }
        return {
          status: 'completed',
          finalText: text,
          handoff: null,
          error: null,
          iterations: iteration,
        };
      }

      for (const call of toolCalls) {
        if (signal.aborted) {
          return { status: 'aborted', finalText: '', handoff: null, error: '任务已终止', iterations: iteration };
        }
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
            args = raw ? JSON.parse(raw) : {};
            if (typeof args !== 'object' || args === null || Array.isArray(args)) {
              throw new Error('工具参数必须是 JSON 对象');
            }
          } catch (error) {
            resultText = `工具执行失败：参数不是合法 JSON 对象（${errorMessage(error)}）`;
            isError = true;
          }
          if (!isError) {
            this.events.publish({
              type: 'agent.activity',
              taskId: params.taskId,
              turnId: params.turnId,
              agentId: agent.id,
              detail: `调用工具 ${call.name}`,
            });
            try {
              const result = await tool.execute(args, context);
              if (typeof result === 'string') {
                resultText = result;
              } else {
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
          return { status: 'aborted', finalText: '', handoff: null, error: '任务已终止', iterations: iteration };
        }
        resultText = truncateText(resultText, settings.maxToolOutputChars);
        const toolMessage = this.store.appendMessage(params.conversationId, {
          role: 'tool',
          content: resultText,
          toolCallId: call.id,
          name: call.name,
          images: resultImages,
          meta: {
            kind: 'tool_result',
            toolName: call.name,
            toolStatus: isError ? 'error' : 'ok',
          },
        });
        history.push({
          role: 'tool',
          content: resultText,
          toolCallId: call.id,
          name: call.name,
          ...(resultImages.length > 0 ? { images: resultImages } : {}),
        });
        this.events.publish({
          type: 'message.appended',
          taskId: params.taskId,
          turnId: params.turnId,
          messageId: toolMessage.id,
        });
        if (context.completed) {
          return {
            status: 'completed',
            finalText: response.content?.trim() || '',
            handoff: context.completed,
            error: null,
            iterations: iteration,
          };
        }
      }
    }
  }

  private waitForIdle(agentId: string, signal: AbortSignal): Promise<void> {
    if (!this.busy.has(agentId)) return Promise.resolve();
    if (signal.aborted) return Promise.reject(new AppError(409, '已终止'));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.idleEvents.off(agentId, onIdle);
        signal.removeEventListener('abort', onAbort);
      };
      const onIdle = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(new AppError(409, '已终止'));
      };
      this.idleEvents.once(agentId, onIdle);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
