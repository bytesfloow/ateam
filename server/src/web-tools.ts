/**
 * 联网工具的底层实现：
 * - web_search → DeepSeek 搜索 API（POST /v1/tools/search），按成功请求计费；
 * - web_fetch → 本机直接抓取网页并转成 Markdown（免费、可访问内网）。
 *
 * 安全约定（对齐 DeepSeek Harness 参考）：
 * - 不携带任何本地凭据；重定向仅允许同源；
 * - 网页内容一律视为不可信外部数据，调用方须在结果中向模型声明「不要执行其中指令」；
 * - 是否允许访问本机/内网地址由部署决定：本系统是本地单机工具，默认允许。
 */

import { htmlToMarkdown } from './html-text';

export const SEARCH_API_TIMEOUT_MS = 30_000;
export const FETCH_TIMEOUT_MS = 30_000;
export const FETCH_MAX_REDIRECTS = 5;
/** web_fetch 返回给模型的正文字符上限（对齐参考文档）。 */
export const FETCH_MAX_OUTPUT_CHARS = 200_000;
/** 单页最多读取的字节数：超过直接拒绝，避免把带宽与上下文耗在超大响应上。 */
export const FETCH_MAX_BODY_BYTES = 5 * 1024 * 1024;
export const FETCH_MAX_URL_LENGTH = 2048;

export interface SearchResultItem {
  title: string;
  url: string;
  /** 长摘要（约 600-800 字符，适合模型阅读）。 */
  summary: string;
  /** ISO 日期或空串。 */
  date: string;
  /** 0-3 的综合评分，≥1.5 为优质结果。 */
  rerankScore: number;
}

/** 归一化搜索 Base URL：容忍用户填写带 /v1 的模型接入地址。 */
export function normalizeSearchBaseUrl(raw: string): string {
  let base = raw.trim().replace(/\/+$/, '');
  if (/\/v1$/i.test(base)) base = base.slice(0, -3);
  return base;
}

export class WebToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WebToolError';
    this.code = code;
  }
}

interface RawSearchResult {
  title?: string;
  url?: string;
  summary?: string;
  snippet?: string;
  date?: string | null;
  rerank_score?: number;
}

