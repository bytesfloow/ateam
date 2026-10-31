import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MockProvider } from './helpers/MockProvider';
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  LlmError,
  OpenAiCompatibleProvider,
  isContentFilterRefusal,
  isContextOverflowError,
  parseUsage,
  thinkingBodyParams,
  type LlmMessage,
  type LlmProgress,
  type LlmRequest,
  type LlmRequestMeta,
  type LlmToolSpec,
} from '../server/src/llm';

describe('thinking body params', () => {
  it('maps DeepSeek dialect to thinking + reasoning_effort', () => {
    expect(
      thinkingBodyParams('https://api.deepseek.com/v1', 'deepseek-chat', { deepThinking: true, thinkingLevel: 'high' }),
    ).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
    expect(
      thinkingBodyParams('https://api.deepseek.com/v1', 'deepseek-chat', { deepThinking: false, thinkingLevel: 'low' }),
    ).toEqual({ thinking: { type: 'disabled' } });
  });

  it('maps Qwen / DashScope dialect to enable_thinking', () => {
    expect(
      thinkingBodyParams('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-max', {
        deepThinking: true,
        thinkingLevel: 'medium',
      }),
    ).toEqual({ chat_template_kwargs: { enable_thinking: true }, reasoning_effort: 'medium' });
    expect(
      thinkingBodyParams('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-max', {
        deepThinking: false,
        thinkingLevel: 'medium',
      }),
    ).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });

  it('only sends reasoning_effort for other OpenAI-compatible providers', () => {
    // 思考级别取值随模型而异，任意合法取值应原样透传（如 OpenAI 的 xhigh / max）。
    expect(
      thinkingBodyParams('https://api.openai.com/v1', 'gpt-5-mini', { deepThinking: true, thinkingLevel: 'xhigh' }),
    ).toEqual({ reasoning_effort: 'xhigh' });
    expect(
      thinkingBodyParams('https://api.openai.com/v1', 'gpt-5-mini', { deepThinking: false, thinkingLevel: 'high' }),
    ).toEqual({});
  });
});

describe('parseUsage', () => {
  it('returns undefined when the provider sends no usage', () => {
    expect(parseUsage(undefined)).toBeUndefined();
    expect(parseUsage({})).toBeUndefined();
  });
  it('parses the OpenAI shape with token details', () => {
    expect(
      parseUsage({
        prompt_tokens: 1200,
        completion_tokens: 300,
        total_tokens: 1500,
        prompt_tokens_details: { cached_tokens: 800 },
        completion_tokens_details: { reasoning_tokens: 120 },
      }),
    ).toEqual({ promptTokens: 1200, completionTokens: 300, reasoningTokens: 120, cachedTokens: 800, totalTokens: 1500 });
  });

  it('parses DeepSeek cache fields and keeps reasoning as a subset of completion', () => {
    const usage = parseUsage({
      prompt_tokens: 50,
      completion_tokens: 9,
      total_tokens: 59,
      prompt_cache_hit_tokens: 20,
      prompt_cache_miss_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 16 },
    });
    expect(usage).toEqual({
      promptTokens: 50,
      completionTokens: 9,
      reasoningTokens: 16,
      cachedTokens: 20,
      totalTokens: 59,
    });
    // reasoning 是 completion 的子集：总量仍取 total_tokens，不重复累加
    expect(usage!.totalTokens).toBeLessThan(usage!.promptTokens + usage!.completionTokens + usage!.reasoningTokens);
  });

  it('falls back to the sum when total_tokens is missing (Qwen minimal shape)', () => {
    expect(parseUsage({ prompt_tokens: 40, completion_tokens: 20 })).toEqual({
      promptTokens: 40,
      completionTokens: 20,
      reasoningTokens: 0,
      cachedTokens: 0,
      totalTokens: 60,
    });
  });
});

describe('LlmRequestMeta', () => {
  it('exposes only pipeline-oriented fields', () => {
    const meta = metaOf();
    expect(Object.keys(meta).sort()).toEqual([
      'agentName',
      'iteration',
      'nextAgentNames',
      'taskId',
      'terminal',
      'turnId',
      'turnSeq',
    ]);
    expect(meta).not.toHaveProperty('handoffAgentNames');
    expect(meta).not.toHaveProperty('handoffHuman');
  });
});

