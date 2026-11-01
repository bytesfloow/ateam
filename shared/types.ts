/* Shared API / domain types used by both the server and the web client. */

export type IsoDate = string;

/* ------------------------------------------------------------------ */
/* Pipeline model                                                      */
/* ------------------------------------------------------------------ */

/**
 * 任务状态：
 * - running 执行中；
 * - paused 流水线在某个环节失败/中断，停在该环节等待用户决定重试或终止；
 * - waiting_human 终点环节已把产出交付给用户，等待验收；
 * - completed / failed / aborted 已结束。
 */
export type TaskStatus = 'running' | 'paused' | 'waiting_human' | 'completed' | 'failed' | 'aborted';

/** 一个环节（一个智能体的一次接手处理）的状态。 */
export type TurnStatus = 'running' | 'completed' | 'failed' | 'aborted';

/**
 * 流水线中的一个节点：节点即智能体。
 * 同一条流水线内每个智能体最多出现一次，不再有独立的「环节名称 / 职责」。
 */
export interface PipelineNode {
  /** 节点 ID，流水线内唯一。 */
  id: string;
  /** 承接本节点的智能体。 */
  agentId: string;
  /** 全流水线恰好一个起点：用户任务直接交给它（返工环下起点也可能有入线）。 */
  isStart: boolean;
  /** 画布坐标（保存布局用，运行时不参与决策）。 */
  x: number;
  y: number;
}

/**
 * 一条带箭头的连线：上游节点完成后交接给下游节点。
 * - triggerPrompt：任务触发提示词，交接时由系统替换占位符后作为下游的 user prompt 注入；
 * - handoffCondition：交接条件，当源节点有多条出边时必填，注入源节点智能体的系统提示词。
 */
export interface PipelineEdge {
  id: string;
  /** 源节点 ID。 */
  from: string;
  /** 目标节点 ID。 */
  to: string;
  /** 任务触发提示词（必填）。支持占位符 {deliverables} / {task} / {sender}。 */
  triggerPrompt: string;
  /** 交接条件：什么情况下走这条线交给对方；源节点出边 ≥2 时每条出边必填。 */
  handoffCondition: string;
}

