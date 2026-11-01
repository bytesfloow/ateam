import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  BUILTIN_TOOL_NAMES,
  DESIGNER_SLUG,
  DESIGNER_WORKSPACE_LIST_MAX,
  type Agent,
  type AgentInput,
  type AgentSummary,
  type AgentToolsConfig,
  type AppSettings,
  type AttachedImage,
  type ConversationMessage,
  type CustomTool,
  type CustomToolInput,
  type DesignerAttachment,
  type DesignerChangeOp,
  type DesignerMessage,
  type DesignerProposal,
  type DesignerProposalStatus,
  type DesignerSession,
  type DesignerSessionSummary,
  type DesignerWorkspaceEntry,
  type DesignerWorkspaceListing,
  type Feedback,
  type FeedbackInput,
  type FeedbackSnapshot,
  type FeedbackStatus,
  type FeedbackUpdate,
  type HandoffFolder,
  type HandoffTargetResolved,
  type MessageMeta,
  type Pipeline,
  type PipelineEdge,
  type PipelineInput,
  type PipelineNode,
  type RuntimeSettings,
  type SettingsUpdate,
  type Skill,
  type SkillFile,
  type SkillFileInput,
  type SkillInput,
  type Stats,
  type TaskDetail,
  type TaskStatus,
  type TaskSummary,
  type ThinkingLevel,
  type ToolCallView,
  type Turn,
  type TurnStatus,
  type WebSearchSettingsView,
} from '../../shared/types';
import { DEFAULT_LLM, DEFAULT_RUNTIME, DEFAULT_SEARCH, VERSION } from './config';
import { AppError, assert, errorMessage } from './errors';
import { bfsNodeOrder, findStartNode, outgoingEdges } from '../../shared/types';
import { MAX_LLM_REQUEST_TIMEOUT_MS, MIN_LLM_REQUEST_TIMEOUT_MS } from './llm';
import {
  assertSkillReferences,
  extractScriptReferences,
  isSkillScriptPath,
  normalizeSkillFilePath,
  renameScriptReferences,
  scriptFileName,
  scriptNamesOf,
  SKILL_FILE_LIMITS,
} from './skill-package';
import { normalizeSearchBaseUrl } from './web-tools';

type Row = Record<string, unknown>;

/** 单个提示词字段的长度上限。 */
export const PROMPT_FIELD_MAX = 20_000;

const ACCENTS = ['#6d8cff', '#38bdf8', '#34d399', '#f59e0b', '#f472b6', '#a78bfa', '#fb7185', '#2dd4bf'];

/** Built-in tools that can be toggled per agent. `handoff` is always injected by the runtime. */
export const TOGGLEABLE_BUILTINS = BUILTIN_TOOL_NAMES.filter((name) => name !== 'handoff');

export type DefaultBuiltinName = (typeof TOGGLEABLE_BUILTINS)[number];

const DEFAULT_BUILTINS: DefaultBuiltinName[] = [
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
];

function now(): string {
  return new Date().toISOString();
}

