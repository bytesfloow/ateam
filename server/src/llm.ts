import { randomUUID } from 'node:crypto';
import type { AttachedImage, ThinkingLevel, TokenUsage } from '../../shared/types';

export interface LlmToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmMessage {
  role: LlmRole;
  content: string | null;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
  name?: string;
  /** 工具结果附带的图片（read_image）；发送时 content 转为 text + image_url 的多模态数组。 */
  images?: AttachedImage[];
}

export interface LlmRequestMeta {
  agentName: string;
  taskId: string;
  turnId: string;
  /** 第几个环节（1 开始）。 */
  turnSeq: number;
  /** 出边指向的交接对象（智能体名称）；空数组表示流水线终点。 */
  nextAgentNames: string[];
  /** 是否流水线终点（交付文件夹交给用户验收）。 */
  terminal: boolean;
  iteration: number;
}

/** 单次模型请求的默认超时（毫秒）：流式为「无新数据」的空闲超时，非流式为整体超时。 */
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 600_000;
export const MIN_LLM_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_LLM_REQUEST_TIMEOUT_MS = 3_600_000;

/** 生成过程中的增量进度，用于给前端心跳（不落库）。 */
export interface LlmProgress {
  /** 已生成的正文长度（字符）。 */
  contentChars: number;
  /** 已生成的思考内容长度（字符）；服务端不返回 reasoning 时恒为 0。 */
  reasoningChars: number;
  /** 已流式到达的工具调用参数字符数——生成大文件时的主要进度来源。 */
  toolChars: number;
  /** 本次请求已耗时（毫秒）。 */
  elapsedMs: number;
  /** 截至本次回调累计的正文文本；供对话类界面做流式上屏。 */
  contentText: string;
  /** 截至本次回调累计的思考文本；服务端不返回 reasoning 时为空串。 */
  reasoningText: string;
}

export interface LlmRequest {
  model: string;
  temperature: number;
  messages: LlmMessage[];
  tools: LlmToolSpec[];
  signal?: AbortSignal;
  meta: LlmRequestMeta;
  /** 流式生成过程中周期性回调（已做节流，默认约 500ms 一次）。 */
  onProgress?: (progress: LlmProgress) => void;
  /** onProgress 的节流间隔（毫秒）；默认 500，最小按 50 处理。 */
  progressIntervalMs?: number;
}

export interface LlmResponse {
  content: string;
  toolCalls: LlmToolCall[];
  /** 接口返回的真实 token 消耗；接口未返回时为空。 */
  usage?: TokenUsage;
  /** 模型思考内容（reasoning）；服务端未返回时为空。仅供展示，不写回模型历史。 */
  reasoning?: string;
}

export interface LlmProvider {
  readonly id: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  readonly status?: number;
  /** 是否为可重试的瞬时故障（超时 / 限流 / 服务端 5xx）。 */
  readonly retryable: boolean;

  constructor(message: string, status?: number, options?: { retryable?: boolean }) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryable = options?.retryable ?? false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把毫秒预算渲染成「180」「600」「1.5」这样的秒数。 */
function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /** 是否开启深度思考；未配置时按关闭处理（不附带推理参数）。 */
  deepThinking?: boolean;
  /** 深度思考级别；未配置时取 medium。 */
  thinkingLevel?: ThinkingLevel;
  /**
   * 单次模型请求的超时（毫秒），默认 {@link DEFAULT_LLM_REQUEST_TIMEOUT_MS}。
   * 流式请求下是「多久没有新数据就判定卡死」，非流式请求下是整体上限；0 表示不限制。
   */
  requestTimeoutMs?: number;
  /** 是否为可重试错误自动重试，默认 2 次（第二次预算为 1.5 倍）。 */
  attempts?: number;
  /** 是否使用 SSE 流式请求，默认 true；服务端不支持时自动回退。 */
  stream?: boolean;
}

function toInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return undefined;
}

/**
 * 解析 Chat Completions 返回的真实 token 消耗（非估算），兼容三种字段形态：
 * - OpenAI：`prompt_tokens_details.cached_tokens` / `completion_tokens_details.reasoning_tokens`
 * - DeepSeek：另有 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 * - 通义 / Qwen（OpenAI 兼容）：可能省略 `total_tokens`
 * `reasoning_tokens` 是 `completion_tokens` 的子集，不重复累加。
 */