describe('mock provider pipeline meta', () => {
  function mockRequest(meta: LlmRequestMeta, messages: LlmMessage[] = [{ role: 'user', content: '写一份方案' }]) {
    return {
      model: 'mock',
      temperature: 0,
      messages,
      tools: MOCK_TOOL_SPECS,
      meta,
    } satisfies LlmRequest;
  }

  const handoffHistory: LlmMessage[] = [
    { role: 'user', content: '写一份方案' },
    {
      role: 'assistant',
      content: '先写交付文件',
      toolCalls: [{ id: 'call_1', name: 'write', arguments: '{}' }],
    },
    { role: 'tool', content: '已写入 output/说明.md', toolCallId: 'call_1', name: 'write' },
  ];

  it('uses turnSeq and iteration to build the deliverable', async () => {
    const response = await new MockProvider().complete(
      mockRequest(
        metaOf({
          agentName: 'Mock甲',
          turnSeq: 3,
          iteration: 1,
          nextAgentNames: ['改写'],
          terminal: false,
        }),
      ),
    );

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0].name).toBe('write');
    const args = JSON.parse(response.toolCalls[0].arguments) as { file_path: string; content: string };
    expect(args.file_path).toBe('output/说明.md');
    expect(args.content).toContain('第 3 环节');
    expect(args.content).toContain('智能体：Mock甲');
  });

  it('picks target from nextAgentNames only when there are multiple candidates', async () => {
    const multi = await new MockProvider().complete(
      mockRequest(metaOf({ turnSeq: 2, iteration: 2, nextAgentNames: ['乙', '丙'], terminal: false }), handoffHistory),
    );
    expect(multi.toolCalls[0].name).toBe('handoff');
    const multiArgs = JSON.parse(multi.toolCalls[0].arguments) as {
      folder: string;
      target?: string;
      summary?: string;
      deliverables?: unknown;
    };
    expect(multiArgs.folder).toBe('output');
    expect(multiArgs.target).toBe('乙');
    expect(multiArgs.summary).toBeUndefined();
    expect(multiArgs.deliverables).toBeUndefined();

    const terminal = await new MockProvider().complete(
      mockRequest(metaOf({ turnSeq: 2, iteration: 2, nextAgentNames: [], terminal: true }), handoffHistory),
    );
    const terminalArgs = JSON.parse(terminal.toolCalls[0].arguments) as { folder: string; target?: string };
    expect(terminalArgs.folder).toBe('output');
    expect(terminalArgs.target).toBeUndefined();
  });
});

describe('isContextOverflowError', () => {
  it('recognizes provider context-length errors', () => {
    expect(isContextOverflowError(new LlmError('This model maximum context length is 128000 tokens', 400))).toBe(true);
    expect(isContextOverflowError(new LlmError('error code: 400 context_length_exceeded', 400))).toBe(true);
    expect(isContextOverflowError(new LlmError('输入过长，请缩短后重试', 400))).toBe(true);
  });

  it('does not retry unrelated errors', () => {
    expect(isContextOverflowError(new LlmError('模型服务鉴权失败（401）', 401))).toBe(false);
    expect(isContextOverflowError(new LlmError('模型服务暂时不可用（500）', 500))).toBe(false);
    expect(isContextOverflowError(new LlmError('Invalid request: unknown field', 400))).toBe(false);
    expect(isContextOverflowError(new Error('socket hang up'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 流式请求 / 超时 / 重试                                              */
/* ------------------------------------------------------------------ */

interface TestServer {
  baseUrl: string;
  requests: { body: Record<string, unknown> | null; auth: string | undefined }[];
  close: () => Promise<void>;
}

const servers: TestServer[] = [];

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, unknown> | null) => void,
): Promise<TestServer> {
  const requests: TestServer['requests'] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = null;
      }
      requests.push({ body, auth: req.headers.authorization });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

function providerFor(
  baseUrl: string,
  extra: Partial<{ requestTimeoutMs: number; attempts: number; stream: boolean }> = {},
) {
  return new OpenAiCompatibleProvider({
    baseUrl,
    apiKey: 'test-key',
    model: 'test-model',
    temperature: 0,
    ...extra,
  });
}

function requestOf(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'test-model',
    temperature: 0,
    messages: [{ role: 'user', content: 'ping' }],
    tools: [],
    meta: metaOf(),
    ...overrides,
  };
}

/** 新模型下的请求元数据：只描述流水线定位，不再携带环节名称与交接对象白名单。 */
function metaOf(overrides: Partial<LlmRequestMeta> = {}): LlmRequestMeta {
  return {
    agentName: 'tester',
    taskId: 'task',
    turnId: 'turn',
    turnSeq: 1,
    nextAgentNames: [],
    terminal: true,
    iteration: 1,
    ...overrides,
  };
}

const MOCK_TOOL_SPECS: LlmToolSpec[] = ['write', 'handoff'].map((name) => ({
  type: 'function' as const,
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
}));

function sse(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

describe('streaming request', () => {
  it('assembles content, tool calls and usage from SSE deltas', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sse(res, { choices: [{ delta: { reasoning_content: '先想一想' } }] });
      sse(res, { choices: [{ delta: { content: '你好' } }] });
      sse(res, { choices: [{ delta: { content: '，世界' } }] });
      sse(res, {
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read', arguments: '{"file_path":' } }] } }],
      });
      sse(res, {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }],
      });
      sse(res, {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
      res.write('data: [DONE]\n\n');
      res.end();
    });
    servers.push(server);

    const progress: LlmProgress[] = [];
    const response = await providerFor(server.baseUrl).complete(requestOf({ onProgress: (info) => progress.push(info) }));

    expect(response.content).toBe('你好，世界');
    expect(response.toolCalls).toEqual([{ id: 'call_a', name: 'read', arguments: '{"file_path":"a.txt"}' }]);
    expect(response.usage).toMatchObject({ promptTokens: 10, completionTokens: 20, totalTokens: 30 });

    const body = server.requests[0].body;
    expect(body?.stream).toBe(true);
    expect(body?.stream_options).toEqual({ include_usage: true });
    expect(server.requests[0].auth).toBe('Bearer test-key');

    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1].contentChars).toBe(5);
    expect(progress[progress.length - 1].reasoningChars).toBe(4);
    // 工具调用参数被拆成两个 delta 到达，进度里要能看到累计字符数（{"file_path":"a.txt"} 共 21 字符）
    expect(progress[progress.length - 1].toolChars).toBe(21);
  });

  it('falls back to a full JSON body when the server ignores stream', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '普通响应', tool_calls: [] } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      );
    });
    servers.push(server);

    const response = await providerFor(server.baseUrl).complete(requestOf());
    expect(response.content).toBe('普通响应');
    expect(response.usage?.totalTokens).toBe(3);
  });

  it('drops stream_options when the provider rejects it', async () => {
    const server = await startServer((_req, res, body) => {
      if (body && 'stream_options' in body) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: stream_options' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sse(res, { choices: [{ delta: { content: '去掉 stream_options 后可用' } }] });
      res.write('data: [DONE]\n\n');
      res.end();
    });
    servers.push(server);

    const response = await providerFor(server.baseUrl).complete(requestOf());
    expect(response.content).toBe('去掉 stream_options 后可用');
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1].body?.stream_options).toBeUndefined();
    expect(server.requests[1].body?.stream).toBe(true);
  });

  it('keeps total-timeout semantics for non-streaming requests', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '非流式' } }] }));
    });
    servers.push(server);

    const response = await providerFor(server.baseUrl, { stream: false }).complete(requestOf());
    expect(response.content).toBe('非流式');
    expect(server.requests[0].body?.stream).toBe(false);
  });
});