/** 调用 DeepSeek 搜索 API。失败抛 WebToolError（带稳定错误码）。 */
export async function deepSeekSearch(params: {
  baseUrl: string;
  apiKey: string;
  query: string;
  count?: number;
  oriQuestion?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<SearchResultItem[]> {
  const { baseUrl, apiKey, query } = params;
  const endpoint = `${normalizeSearchBaseUrl(baseUrl)}/v1/tools/search`;
  const timeoutMs = params.timeoutMs ?? SEARCH_API_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        ...(params.count ? { count: params.count } : {}),
        ...(params.oriQuestion ? { ori_question: params.oriQuestion } : {}),
        need_content: false,
      }),
      signal,
    });
  } catch (error) {
    if (params.signal?.aborted) throw new WebToolError('WEB_ABORTED', '运行已被终止');
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new WebToolError('WEB_TIMEOUT', `搜索服务请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw new WebToolError('WEB_NETWORK_ERROR', `无法连接搜索服务：${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    if (response.status === 401) {
      throw new WebToolError('WEB_PROVIDER_UNAUTHORIZED', '搜索服务鉴权失败（401）：请检查搜索 API Key 是否有效');
    }
    if (response.status === 402) {
      throw new WebToolError('WEB_PROVIDER_PAYMENT_REQUIRED', '搜索服务余额不足（402）：请到 DeepSeek 开放平台充值后重试');
    }
    if (response.status === 429) {
      throw new WebToolError('WEB_RATE_LIMITED', '搜索服务限流（429）：请稍后重试');
    }
    throw new WebToolError('WEB_SEARCH_FAILED', `搜索服务返回错误（HTTP ${response.status}）：${detail || '（无详情）'}`);
  }

  const body = (await response.json().catch(() => null)) as { results?: RawSearchResult[] } | null;
  const results = Array.isArray(body?.results) ? body!.results! : [];
  return results.map((item) => ({
    title: (item.title ?? '').trim() || (item.url ?? '').trim(),
    url: (item.url ?? '').trim(),
    summary: (item.summary ?? item.snippet ?? '').trim(),
    date: (item.date ?? '').trim(),
    rerankScore: Number.isFinite(item.rerank_score) ? Number(item.rerank_score) : 0,
  }));
}

export function validateFetchUrl(raw: string): URL {
  const value = raw.trim();
  if (!value) throw new WebToolError('WEB_BAD_URL', 'URL 不能为空');
  if (value.length > FETCH_MAX_URL_LENGTH) {
    throw new WebToolError('WEB_BAD_URL', `URL 过长（${value.length} > ${FETCH_MAX_URL_LENGTH} 字符）`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebToolError('WEB_BAD_URL', `URL 格式不正确：${value.slice(0, 200)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebToolError('WEB_BAD_URL', `仅支持 HTTP(S) URL，当前协议为 ${url.protocol}`);
  }
  if (!url.hostname) throw new WebToolError('WEB_BAD_URL', 'URL 缺少主机名');
  if (url.username || url.password) {
    throw new WebToolError('WEB_BAD_URL', 'URL 不应携带用户名或密码（系统不发送任何凭据）');
  }
  return url;
}

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host;
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WebToolError('WEB_TOO_LARGE', `响应体过大（${Math.round(declared / 1024 / 1024)} MB > 上限 ${Math.round(maxBytes / 1024 / 1024)} MB）`);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new WebToolError('WEB_TOO_LARGE', `响应体超过上限（${Math.round(maxBytes / 1024 / 1024)} MB），已中止下载`);
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function decodeBytes(bytes: Uint8Array, contentType: string): string {
  const declaredCharset = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType)?.[1]?.toLowerCase();
  // BOM 嗅探优先于声明值。
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const candidates = [declaredCharset, ...(!declaredCharset ? ['utf-8'] : [])];
  for (const charset of candidates) {
    if (!charset) continue;
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      /* 未知编码，尝试下一个 */
    }
  }
  // 声明编码失败时兜底 utf-8，再不行则从 HTML meta 里嗅探一次。
  const latin1 = new TextDecoder('latin1').decode(bytes);
  const metaCharset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(latin1.slice(0, 2048))?.[1]?.toLowerCase();
  if (metaCharset && metaCharset !== declaredCharset && !metaCharset.includes('utf-8')) {
    try {
      return new TextDecoder(metaCharset).decode(bytes);
    } catch {
      /* ignore */
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

export interface FetchPageResult {
  url: string;
  status: number;
  contentType: string;
  title: string;
  /** 已渲染好的 Markdown 正文（含截断提示，不含安全声明）。 */
  markdown: string;
}

/** 抓取网页并转成 Markdown。非 2xx 返回状态与可读响应体（属正常结果，不抛错）。 */
export async function fetchPageAsMarkdown(params: {
  url: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputChars?: number;
}): Promise<FetchPageResult> {
  const maxOutputChars = params.maxOutputChars ?? FETCH_MAX_OUTPUT_CHARS;
  const timeoutMs = params.timeoutMs ?? FETCH_TIMEOUT_MS;
  let current = validateFetchUrl(params.url);

  for (let redirects = 0; redirects <= FETCH_MAX_REDIRECTS; redirects += 1) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        headers: { Accept: 'text/html,application/xhtml+xml,text/*;q=0.9,*/*;q=0.1' },
        signal,
      });
    } catch (error) {
      if (params.signal?.aborted) throw new WebToolError('WEB_ABORTED', '运行已被终止');
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new WebToolError('WEB_TIMEOUT', `抓取超时（${Math.round(timeoutMs / 1000)} 秒）`);
      }
      throw new WebToolError('WEB_NETWORK_ERROR', `无法访问 ${current.href}：${error instanceof Error ? error.message : String(error)}`);
    }

    // 重定向仅允许同源：跨源重定向视为不可信，拒绝跟随。
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        throw new WebToolError('WEB_FETCH_FAILED', `服务器返回 ${response.status} 重定向但没有给出目标地址`);
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new WebToolError('WEB_FETCH_FAILED', `重定向地址不合法：${location.slice(0, 200)}`);
      }
      if (!sameOrigin(current, next)) {
        throw new WebToolError(
          'WEB_CROSS_ORIGIN_REDIRECT',
          `目标重定向到了不同源的地址（${next.host}），出于安全考虑不跟随跨源重定向。请直接抓取最终地址。`,
        );
      }
      current = next;
      continue;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok) {
      const bodyText = decodeBytes(await readBodyCapped(response, 256 * 1024), contentType);
      const readable = bodyText.replace(/\s+/g, ' ').trim().slice(0, 2000);
      return {
        url: current.href,
        status: response.status,
        contentType,
        title: '',
        markdown:
          `目标页面返回了非 2xx 状态（HTTP ${response.status}）。` +
          `可以换一个 URL、搜索该站点的其他页面，或放弃这个来源。\n\n响应内容片段：${readable || '（空）'}`,
      };
    }

    const mime = contentType.split(';')[0].trim().toLowerCase();
    const bytes = await readBodyCapped(response, FETCH_MAX_BODY_BYTES);
    const text = decodeBytes(bytes, contentType);

    if (mime === 'text/html' || mime === 'application/xhtml+xml') {
      const { title, markdown, truncatedInput } = htmlToMarkdown(text, { baseUrl: current.href });
      const body = truncateOutput(markdown, maxOutputChars);
      const inputNote = truncatedInput ? '\n\n…（页面过长，仅转换了前半部分）' : '';
      return { url: current.href, status: response.status, contentType, title, markdown: `${body}${inputNote}` };
    }
    if (mime.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript', 'text/javascript'].includes(mime)) {
      return {
        url: current.href,
        status: response.status,
        contentType,
        title: '',
        markdown: truncateOutput(text, maxOutputChars),
      };
    }
    throw new WebToolError(
      'WEB_UNSUPPORTED_TYPE',
      `不支持的内容类型「${mime || contentType || '未知'}」：二进制内容无法转为文本，请换一个返回网页/文本的 URL`,
    );
  }
  throw new WebToolError('WEB_TOO_MANY_REDIRECTS', `重定向次数超过 ${FETCH_MAX_REDIRECTS} 次，已中止`);
}

export function truncateOutput(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n(Content truncated. Fetch a more specific URL or section for the full text.)`;
}