export function parseUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const data = raw as Record<string, unknown>;
  const promptTokens = toInt(data.prompt_tokens);
  const completionTokens = toInt(data.completion_tokens);
  if (promptTokens === undefined && completionTokens === undefined) return undefined;
  const promptDetails =
    data.prompt_tokens_details && typeof data.prompt_tokens_details === 'object'
      ? (data.prompt_tokens_details as Record<string, unknown>)
      : {};
  const completionDetails =
    data.completion_tokens_details && typeof data.completion_tokens_details === 'object'
      ? (data.completion_tokens_details as Record<string, unknown>)
      : {};
  const prompt = promptTokens ?? 0;
  const completion = completionTokens ?? 0;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    reasoningTokens: toInt(completionDetails.reasoning_tokens) ?? 0,
    cachedTokens: toInt(promptDetails.cached_tokens) ?? toInt(data.prompt_cache_hit_tokens) ?? 0,
    totalTokens: toInt(data.total_tokens) ?? prompt + completion,
  };
}

/** 典型的“上下文超限”报错特征（400/413 + 文案）。 */
const CONTEXT_OVERFLOW_PATTERNS = [
  /context[_ ]length/i,
  /maximum context/i,
  /context window/i,
  /too many tokens/i,
  /reduce the length/i,
  /输入.{0,8}(过长|超长|超出)/,
  /上下文.{0,8}(超|过)(出|长|限)/,
];

/** 判断模型报错是否为上下文超限（用于压缩后重试）。 */
export function isContextOverflowError(error: unknown): boolean {
  const status = error instanceof LlmError ? error.status : undefined;
  if (status !== undefined && status !== 400 && status !== 413) return false;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}

/** 内容安全审查的 error type：Kimi 用 content_filter，少数网关写作 content-filter。 */
const CONTENT_FILTER_TYPE = /^content[_-]?filter$/i;

/**
 * 服务商内容安全审查的固定拒答文案。部分网关并不返回错误码，而是把它当作一次正常的
 * 模型回复（HTTP 200、无 usage、无 tool_calls）塞回客户端——若不识别，运行时会把
 * 它当成「智能体结束了但没有交接」，掩盖真正的原因。
 */
const CONTENT_FILTER_REFUSAL = 'The request was rejected because it was considered high risk';

/** 判断一次响应是否为内容安全审查拦截，而不是模型真的完成了回答。 */
export function isContentFilterRefusal(
  content: string | null | undefined,
  finishReason?: string | null,
): boolean {
  if (finishReason && CONTENT_FILTER_TYPE.test(finishReason)) return true;
  const text = (content ?? '').trim();
  return text.length > 0 && text.toLowerCase() === CONTENT_FILTER_REFUSAL.toLowerCase();
}

function contentFilterError(detail?: string): LlmError {
  const reason = (detail ?? '').trim();
  const extra =
    reason && reason.toLowerCase() !== CONTENT_FILTER_REFUSAL.toLowerCase() ? `（${reason.slice(0, 200)}）` : '';
  return new LlmError(
    `模型服务的内容安全审查拒绝了本次请求（content_filter）${extra}。` +
      '该拦截由服务商侧风控触发、偶发误判较多：可以直接重试本环节，或更换模型后重试。',
    undefined,
    { retryable: true },
  );
}

export interface ThinkingOptions {
  deepThinking: boolean;
  /** 取值随模型而异（如 none / minimal / low / medium / high / xhigh / max），原样透传给模型。 */
  thinkingLevel: ThinkingLevel;
}

/**
 * 深度思考参数按服务方言适配（依据 DeepSeek / OpenAI / 通义官方文档）：
 * - DeepSeek：`thinking: {type: enabled|disabled}`，开启时附带 `reasoning_effort`
 * - 通义 / Qwen：`chat_template_kwargs.enable_thinking`，开启时附带 `reasoning_effort`
 * - 其它 OpenAI 兼容服务：开启时附带 `reasoning_effort`，关闭时不传（保持默认行为）
 */
export function thinkingBodyParams(
  baseUrl: string,
  model: string,
  options: ThinkingOptions,
): Record<string, unknown> {
  const target = `${baseUrl} ${model}`.toLowerCase();
  const { deepThinking, thinkingLevel } = options;
  if (target.includes('deepseek')) {
    return deepThinking
      ? { thinking: { type: 'enabled' }, reasoning_effort: thinkingLevel }
      : { thinking: { type: 'disabled' } };
  }
  if (target.includes('qwen') || target.includes('dashscope') || target.includes('tongyi')) {
    return deepThinking
      ? { chat_template_kwargs: { enable_thinking: true }, reasoning_effort: thinkingLevel }
      : { chat_template_kwargs: { enable_thinking: false } };
  }
  return deepThinking ? { reasoning_effort: thinkingLevel } : {};
}

/** Normalizes a user supplied base URL to the chat completions endpoint. */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