/** 流水线定义：智能体节点 + 带箭头的连线（可分支、可返工）。 */
export interface Pipeline {
  id: string;
  name: string;
  description: string;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface PipelineNodeInput {
  /** 编辑已有节点时沿用原 ID；新增节点留空由服务端生成。 */
  id?: string;
  agentId: string;
  isStart?: boolean;
  x?: number;
  y?: number;
}

export interface PipelineEdgeInput {
  id?: string;
  from: string;
  to: string;
  triggerPrompt: string;
  handoffCondition?: string;
}

export interface PipelineInput {
  name: string;
  description?: string;
  nodes: PipelineNodeInput[];
  edges?: PipelineEdgeInput[];
}

/**
 * 一个环节的交接目标：
 * - agent：下游节点的智能体；
 * - human：终点节点的产出交给用户验收。
 */
export type HandoffTargetType = 'agent' | 'human';

/** 交接完成后写入回合记录的目标（含解析出的节点、智能体与所用连线）。 */
export interface HandoffTargetResolved {
  type: HandoffTargetType;
  nodeId?: string;
  agentId?: string;
  agentName?: string;
  /** 本环节实际使用的连线（多候选时用于确定触发提示词）。 */
  edgeId?: string;
}

/* ------------------------------------------------------------------ */
/* Pipeline graph helpers（前后端共用）                                  */
/* ------------------------------------------------------------------ */

export function findNode(pipeline: Pipeline, nodeId: string): PipelineNode | null {
  return pipeline.nodes.find((node) => node.id === nodeId) ?? null;
}

export function findEdge(pipeline: Pipeline, edgeId: string | undefined | null): PipelineEdge | null {
  if (!edgeId) return null;
  return pipeline.edges.find((edge) => edge.id === edgeId) ?? null;
}

/** 从某节点出发的全部连线（按连线定义顺序）。 */
export function outgoingEdges(pipeline: Pipeline, nodeId: string): PipelineEdge[] {
  return pipeline.edges.filter((edge) => edge.from === nodeId);
}

/** 汇入某节点的全部连线。 */
export function incomingEdges(pipeline: Pipeline, nodeId: string): PipelineEdge[] {
  return pipeline.edges.filter((edge) => edge.to === nodeId);
}

/** 终点节点：没有任何出边，产出交给用户验收。 */
export function isTerminalNode(pipeline: Pipeline, nodeId: string): boolean {
  return outgoingEdges(pipeline, nodeId).length === 0;
}

/** 起点节点：显式标记（全流水线恰好一个）；历史/单节点数据回退到「无入边的唯一节点」。 */
export function findStartNode(pipeline: Pipeline): PipelineNode | null {
  if (pipeline.nodes.length === 0) return null;
  const marked = pipeline.nodes.filter((node) => node.isStart);
  if (marked.length === 1) return marked[0];
  if (marked.length > 1) return null;
  if (pipeline.nodes.length === 1) return pipeline.nodes[0];
  const withIn = new Set(pipeline.edges.map((edge) => edge.to));
  const starts = pipeline.nodes.filter((node) => !withIn.has(node.id));
  return starts.length === 1 ? starts[0] : null;
}

/**
 * 从起点按 BFS 展开的节点顺序，用于进度展示（分支图没有天然的线性顺序）。
 */
export function bfsNodeOrder(pipeline: Pipeline): PipelineNode[] {
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
  // 兜底：把因数据异常（如多起点）未覆盖的节点补在末尾。
  for (const node of pipeline.nodes) {
    if (!visited.has(node.id)) order.push(node);
  }
  return order;
}

/** 触发提示词占位符替换：未识别的 {xxx} 原样保留。 */
export function renderTriggerPrompt(
  template: string,
  values: { deliverables: string; task: string; sender: string },
): string {
  return template
    .replace(/\{\s*deliverables\s*\}/g, values.deliverables)
    .replace(/\{\s*task\s*\}/g, values.task)
    .replace(/\{\s*sender\s*\}/g, values.sender);
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/** 深度思考级别，映射为模型的推理力度参数（如 reasoning_effort）。取值随模型而异，由用户自由填写。 */
export type ThinkingLevel = string;

/** 常见思考级别取值，仅作为输入建议，不做强约束。 */
export const THINKING_LEVEL_SUGGESTIONS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface LlmSettingsView {
  baseUrl: string;
  model: string;
  temperature: number;
  /** 是否开启深度思考（请求中附带推理参数）。 */
  deepThinking: boolean;
  /** 深度思考级别，deepThinking 开启时生效。 */
  thinkingLevel: ThinkingLevel;
  /** 模型最大上下文长度（token），默认 1,000,000（1M）。 */
  maxContextTokens: number;
  /** 单次模型请求超时（毫秒）：流式为「无新数据」超时，非流式为整体超时；0 = 不限制。 */
  requestTimeoutMs: number;
  apiKeySet: boolean;
  apiKeyHint: string;
}

export interface RuntimeSettings {
  toolTimeoutMs: number;
  commandTimeoutMs: number;
  maxToolOutputChars: number;
  maxFeedbackSnapshotMessages: number;
}

/** 联网搜索（web_search）配置视图：Key 只回显尾号，不回传原文。 */
export interface WebSearchSettingsView {
  /** 搜索服务 Base URL（当前固定支持 DeepSeek 搜索 API）。 */
  searchBaseUrl: string;
  searchApiKeySet: boolean;
  searchApiKeyHint: string;
  /** 未单独配置搜索 Key、且当前模型接入就是 DeepSeek 时，自动复用模型 Key。 */
  reusingLlmKey: boolean;
}

export interface AppSettings {
  llm: LlmSettingsView;
  runtime: RuntimeSettings;
  webSearch: WebSearchSettingsView;
  workspaceRoot: string;
  version: string;
}

export interface SettingsUpdate {
  llm?: {
    baseUrl?: string;
    model?: string;
    temperature?: number;
    deepThinking?: boolean;
    thinkingLevel?: ThinkingLevel;
    maxContextTokens?: number;
    /** 单次模型请求超时（毫秒），0 = 不限制。 */
    requestTimeoutMs?: number;
    /** New API key. `null` clears it. `undefined` keeps the current key. */
    apiKey?: string | null;
  };
  runtime?: Partial<RuntimeSettings>;
  webSearch?: {
    searchBaseUrl?: string;
    /** New search API key. `null` clears it（清空后回退为复用 DeepSeek 模型 Key）. */
    searchApiKey?: string | null;
  };
}

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

export interface AgentToolsConfig {
  builtin: string[];
  custom: string[];
}

export interface Agent {
  id: string;
  name: string;
  slug: string;
  description: string;
  /** 任务说明（必填）：写清本环节要做哪些事、做到什么程度；创建时缺省取自 description。 */
  responsibilities: string;
  /** 交付要求：这个岗位需要交付什么、以什么形式；留空则输出默认说明。 */
  deliverable: string;
  /** 工作指南：本岗位的工作方法与思考方式，留空则不出现在提示词中。 */
  guide: string;
  model: string | null;
  temperature: number | null;
  tools: AgentToolsConfig;
  skillIds: string[];
  accent: string;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

/** Lightweight agent shape embedded in turns / messages. */
export interface AgentSummary {
  id: string;
  name: string;
  slug: string;
  description: string;
  accent: string;
}

export interface AgentInput {
  name: string;
  description?: string;
  responsibilities?: string;
  deliverable?: string;
  guide?: string;
  model?: string | null;
  temperature?: number | null;
  tools?: Partial<AgentToolsConfig>;
  skillIds?: string[];
  accent?: string;
}

/* ------------------------------------------------------------------ */
/* Skills & tools                                                      */
/* ------------------------------------------------------------------ */

export interface SkillFile {
  /** 相对技能包根目录的 POSIX 路径，例如 scripts/render.js。 */
  path: string;
  size: number;
  /** 是否位于 scripts/ 下（可被 SKILL.md 以 {{script:文件名}} 引用）。 */
  script: boolean;
  /** 是否可直接按 UTF-8 文本编辑；二进制素材只支持下载与删除。 */
  text: boolean;
  updatedAt: IsoDate;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  files: SkillFile[];
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface SkillInput {
  name: string;
  description?: string;
  content?: string;
}

export type SkillFileEncoding = 'utf8' | 'base64';

export interface SkillFileInput {
  path: string;
  content: string;
  encoding?: SkillFileEncoding;
}

export interface SkillFileContent {
  file: SkillFile;
  encoding: SkillFileEncoding;
  content: string;
}

export interface SkillFileRenameInput {
  from: string;
  to: string;
}

export type JsonSchema = Record<string, unknown>;

export interface CustomTool {
  id: string;
  name: string;
  description: string;
  parameters: JsonSchema;
  code: string;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface CustomToolInput {
  name: string;
  description?: string;
  parameters?: JsonSchema;
  code?: string;
}

export interface BuiltinToolInfo {
  name: string;
  label: string;
  description: string;
  category: 'file' | 'shell' | 'web' | 'collaboration';
  /** JSON Schema 实际暴露给模型的参数定义；makeBuiltinTools 以此为单一数据源。 */
  parameters: JsonSchema;
  /** Only exposed when the agent has at least one enabled skill. */
  conditional?: 'skills';
}

/* ------------------------------------------------------------------ */
/* Tasks & turns                                                       */
/* ------------------------------------------------------------------ */

/**
 * 一个环节的交付单元：一个文件夹。
 * 交接时系统把整个文件夹递归复制到接收方工作区 `inbox/<发送方slug>/...` 下；
 * 终点环节复制到任务目录的 `final/` 下。绝不覆盖，同名时整个目录加 -v2 后缀。
 */
export interface HandoffFolder {
  /** 源目录路径，相对发送方在本任务中的工作区，例如 output。 */
  path: string;
  /** 目录名（path 的最后一段）。 */
  name: string;
  /** 目录内文件数量（含子目录）。 */
  files: number;
  /** 目录内文件总字节数。 */
  bytes: number;
  /** 已复制时的目标路径：交给智能体时相对接收方工作区（inbox/<发送方slug>/…）；终点时相对任务目录（final/…）。 */
  deliveredPath?: string;
  /** 接收方智能体 ID；target=human（终点）时为 'human'。 */
  deliveredTo?: string;
}

/** 交付文件夹内的单个文件（列表 / 预览用）。 */
export interface DeliverableFile {
  /** 相对发送方任务工作区的路径，例如 output/说明.md。 */
  path: string;
  name: string;
  size: number;
}

/** 任务中的一个环节：某个智能体对某个节点的一次接手处理。 */
export interface Turn {
  id: string;
  taskId: string;
  /** 从 1 开始的第几个环节。 */
  seq: number;
  /** 本环节对应的流水线节点（历史任务可能为空）。 */
  nodeId: string | null;
  agentId: string;
  agentName: string;
  agentAccent: string;
  status: TurnStatus;
  /** 本环节输入：首个环节为任务原文；后续为连线触发提示词（已替换占位符）。 */
  input: string;
  /** 本环节最后的文本回复（仅 UI 留档，不再注入下游）。 */
  output: string;
  /** 本环节交接出去的交付文件夹。 */
  handoffFolder: HandoffFolder | null;
  /** 交接目标（完成时写入）。 */
  target: HandoffTargetResolved | null;
  iterations: number;
  startedAt: IsoDate | null;
  finishedAt: IsoDate | null;
  error: string | null;
}

export interface TaskSummary {
  id: string;
  task: string;
  status: TaskStatus;
  startAgentId: string;
  /** 任务所属流水线（历史任务可能为空）。 */
  pipelineId: string | null;
  pipelineName: string;
  /** 当前所处节点；waiting_human 时指向产出交付给用户的终点节点。 */
  currentNodeId: string | null;
  /** 当前节点在「起点 BFS 顺序」中的序号（1 起）与节点总数，用于进度展示。 */
  pipelineStep: number;
  pipelineTotal: number;
  /** 当前环节 ID；paused 时指向失败的那一个环节。 */
  currentTurnId: string | null;
  /** 当前接手的智能体；waiting_human 时为 null（处理者是人类）。 */
  currentAgentId: string | null;
  currentAgentName: string | null;
  turnCount: number;
  error: string | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  finishedAt: IsoDate | null;
}

export interface TaskDetail extends TaskSummary {
  /** 任务启动时的流水线快照：后续编辑流水线不会影响进行中和历史任务。 */
  pipeline: Pipeline | null;
  turns: Turn[];
}

/** 交付物预览方式：文本直接返回内容；图片/PDF 由前端用 raw 地址展示；其余二进制只提供下载。 */
export type DeliverablePreviewKind = 'text' | 'image' | 'pdf' | 'binary';

/** 单个交付文件的在线预览数据（路径来自交付文件夹清单）。 */
export interface DeliverablePreview {
  /** 相对发送方任务工作区的路径。 */
  path: string;
  name: string;
  size: number;
  kind: DeliverablePreviewKind;
  mimeType: string;
  /** kind === 'text' 时的内容（UTF-8 解码，超限时截断）。 */
  content?: string;
  /** 文本内容超过预览上限被截断时为 true。 */
  truncated?: boolean;
}

export interface TaskStartInput {
  task: string;
  /** 本次任务要跑的流水线；起点节点是任务入口。 */
  pipelineId: string;
}

export interface TaskRetryInput {
  /** 重跑时给智能体的补充指示。 */
  note?: string;
}

export interface TurnDetail {
  turn: Turn;
  messages: ConversationMessage[];
  /** 本环节实际下发给模型的完整系统提示词（开始执行时按当时配置拼装并落库；尚未执行为 null）。 */
  systemPrompt: string | null;
  /** 本环节累计的真实 token 消耗（由各次模型调用返回的 usage 汇总）。 */
  usage: TokenUsage;
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

export interface ToolCallView {
  id: string;
  name: string;
  arguments: string;
}

/** 模型接口返回的真实 token 消耗（非估算）。 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** 思考 token，是 completionTokens 的子集，不重复累加。 */
  reasoningTokens: number;
  /** 命中缓存的输入 token（DeepSeek 记为 prompt_cache_hit_tokens）。 */
  cachedTokens: number;
  totalTokens: number;
}

export function emptyTokenUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0, totalTokens: 0 };
}

/** 汇总多次调用的真实 token 消耗。 */
export function sumTokenUsage(items: (TokenUsage | undefined | null)[]): TokenUsage {
  const total = emptyTokenUsage();
  for (const item of items) {
    if (!item) continue;
    total.promptTokens += item.promptTokens || 0;
    total.completionTokens += item.completionTokens || 0;
    total.reasoningTokens += item.reasoningTokens || 0;
    total.cachedTokens += item.cachedTokens || 0;
    total.totalTokens += item.totalTokens || 0;
  }
  return total;
}

export interface MessageMeta {
  kind: 'turn_input' | 'assistant' | 'tool_result' | 'final';
  toolName?: string;
  toolStatus?: 'ok' | 'error';
  /** assistant 消息记录产生它的那次模型调用的真实 token 消耗。 */
  usage?: TokenUsage;
  /** 本条消息是运行错误说明（展示为错误样式）。 */
  error?: boolean;
  /** 设计师用户消息附带的附件清单（文件已保存到设计师工作目录，模型按路径自行读取）。 */
  attachments?: DesignerAttachment[];
  /** 设计师助手消息的思考内容（模型 reasoning，仅供展示，不回传模型历史）。 */
  reasoning?: string;
  /** 产生本条用量时生效的压缩水位（seq ≤ 该值的消息未进入当次请求），供下次压缩规划精确还原上次载荷。 */
  compactedSeq?: number;
}

/**
 * 设计师对话的一个附件：
 * - 文件保存在设计师专属工作目录 `uploads/<sessionId>/` 下，不进入消息正文；
 * - 模型通过消息里的路径清单用 read / read_image 工具自行读取。
 */
export interface DesignerAttachment {
  /** 原始文件名（展示用，可能与存储文件名不同）。 */
  name: string;
  /** 相对设计师工作目录的存储路径，例如 uploads/<sessionId>/xxx.png。 */
  path: string;
  /** 文件字节数。 */
  size: number;
  /** 是否为图片（扩展名判断；前端据此渲染缩略图与预览）。 */
  image: boolean;
}

/** 工具结果附带的图片（如 read_image 读取的本地图片），以 base64 存档并作为多模态内容发给模型。 */
export interface AttachedImage {
  mimeType: string;
  dataBase64: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls: ToolCallView[];
  toolCallId: string | null;
  name: string | null;
  meta: MessageMeta;
  /** 工具结果附带的图片（base64）。仅为模型请求服务；对前端的响应中会被剥离。 */
  images: AttachedImage[];
  createdAt: IsoDate;
}

/* ------------------------------------------------------------------ */
/* Feedback                                                            */
/* ------------------------------------------------------------------ */

export interface FeedbackSnapshotMessage {
  role: string;
  content: string;
}

export interface FeedbackSnapshot {
  task?: string;
  turnSeq?: number;
  systemPrompt?: string;
  messages: FeedbackSnapshotMessage[];
}

export type FeedbackCategory =
  | 'prompt'
  | 'tool'
  | 'skill'
  | 'workflow'
  | 'agent'
  | 'environment'
  | 'other';
export type FeedbackSeverity = 'low' | 'medium' | 'high';
export type FeedbackStatus = 'open' | 'resolved' | 'ignored';

export interface Feedback {
  id: string;
  agentId: string | null;
  agentName: string;
  taskName: string;
  taskId: string | null;
  turnId: string | null;
  category: FeedbackCategory;
  severity: FeedbackSeverity;
  content: string;
  contextSnapshot: FeedbackSnapshot | null;
  status: FeedbackStatus;
  resolutionNote: string;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface FeedbackInput {
  category: FeedbackCategory;
  severity: FeedbackSeverity;
  content: string;
}

export interface FeedbackUpdate {
  status?: FeedbackStatus;
  resolutionNote?: string;
}

/* ------------------------------------------------------------------ */
/* Designer（流水线设计师）                                              */
/* ------------------------------------------------------------------ */

/** 流水线设计师的系统级智能体标识：slug 固定，全系统按它识别设计师。 */
export const DESIGNER_SLUG = 'designer';

/** 设计师对话单个附件的字节上限（与 read_image 的单图上限一致）。 */
export const DESIGNER_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

/** 设计师对话一条消息最多携带的附件数。 */
export const DESIGNER_MAX_ATTACHMENTS = 10;

/** 设计师工作目录浏览：单层目录的清单条目上限（超过标记 truncated）。 */
export const DESIGNER_WORKSPACE_LIST_MAX = 2000;

/** 设计师工作目录浏览：单个条目（文件或子目录）。 */
export interface DesignerWorkspaceEntry {
  /** 相对设计师工作目录的路径（正斜杠）。 */
  path: string;
  name: string;
  type: 'dir' | 'file';
  /** 文件字节数；目录为 0。 */
  size: number;
}

/** 设计师工作目录某一层的清单（文件夹在前、同类按名称排序）。 */
export interface DesignerWorkspaceListing {
  /** 当前目录相对设计师工作目录的路径（'' 表示根目录）。 */
  path: string;
  entries: DesignerWorkspaceEntry[];
  /** 超出单层清单上限被截断时为 true。 */
  truncated: boolean;
}

/** 设计师工作目录文件的在线预览数据（与交付物预览同一套能力）。 */
export type DesignerWorkspaceFilePreview = DeliverablePreview;

/** 设计师的一个会话：用户与设计师的唯一对话线程（系统只保留一条会话）。 */
export interface DesignerSession {
  id: string;
  title: string;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  /**
   * 上下文压缩水位：seq ≤ 该值的较早消息已摘要压缩，不再进入模型请求（界面仍完整展示）。
   * 摘要正文由服务端保存在会话上，并注入系统提示词。
   */
  compactedSeq: number;
  /** 当前「前情提要」正文（压缩产物；空串表示尚未压缩过）。 */
  summary: string;
}

/** 会话列表项：附消息数与最后一条消息预览。 */
export interface DesignerSessionSummary extends DesignerSession {
  messageCount: number;
  lastMessagePreview: string;
}

export interface DesignerMessage {
  id: string;
  sessionId: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls: ToolCallView[];
  toolCallId: string | null;
  name: string | null;
  meta: MessageMeta;
  images: AttachedImage[];
  createdAt: IsoDate;
}

/**
 * 设计师的一条变更操作。引用已有对象时优先用 id，也接受 name（按名称唯一解析）；
 * 同一次变更内 create 之后再引用，用 name（校验与应用都按变更顺序解析：
 * 仅可引用系统已有对象或前序变更创建的对象；先建后删、先删后引、后向引用都会被校验拒绝）。
 */
export type DesignerChangeOp =
  | { op: 'create_agent'; agent: AgentInput }
  | { op: 'update_agent'; agentId?: string; agentName?: string; agent: Partial<AgentInput> }
  | { op: 'delete_agent'; agentId?: string; agentName?: string }
  | { op: 'create_pipeline'; pipeline: PipelineInput }
  | { op: 'update_pipeline'; pipelineId?: string; pipelineName?: string; pipeline: PipelineInput }
  | { op: 'delete_pipeline'; pipelineId?: string; pipelineName?: string }
  | { op: 'create_tool'; tool: CustomToolInput & { name: string } }
  | { op: 'update_tool'; toolId?: string; toolName?: string; tool: Partial<CustomToolInput> }
  | { op: 'delete_tool'; toolId?: string; toolName?: string }
  | { op: 'create_skill'; skill: SkillInput & { name: string } }
  | { op: 'update_skill'; skillId?: string; skillName?: string; skill: Partial<SkillInput> }
  | { op: 'delete_skill'; skillId?: string; skillName?: string };

/**
 * 变更记录状态：设计师调用 apply_changes 直接执行后落档。
 * - applied：全部变更生效；failed：执行中断，error 里说明失败项与已生效清单。
 * - pending / rejected 是旧版「提案 + 界面确认」流程的遗留状态，仅为兼容历史数据保留。
 */
export type DesignerProposalStatus = 'pending' | 'applied' | 'rejected' | 'failed';

/** 一次对话式变更的留档：设计师经用户认可后直接执行，结果在此记录展示。 */
export interface DesignerProposal {
  id: string;
  sessionId: string;
  /** 触发本次变更的助手消息（变更卡片渲染在该消息下方）。 */
  messageId: string | null;
  title: string;
  /** 一句话说明这次变更要达成什么。 */
  summary: string;
  changes: DesignerChangeOp[];
  status: DesignerProposalStatus;
  /** 应用失败时的错误说明（含已成功应用的前序步骤）。 */
  error: string | null;
  createdAt: IsoDate;
  decidedAt: IsoDate | null;
}

export interface DesignerSessionDetail {
  session: DesignerSession;
  messages: DesignerMessage[];
  proposals: DesignerProposal[];
  /** 设计师运行时是否正忙（本会话或任意会话）。 */
  busy: boolean;
}

/** 设计师实际下发给模型的一个工具（按来源分组展示）。 */
export interface DesignerToolInfo {
  name: string;
  /** 内置工具的展示名（自定义 / 设计师专属工具没有）。 */
  label?: string;
  description: string;
  source: 'builtin' | 'custom' | 'designer';
  category?: 'file' | 'shell' | 'web' | 'collaboration';
}

/** 设计师会话的运行时信息（头部徽标展示用）。 */
export interface DesignerRuntimeInfo {
  /** 实际使用的模型（设计师档案覆盖或全局默认）。 */
  model: string;
  /** 是否开启深度思考（全局设置）。 */
  deepThinking: boolean;
  /** 深度思考级别（全局设置）。 */
  thinkingLevel: ThinkingLevel;
  /** 模型最大上下文长度（token）。 */
  maxContextTokens: number;
}

/** 设计师详情：实际下发给模型的系统提示词、工具与技能（实时生成）。 */
export interface DesignerProfile {
  agent: Agent;
  systemPrompt: string;
  tools: DesignerToolInfo[];
  skills: Skill[];
  runtime: DesignerRuntimeInfo;
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export interface ApiErrorBody {
  error: string;
  details?: unknown;
}

export interface RealtimeEvent {
  type:
    | 'task.created'
    | 'task.updated'
    | 'turn.updated'
    | 'agent.status'
    | 'agent.activity'
    | 'message.appended'
    | 'feedback.created'
    | 'feedback.updated'
    | 'settings.updated'
    | 'config.updated'
    | 'designer.session'
    | 'designer.message'
    | 'designer.status'
    | 'designer.delta'
    | 'designer.reasoning'
    | 'designer.proposal'
    | 'reset';
  taskId?: string;
  turnId?: string;
  agentId?: string;
  messageId?: string;
  feedbackId?: string;
  sessionId?: string;
  proposalId?: string;
  detail?: string;
  /** designer.delta / designer.reasoning：截至当前累计的正文或思考文本（整段替换，非增量拼接）。 */
  text?: string;
  at: IsoDate;
}

export interface StatusSnapshot {
  version: string;
  activeTask: TaskSummary | null;
  busyAgents: { agentId: string; agentName: string; turnId: string }[];
  openFeedback: number;
  /** 流水线设计师是否正在生成回复（由 system 路由合成；Runtime 自身不感知设计师）。 */
  designerBusy?: boolean;
}

export interface ResetResult {
  tasks: number;
  turns: number;
  messages: number;
}

export interface Stats {
  agents: number;
  skills: number;
  tools: number;
  tasks: number;
  openFeedback: number;
  activeTask: TaskSummary | null;
}

/**
 * 内置工具名（对齐 DeepSeek Harness 的工具体系）。
 * - bash / pwsh：两个 Shell 工具按平台可用性注册（Windows 上 pwsh 始终可用，bash 检测到 Git Bash 时可用）；
 * - handoff：流水线专属交接工具，由运行时强制启用，不进入智能体的工具开关列表。
 */
export const BUILTIN_TOOL_NAMES = [
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
  'submit_feedback',
  'load_skill',
  'handoff',
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export const FEEDBACK_CATEGORIES: { value: FeedbackCategory; label: string }[] = [
  { value: 'prompt', label: '提示词' },
  { value: 'tool', label: '工具' },
  { value: 'skill', label: '技能' },
  { value: 'workflow', label: '流程' },
  { value: 'agent', label: '智能体' },
  { value: 'environment', label: '运行环境' },
  { value: 'other', label: '其他' },
];

export const FEEDBACK_SEVERITIES: { value: FeedbackSeverity; label: string }[] = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];
