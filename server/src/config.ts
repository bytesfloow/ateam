import fs from 'node:fs';
import path from 'node:path';
import type { ThinkingLevel } from '../../shared/types';
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS } from './llm';

const APP_VERSION = '1.0.0';

function findProjectRoot(start: string): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const PROJECT_ROOT = process.env.ATEAM_ROOT
  ? path.resolve(process.env.ATEAM_ROOT)
  : findProjectRoot(__dirname);

export const DATA_DIR = process.env.ATEAM_DATA_DIR
  ? path.resolve(process.env.ATEAM_DATA_DIR)
  : path.join(PROJECT_ROOT, 'data');

export const WORKSPACE_ROOT = process.env.ATEAM_WORKSPACE_ROOT
  ? path.resolve(process.env.ATEAM_WORKSPACE_ROOT)
  : path.join(PROJECT_ROOT, 'workspaces');

export const DB_PATH = process.env.ATEAM_DB_PATH
  ? path.resolve(process.env.ATEAM_DB_PATH)
  : path.join(DATA_DIR, 'ateam.db');

export const WEB_DIST = path.join(PROJECT_ROOT, 'web', 'dist');

export const PORT = Number(process.env.PORT || 3310);
export const HOST = process.env.HOST || '127.0.0.1';
export const VERSION = APP_VERSION;

export const DEFAULT_LLM = {
  baseUrl: process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
  model: process.env.LLM_MODEL || 'deepseek-chat',
  temperature: 0.7,
  /** 是否开启深度思考（请求中附带推理参数）。 */
  deepThinking: false,
  /** 深度思考级别，deepThinking 开启时生效。 */
  thinkingLevel: 'medium' as ThinkingLevel,
  /** 模型最大上下文长度（token），默认 1,000,000（1M）。 */
  maxContextTokens: 1_000_000,
  /** 单次模型请求超时（毫秒）：流式为「无新数据」超时，非流式为整体超时；0 = 不限制。 */
  requestTimeoutMs: DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  apiKey: process.env.LLM_API_KEY || '',
};

export const DEFAULT_RUNTIME = {
  toolTimeoutMs: 600_000,
  commandTimeoutMs: 600_000,
  maxToolOutputChars: 60_000,
  maxFeedbackSnapshotMessages: 30,
};

/**
 * 联网搜索（web_search）的服务地址。
 * 注意与 LLM Base URL 的区别：这里不带 /v1，接口路径 /v1/tools/search 由客户端拼接。
 */
export const DEFAULT_SEARCH = {
  baseUrl: process.env.ATEAM_SEARCH_BASE_URL || 'https://api.deepseek.com',
};

export function ensureBaseDirs(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
}