function toApiMessage(message: LlmMessage): Record<string, unknown> {
  const base: Record<string, unknown> = { role: message.role, content: message.content ?? '' };
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    base.content = message.content ?? null;
    base.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  if (message.role === 'tool') {
    base.tool_call_id = message.toolCallId ?? '';
    if (message.name) base.name = message.name;
    const images = message.images ?? [];
    if (images.length > 0) {
      // 多模态工具结果：content 用 parts 数组承载文本 + 图片（OpenAI 兼容的 image_url 形态，data URL 内联）。
      base.content = [
        { type: 'text', text: message.content ?? '' },
        ...images.map((image) => ({
          type: 'image_url',
          image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` },
        })),
      ];
    }
  }
  return base;
}

function parseResponse(body: unknown): LlmResponse {
  const data = body as {
    choices?: {
      message?: {
        content?: string | null;
        tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
      };
      finish_reason?: string;
    }[];
    usage?: unknown;
    error?: { message?: string; type?: string; code?: string };
  };
  if (data.error) {
    if (data.error.type && CONTENT_FILTER_TYPE.test(data.error.type)) {
      throw contentFilterError(data.error.message);
    }
    throw new LlmError(data.error.message || '模型服务返回错误');
  }
  const choice = data.choices?.[0];
  if (!choice || !choice.message) {
    throw new LlmError('模型服务返回了空响应');
  }
  const calls = (choice.message.tool_calls ?? [])
    .filter((call) => call.function?.name)
    .map((call) => ({
      id: call.id || `call_${randomUUID().slice(0, 8)}`,
      name: call.function!.name!,
      arguments: call.function?.arguments || '{}',
    }));
  const content = choice.message.content ?? '';
  // 内容审查拦截可能伪装成一次正常回复，不能当成智能体的最终回答。
  if (calls.length === 0 && isContentFilterRefusal(content, choice.finish_reason)) {
    throw contentFilterError(content);
  }
  return {
    content,
    toolCalls: calls,
    usage: parseUsage(data.usage),
  };
}

function describeHttpError(status: number, bodyText: string): LlmError {
  let detail = bodyText.trim();
  let type = '';
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string; type?: string } };
    if (parsed.error?.message) detail = parsed.error.message;
    if (parsed.error?.type) type = parsed.error.type;
  } catch {
    /* keep raw text */
  }
  detail = detail.slice(0, 800);
  // 内容拦截：有的服务商用 400 + type=content_filter，MiMo 等则用专门的 421「内容拦截」。
  if (status === 421 || CONTENT_FILTER_TYPE.test(type)) {
    return contentFilterError(detail);
  }
  if (status === 401 || status === 403) {
    return new LlmError(`模型服务鉴权失败（${status}）：请检查 API Key。${detail}`, status);
  }
  if (status === 429) {
    return new LlmError(`模型服务请求过于频繁（429），请稍后重试。${detail}`, status, { retryable: true });
  }
  if (status >= 500) {
    return new LlmError(`模型服务暂时不可用（${status}）。${detail}`, status, { retryable: true });
  }
  return new LlmError(`模型请求失败（${status}）。${detail}`, status);
}

/* ------------------------------------------------------------------ */
/* 兼容性探测：部分 OpenAI 兼容服务不支持 stream 或 stream_options      */
/* ------------------------------------------------------------------ */

interface StreamCompat {
  stream: boolean;
  includeUsage: boolean;
}

/** 按「baseUrl|model」记住探测结果，避免每一轮都重复踩同一个坑。 */
const STREAM_COMPAT = new Map<string, StreamCompat>();

function compatFor(key: string): StreamCompat {
  let value = STREAM_COMPAT.get(key);
  if (!value) {
    value = { stream: true, includeUsage: true };
    STREAM_COMPAT.set(key, value);
  }
  return value;
}

/** 400/404/422 且报错文案命中关键字时，认为是「该参数不被支持」。 */
function isUnsupportedFieldError(error: LlmError, pattern: RegExp): boolean {
  if (error.status !== 400 && error.status !== 404 && error.status !== 422) return false;
  return pattern.test(error.message);
}

interface StreamEvent {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: unknown;
  error?: { message?: string; type?: string };
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = 'openai-compatible';
  private readonly config: OpenAiCompatibleConfig;

  constructor(config: OpenAiCompatibleConfig) {
    this.config = config;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const url = chatCompletionsUrl(this.config.baseUrl);
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toApiMessage),
      temperature: request.temperature,
      ...thinkingBodyParams(this.config.baseUrl, request.model, {
        deepThinking: this.config.deepThinking ?? false,
        thinkingLevel: this.config.thinkingLevel ?? 'medium',
      }),
    };
    if (request.tools.length > 0) {
      body.tools = request.tools;
      body.tool_choice = 'auto';
    }

    const attempts = Math.max(1, Math.round(this.config.attempts ?? 2));
    const baseTimeout = this.requestTimeoutMs();
    let lastError: LlmError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      // 第二次尝试给 1.5 倍预算：慢模型往往只是差一点点。
      const timeout = attempt === 1 ? baseTimeout : Math.round(baseTimeout * 1.5);
      try {
        return await this.sendOnce(request, body, url, timeout);
      } catch (error) {
        if (request.signal?.aborted) throw new LlmError('运行已被终止');
        const failure =
          error instanceof LlmError
            ? error
            : new LlmError(
                `无法连接模型服务：${error instanceof Error ? error.message : String(error)}`,
                undefined,
                { retryable: true },
              );
        if (!failure.retryable || attempt >= attempts) {
          if (failure.retryable && attempts > 1) {
            throw new LlmError(`${failure.message}（共尝试 ${attempts} 次）`, failure.status);
          }
          throw failure;
        }
        lastError = failure;
        await sleep(800 * attempt);
      }
    }
    throw lastError ?? new LlmError('模型请求失败');
  }

  /** 配置的超时预算（毫秒）；0 表示不限制。 */
  private requestTimeoutMs(): number {
    const configured = this.config.requestTimeoutMs;
    if (configured === undefined || configured === null || !Number.isFinite(configured)) {
      return DEFAULT_LLM_REQUEST_TIMEOUT_MS;
    }
    return configured <= 0 ? 0 : Math.round(configured);
  }

  private async sendOnce(
    request: LlmRequest,
    body: Record<string, unknown>,
    url: string,
    timeoutMs: number,
  ): Promise<LlmResponse> {
    const key = `${this.config.baseUrl}|${request.model}`;
    const compat = compatFor(key);
    const stream = (this.config.stream ?? true) && compat.stream;
    const payload: Record<string, unknown> = { ...body, stream };
    if (stream && compat.includeUsage) payload.stream_options = { include_usage: true };

    const controller = new AbortController();
    let timedOut = false;
    let idleTimer: NodeJS.Timeout | null = null;
    const arm = (): void => {
      if (timeoutMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    };
    // 流式请求下 idleTimer 是「无新数据」超时；再加一个整体上限，避免服务端用空 keep-alive 无限拖延。
    const overallTimer =
      stream && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs * 3)
        : null;
    arm();
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const error = describeHttpError(response.status, text);
        // 兼容性回退：先去掉 stream_options，仍报错则整体退回非流式。
        if (stream && compat.includeUsage && isUnsupportedFieldError(error, /stream_options|include_usage/i)) {
          compat.includeUsage = false;
          return await this.sendOnce(request, body, url, timeoutMs);
        }
        if (stream && isUnsupportedFieldError(error, /stream/i)) {
          compat.stream = false;
          return await this.sendOnce(request, body, url, timeoutMs);
        }
        throw error;
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!stream || !contentType.includes('text/event-stream')) {
        // 服务端忽略了 stream 参数，直接返回完整 JSON。
        const result = (await response.json()) as unknown;
        return parseResponse(result);
      }
      return await this.consumeStream(response, request, arm);
    } catch (error) {
      if (timedOut) {
        throw new LlmError(
          stream
            ? `模型请求超时（${formatSeconds(timeoutMs)} 秒内没有新数据）`
            : `模型请求超时（${formatSeconds(timeoutMs)} 秒）`,
          undefined,
          { retryable: true },
        );
      }
      if (request.signal?.aborted) throw new LlmError('运行已被终止');
      throw error;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (overallTimer) clearTimeout(overallTimer);
    }
  }

  /** 逐行消费 SSE，累积正文、工具调用与 usage。 */
  private async consumeStream(
    response: Response,
    request: LlmRequest,
    arm: () => void,
  ): Promise<LlmResponse> {
    const stream = response.body;
    if (!stream) throw new LlmError('模型服务返回了空响应');
    const decoder = new TextDecoder();
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    const startedAt = Date.now();
    let buffer = '';
    let content = '';
    let reasoningText = '';
    let reasoningChars = 0;
    let toolChars = 0;
    let usage: TokenUsage | undefined;
    let finishReason: string | null = null;
    let finished = false;
    let lastReport = 0;
    const progressIntervalMs = Math.max(50, request.progressIntervalMs ?? 500);

    const reportProgress = (now: number): void => {
      if (!request.onProgress) return;
      lastReport = now;
      request.onProgress({
        contentChars: content.length,
        reasoningChars,
        toolChars,
        elapsedMs: now - startedAt,
        contentText: content,
        reasoningText,
      });
    };

    const handleLine = (line: string): void => {
      const data = line.startsWith('data:') ? line.slice(5).trim() : '';
      if (!data) return;
      if (data === '[DONE]') {
        finished = true;
        return;
      }
      let event: StreamEvent;
      try {
        event = JSON.parse(data) as StreamEvent;
      } catch {
        return; // 容忍坏行（部分网关会插入非 JSON 心跳）
      }
      if (event.error) {
        if (event.error.type && CONTENT_FILTER_TYPE.test(event.error.type)) {
          throw contentFilterError(event.error.message);
        }
        throw new LlmError(event.error.message || '模型服务返回错误');
      }
      const chunkUsage = event.usage ? parseUsage(event.usage) : undefined;
      if (chunkUsage) usage = chunkUsage;
      const choice = event.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string') content += delta.content;
      const thought = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : delta.reasoning;
      if (typeof thought === 'string') {
        reasoningText += thought;
        reasoningChars += thought.length;
      }
      for (const call of delta.tool_calls ?? []) {
        const index = typeof call.index === 'number' ? call.index : calls.size;
        const entry = calls.get(index) ?? { id: '', name: '', arguments: '' };
        if (call.id) entry.id = call.id;
        if (call.function?.name && !entry.name) entry.name = call.function.name;
        if (typeof call.function?.arguments === 'string') {
          entry.arguments += call.function.arguments;
          toolChars += call.function.arguments.length;
        }
        calls.set(index, entry);
      }
    };

    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      arm();
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
        if (finished) break;
        index = buffer.indexOf('\n');
      }
      const now = Date.now();
      if (request.onProgress && now - lastReport >= progressIntervalMs) {
        reportProgress(now);
      }
      if (finished) break;
    }

    // 冲刷解码器与最后一行（服务端可能不发送结尾换行）。
    buffer += decoder.decode();
    if (!finished && buffer.trim()) handleLine(buffer);
    if (request.onProgress) {
      reportProgress(Date.now());
    }

    const toolCalls: LlmToolCall[] = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, call]) => call.name)
      .map(([, call]) => ({
        id: call.id || `call_${randomUUID().slice(0, 8)}`,
        name: call.name,
        arguments: call.arguments || '{}',
      }));
    // 网关把内容审查拦截当作正常正文返回时，这里必须报错而不是交给运行时当回答。
    if (toolCalls.length === 0 && isContentFilterRefusal(content, finishReason)) {
      throw contentFilterError();
    }
    if (!content.trim() && toolCalls.length === 0) {
      throw new LlmError('模型服务返回了空响应');
    }
    return { content, toolCalls, usage, ...(reasoningText ? { reasoning: reasoningText } : {}) };
  }
}

export function createProvider(config: {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  deepThinking?: boolean;
  thinkingLevel?: ThinkingLevel;
  requestTimeoutMs?: number;
}): LlmProvider {
  if (!config.apiKey) {
    throw new LlmError('尚未配置 API Key。请在「设置」中填写。');
  }
  return new OpenAiCompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    temperature: config.temperature,
    deepThinking: config.deepThinking,
    thinkingLevel: config.thinkingLevel,
    requestTimeoutMs: config.requestTimeoutMs,
  });
}

export async function testModelConnection(config: {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  deepThinking?: boolean;
  thinkingLevel?: ThinkingLevel;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ ok: true; message: string; latencyMs: number }> {
  const started = Date.now();
  if (!config.apiKey) throw new LlmError('尚未配置 API Key');
  const provider = new OpenAiCompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    temperature: 0,
    deepThinking: config.deepThinking,
    thinkingLevel: config.thinkingLevel,
    // 连接测试最多等 30 秒，只试一次，避免用户在设置页干等。
    requestTimeoutMs: Math.min(config.requestTimeoutMs ?? 30_000, 30_000),
    attempts: 1,
  });
  const response = await provider.complete({
    model: config.model,
    temperature: 0,
    messages: [
      { role: 'system', content: '你是连通性测试助手。只回复“OK”。' },
      { role: 'user', content: 'ping' },
    ],
    tools: [],
    signal: config.signal,
    meta: {
      agentName: 'test',
      taskId: 'test',
      turnId: 'test',
      turnSeq: 1,
      nextAgentNames: [],
      terminal: true,
      iteration: 0,
    },
  });
  return {
    ok: true,
    message: `连接成功，模型返回：${(response.content || '（空）').slice(0, 80)}`,
    latencyMs: Date.now() - started,
  };
}