describe('content safety refusal', () => {
  const refusal = 'The request was rejected because it was considered high risk';

  it('matches only the exact refusal text or a content_filter finish reason', () => {
    expect(isContentFilterRefusal(refusal)).toBe(true);
    expect(isContentFilterRefusal(`\n ${refusal} \n`)).toBe(true);
    expect(isContentFilterRefusal('', 'content_filter')).toBe(true);
    expect(isContentFilterRefusal('正常回复')).toBe(false);
    expect(isContentFilterRefusal('The risk is high, but the plan still works.')).toBe(false);
  });

  it('turns a refusal delivered as normal stream content into a retryable error', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sse(res, { choices: [{ delta: { content: refusal } }] });
      sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      res.end();
    });
    servers.push(server);

    await expect(providerFor(server.baseUrl).complete(requestOf())).rejects.toThrow(/内容安全审查/);
    // 可重试错误：默认尝试 2 次，避免一次误判就暂停整条流水线
    expect(server.requests).toHaveLength(2);
  });

  it('treats finish_reason=content_filter as an error in non-streaming responses', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }));
    });
    servers.push(server);

    await expect(providerFor(server.baseUrl, { stream: false, attempts: 1 }).complete(requestOf())).rejects.toThrow(
      /content_filter/,
    );
  });

  it('maps HTTP 421 content blocking to the same error', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(421, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'blocked by moderation' } }));
    });
    servers.push(server);

    await expect(providerFor(server.baseUrl, { attempts: 1 }).complete(requestOf())).rejects.toThrow(/内容安全审查/);
  });
});

describe('timeout & retry', () => {
  it('defaults to a 10 minute model request timeout', () => {
    expect(DEFAULT_LLM_REQUEST_TIMEOUT_MS).toBe(600_000);
  });

  it('retries once after a timeout and succeeds', async () => {
    let calls = 0;
    const server = await startServer((_req, res) => {
      calls += 1;
      if (calls === 1) return; // 第一次永不响应，交给超时中断
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '第二次成功' } }] }));
    });
    servers.push(server);

    const response = await providerFor(server.baseUrl, { requestTimeoutMs: 200 }).complete(requestOf());
    expect(response.content).toBe('第二次成功');
    expect(server.requests).toHaveLength(2);
  });

  it('gives the retry a 1.5x budget and reports the attempt count', async () => {
    const server = await startServer(() => {
      /* 两次都不响应 */
    });
    servers.push(server);
    const started = Date.now();

    await expect(providerFor(server.baseUrl, { requestTimeoutMs: 150 }).complete(requestOf())).rejects.toThrow(
      /模型请求超时（0\.2 秒内没有新数据）（共尝试 2 次）/,
    );
    expect(server.requests).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('does not retry a non-retryable error such as 401', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid key' } }));
    });
    servers.push(server);

    await expect(providerFor(server.baseUrl, { requestTimeoutMs: 200 }).complete(requestOf())).rejects.toThrow(
      /鉴权失败/,
    );
    expect(server.requests).toHaveLength(1);
  });
});