/** 会话列表的最后一条消息预览长度。 */
function truncateDesignerPreview(text: string): string {
  return text.length <= 80 ? text : `${text.slice(0, 80)}…`;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function asString(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 归一化最大迭代轮数：0 = 不限制，缺省/非法值回退到 fallback，有效范围 0-100。 */
function normalizeMaxIterations(value: unknown, fallback: number): number {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(Math.round(parsed), 0, 100);
}

/** 归一化模型请求超时：0 = 不限制；正数夹在 [10s, 60min]。 */
function normalizeLlmTimeout(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return DEFAULT_LLM.requestTimeoutMs;
  if (parsed <= 0) return 0;
  return clamp(Math.round(parsed), MIN_LLM_REQUEST_TIMEOUT_MS, MAX_LLM_REQUEST_TIMEOUT_MS);
}

/** 思考级别取值随模型而异，只约束为合法标识符（1-32 位字母/数字/下划线/连字符）。 */
const THINKING_LEVEL_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** 归一化思考级别：非法值回退到 fallback。 */
function normalizeThinkingLevel(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
  const parsed = asString(value).trim();
  return THINKING_LEVEL_PATTERN.test(parsed) ? parsed : fallback;
}

function translateSqliteError(error: unknown, fallback: string): never {
  const message = errorMessage(error);
  if (message.includes('UNIQUE constraint failed')) {
    if (message.includes('agents.name')) throw new AppError(409, '已存在同名智能体');
    if (message.includes('skills.name')) throw new AppError(409, '已存在同名技能');
    if (message.includes('custom_tools.name')) throw new AppError(409, '已存在同名工具');
    if (message.includes('pipelines.name')) throw new AppError(409, '已存在同名流水线');
    throw new AppError(409, '名称已存在');
  }
  if (message.includes('FOREIGN KEY constraint failed')) {
    throw new AppError(409, '该数据仍被其他配置引用，无法删除');
  }
  throw new AppError(500, fallback, message);
}

/* ---------------------------------------------------------------- */
/* designer upload filename helpers                                   */
/* ---------------------------------------------------------------- */

/** 按扩展名判断是否图片（前端缩略图 / 预览用；模型侧仍以 read_image 的文件签名为准）。 */
const UPLOAD_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

function isImageUploadName(name: string): boolean {
  return UPLOAD_IMAGE_EXTS.has(path.extname(name).toLowerCase());
}

/** 清洗上传文件名：去掉路径成分与非法字符，限制长度（保留扩展名）。 */
function sanitizeUploadName(name: string): string {
  const base = path.basename(String(name ?? '').trim().replace(/\\/g, '/'));
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  const ext = path.extname(cleaned).slice(0, 20);
  const stem = (cleaned.slice(0, cleaned.length - ext.length).trim() || 'file').slice(0, 80);
  return `${stem}${ext}`;
}

/** 展示名：优先用清洗后的原始文件名，异常时回退到存储文件名。 */
function normalizeUploadDisplayName(originalName: string, storedName: string): string {
  const base = String(originalName ?? '').trim().replace(/[\u0000-\u001f]+/g, ' ');
  return base ? base.slice(0, 160) : storedName;
}

/** 同名不覆盖：追加 `-2`、`-3` 序号（与交付文件夹的版本语义一致）。 */
function uniqueUploadName(dir: string, name: string): string {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 10_000; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${stem}-${randomUUID().slice(0, 8)}${ext}`;
}

export interface MessageInput {
  role: ConversationMessage['role'];
  content: string;
  toolCalls?: ToolCallView[];
  toolCallId?: string | null;
  name?: string | null;
  images?: AttachedImage[];
  meta?: MessageMeta;
}

export interface FeedbackCreateInput extends FeedbackInput {
  agentId: string | null;
  agentName: string;
  taskName: string;
  taskId: string | null;
  turnId: string | null;
  contextSnapshot: FeedbackSnapshot | null;
}

export interface StoreOptions {
  db: DatabaseSync;
  workspaceRoot: string;
}

export class Store {
  readonly db: DatabaseSync;
  readonly workspaceRoot: string;

  constructor(options: StoreOptions) {
    this.db = options.db;
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.seedDefaults();
  }

  /* ---------------------------------------------------------------- */
  /* low level helpers                                                 */
  /* ---------------------------------------------------------------- */

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  private rawSetting(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return row ? parseJson(row.value, undefined) : undefined;
  }

  private setRawSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  private seedDefaults(): void {
    const defaults: Record<string, unknown> = {
      'llm.baseUrl': DEFAULT_LLM.baseUrl,
      'llm.apiKey': DEFAULT_LLM.apiKey,
      'llm.model': DEFAULT_LLM.model,
      'llm.temperature': DEFAULT_LLM.temperature,
      'llm.maxIterations': DEFAULT_LLM.maxIterations,
      'llm.deepThinking': DEFAULT_LLM.deepThinking,
      'llm.thinkingLevel': DEFAULT_LLM.thinkingLevel,
      'llm.maxContextTokens': DEFAULT_LLM.maxContextTokens,
      'llm.requestTimeoutMs': DEFAULT_LLM.requestTimeoutMs,
      'web.searchBaseUrl': DEFAULT_SEARCH.baseUrl,
      'web.searchApiKey': '',
      ...Object.fromEntries(Object.entries(DEFAULT_RUNTIME).map(([key, value]) => [`runtime.${key}`, value])),
    };
    const insert = this.db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(defaults)) {
      insert.run(key, JSON.stringify(value));
    }
    // Mock 模式已移除：清掉历史版本遗留的开关，避免残留无效配置。
    this.db.prepare("DELETE FROM settings WHERE key = 'llm.mock'").run();
    this.migrateRuntimeTimeouts();
  }

  /**
   * 旧版本的默认超时是 2 分钟。升级后把仍是旧默认值的设置改成新的 10 分钟；
   * 用户自定义过的值保持不变，迁移标记保证只执行一次。
   */
  private migrateRuntimeTimeouts(): void {
    const marker = 'migration.runtimeTimeouts10m';
    if (this.rawSetting(marker) !== undefined) return;
    const update = this.db.prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?');
    const oldDefault = JSON.stringify(120_000);
    for (const key of ['toolTimeoutMs', 'commandTimeoutMs'] as const) {
      update.run(JSON.stringify(DEFAULT_RUNTIME[key]), `runtime.${key}`, oldDefault);
    }
    this.setRawSetting(marker, true);
  }

  /* ---------------------------------------------------------------- */
  /* settings                                                          */
  /* ---------------------------------------------------------------- */

  getRuntimeSettings(): RuntimeSettings {
    const get = (key: keyof RuntimeSettings) =>
      asNumber(this.rawSetting(`runtime.${key}`) ?? DEFAULT_RUNTIME[key]);
    return {
      toolTimeoutMs: clamp(get('toolTimeoutMs'), 1_000, 600_000),
      commandTimeoutMs: clamp(get('commandTimeoutMs'), 1_000, 600_000),
      maxToolOutputChars: clamp(get('maxToolOutputChars'), 1_000, 200_000),
      maxFeedbackSnapshotMessages: clamp(get('maxFeedbackSnapshotMessages'), 5, 100),
    };
  }

  getLlmConfig(): {
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxIterations: number;
    deepThinking: boolean;
    thinkingLevel: ThinkingLevel;
    maxContextTokens: number;
    requestTimeoutMs: number;
  } {
    return {
      baseUrl: asString(this.rawSetting('llm.baseUrl') ?? DEFAULT_LLM.baseUrl).replace(/\/+$/, ''),
      apiKey: asString(this.rawSetting('llm.apiKey')),
      model: asString(this.rawSetting('llm.model') ?? DEFAULT_LLM.model),
      temperature: clamp(asNumber(this.rawSetting('llm.temperature') ?? DEFAULT_LLM.temperature), 0, 2),
      maxIterations: clamp(asNumber(this.rawSetting('llm.maxIterations') ?? DEFAULT_LLM.maxIterations), 0, 100),
      deepThinking: Boolean(this.rawSetting('llm.deepThinking') ?? DEFAULT_LLM.deepThinking),
      thinkingLevel: normalizeThinkingLevel(
        this.rawSetting('llm.thinkingLevel') ?? DEFAULT_LLM.thinkingLevel,
        DEFAULT_LLM.thinkingLevel,
      ),
      maxContextTokens: clamp(
        asNumber(this.rawSetting('llm.maxContextTokens') ?? DEFAULT_LLM.maxContextTokens),
        1_000,
        10_000_000,
      ),
      requestTimeoutMs: normalizeLlmTimeout(
        this.rawSetting('llm.requestTimeoutMs') ?? DEFAULT_LLM.requestTimeoutMs,
      ),
    };
  }

  /**
   * 联网搜索（web_search）配置：
   * - 优先使用专门配置的搜索 Key；
   * - 未配置且模型接入是 DeepSeek 时自动复用模型 Key（省一次配置）；
   * - 都没有时 apiKey 为空，工具调用返回 WEB_PROVIDER_UNAVAILABLE 的结构化错误。
   */
  getWebSearchConfig(): { searchBaseUrl: string; apiKey: string; reusingLlmKey: boolean } {
    const searchBaseUrl = normalizeSearchBaseUrl(
      asString(this.rawSetting('web.searchBaseUrl') ?? DEFAULT_SEARCH.baseUrl),
    );
    const ownKey = asString(this.rawSetting('web.searchApiKey'));
    if (ownKey) return { searchBaseUrl, apiKey: ownKey, reusingLlmKey: false };
    const llm = this.getLlmConfig();
    if (llm.apiKey && /deepseek/i.test(llm.baseUrl)) {
      return { searchBaseUrl, apiKey: llm.apiKey, reusingLlmKey: true };
    }
    return { searchBaseUrl, apiKey: '', reusingLlmKey: false };
  }

  private webSearchSettingsView(): WebSearchSettingsView {
    const config = this.getWebSearchConfig();
    const apiKey = config.apiKey;
    return {
      searchBaseUrl: config.searchBaseUrl,
      searchApiKeySet: apiKey.length > 0,
      searchApiKeyHint: apiKey.length === 0 ? '' : apiKey.length <= 8 ? '••••••••' : `••••${apiKey.slice(-4)}`,
      reusingLlmKey: config.reusingLlmKey,
    };
  }

  getAppSettings(): AppSettings {
    const llm = this.getLlmConfig();
    const apiKey = llm.apiKey;
    return {
      llm: {
        baseUrl: llm.baseUrl,
        model: llm.model,
        temperature: llm.temperature,
        maxIterations: llm.maxIterations,
        deepThinking: llm.deepThinking,
        thinkingLevel: llm.thinkingLevel,
        maxContextTokens: llm.maxContextTokens,
        requestTimeoutMs: llm.requestTimeoutMs,
        apiKeySet: apiKey.length > 0,
        apiKeyHint: apiKey.length === 0 ? '' : apiKey.length <= 8 ? '••••••••' : `••••${apiKey.slice(-4)}`,
      },
      runtime: this.getRuntimeSettings(),
      webSearch: this.webSearchSettingsView(),
      workspaceRoot: this.workspaceRoot,
      version: VERSION,
    };
  }

  updateSettings(input: SettingsUpdate): AppSettings {
    if (input.llm) {
      const llm = input.llm;
      if (llm.baseUrl !== undefined) {
        const baseUrl = llm.baseUrl.trim().replace(/\/+$/, '');
        assert(baseUrl.length > 0 && baseUrl.length <= 300, 400, 'Base URL 不能为空且不能超过 300 个字符');
        try {
          const url = new URL(baseUrl);
          assert(url.protocol === 'http:' || url.protocol === 'https:', 400, 'Base URL 必须使用 http 或 https');
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError(400, 'Base URL 格式不正确');
        }
        this.setRawSetting('llm.baseUrl', baseUrl);
      }
      if (llm.model !== undefined) {
        const model = llm.model.trim();
        assert(model.length > 0 && model.length <= 100, 400, '模型名称不能为空且不能超过 100 个字符');
        this.setRawSetting('llm.model', model);
      }
      if (llm.temperature !== undefined) {
        assert(Number.isFinite(llm.temperature), 400, 'temperature 必须是数字');
        this.setRawSetting('llm.temperature', clamp(llm.temperature, 0, 2));
      }
      if (llm.maxIterations !== undefined) {
        assert(Number.isFinite(llm.maxIterations), 400, '最大迭代轮数必须是数字');
        this.setRawSetting('llm.maxIterations', Math.round(clamp(llm.maxIterations, 0, 100)));
      }
      if (llm.deepThinking !== undefined) this.setRawSetting('llm.deepThinking', Boolean(llm.deepThinking));
      if (llm.thinkingLevel !== undefined) {
        const thinkingLevel = asString(llm.thinkingLevel).trim();
        assert(
          THINKING_LEVEL_PATTERN.test(thinkingLevel),
          400,
          '思考级别只能包含字母、数字、下划线或连字符（1-32 个字符），例如 low / medium / high',
        );
        this.setRawSetting('llm.thinkingLevel', thinkingLevel);
      }
      if (llm.maxContextTokens !== undefined) {
        assert(Number.isFinite(llm.maxContextTokens), 400, '最大上下文长度必须是数字');
        this.setRawSetting('llm.maxContextTokens', Math.round(clamp(llm.maxContextTokens, 1_000, 10_000_000)));
      }
      if (llm.requestTimeoutMs !== undefined) {
        assert(Number.isFinite(llm.requestTimeoutMs), 400, '模型请求超时必须是数字');
        const timeout = Math.round(llm.requestTimeoutMs);
        assert(
          timeout === 0 || (timeout >= MIN_LLM_REQUEST_TIMEOUT_MS && timeout <= MAX_LLM_REQUEST_TIMEOUT_MS),
          400,
          '模型请求超时需为 0（不限制）或 10,000 - 3,600,000 毫秒',
        );
        this.setRawSetting('llm.requestTimeoutMs', timeout);
      }
      if (llm.apiKey !== undefined) {
        if (llm.apiKey === null) {
          this.setRawSetting('llm.apiKey', '');
        } else {
          const key = llm.apiKey.trim();
          if (key.length > 0) {
            assert(key.length <= 500, 400, 'API Key 过长');
            this.setRawSetting('llm.apiKey', key);
          }
        }
      }
    }

    if (input.runtime) {
      for (const [key, value] of Object.entries(input.runtime)) {
        if (value === undefined) continue;
        assert(Number.isFinite(Number(value)), 400, '运行时参数必须是数字');
        this.setRawSetting(`runtime.${key}`, Number(value));
      }
    }

    if (input.webSearch) {
      const web = input.webSearch;
      if (web.searchBaseUrl !== undefined) {
        const baseUrl = normalizeSearchBaseUrl(web.searchBaseUrl);
        assert(baseUrl.length > 0 && baseUrl.length <= 300, 400, '搜索 Base URL 不能为空且不能超过 300 个字符');
        try {
          const url = new URL(baseUrl);
          assert(url.protocol === 'http:' || url.protocol === 'https:', 400, '搜索 Base URL 必须使用 http 或 https');
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError(400, '搜索 Base URL 格式不正确');
        }
        this.setRawSetting('web.searchBaseUrl', baseUrl);
      }
      if (web.searchApiKey !== undefined) {
        if (web.searchApiKey === null) {
          // 清空后回退为「模型接入是 DeepSeek 时自动复用模型 Key」。
          this.setRawSetting('web.searchApiKey', '');
        } else {
          const key = web.searchApiKey.trim();
          if (key.length > 0) {
            assert(key.length <= 500, 400, '搜索 API Key 过长');
            this.setRawSetting('web.searchApiKey', key);
          }
        }
      }
    }

    return this.getAppSettings();
  }

  /* ---------------------------------------------------------------- */
  /* agents                                                            */
  /* ---------------------------------------------------------------- */

  /** 任务目录：存放人类投放的 input\，以及每个智能体的独立子工作区。 */
  taskWorkspaceDir(taskId: string): string {
    assert(/^[0-9a-fA-F-]{8,64}$/.test(taskId), 500, '任务标识不合法');
    const resolved = path.resolve(this.workspaceRoot, 'tasks', taskId);
    const root = this.workspaceRoot.endsWith(path.sep) ? this.workspaceRoot : this.workspaceRoot + path.sep;
    assert(resolved.startsWith(root), 500, '任务工作区路径越界');
    return resolved;
  }

  /** 任务级输入目录：人类投放外部输入的唯一入口。 */
  taskInputDir(taskId: string): string {
    return path.join(this.taskWorkspaceDir(taskId), 'input');
  }

  /** 某个智能体在本任务中的独立工作区。 */
  agentTaskWorkspaceDir(taskId: string, slug: string): string {
    assert(/^[a-z0-9][a-z0-9-]{1,48}$/.test(slug), 500, '智能体工作目录标识不合法');
    const root = this.taskWorkspaceDir(taskId);
    const resolved = path.resolve(root, slug);
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    assert(resolved.startsWith(prefix), 500, '智能体任务工作区路径越界');
    return resolved;
  }

  /**
   * 某个智能体在本任务中的输入根目录：inbox\。
   * 用户投放的外部输入统一同步到其下的 user\ 子目录，与上游交付（inbox\<发送方>\）同属一个输入根目录。
   */
  agentTaskInboxDir(taskId: string, slug: string): string {
    return path.join(this.agentTaskWorkspaceDir(taskId, slug), 'inbox');
  }

  /** 用户投放的输入文件目录：inbox\user\。 */
  agentTaskUserInputDir(taskId: string, slug: string): string {
    return path.join(this.agentTaskInboxDir(taskId, slug), 'user');
  }

  /** 终点交付目录：final\（任务根下，存放交给用户验收的文件夹副本）。 */
  taskFinalDir(taskId: string): string {
    return path.join(this.taskWorkspaceDir(taskId), 'final');
  }

  ensureTaskFinalDir(taskId: string): string {
    const dir = this.taskFinalDir(taskId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 创建任务目录与任务级 input\（幂等）。 */
  ensureTaskWorkspace(taskId: string): string {
    const dir = this.taskWorkspaceDir(taskId);
    fs.mkdirSync(path.join(dir, 'input'), { recursive: true });
    return dir;
  }

  /** 创建智能体在本任务中的 inbox\user\（输入）与 output\（产出）（幂等）。 */
  ensureAgentTaskWorkspace(taskId: string, slug: string): string {
    const dir = this.agentTaskWorkspaceDir(taskId, slug);
    fs.mkdirSync(path.join(dir, 'inbox', 'user'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'output'), { recursive: true });
    return dir;
  }

  /**
   * 把任务级 input\ 中的文件同步到智能体工作区的 inbox\user\。
   * 人类更新同名文件会覆盖旧副本；任务级目录中删除文件不会反向删除工作区副本。
   */
  syncTaskInput(taskId: string, slug: string): void {
    const source = this.taskInputDir(taskId);
    const target = this.agentTaskUserInputDir(taskId, slug);
    fs.mkdirSync(target, { recursive: true });
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(source, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        fs.copyFileSync(path.join(source, entry.name), path.join(target, entry.name));
      } catch {
        /* 单个输入文件复制失败不应阻断任务启动 */
      }
    }
  }

  /** 准备某个智能体在本任务中的工作区，并同步人类输入（幂等）。 */
  prepareAgentTaskWorkspace(taskId: string, slug: string): string {
    const dir = this.ensureAgentTaskWorkspace(taskId, slug);
    this.syncTaskInput(taskId, slug);
    return dir;
  }

  mapAgent(row: Row): Agent {
    const slug = asString(row.slug);
    return {
      id: asString(row.id),
      name: asString(row.name),
      slug,
      description: asString(row.description),
      responsibilities: asString(row.responsibilities),
      deliverable: asString(row.deliverable),
      guide: asString(row.guide),
      model: row.model === null || row.model === undefined || row.model === '' ? null : asString(row.model),
      temperature: row.temperature === null || row.temperature === undefined ? null : asNumber(row.temperature),
      maxIterations: Math.max(0, Math.round(asNumber(row.max_iterations) || 0)),
      tools: parseJson<AgentToolsConfig>(row.tools, { builtin: DEFAULT_BUILTINS, custom: [] }),
      skillIds: parseJson<string[]>(row.skill_ids, []),
      accent: asString(row.accent) || ACCENTS[0],
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    };
  }

  private getAgentRow(id: string): Row {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined;
    assert(row, 404, '智能体不存在');
    return row;
  }

  listAgents(): Agent[] {
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY created_at ASC').all() as Row[];
    return rows.map((row) => this.mapAgent(row));
  }

  getAgent(id: string): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapAgent(row) : null;
  }

  /** 按名称查找智能体（名称唯一，不区分大小写）。 */
  getAgentByName(name: string): Agent | null {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return null;
    const row = this.db
      .prepare('SELECT * FROM agents WHERE name = ? COLLATE NOCASE LIMIT 1')
      .get(trimmed) as Row | undefined;
    return row ? this.mapAgent(row) : null;
  }

  private validateSkillIds(ids: string[]): string[] {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)];
    const placeholders = unique.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT id FROM skills WHERE id IN (${placeholders})`).all(...unique) as Row[];
    assert(rows.length === unique.length, 400, '包含不存在的技能');
    return unique;
  }

  private validateCustomToolIds(ids: string[]): string[] {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)];
    const placeholders = unique.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT id FROM custom_tools WHERE id IN (${placeholders})`)
      .all(...unique) as Row[];
    assert(rows.length === unique.length, 400, '包含不存在的自定义工具');
    return unique;
  }

  private normalizeTools(tools: Partial<AgentToolsConfig> | undefined): AgentToolsConfig {
    const builtin = Array.isArray(tools?.builtin)
      ? [...new Set(tools.builtin)].filter((name): name is DefaultBuiltinName =>
          (TOGGLEABLE_BUILTINS as readonly string[]).includes(name),
        )
      : [...DEFAULT_BUILTINS];
    const custom = this.validateCustomToolIds(Array.isArray(tools?.custom) ? tools.custom : []);
    return { builtin, custom };
  }

  /** 智能体名称不能重名（不区分大小写）：流水线按名称引用环节，名称必须唯一。 */
  private assertAgentNameUnique(name: string, exceptId?: string): void {
    const row = this.db
      .prepare('SELECT id FROM agents WHERE name = ? COLLATE NOCASE AND id != ?')
      .get(name, exceptId ?? '') as Row | undefined;
    if (row) throw new AppError(409, `已存在同名智能体「${name}」，请换一个名称`);
  }

  createAgent(input: AgentInput): Agent {
    const name = String(input.name ?? '').trim();
    assert(name.length >= 1 && name.length <= 40, 400, '智能体名称长度需在 1-40 个字符之间');
    this.assertAgentNameUnique(name);
    const description = String(input.description ?? '').trim();
    assert(description.length <= 300, 400, '智能体描述不能超过 300 个字符');
    // 任务说明缺省取自一句话描述。
    const responsibilities = String(input.responsibilities ?? '').trim() || description;
    const deliverable = String(input.deliverable ?? '').trim();
    const guide = String(input.guide ?? '').trim();
    assert(responsibilities.length <= PROMPT_FIELD_MAX, 400, `任务说明不能超过 ${PROMPT_FIELD_MAX} 个字符`);
    assert(deliverable.length <= PROMPT_FIELD_MAX, 400, `交付要求不能超过 ${PROMPT_FIELD_MAX} 个字符`);
    assert(guide.length <= PROMPT_FIELD_MAX, 400, `工作指南不能超过 ${PROMPT_FIELD_MAX} 个字符`);
    const model = input.model === null || input.model === undefined ? null : String(input.model).trim() || null;
    if (model) assert(model.length <= 100, 400, '模型名称不能超过 100 个字符');
    const temperature =
      input.temperature === null || input.temperature === undefined
        ? null
        : clamp(Number(input.temperature), 0, 2);
    const maxIterations = normalizeMaxIterations(input.maxIterations, 0);
    const accent =
      typeof input.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.accent)
        ? input.accent
        : ACCENTS[this.countAgents() % ACCENTS.length];
    const id = randomUUID();
    const slug = `agent-${id.replace(/-/g, '').slice(0, 8)}`;
    const tools = this.normalizeTools(input.tools);
    const skillIds = this.validateSkillIds(Array.isArray(input.skillIds) ? input.skillIds : []);
    const timestamp = now();
    try {
      this.db
        .prepare(
          `INSERT INTO agents
           (id, name, slug, description, responsibilities, deliverable, guide, model, temperature, max_iterations, tools, skill_ids, accent, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          name,
          slug,
          description,
          responsibilities,
          deliverable,
          guide,
          model,
          temperature,
          maxIterations,
          JSON.stringify(tools),
          JSON.stringify(skillIds),
          accent,
          timestamp,
          timestamp,
        );
    } catch (error) {
      translateSqliteError(error, '创建智能体失败');
    }
    return this.getAgent(id)!;
  }

  updateAgent(id: string, input: Partial<AgentInput>): Agent {
    const row = this.getAgentRow(id);
    const current = this.mapAgent(row);
    const name = input.name !== undefined ? String(input.name).trim() : current.name;
    assert(name.length >= 1 && name.length <= 40, 400, '智能体名称长度需在 1-40 个字符之间');
    this.assertAgentNameUnique(name, id);
    const description =
      input.description !== undefined ? String(input.description).trim() : current.description;
    assert(description.length <= 300, 400, '智能体描述不能超过 300 个字符');
    const responsibilities =
      input.responsibilities !== undefined ? String(input.responsibilities).trim() : current.responsibilities;
    const deliverable =
      input.deliverable !== undefined ? String(input.deliverable).trim() : current.deliverable;
    const guide = input.guide !== undefined ? String(input.guide).trim() : current.guide;
    assert(responsibilities.length <= PROMPT_FIELD_MAX, 400, `任务说明不能超过 ${PROMPT_FIELD_MAX} 个字符`);
    assert(deliverable.length <= PROMPT_FIELD_MAX, 400, `交付要求不能超过 ${PROMPT_FIELD_MAX} 个字符`);
    assert(guide.length <= PROMPT_FIELD_MAX, 400, `工作指南不能超过 ${PROMPT_FIELD_MAX} 个字符`);
    const model =
      input.model === undefined
        ? current.model
        : input.model === null
          ? null
          : String(input.model).trim() || null;
    if (model) assert(model.length <= 100, 400, '模型名称不能超过 100 个字符');
    const temperature =
      input.temperature === undefined
        ? current.temperature
        : input.temperature === null
          ? null
          : clamp(Number(input.temperature), 0, 2);
    const maxIterations =
      input.maxIterations === undefined
        ? current.maxIterations
        : normalizeMaxIterations(input.maxIterations, current.maxIterations);
    const accent =
      input.accent !== undefined && /^#[0-9a-fA-F]{6}$/.test(input.accent) ? input.accent : current.accent;
    const tools = input.tools !== undefined ? this.normalizeTools({ ...current.tools, ...input.tools }) : current.tools;
    const skillIds =
      input.skillIds !== undefined ? this.validateSkillIds(input.skillIds) : current.skillIds;
    try {
      this.db
        .prepare(
          `UPDATE agents SET name = ?, description = ?, responsibilities = ?, deliverable = ?, guide = ?, model = ?, temperature = ?,
             max_iterations = ?, tools = ?, skill_ids = ?, accent = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          name,
          description,
          responsibilities,
          deliverable,
          guide,
          model,
          temperature,
          maxIterations,
          JSON.stringify(tools),
          JSON.stringify(skillIds),
          accent,
          now(),
          id,
        );
    } catch (error) {
      translateSqliteError(error, '更新智能体失败');
    }
    return this.getAgent(id)!;
  }

  countAgents(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM agents').get() as Row;
    return asNumber(row.c);
  }

  agentSummaries(): AgentSummary[] {
    return this.listAgents().map((agent) => ({
      id: agent.id,
      name: agent.name,
      slug: agent.slug,
      description: agent.description,
      accent: agent.accent,
    }));
  }

  deleteAgent(id: string): Agent {
    const agent = this.getAgent(id);
    assert(agent, 404, '智能体不存在');
    assert(agent.slug !== DESIGNER_SLUG, 409, '「流水线设计师」是系统内置智能体，不能删除');
    const used = this.listPipelines().filter((pipeline) =>
      pipeline.nodes.some((node) => node.agentId === id),
    );
    if (used.length > 0) {
      throw new AppError(
        409,
        `该智能体仍被流水线使用：${used.map((pipeline) => pipeline.name).join('、')}，请先调整流水线`,
      );
    }
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
    return agent;
  }

  /* ---------------------------------------------------------------- */
  /* pipelines                                                         */
  /* ---------------------------------------------------------------- */

  mapPipeline(row: Row): Pipeline {
    return {
      id: asString(row.id),
      name: asString(row.name),
      description: asString(row.description),
      nodes: parseJson<PipelineNode[]>(row.nodes, []),
      edges: parseJson<PipelineEdge[]>(row.edges, []),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    };
  }

  listPipelines(): Pipeline[] {
    const rows = this.db.prepare('SELECT * FROM pipelines ORDER BY created_at ASC').all() as Row[];
    return rows.map((row) => this.mapPipeline(row));
  }

  getPipeline(id: string): Pipeline | null {
    const row = this.db.prepare('SELECT * FROM pipelines WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapPipeline(row) : null;
  }

  /**
   * 校验并归一化流水线定义（节点即智能体 + 带箭头的连线）：
   * - 1-30 个节点；每个节点绑定存在的智能体，同一智能体最多一个节点；
   * - 连线两端必须是本流水线节点，不允许自环与重复连线；
   * - 每条连线必填「任务触发提示词」；
   * - 源节点出边 ≥2 时，它的每条出边都必须填「交接条件」；
   * - 恰好一个起点（显式标记）；所有节点从起点可达；
   * - 至少一个终点（无出边节点），否则任务永远无法交付给用户。
   */
  private normalizePipeline(input: PipelineInput): Omit<Pipeline, 'id' | 'createdAt' | 'updatedAt'> {
    const name = String(input.name ?? '').trim();
    assert(name.length >= 1 && name.length <= 60, 400, '流水线名称长度需在 1-60 个字符之间');
    const description = String(input.description ?? '').trim();
    assert(description.length <= 500, 400, '流水线简介不能超过 500 个字符');
    const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
    assert(rawNodes.length >= 1, 400, '流水线至少需要一个智能体节点');
    assert(rawNodes.length <= 30, 400, '一条流水线最多 30 个节点');

    const nodes: PipelineNode[] = [];
    const ids = new Set<string>();
    const agentIds = new Set<string>();
    for (const raw of rawNodes) {
      const id = String(raw?.id ?? '').trim() || randomUUID();
      assert(!ids.has(id), 400, '节点 ID 重复，请重新保存流水线');
      const agent = this.getAgent(String(raw?.agentId ?? ''));
      assert(agent, 400, '节点选择的智能体不存在');
      assert(
        agent.slug !== DESIGNER_SLUG,
        400,
        '「流水线设计师」不能作为流水线节点：它负责系统管理对话，不参与任务交付',
      );
      assert(!agentIds.has(agent.id), 400, `智能体「${agent.name}」在这条流水线里出现了多次：一个智能体只能是一个节点`);
      ids.add(id);
      agentIds.add(agent.id);
      const x = Number(raw?.x ?? 0);
      const y = Number(raw?.y ?? 0);
      nodes.push({
        id,
        agentId: agent.id,
        isStart: Boolean(raw?.isStart),
        x: Number.isFinite(x) ? clamp(Math.round(x), -100_000, 100_000) : 0,
        y: Number.isFinite(y) ? clamp(Math.round(y), -100_000, 100_000) : 0,
      });
    }
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const agentNameOf = (nodeId: string): string =>
      this.getAgent(nodeById.get(nodeId)?.agentId ?? '')?.name ?? '（智能体已删除）';

    const rawEdges = Array.isArray(input.edges) ? input.edges : [];
    assert(rawEdges.length <= 300, 400, '一条流水线最多 300 条连线');
    const edges: PipelineEdge[] = [];
    const pairs = new Set<string>();
    const edgeIds = new Set<string>();
    for (const raw of rawEdges) {
      const id = String(raw?.id ?? '').trim() || randomUUID();
      assert(!edgeIds.has(id), 400, '连线 ID 重复，请重新保存流水线');
      edgeIds.add(id);
      const from = String(raw?.from ?? '').trim();
      const to = String(raw?.to ?? '').trim();
      assert(ids.has(from) && ids.has(to), 400, '连线引用的节点不存在');
      assert(from !== to, 400, `不允许从「${agentNameOf(from)}」交接给自己`);
      const pair = `${from}->${to}`;
      assert(!pairs.has(pair), 400, `「${agentNameOf(from)}」到「${agentNameOf(to)}」已有连线`);
      pairs.add(pair);
      const triggerPrompt = String(raw?.triggerPrompt ?? '').trim();
      assert(triggerPrompt.length >= 1, 400, `「${agentNameOf(from)}」→「${agentNameOf(to)}」的连线必须填写任务触发提示词`);
      assert(
        triggerPrompt.length <= PROMPT_FIELD_MAX,
        400,
        `「${agentNameOf(from)}」→「${agentNameOf(to)}」的触发提示词不能超过 ${PROMPT_FIELD_MAX} 个字符`,
      );
      const handoffCondition = String(raw?.handoffCondition ?? '').trim();
      assert(
        handoffCondition.length <= PROMPT_FIELD_MAX,
        400,
        `「${agentNameOf(from)}」→「${agentNameOf(to)}」的交接条件不能超过 ${PROMPT_FIELD_MAX} 个字符`,
      );
      edges.push({ id, from, to, triggerPrompt, handoffCondition });
    }

    // 多出边的源节点：每条出边都必须写清交接条件。
    const outDegrees = new Map<string, number>();
    for (const edge of edges) outDegrees.set(edge.from, (outDegrees.get(edge.from) ?? 0) + 1);
    for (const edge of edges) {
      if ((outDegrees.get(edge.from) ?? 0) >= 2) {
        assert(
          edge.handoffCondition.length >= 1,
          400,
          `「${agentNameOf(edge.from)}」有多个交接对象，连线到「${agentNameOf(edge.to)}」必须填写交接条件`,
        );
      }
    }

    // 起点唯一（显式标记；返工环下起点也可能有入线）+ 全覆盖可达 + 至少一个终点。
    if (nodes.length === 1) {
      nodes[0].isStart = true;
    } else {
      const startCount = nodes.filter((node) => node.isStart).length;
      assert(
        startCount === 1,
        400,
        startCount === 0
          ? '还没有标记起点：请在画布上把接手用户任务的节点设为起点'
          : `起点必须唯一，当前标了 ${startCount} 个起点`,
      );
    }
    if (nodes.length > 1) {
      const start = nodes.find((node) => node.isStart)!;
      const reachable = new Set<string>();
      const queue: string[] = [start.id];
      reachable.add(start.id);
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const edge of edges) {
          if (edge.from === current && !reachable.has(edge.to)) {
            reachable.add(edge.to);
            queue.push(edge.to);
          }
        }
      }
      const unreachable = nodes.filter((node) => !reachable.has(node.id));
      assert(
        unreachable.length === 0,
        400,
        `以下节点从起点不可达，任务永远走不到：「${unreachable.map((node) => agentNameOf(node.id)).join('、')}」`,
      );
    }
    const terminals = nodes.filter((node) => (outDegrees.get(node.id) ?? 0) === 0);
    assert(
      terminals.length >= 1,
      400,
      '流水线必须至少有一个终点（不连出线的节点），否则任务无法交付给用户',
    );

    return { name, description, nodes, edges };
  }

  private assertPipelineNameUnique(name: string, exceptId?: string): void {
    const row = this.db
      .prepare('SELECT id FROM pipelines WHERE name = ? COLLATE NOCASE AND id != ?')
      .get(name, exceptId ?? '') as Row | undefined;
    if (row) throw new AppError(409, `已存在同名流水线「${name}」，请换一个名称`);
  }

  createPipeline(input: PipelineInput): Pipeline {
    const normalized = this.normalizePipeline(input);
    this.assertPipelineNameUnique(normalized.name);
    const id = randomUUID();
    const timestamp = now();
    try {
      this.db
        .prepare(
          'INSERT INTO pipelines (id, name, description, nodes, edges, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          normalized.name,
          normalized.description,
          JSON.stringify(normalized.nodes),
          JSON.stringify(normalized.edges),
          timestamp,
          timestamp,
        );
    } catch (error) {
      translateSqliteError(error, '创建流水线失败');
    }
    return this.getPipeline(id)!;
  }

  updatePipeline(id: string, input: PipelineInput): Pipeline {
    assert(this.getPipeline(id), 404, '流水线不存在');
    const normalized = this.normalizePipeline(input);
    this.assertPipelineNameUnique(normalized.name, id);
    try {
      this.db
        .prepare('UPDATE pipelines SET name = ?, description = ?, nodes = ?, edges = ?, updated_at = ? WHERE id = ?')
        .run(
          normalized.name,
          normalized.description,
          JSON.stringify(normalized.nodes),
          JSON.stringify(normalized.edges),
          now(),
          id,
        );
    } catch (error) {
      translateSqliteError(error, '更新流水线失败');
    }
    return this.getPipeline(id)!;
  }

  deletePipeline(id: string): Pipeline {
    const pipeline = this.getPipeline(id);
    assert(pipeline, 404, '流水线不存在');
    const running = this.findActiveTask();
    if (running && running.pipelineId === id) {
      throw new AppError(409, '该流水线上仍有进行中的任务，请先处理或终止任务');
    }
    this.db.prepare('DELETE FROM pipelines WHERE id = ?').run(id);
    return pipeline;
  }

  /* ---------------------------------------------------------------- */
  /* skills                                                            */
  /* ---------------------------------------------------------------- */

  mapSkillFile(row: Row): SkillFile {
    const filePath = asString(row.path);
    return {
      path: filePath,
      size: Number(row.size ?? 0),
      script: isSkillScriptPath(filePath),
      text: Number(row.is_text ?? 1) !== 0,
      updatedAt: asString(row.updated_at),
    };
  }

  mapSkill(row: Row, files: SkillFile[] = []): Skill {
    return {
      id: asString(row.id),
      name: asString(row.name),
      description: asString(row.description),
      content: asString(row.content),
      files,
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    };
  }

  listSkillFiles(skillId: string): SkillFile[] {
    const rows = this.db
      .prepare('SELECT path, size, is_text, updated_at FROM skill_files WHERE skill_id = ? ORDER BY path ASC')
      .all(skillId) as Row[];
    return rows.map((row) => this.mapSkillFile(row));
  }

  /** 把文件元数据按技能分组，避免列表接口逐条查询。 */
  private groupSkillFiles(rows: Row[]): Map<string, SkillFile[]> {
    const grouped = new Map<string, SkillFile[]>();
    for (const row of rows) {
      const skillId = asString(row.skill_id);
      const list = grouped.get(skillId) ?? [];
      list.push(this.mapSkillFile(row));
      grouped.set(skillId, list);
    }
    return grouped;
  }

  listSkills(): Skill[] {
    const rows = this.db.prepare('SELECT * FROM skills ORDER BY created_at ASC').all() as Row[];
    const fileRows = this.db
      .prepare('SELECT skill_id, path, size, is_text, updated_at FROM skill_files ORDER BY path ASC')
      .all() as Row[];
    const grouped = this.groupSkillFiles(fileRows);
    return rows.map((row) => this.mapSkill(row, grouped.get(asString(row.id)) ?? []));
  }

  getSkill(id: string): Skill | null {
    const row = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    return this.mapSkill(row, this.listSkillFiles(id));
  }

  getSkillsByIds(ids: string[]): Skill[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM skills WHERE id IN (${placeholders}) ORDER BY name ASC`)
      .all(...ids) as Row[];
    const fileRows = this.db
      .prepare(
        `SELECT skill_id, path, size, is_text, updated_at FROM skill_files WHERE skill_id IN (${placeholders}) ORDER BY path ASC`,
      )
      .all(...ids) as Row[];
    const grouped = this.groupSkillFiles(fileRows);
    return rows.map((row) => this.mapSkill(row, grouped.get(asString(row.id)) ?? []));
  }

  /** 包内脚本按文件名唯一（大小写不敏感），文档里的 {{script:名}} 才能无歧义解析。 */
  private assertUniqueScriptName(skillId: string, name: string, exceptPath?: string): void {
    const rows = this.db
      .prepare("SELECT path FROM skill_files WHERE skill_id = ? AND path LIKE 'scripts/%'")
      .all(skillId) as Row[];
    const key = name.toLowerCase();
    const conflict = rows.find(
      (row) => asString(row.path).toLowerCase() !== (exceptPath ?? '').toLowerCase() && scriptFileName(asString(row.path)).toLowerCase() === key,
    );
    if (conflict) {
      throw new AppError(409, `脚本名称「${name}」已被 ${asString(conflict.path)} 使用，同一技能内的脚本文件名不能重复`);
    }
  }

  private assertSkillReferences(content: string, skillId: string): void {
    assertSkillReferences(content, scriptNamesOf(this.listSkillFiles(skillId)));
  }

  readSkillFile(skillId: string, filePath: string): { file: SkillFile; bytes: Buffer } | null {
    const normalized = normalizeSkillFilePath(filePath);
    const row = this.db
      .prepare(
        'SELECT path, content, size, is_text, updated_at FROM skill_files WHERE skill_id = ? AND path = ?',
      )
      .get(skillId, normalized) as Row | undefined;
    if (!row) return null;
    return { file: this.mapSkillFile(row), bytes: Buffer.from(row.content as Uint8Array) };
  }

  getSkillPackageFiles(skillId: string): { file: SkillFile; bytes: Buffer }[] {
    const rows = this.db
      .prepare(
        'SELECT path, content, size, is_text, updated_at FROM skill_files WHERE skill_id = ? ORDER BY path ASC',
      )
      .all(skillId) as Row[];
    return rows.map((row) => ({
      file: this.mapSkillFile(row),
      bytes: Buffer.from(row.content as Uint8Array),
    }));
  }

  upsertSkillFile(skillId: string, input: SkillFileInput): Skill {
    assert(this.getSkill(skillId), 404, '技能不存在');
    const filePath = normalizeSkillFilePath(input.path);
    const script = isSkillScriptPath(filePath);
    const encoding = input.encoding === 'base64' ? 'base64' : 'utf8';
    if (script && encoding === 'base64') {
      throw new AppError(400, '脚本文件必须以 UTF-8 文本方式保存');
    }
    const bytes = Buffer.from(String(input.content ?? ''), encoding);
    assert(
      bytes.length <= SKILL_FILE_LIMITS.maxFileBytes,
      400,
      `单个技能文件不能超过 ${Math.round(SKILL_FILE_LIMITS.maxFileBytes / 1024)} KB`,
    );
    const existing = this.db
      .prepare('SELECT size FROM skill_files WHERE skill_id = ? AND path = ?')
      .get(skillId, filePath) as Row | undefined;
    const totals = this.db
      .prepare('SELECT COALESCE(SUM(size), 0) AS total, COUNT(*) AS count FROM skill_files WHERE skill_id = ?')
      .get(skillId) as Row;
    const nextTotal = Number(totals.total) - (existing ? Number(existing.size) : 0) + bytes.length;
    assert(
      nextTotal <= SKILL_FILE_LIMITS.maxTotalBytes,
      400,
      `单个技能的文件总量不能超过 ${Math.round(SKILL_FILE_LIMITS.maxTotalBytes / 1024 / 1024)} MB`,
    );
    const nextCount = Number(totals.count) + (existing ? 0 : 1);
    assert(nextCount <= SKILL_FILE_LIMITS.maxFiles, 400, `单个技能最多包含 ${SKILL_FILE_LIMITS.maxFiles} 个文件`);
    // Windows 文件系统大小写不敏感，避免同一路径仅大小写不同造成落盘覆盖。
    const pathConflict = this.db
      .prepare('SELECT path FROM skill_files WHERE skill_id = ? AND path = ? COLLATE NOCASE AND path != ?')
      .get(skillId, filePath, filePath) as Row | undefined;
    assert(!pathConflict, 409, `路径「${asString(pathConflict?.path ?? filePath)}」已存在`);
    if (script) this.assertUniqueScriptName(skillId, scriptFileName(filePath), filePath);

    const timestamp = now();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO skill_files (skill_id, path, content, size, is_text, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(skill_id, path) DO UPDATE SET
             content = excluded.content,
             size = excluded.size,
             is_text = excluded.is_text,
             updated_at = excluded.updated_at`,
        )
        .run(skillId, filePath, bytes, bytes.length, encoding === 'utf8' ? 1 : 0, timestamp);
      this.db.prepare('UPDATE skills SET updated_at = ? WHERE id = ?').run(timestamp, skillId);
    });
    return this.getSkill(skillId)!;
  }

  renameSkillFile(skillId: string, from: string, to: string): Skill {
    const skill = this.getSkill(skillId);
    assert(skill, 404, '技能不存在');
    const fromPath = normalizeSkillFilePath(from);
    const toPath = normalizeSkillFilePath(to);
    // Windows 文件系统大小写不敏感，仅改大小写视为同一路径，不做变更。
    if (fromPath.toLowerCase() === toPath.toLowerCase()) return skill;
    const existing = this.db
      .prepare('SELECT path FROM skill_files WHERE skill_id = ? AND path = ?')
      .get(skillId, fromPath) as Row | undefined;
    assert(existing, 404, `文件「${fromPath}」不存在`);
    const fromScript = isSkillScriptPath(fromPath);
    const toScript = isSkillScriptPath(toPath);
    assert(fromScript === toScript, 400, '脚本与普通文件之间不能直接移动，请分别删除后重新添加');
    const target = this.db
      .prepare('SELECT path FROM skill_files WHERE skill_id = ? AND path = ? COLLATE NOCASE')
      .get(skillId, toPath) as Row | undefined;
    assert(!target, 409, `目标路径「${toPath}」已存在`);
    if (toScript) this.assertUniqueScriptName(skillId, scriptFileName(toPath), fromPath);

    const timestamp = now();
    this.tx(() => {
      this.db
        .prepare('UPDATE skill_files SET path = ?, updated_at = ? WHERE skill_id = ? AND path = ?')
        .run(toPath, timestamp, skillId, fromPath);
      const oldName = scriptFileName(fromPath);
      const newName = scriptFileName(toPath);
      if (fromScript && oldName.toLowerCase() !== newName.toLowerCase()) {
        const content = renameScriptReferences(skill.content, oldName, newName);
        this.assertSkillReferences(content, skillId);
        this.db.prepare('UPDATE skills SET content = ?, updated_at = ? WHERE id = ?').run(content, timestamp, skillId);
      } else {
        this.db.prepare('UPDATE skills SET updated_at = ? WHERE id = ?').run(timestamp, skillId);
      }
    });
    return this.getSkill(skillId)!;
  }

  deleteSkillFile(skillId: string, filePath: string): Skill {
    const skill = this.getSkill(skillId);
    assert(skill, 404, '技能不存在');
    const normalized = normalizeSkillFilePath(filePath);
    const existing = this.db
      .prepare('SELECT path FROM skill_files WHERE skill_id = ? AND path = ?')
      .get(skillId, normalized) as Row | undefined;
    assert(existing, 404, `文件「${normalized}」不存在`);
    if (isSkillScriptPath(normalized)) {
      const name = scriptFileName(normalized);
      const referenced = extractScriptReferences(skill.content).some(
        (ref) => ref.toLowerCase() === name.toLowerCase(),
      );
      if (referenced) {
        throw new AppError(409, `脚本「${name}」仍被技能文档引用，请先在 Markdown 中删除对应的 {{script:${name}}} 占位符`);
      }
    }
    const timestamp = now();
    this.tx(() => {
      this.db.prepare('DELETE FROM skill_files WHERE skill_id = ? AND path = ?').run(skillId, normalized);
      this.db.prepare('UPDATE skills SET updated_at = ? WHERE id = ?').run(timestamp, skillId);
    });
    return this.getSkill(skillId)!;
  }

  private assertSkillName(name: string, exceptId?: string): void {
    assert(name.length >= 1 && name.length <= 40, 400, '技能名称长度需在 1-40 个字符之间');
    const row = this.db
      .prepare('SELECT id FROM skills WHERE name = ? COLLATE NOCASE AND id != ?')
      .get(name, exceptId ?? '') as Row | undefined;
    if (row) throw new AppError(409, '已存在同名技能');
  }

  createSkill(input: SkillInput): Skill {
    const name = String(input.name ?? '').trim();
    this.assertSkillName(name);
    const description = String(input.description ?? '').trim();
    assert(description.length <= 300, 400, '技能描述不能超过 300 个字符');
    const content = String(input.content ?? '');
    assert(content.length <= 200_000, 400, '技能正文不能超过 200000 个字符');
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        'INSERT INTO skills (id, name, description, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, name, description, content, timestamp, timestamp);
    return this.getSkill(id)!;
  }

  updateSkill(id: string, input: Partial<SkillInput>): Skill {
    const existing = this.getSkill(id);
    assert(existing, 404, '技能不存在');
    const name = input.name !== undefined ? String(input.name).trim() : existing.name;
    this.assertSkillName(name, id);
    const description =
      input.description !== undefined ? String(input.description).trim() : existing.description;
    assert(description.length <= 300, 400, '技能描述不能超过 300 个字符');
    const content = input.content !== undefined ? String(input.content) : existing.content;
    assert(content.length <= 200_000, 400, '技能正文不能超过 200000 个字符');
    if (content !== existing.content) this.assertSkillReferences(content, id);
    this.db
      .prepare('UPDATE skills SET name = ?, description = ?, content = ?, updated_at = ? WHERE id = ?')
      .run(name, description, content, now(), id);
    return this.getSkill(id)!;
  }

  deleteSkill(id: string): void {
    assert(this.getSkill(id), 404, '技能不存在');
    this.tx(() => {
      const agents = this.db.prepare('SELECT id, skill_ids FROM agents').all() as Row[];
      const update = this.db.prepare('UPDATE agents SET skill_ids = ? WHERE id = ?');
      for (const agent of agents) {
        const ids = parseJson<string[]>(agent.skill_ids, []);
        if (!ids.includes(id)) continue;
        update.run(JSON.stringify(ids.filter((skillId) => skillId !== id)), asString(agent.id));
      }
      this.db.prepare('DELETE FROM skills WHERE id = ?').run(id);
    });
  }

  /* ---------------------------------------------------------------- */
  /* custom tools                                                      */
  /* ---------------------------------------------------------------- */

  mapTool(row: Row): CustomTool {
    return {
      id: asString(row.id),
      name: asString(row.name),
      description: asString(row.description),
      parameters: parseJson<Record<string, unknown>>(row.parameters, {
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      code: asString(row.code),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    };
  }

  listCustomTools(): CustomTool[] {
    const rows = this.db.prepare('SELECT * FROM custom_tools ORDER BY created_at ASC').all() as Row[];
    return rows.map((row) => this.mapTool(row));
  }

  getCustomTool(id: string): CustomTool | null {
    const row = this.db.prepare('SELECT * FROM custom_tools WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapTool(row) : null;
  }

  private assertToolName(name: string, exceptId?: string): void {
    assert(/^[a-z][a-z0-9_]{1,40}$/.test(name), 400, '工具名称需以小写字母开头，只能包含小写字母、数字和下划线，长度 2-41');
    assert(!(BUILTIN_TOOL_NAMES as readonly string[]).includes(name), 400, '工具名称与内置工具冲突');
    const row = this.db
      .prepare('SELECT id FROM custom_tools WHERE name = ? AND id != ?')
      .get(name, exceptId ?? '') as Row | undefined;
    if (row) throw new AppError(409, '已存在同名工具');
  }

  createTool(input: CustomToolInput): CustomTool {
    const name = String(input.name ?? '').trim();
    this.assertToolName(name);
    const description = String(input.description ?? '').trim();
    assert(description.length >= 1 && description.length <= 500, 400, '工具描述长度需在 1-500 个字符之间');
    const parameters = input.parameters ?? { type: 'object', properties: {}, additionalProperties: false };
    assert(typeof parameters === 'object' && parameters !== null, 400, '参数 Schema 必须是 JSON 对象');
    const parametersText = JSON.stringify(parameters);
    assert(parametersText.length <= 50_000, 400, '参数 Schema 过大');
    const code = String(input.code ?? '');
    assert(code.length >= 1 && code.length <= 100_000, 400, '工具代码长度需在 1-100000 个字符之间');
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        'INSERT INTO custom_tools (id, name, description, parameters, code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, name, description, parametersText, code, timestamp, timestamp);
    return this.getCustomTool(id)!;
  }

  updateTool(id: string, input: Partial<CustomToolInput>): CustomTool {
    const existing = this.getCustomTool(id);
    assert(existing, 404, '工具不存在');
    const name = input.name !== undefined ? String(input.name).trim() : existing.name;
    this.assertToolName(name, id);
    const description =
      input.description !== undefined ? String(input.description).trim() : existing.description;
    assert(description.length >= 1 && description.length <= 500, 400, '工具描述长度需在 1-500 个字符之间');
    const parameters = input.parameters !== undefined ? input.parameters : existing.parameters;
    assert(typeof parameters === 'object' && parameters !== null, 400, '参数 Schema 必须是 JSON 对象');
    const parametersText = JSON.stringify(parameters);
    assert(parametersText.length <= 50_000, 400, '参数 Schema 过大');
    const code = input.code !== undefined ? String(input.code) : existing.code;
    assert(code.length >= 1 && code.length <= 100_000, 400, '工具代码长度需在 1-100000 个字符之间');
    this.db
      .prepare('UPDATE custom_tools SET name = ?, description = ?, parameters = ?, code = ?, updated_at = ? WHERE id = ?')
      .run(name, description, parametersText, code, now(), id);
    return this.getCustomTool(id)!;
  }

  toolUsage(id: string): Agent[] {
    return this.listAgents().filter((agent) => agent.tools.custom.includes(id));
  }

  deleteTool(id: string): void {
    assert(this.getCustomTool(id), 404, '工具不存在');
    const usage = this.toolUsage(id);
    if (usage.length > 0) {
      throw new AppError(
        409,
        `该工具仍被 ${usage.length} 个智能体使用：${usage.map((agent) => agent.name).join('、')}`,
      );
    }
    this.db.prepare('DELETE FROM custom_tools WHERE id = ?').run(id);
  }

  /* ---------------------------------------------------------------- */
  /* tasks & turns                                                     */
  /* ---------------------------------------------------------------- */

  private taskSummaryQuery(where: string): string {
    return `SELECT t.*,
      (SELECT COUNT(*) FROM turns tn WHERE tn.task_id = t.id) AS turn_count,
      (SELECT tt.agent_id FROM turns tt WHERE tt.id = t.current_turn_id) AS current_agent_id,
      (SELECT tt.agent_name FROM turns tt WHERE tt.id = t.current_turn_id) AS current_agent_name
      FROM tasks t ${where}`;
  }

  mapTaskSummary(row: Row): TaskSummary {
    const status = asString(row.status) as TaskStatus;
    const snapshot = parseJson<Pipeline | null>(row.pipeline_snapshot, null);
    const nodes = snapshot?.nodes ?? [];
    const currentNodeId =
      row.current_node_id === null || row.current_node_id === undefined ? null : asString(row.current_node_id);
    // 分支图没有天然线性顺序：进度按「起点 BFS 顺序」中的位置计算。
    const order = snapshot ? bfsNodeOrder(snapshot) : [];
    const currentIndex = currentNodeId ? order.findIndex((node) => node.id === currentNodeId) : -1;
    return {
      id: asString(row.id),
      task: asString(row.task),
      status,
      startAgentId: asString(row.start_agent_id),
      pipelineId: row.pipeline_id === null || row.pipeline_id === undefined ? null : asString(row.pipeline_id),
      pipelineName: asString(row.pipeline_name),
      currentNodeId,
      pipelineStep: snapshot && findStartNode(snapshot) ? Math.max(currentIndex, 0) + 1 : nodes.length > 0 ? 1 : 0,
      pipelineTotal: nodes.length,
      currentTurnId:
        row.current_turn_id === null || row.current_turn_id === undefined ? null : asString(row.current_turn_id),
      // 交付给人类验收后，当前处理者是「人类」而不是某个智能体
      currentAgentId: status === 'waiting_human' ? null : asString(row.current_agent_id) || null,
      currentAgentName: status === 'waiting_human' ? null : asString(row.current_agent_name) || null,
      turnCount: asNumber(row.turn_count),
      error: row.error === null || row.error === undefined ? null : asString(row.error),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      finishedAt: row.finished_at === null || row.finished_at === undefined ? null : asString(row.finished_at),
    };
  }

  listTasks(limit = 50): TaskSummary[] {
    const rows = this.db
      .prepare(`${this.taskSummaryQuery('')} ORDER BY t.created_at DESC LIMIT ?`)
      .all(clamp(limit, 1, 200)) as Row[];
    return rows.map((row) => this.mapTaskSummary(row));
  }

  getTask(id: string): TaskSummary | null {
    const row = this.db.prepare(this.taskSummaryQuery('WHERE t.id = ?')).get(id) as Row | undefined;
    return row ? this.mapTaskSummary(row) : null;
  }

  getTaskDetail(id: string): TaskDetail | null {
    const task = this.getTask(id);
    if (!task) return null;
    const row = this.db.prepare('SELECT pipeline_snapshot FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return {
      ...task,
      pipeline: parseJson<Pipeline | null>(row?.pipeline_snapshot, null),
      turns: this.listTurns(id),
    };
  }

  updateTask(
    id: string,
    patch: Partial<{
      status: TaskStatus;
      currentNodeId: string | null;
      currentTurnId: string | null;
      error: string | null;
      finishedAt: string | null;
    }>,
  ): void {
    const sets: string[] = [];
    const params: (string | null)[] = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.currentNodeId !== undefined) {
      sets.push('current_node_id = ?');
      params.push(patch.currentNodeId);
    }
    if (patch.currentTurnId !== undefined) {
      sets.push('current_turn_id = ?');
      params.push(patch.currentTurnId);
    }
    if (patch.error !== undefined) {
      sets.push('error = ?');
      params.push(patch.error);
    }
    if (patch.finishedAt !== undefined) {
      sets.push('finished_at = ?');
      params.push(patch.finishedAt);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(now());
    params.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  /** 创建任务并生成第一个环节（起点节点）。 */
  createTask(params: {
    task: string;
    pipeline: Pipeline;
    node: PipelineNode;
    agent: Agent;
  }): { taskId: string; turnId: string; conversationId: string } {
    const { node, agent } = params;
    const task = String(params.task ?? '').trim();
    assert(task.length >= 1 && task.length <= 50_000, 400, '任务内容长度需在 1-50000 个字符之间');
    const taskId = randomUUID();
    const turnId = randomUUID();
    const conversationId = randomUUID();
    const timestamp = now();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO tasks
             (id, task, status, start_agent_id, pipeline_id, pipeline_name, pipeline_snapshot, current_node_id, current_turn_id, error, created_at, updated_at)
           VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          taskId,
          task,
          agent.id,
          params.pipeline.id,
          params.pipeline.name,
          JSON.stringify(params.pipeline),
          node.id,
          turnId,
          timestamp,
          timestamp,
        );
      this.db
        .prepare(
          `INSERT INTO turns
             (id, task_id, seq, node_id, agent_id, agent_name, agent_accent, status, input, output, iterations)
           VALUES (?, ?, 1, ?, ?, ?, ?, 'running', '', '', 0)`,
        )
        .run(turnId, taskId, node.id, agent.id, agent.name, agent.accent);
      this.db
        .prepare('INSERT INTO conversations (id, task_id, turn_id, agent_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(conversationId, taskId, turnId, agent.id, timestamp);
    });
    return { taskId, turnId, conversationId };
  }

  /** 为任务追加下一环节（沿连线推进到指定节点）。 */
  createTurn(taskId: string, agent: Agent, node: PipelineNode): { turnId: string; conversationId: string; seq: number } {
    const task = this.getTask(taskId);
    assert(task, 404, '任务不存在');
    const turnId = randomUUID();
    const conversationId = randomUUID();
    const seq = this.tx(() => {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM turns WHERE task_id = ?')
        .get(taskId) as Row;
      const next = asNumber(row.next);
      this.db
        .prepare(
          `INSERT INTO turns
             (id, task_id, seq, node_id, agent_id, agent_name, agent_accent, status, input, output, iterations)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'running', '', '', 0)`,
        )
        .run(turnId, taskId, next, node.id, agent.id, agent.name, agent.accent);
      this.db
        .prepare('INSERT INTO conversations (id, task_id, turn_id, agent_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(conversationId, taskId, turnId, agent.id, now());
      this.db
        .prepare('UPDATE tasks SET current_turn_id = ?, current_node_id = ?, updated_at = ? WHERE id = ?')
        .run(turnId, node.id, now(), taskId);
      return next;
    });
    return { turnId, conversationId, seq };
  }

  mapTurn(row: Row): Turn {
    return {
      id: asString(row.id),
      taskId: asString(row.task_id),
      seq: asNumber(row.seq),
      nodeId: row.node_id === null || row.node_id === undefined ? null : asString(row.node_id),
      agentId: asString(row.agent_id),
      agentName: asString(row.agent_name),
      agentAccent: asString(row.agent_accent),
      status: asString(row.status) as TurnStatus,
      input: asString(row.input),
      output: asString(row.output),
      handoffFolder: parseJson<HandoffFolder | null>(row.handoff_folder, null),
      target: parseJson<HandoffTargetResolved | null>(row.target, null),
      iterations: asNumber(row.iterations),
      startedAt: row.started_at === null || row.started_at === undefined ? null : asString(row.started_at),
      finishedAt: row.finished_at === null || row.finished_at === undefined ? null : asString(row.finished_at),
      error: row.error === null || row.error === undefined ? null : asString(row.error),
    };
  }

  listTurns(taskId: string): Turn[] {
    const rows = this.db
      .prepare('SELECT * FROM turns WHERE task_id = ? ORDER BY seq ASC')
      .all(taskId) as Row[];
    return rows.map((row) => this.mapTurn(row));
  }

  getTurn(id: string): Turn | null {
    const row = this.db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapTurn(row) : null;
  }

  /** 读取某个环节落库的完整系统提示词（开始执行时写入；尚未执行或回合不存在为 null）。 */
  getTurnSystemPrompt(turnId: string): string | null {
    const row = this.db.prepare('SELECT system_prompt FROM turns WHERE id = ?').get(turnId) as
      | Row
      | undefined;
    if (!row) return null;
    return row.system_prompt === null || row.system_prompt === undefined ? null : asString(row.system_prompt);
  }

  updateTurn(
    id: string,
    patch: Partial<{
      status: TurnStatus;
      input: string;
      output: string;
      systemPrompt: string | null;
      handoffFolder: HandoffFolder | null;
      target: HandoffTargetResolved | null;
      iterations: number;
      startedAt: string | null;
      finishedAt: string | null;
      error: string | null;
    }>,
  ): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.input !== undefined) {
      sets.push('input = ?');
      params.push(patch.input);
    }
    if (patch.output !== undefined) {
      sets.push('output = ?');
      params.push(patch.output);
    }
    if (patch.systemPrompt !== undefined) {
      sets.push('system_prompt = ?');
      params.push(patch.systemPrompt);
    }
    if (patch.handoffFolder !== undefined) {
      sets.push('handoff_folder = ?');
      params.push(patch.handoffFolder === null ? null : JSON.stringify(patch.handoffFolder));
    }
    if (patch.target !== undefined) {
      sets.push('target = ?');
      params.push(patch.target === null ? null : JSON.stringify(patch.target));
    }
    if (patch.iterations !== undefined) {
      sets.push('iterations = ?');
      params.push(patch.iterations);
    }
    if (patch.startedAt !== undefined) {
      sets.push('started_at = ?');
      params.push(patch.startedAt);
    }
    if (patch.finishedAt !== undefined) {
      sets.push('finished_at = ?');
      params.push(patch.finishedAt);
    }
    if (patch.error !== undefined) {
      sets.push('error = ?');
      params.push(patch.error);
    }
    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE turns SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  getTurnConversation(turnId: string): { id: string; taskId: string; turnId: string; agentId: string } | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE turn_id = ?').get(turnId) as Row | undefined;
    if (!row) return null;
    return {
      id: asString(row.id),
      taskId: asString(row.task_id),
      turnId: asString(row.turn_id),
      agentId: asString(row.agent_id),
    };
  }

  findActiveTask(): TaskSummary | null {
    const row = this.db
      .prepare(
        `${this.taskSummaryQuery(
          "WHERE t.status IN ('running','paused','waiting_human')",
        )} ORDER BY t.created_at DESC LIMIT 1`,
      )
      .get() as Row | undefined;
    return row ? this.mapTaskSummary(row) : null;
  }

  /* ---------------------------------------------------------------- */
  /* messages                                                          */
  /* ---------------------------------------------------------------- */

  mapMessage(row: Row): ConversationMessage {
    return {
      id: asString(row.id),
      conversationId: asString(row.conversation_id),
      seq: asNumber(row.seq),
      role: asString(row.role) as ConversationMessage['role'],
      content: asString(row.content),
      toolCalls: parseJson<ToolCallView[]>(row.tool_calls, []),
      toolCallId: row.tool_call_id === null || row.tool_call_id === undefined ? null : asString(row.tool_call_id),
      name: row.name === null || row.name === undefined ? null : asString(row.name),
      meta: parseJson<MessageMeta>(row.meta, { kind: 'assistant' }),
      images: parseJson<AttachedImage[]>(row.images, []),
      createdAt: asString(row.created_at),
    };
  }

  appendMessage(conversationId: string, input: MessageInput): ConversationMessage {
    return this.tx(() => {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?')
        .get(conversationId) as Row;
      const seq = asNumber(row.next);
      const id = randomUUID();
      const createdAt = now();
      const images = input.images ?? [];
      this.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, seq, role, content, tool_calls, tool_call_id, name, meta, images, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          conversationId,
          seq,
          input.role,
          input.content,
          input.toolCalls && input.toolCalls.length > 0 ? JSON.stringify(input.toolCalls) : null,
          input.toolCallId ?? null,
          input.name ?? null,
          JSON.stringify(input.meta ?? { kind: input.role === 'tool' ? 'tool_result' : 'assistant' }),
          images.length > 0 ? JSON.stringify(images) : null,
          createdAt,
        );
      return {
        id,
        conversationId,
        seq,
        role: input.role,
        content: input.content,
        toolCalls: input.toolCalls ?? [],
        toolCallId: input.toolCallId ?? null,
        name: input.name ?? null,
        meta: input.meta ?? { kind: input.role === 'tool' ? 'tool_result' : 'assistant' },
        images,
        createdAt,
      };
    });
  }

  listMessages(conversationId: string, limit?: number): ConversationMessage[] {
    if (limit && limit > 0) {
      const rows = this.db
        .prepare(
          `SELECT * FROM (
             SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?
           ) ORDER BY seq ASC`,
        )
        .all(conversationId, limit) as Row[];
      return rows.map((row) => this.mapMessage(row));
    }
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC')
      .all(conversationId) as Row[];
    return rows.map((row) => this.mapMessage(row));
  }

  /* ---------------------------------------------------------------- */
  /* feedback                                                          */
  /* ---------------------------------------------------------------- */

  mapFeedback(row: Row): Feedback {
    return {
      id: asString(row.id),
      agentId: row.agent_id === null || row.agent_id === undefined ? null : asString(row.agent_id),
      agentName: asString(row.agent_name),
      taskName: asString(row.task_name),
      taskId: row.task_id === null || row.task_id === undefined ? null : asString(row.task_id),
      turnId: row.turn_id === null || row.turn_id === undefined ? null : asString(row.turn_id),
      category: asString(row.category) as Feedback['category'],
      severity: asString(row.severity) as Feedback['severity'],
      content: asString(row.content),
      contextSnapshot: parseJson<FeedbackSnapshot | null>(row.context_snapshot, null),
      status: asString(row.status) as FeedbackStatus,
      resolutionNote: asString(row.resolution_note),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    };
  }

  createFeedback(input: FeedbackCreateInput): Feedback {
    const content = String(input.content ?? '').trim();
    assert(content.length >= 1 && content.length <= 10_000, 400, '反馈内容长度需在 1-10000 个字符之间');
    assert(['prompt', 'tool', 'skill', 'workflow', 'agent', 'environment', 'other'].includes(input.category), 400, '无效的反馈分类');
    assert(['low', 'medium', 'high'].includes(input.severity), 400, '无效的严重程度');
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO feedback
         (id, agent_id, agent_name, task_name, task_id, turn_id, category, severity, content, context_snapshot, status, resolution_note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', '', ?, ?)`,
      )
      .run(
        id,
        input.agentId,
        input.agentName,
        input.taskName,
        input.taskId,
        input.turnId,
        input.category,
        input.severity,
        content,
        input.contextSnapshot ? JSON.stringify(input.contextSnapshot) : null,
        timestamp,
        timestamp,
      );
    const row = this.db.prepare('SELECT * FROM feedback WHERE id = ?').get(id) as Row;
    return this.mapFeedback(row);
  }

  getFeedback(id: string): Feedback | null {
    const row = this.db.prepare('SELECT * FROM feedback WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapFeedback(row) : null;
  }

  listFeedback(filters: { status?: string; category?: string; agentId?: string; limit?: number } = {}): Feedback[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filters.status && filters.status !== 'all') {
      where.push('status = ?');
      params.push(filters.status);
    }
    if (filters.category && filters.category !== 'all') {
      where.push('category = ?');
      params.push(filters.category);
    }
    if (filters.agentId) {
      where.push('agent_id = ?');
      params.push(filters.agentId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM feedback ${clause} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, clamp(filters.limit ?? 100, 1, 500)) as Row[];
    return rows.map((row) => this.mapFeedback(row));
  }

  updateFeedback(id: string, input: FeedbackUpdate): Feedback {
    const existing = this.getFeedback(id);
    assert(existing, 404, '反馈不存在');
    const status = input.status ?? existing.status;
    assert(['open', 'resolved', 'ignored'].includes(status), 400, '无效的反馈状态');
    const note = input.resolutionNote !== undefined ? String(input.resolutionNote).trim() : existing.resolutionNote;
    assert(note.length <= 2000, 400, '处理备注不能超过 2000 个字符');
    this.db
      .prepare('UPDATE feedback SET status = ?, resolution_note = ?, updated_at = ? WHERE id = ?')
      .run(status, note, now(), id);
    return this.getFeedback(id)!;
  }

  countOpenFeedback(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM feedback WHERE status = 'open'").get() as Row;
    return asNumber(row.c);
  }

  feedbackCounts(): { all: number; open: number; resolved: number; ignored: number } {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS c FROM feedback GROUP BY status').all() as Row[];
    const result = { all: 0, open: 0, resolved: 0, ignored: 0 };
    for (const row of rows) {
      const count = asNumber(row.c);
      const status = asString(row.status) as 'open' | 'resolved' | 'ignored';
      if (status in result) result[status] += count;
      result.all += count;
    }
    return result;
  }

  /* ---------------------------------------------------------------- */
  /* designer（流水线设计师）                                            */
  /* ---------------------------------------------------------------- */

  /** 设计师的系统级专属工作目录：跨会话持久，不属于任何任务。 */
  designerWorkspaceDir(): string {
    const dir = path.join(this.workspaceRoot, 'designer');
    assert(path.resolve(dir).startsWith(path.resolve(this.workspaceRoot)), 500, '设计师工作目录路径越界');
    return dir;
  }

  ensureDesignerWorkspace(): string {
    const dir = this.designerWorkspaceDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 校验并解析设计师工作目录内的相对路径（'' 表示根目录）。
   * 拒绝绝对路径、反斜杠与 `..` 上跳；解析后仍必须落在工作目录内，否则抛 400。
   */
  resolveDesignerWorkspacePath(relPath: string): string {
    const normalized = path.posix.normalize(String(relPath ?? '').replace(/\\/g, '/').trim());
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new AppError(400, `路径不合法：${relPath}`);
    }
    const workspace = path.resolve(this.designerWorkspaceDir());
    const parts = normalized === '' || normalized === '.' ? [] : normalized.split('/');
    const target = path.resolve(workspace, ...parts);
    if (target !== workspace && !target.startsWith(workspace + path.sep)) {
      throw new AppError(400, `路径越界：${relPath}`);
    }
    return target;
  }

  /**
   * 列出设计师工作目录某一层的内容（文件夹在前、同类按名称排序）。
   * 符号链接一律跳过；超过单层上限时丢弃多余条目并标记 truncated。
   */
  listDesignerWorkspace(relPath: string): DesignerWorkspaceListing {
    const workspace = path.resolve(this.designerWorkspaceDir());
    const target = this.resolveDesignerWorkspacePath(relPath);
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(target, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
        throw new AppError(400, '该路径是文件，请按文件预览');
      }
      throw new AppError(404, '目录不存在或已被清理');
    }
    const relOf = (name: string): string =>
      path.relative(workspace, path.join(target, name)).split(path.sep).join('/');
    const entries: DesignerWorkspaceEntry[] = [];
    let truncated = false;
    const sorted = dirents
      .filter((entry) => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
      .sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN'),
      );
    for (const entry of sorted) {
      if (entries.length >= DESIGNER_WORKSPACE_LIST_MAX) {
        truncated = true;
        break;
      }
      if (entry.isDirectory()) {
        entries.push({ path: relOf(entry.name), name: entry.name, type: 'dir', size: 0 });
        continue;
      }
      let size = 0;
      try {
        size = fs.statSync(path.join(target, entry.name)).size;
      } catch {
        /* 读不到大小就按 0 展示 */
      }
      entries.push({ path: relOf(entry.name), name: entry.name, type: 'file', size });
    }
    return {
      path: path.relative(workspace, target).split(path.sep).join('/'),
      entries,
      truncated,
    };
  }

  getDesignerAgent(): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE slug = ?').get(DESIGNER_SLUG) as Row | undefined;
    return row ? this.mapAgent(row) : null;
  }

  /** 确保设计师智能体存在（slug 固定）；已存在时不覆盖——它的定义由人类维护。 */
  ensureDesignerAgent(definition: AgentInput): Agent {
    const existing = this.getDesignerAgent();
    if (existing) return existing;
    // 极端情况：用户此前手动建过同名智能体。换个名字兜底，绝不让系统启动失败。
    let name = definition.name;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const created = this.createAgent({ ...definition, name });
        // createAgent 生成随机 slug；这里把 slug 固定为 designer 作为系统标识。
        this.db.prepare('UPDATE agents SET slug = ? WHERE id = ?').run(DESIGNER_SLUG, created.id);
        return this.getDesignerAgent()!;
      } catch (error) {
        if (attempt === 0 && error instanceof AppError && error.status === 409) {
          name = `${definition.name}（系统）`;
          continue;
        }
        throw error;
      }
    }
  }

  mapDesignerSession(row: Row): DesignerSession {
    return {
      id: asString(row.id),
      title: asString(row.title) || '新对话',
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      compactedSeq: asNumber(row.compacted_seq),
      summary: asString(row.summary),
    };
  }

  listDesignerSessions(): DesignerSessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT s.*,
           (SELECT COUNT(*) FROM designer_messages m WHERE m.session_id = s.id) AS message_count
         FROM designer_sessions s
         ORDER BY s.updated_at DESC`,
      )
      .all() as Row[];
    const lastRows = this.db
      .prepare(
        `SELECT m.session_id, m.role, m.content FROM designer_messages m
         WHERE m.seq IN (SELECT MAX(seq) FROM designer_messages GROUP BY session_id)`,
      )
      .all() as Row[];
    const lastBySession = new Map(lastRows.map((row) => [asString(row.session_id), row]));
    return rows.map((row) => {
      const last = lastBySession.get(asString(row.id));
      const content = last ? asString(last.content).replace(/\s+/g, ' ').trim() : '';
      const preview =
        !last || asString(last.role) === 'tool'
          ? content
            ? `（工具调用）${content}`
            : '（工具调用）'
          : content;
      return {
        ...this.mapDesignerSession(row),
        messageCount: asNumber(row.message_count),
        lastMessagePreview: preview ? truncateDesignerPreview(preview) : '（空对话）',
      };
    });
  }

  getDesignerSession(id: string): DesignerSession | null {
    const row = this.db.prepare('SELECT * FROM designer_sessions WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapDesignerSession(row) : null;
  }

  createDesignerSession(title?: string): DesignerSession {
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare('INSERT INTO designer_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, (title ?? '').trim().slice(0, 60) || '新对话', timestamp, timestamp);
    return this.getDesignerSession(id)!;
  }

  /** 首条用户消息写入后，用消息前缀做会话标题。 */
  renameDesignerSessionFromMessage(id: string, message: string): void {
    const title = message.replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!title) return;
    this.db
      .prepare("UPDATE designer_sessions SET title = ?, updated_at = ? WHERE id = ? AND title = '新对话'")
      .run(title, now(), id);
  }

  touchDesignerSession(id: string): void {
    this.db.prepare('UPDATE designer_sessions SET updated_at = ? WHERE id = ?').run(now(), id);
  }

  /**
   * 落库一次「摘要压缩」结果：seq ≤ compactedSeq 的较早消息此后不再进入模型请求，
   * 由 summary（前情提要）替代（注入系统提示词）。界面历史不受影响。
   */
  compactDesignerSession(id: string, patch: { compactedSeq: number; summary: string }): DesignerSession {
    const session = this.getDesignerSession(id);
    assert(session, 404, '会话不存在');
    this.db
      .prepare('UPDATE designer_sessions SET compacted_seq = ?, summary = ?, updated_at = ? WHERE id = ?')
      .run(Math.max(0, Math.round(patch.compactedSeq)), patch.summary, now(), id);
    return this.getDesignerSession(id)!;
  }

  deleteDesignerSession(id: string): DesignerSession {
    const session = this.getDesignerSession(id);
    assert(session, 404, '会话不存在');
    this.db.prepare('DELETE FROM designer_sessions WHERE id = ?').run(id);
    return session;
  }

  mapDesignerMessage(row: Row): DesignerMessage {
    return {
      id: asString(row.id),
      sessionId: asString(row.session_id),
      seq: asNumber(row.seq),
      role: asString(row.role) as DesignerMessage['role'],
      content: asString(row.content),
      toolCalls: parseJson<ToolCallView[]>(row.tool_calls, []),
      toolCallId: row.tool_call_id === null || row.tool_call_id === undefined ? null : asString(row.tool_call_id),
      name: row.name === null || row.name === undefined ? null : asString(row.name),
      meta: parseJson<MessageMeta>(row.meta, { kind: 'assistant' }),
      images: parseJson<AttachedImage[]>(row.images, []),
      createdAt: asString(row.created_at),
    };
  }

  appendDesignerMessage(sessionId: string, input: MessageInput): DesignerMessage {
    return this.tx(() => {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM designer_messages WHERE session_id = ?')
        .get(sessionId) as Row;
      const seq = asNumber(row.next);
      const id = randomUUID();
      const createdAt = now();
      const images = input.images ?? [];
      this.db
        .prepare(
          `INSERT INTO designer_messages (id, session_id, seq, role, content, tool_calls, tool_call_id, name, meta, images, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          sessionId,
          seq,
          input.role,
          input.content,
          input.toolCalls && input.toolCalls.length > 0 ? JSON.stringify(input.toolCalls) : null,
          input.toolCallId ?? null,
          input.name ?? null,
          JSON.stringify(input.meta ?? { kind: input.role === 'tool' ? 'tool_result' : 'assistant' }),
          images.length > 0 ? JSON.stringify(images) : null,
          createdAt,
        );
      this.touchDesignerSession(sessionId);
      return {
        id,
        sessionId,
        seq,
        role: input.role,
        content: input.content,
        toolCalls: input.toolCalls ?? [],
        toolCallId: input.toolCallId ?? null,
        name: input.name ?? null,
        meta: input.meta ?? { kind: input.role === 'tool' ? 'tool_result' : 'assistant' },
        images,
        createdAt,
      };
    });
  }

  listDesignerMessages(sessionId: string): DesignerMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM designer_messages WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as Row[];
    return rows.map((row) => this.mapDesignerMessage(row));
  }

  mapDesignerProposal(row: Row): DesignerProposal {
    return {
      id: asString(row.id),
      sessionId: asString(row.session_id),
      messageId: row.message_id === null || row.message_id === undefined ? null : asString(row.message_id),
      title: asString(row.title),
      summary: asString(row.summary),
      changes: parseJson<DesignerChangeOp[]>(row.changes, []),
      status: asString(row.status) as DesignerProposalStatus,
      error: row.error === null || row.error === undefined ? null : asString(row.error),
      createdAt: asString(row.created_at),
      decidedAt: row.decided_at === null || row.decided_at === undefined ? null : asString(row.decided_at),
    };
  }

  /**
   * 落一条变更记录（对话式变更直接执行后的留档）：status 为 applied / failed，
   * failed 时携带 error（说明第几项失败与已生效清单）。decided_at 即执行完成时间。
   */
  createDesignerProposal(input: {
    sessionId: string;
    messageId: string | null;
    title: string;
    summary: string;
    changes: DesignerChangeOp[];
    status: 'applied' | 'failed';
    error?: string;
  }): DesignerProposal {
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO designer_proposals (id, session_id, message_id, title, summary, changes, status, error, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.messageId,
        input.title,
        input.summary,
        JSON.stringify(input.changes),
        input.status,
        input.error ?? null,
        timestamp,
        timestamp,
      );
    this.touchDesignerSession(input.sessionId);
    return this.getDesignerProposal(id)!;
  }

  getDesignerProposal(id: string): DesignerProposal | null {
    const row = this.db.prepare('SELECT * FROM designer_proposals WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapDesignerProposal(row) : null;
  }

  listDesignerProposals(sessionId: string): DesignerProposal[] {
    const rows = this.db
      .prepare('SELECT * FROM designer_proposals WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as Row[];
    return rows.map((row) => this.mapDesignerProposal(row));
  }

  /** 设计师的会话与消息属于运行数据，随一键清空一起删除；设计师智能体本身保留。 */
  resetDesignerData(): { sessions: number; messages: number; proposals: number } {
    return this.tx(() => {
      const count = (table: string) => {
        const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as Row;
        return asNumber(row.c);
      };
      const result = {
        sessions: count('designer_sessions'),
        messages: count('designer_messages'),
        proposals: count('designer_proposals'),
      };
      this.db.exec('DELETE FROM designer_proposals;');
      this.db.exec('DELETE FROM designer_messages;');
      this.db.exec('DELETE FROM designer_sessions;');
      return result;
    });
  }

  /** 设计师的系统级工作目录属于运行数据，随一键清空一起清空。 */
  resetDesignerWorkspace(): void {
    try {
      fs.rmSync(this.designerWorkspaceDir(), {
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 100,
      });
    } catch {
      /* ignore */
    }
  }

  /* --------------------------------------------------------------- */
  /* designer uploads（对话附件，保存在设计师工作目录下）                  */
  /* --------------------------------------------------------------- */

  /** 设计师上传附件的根目录：`<designer>/uploads/`，按会话分目录。 */
  designerUploadsRoot(): string {
    return path.join(this.designerWorkspaceDir(), 'uploads');
  }

  /** 某个会话的上传目录。会话 ID 是随机 UUID，这里同时校验它不含路径成分。 */
  designerUploadDir(sessionId: string): string {
    assert(/^[A-Za-z0-9-]{8,64}$/.test(sessionId), 400, '会话 ID 不合法');
    const dir = path.join(this.designerUploadsRoot(), sessionId);
    assert(
      path.resolve(dir).startsWith(path.resolve(this.designerUploadsRoot()) + path.sep),
      500,
      '上传目录路径越界',
    );
    return dir;
  }

  /** 保存一个上传附件：文件名清洗、同名自动加序号，绝不覆盖已有文件。 */
  saveDesignerUpload(sessionId: string, originalName: string, bytes: Buffer): DesignerAttachment {
    assert(this.getDesignerSession(sessionId), 404, '会话不存在');
    assert(bytes.length > 0, 400, '附件内容为空');
    const dir = this.designerUploadDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const stored = uniqueUploadName(dir, sanitizeUploadName(originalName));
    fs.writeFileSync(path.join(dir, stored), bytes);
    const display = normalizeUploadDisplayName(originalName, stored);
    return {
      name: display,
      path: `uploads/${sessionId}/${stored.split(path.sep).join('/')}`,
      size: bytes.length,
      image: isImageUploadName(stored),
    };
  }

  /**
   * 校验并解析一个附件引用：附件 path 相对设计师工作区根（与发给模型的路径一致），
   * 但必须落在本会话的上传目录内。
   */
  resolveDesignerUpload(sessionId: string, relPath: string, displayName?: string): DesignerAttachment {
    const workspace = path.resolve(this.designerWorkspaceDir());
    const uploadsDir = path.resolve(this.designerUploadDir(sessionId));
    const target = path.resolve(workspace, relPath);
    assert(
      target === uploadsDir || target.startsWith(uploadsDir + path.sep),
      400,
      `附件路径不合法：${relPath}`,
    );
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      throw new AppError(404, `附件不存在或已被清理：${relPath}`);
    }
    assert(stat.isFile(), 400, `附件不是普通文件：${relPath}`);
    const stored = path.relative(uploadsDir, target).split(path.sep).join('/');
    return {
      name: displayName?.trim() || stored,
      path: `uploads/${sessionId}/${stored}`,
      size: stat.size,
      image: isImageUploadName(stored),
    };
  }

  /** 读取一个附件的原始字节（预览 / 下载用）；路径越界或文件缺失返回 null。 */
  readDesignerUpload(sessionId: string, relPath: string): { bytes: Buffer; fileName: string } | null {
    const workspace = path.resolve(this.designerWorkspaceDir());
    const uploadsDir = path.resolve(this.designerUploadDir(sessionId));
    const target = path.resolve(workspace, relPath);
    if (target !== uploadsDir && !target.startsWith(uploadsDir + path.sep)) return null;
    try {
      if (!fs.statSync(target).isFile()) return null;
    } catch {
      return null;
    }
    return { bytes: fs.readFileSync(target), fileName: path.basename(target) };
  }

  /** 删除某个会话的全部上传文件（随会话删除 / 会话数据清理调用）。 */
  deleteDesignerUploads(sessionId: string): void {
    try {
      fs.rmSync(path.resolve(this.designerUploadDir(sessionId)), {
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 100,
      });
    } catch {
      /* ignore */
    }
  }

  /**
   * 清理「没有对应会话」的上传目录（孤儿附件）。数据库里已删除的会话不应留下
   * 无人引用的文件——升级迁移清空会话、或未来任何会话清理路径漏掉附件时兜底。
   */
  purgeOrphanDesignerUploads(): number {
    const root = this.designerUploadsRoot();
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (this.getDesignerSession(entry.name)) continue;
      const target = path.resolve(root, entry.name);
      // 双保险：只清理上传根目录内的目录。
      if (!target.startsWith(path.resolve(root) + path.sep)) continue;
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
        removed += 1;
      } catch {
        /* ignore */
      }
    }
    return removed;
  }

  /* ---------------------------------------------------------------- */
  /* stats & reset                                                     */
  /* ---------------------------------------------------------------- */

  getStats(): Stats {
    const count = (table: string) => {
      const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as Row;
      return asNumber(row.c);
    };
    return {
      agents: count('agents'),
      skills: count('skills'),
      tools: count('custom_tools'),
      tasks: count('tasks'),
      openFeedback: this.countOpenFeedback(),
      activeTask: this.findActiveTask(),
    };
  }

  resetRuntimeData(): { tasks: number; turns: number; messages: number } {
    return this.tx(() => {
      const count = (table: string) => {
        const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as Row;
        return asNumber(row.c);
      };
      const result = {
        tasks: count('tasks'),
        turns: count('turns'),
        messages: count('messages'),
      };
      this.db.exec('DELETE FROM messages;');
      this.db.exec('DELETE FROM conversations;');
      this.db.exec('DELETE FROM turns;');
      this.db.exec('DELETE FROM tasks;');
      return result;
    });
  }

  /** 任务工作区属于运行数据，随任务记录一起清空。 */
  resetTaskWorkspaces(): void {
    try {
      fs.rmSync(path.join(this.workspaceRoot, 'tasks'), {
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 100,
      });
    } catch {
      /* ignore */
    }
  }

  /** 进程重启时把仍在执行的回合标记为失败，任务停在当前环节等待用户决定。 */
  recoverInterruptedTasks(): number {
    const timestamp = now();
    const rows = this.db.prepare("SELECT id FROM tasks WHERE status = 'running'").all() as Row[];
    for (const row of rows) {
      const taskId = asString(row.id);
      this.db
        .prepare(
          "UPDATE turns SET status = 'failed', error = ?, finished_at = ? WHERE task_id = ? AND status = 'running'",
        )
        .run('服务重启，本环节中断', timestamp, taskId);
      this.db
        .prepare(
          "UPDATE tasks SET status = 'paused', error = ?, updated_at = ? WHERE id = ?",
        )
        .run('服务重启，流水线停在本环节；可重试或终止任务', timestamp, taskId);
    }
    return rows.length;
  }
}
