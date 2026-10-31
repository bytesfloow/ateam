import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 10;

/**
 * 首个支持增量迁移的版本。低于该版本的旧库（探索期的历史 schema）仍走「清空重建」：
 * 它们在旧策略下早已被清空过，没有可保留的业务数据。
 */
const MIGRATION_BASELINE = 9;

/**
 * 增量迁移步骤：把数据库从上一版本升到 `to` 版本。发布涉及 schema 变更的新版本时，
 * 把 SCHEMA_VERSION 加一，并在这里追加一个 `{ to: 新版本, up: (db) => { ... } }` 步骤。
 * - 纯代码升级（无结构变更）也要追加 `{ to: 新版本, up: () => {} }` 占位步骤；
 * - 步骤在事务中执行，失败会回滚并中止启动（绝不静默清数据）；
 * - 迁移只做「改旧为新」，新建表 / 索引交给 SCHEMA 的 `IF NOT EXISTS` 统一补齐。
 */
const MIGRATIONS: SchemaMigration[] = [
  {
    // v10：设计师改为「永远只有一条会话」+ 支持摘要压缩上下文。
    // - 会话表新增压缩水位（compacted_seq）与前情提要（summary）两列；
    // - 按需求确认：多会话存量数据（含消息、提案）一次性清空，从一条全新会话开始。
    //   删除会话行即级联删除消息与提案（外键 ON DELETE CASCADE）；
    //   各会话遗留的上传附件目录由启动时的 purgeOrphanDesignerUploads 统一清理。
    to: 10,
    up: (db) => {
      db.exec('ALTER TABLE designer_sessions ADD COLUMN compacted_seq INTEGER NOT NULL DEFAULT 0;');
      db.exec("ALTER TABLE designer_sessions ADD COLUMN summary TEXT NOT NULL DEFAULT '';");
      db.exec('DELETE FROM designer_proposals;');
      db.exec('DELETE FROM designer_messages;');
      db.exec('DELETE FROM designer_sessions;');
    },
  },
];

export interface SchemaMigration {
  /** 迁移目标版本（必须严格大于上一台阶）。 */
  to: number;
  up: (db: DatabaseSync) => void;
}

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  responsibilities TEXT NOT NULL DEFAULT '',
  deliverable TEXT NOT NULL DEFAULT '',
  guide TEXT NOT NULL DEFAULT '',
  model TEXT,
  temperature REAL,
  max_iterations INTEGER NOT NULL DEFAULT 0,
  tools TEXT NOT NULL,
  skill_ids TEXT NOT NULL DEFAULT '[]',
  accent TEXT NOT NULL DEFAULT '#6d8cff',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name ON agents(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_files (
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content BLOB NOT NULL,
  size INTEGER NOT NULL,
  is_text INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (skill_id, path)
);

CREATE TABLE IF NOT EXISTS custom_tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  parameters TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  nodes TEXT NOT NULL DEFAULT '[]',
  edges TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipelines_name ON pipelines(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  start_agent_id TEXT NOT NULL,
  pipeline_id TEXT,
  pipeline_name TEXT NOT NULL DEFAULT '',
  pipeline_snapshot TEXT,
  current_node_id TEXT,
  current_turn_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  node_id TEXT,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agent_accent TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT '',
  system_prompt TEXT,
  handoff_folder TEXT,
  target TEXT,
  iterations INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_turns_task ON turns(task_id, seq);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_turn ON conversations(turn_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tool_calls TEXT,
  tool_call_id TEXT,
  name TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  images TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_seq ON messages(conversation_id, seq);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  agent_name TEXT NOT NULL,
  task_name TEXT NOT NULL DEFAULT '',
  task_id TEXT,
  turn_id TEXT,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  content TEXT NOT NULL,
  context_snapshot TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolution_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, created_at DESC);

CREATE TABLE IF NOT EXISTS designer_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '新对话',
  compacted_seq INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS designer_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES designer_sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tool_calls TEXT,
  tool_call_id TEXT,
  name TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  images TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_designer_messages_seq ON designer_messages(session_id, seq);

CREATE TABLE IF NOT EXISTS designer_proposals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES designer_sessions(id) ON DELETE CASCADE,
  message_id TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  changes TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_designer_proposals_session ON designer_proposals(session_id, created_at);
`;

/**
 * 只保留 `settings` 的清空策略仅作为基线之前的兜底（见 MIGRATION_BASELINE）。
 * 基线及以后的升级一律走 MIGRATIONS 增量迁移，保留全部业务数据。
 */
const KEPT_TABLES = new Set(['settings']);

export function openDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');

  const fromVersion = userVersionOf(db);
  if (fromVersion === SCHEMA_VERSION) {
    db.exec(SCHEMA); // 全部 IF NOT EXISTS：幂等补齐，不动数据
  } else if (fromVersion === 0) {
    db.exec(SCHEMA);
    setUserVersion(db, SCHEMA_VERSION);
  } else if (fromVersion > SCHEMA_VERSION) {
    // 代码版本比数据库旧（回滚 / 换机器）：不动数据也不降版本号，只补齐缺失对象。
    console.warn(
      `  数据库 schema 版本（v${fromVersion}）比程序（v${SCHEMA_VERSION}）新，请升级程序；本次按现有结构打开。`,
    );
    db.exec(SCHEMA);
  } else if (fromVersion < MIGRATION_BASELINE) {
    console.warn(`  检测到探索期旧库（v${fromVersion}）：无迁移基线，按旧策略清空业务数据（保留设置）重建。`);
    resetOutdatedSchema(db);
    db.exec(SCHEMA);
    setUserVersion(db, SCHEMA_VERSION);
  } else {
    applyMigrations(db, fromVersion, SCHEMA_VERSION, MIGRATIONS);
    db.exec(SCHEMA); // 补齐迁移未覆盖的新表 / 索引
  }

  purgeLegacyRuntimeData(db);
  return db;
}

function userVersionOf(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

function setUserVersion(db: DatabaseSync, version: number): void {
  db.exec(`PRAGMA user_version = ${version}`);
}

/**
 * 顺序执行从 `from` 到 `to` 的增量迁移。每个步骤独立事务：
 * 成功即推进 user_version（中断后下次启动从断点继续），失败则回滚并抛错终止启动。
 * 步骤缺失时抛错而不是猜测——宁可启动失败，也不静默清空业务数据。
 */
export function applyMigrations(
  db: DatabaseSync,
  from: number,
  to: number,
  migrations: readonly SchemaMigration[] = MIGRATIONS,
): void {
  let current = from;
  for (const step of migrations) {
    if (step.to <= current) continue;
    if (step.to > to) break;
    db.exec('BEGIN IMMEDIATE');
    try {
      step.up(db);
      setUserVersion(db, step.to);
      db.exec('COMMIT');
      current = step.to;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`schema 迁移失败（v${current} → v${step.to}）：${message}`);
    }
  }
  if (current < to) {
    throw new Error(
      `缺少 schema 迁移步骤（数据库 v${current}，程序 v${to}）。` +
        '请在 server/src/db.ts 的 MIGRATIONS 中补齐对应升级步骤后重启；数据库未被改动。',
    );
  }
}

/** 版本不一致时的旧策略兜底：清空除 settings 外的所有业务表；新库（user_version=0）无需处理。 */
function resetOutdatedSchema(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name?: unknown }[];
  // 先关外键再逐表删除，避免父子表互相引用导致 DROP 失败。
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    for (const row of rows) {
      const name = String(row.name ?? '');
      if (!name || KEPT_TABLES.has(name)) continue;
      db.exec(`DROP TABLE IF EXISTS "${name}";`);
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

/**
 * 只保留流水线模型下产生的任务。早期自由交接产生的任务没有流水线快照，
 * 启动时直接清掉，避免残缺数据混进任务列表。
 */
function purgeLegacyRuntimeData(db: DatabaseSync): void {
  db.exec('DELETE FROM tasks WHERE pipeline_id IS NULL OR pipeline_snapshot IS NULL;');
  db.exec('DELETE FROM turns WHERE task_id NOT IN (SELECT id FROM tasks);');
  db.exec(
    "DELETE FROM conversations WHERE turn_id NOT IN (SELECT id FROM turns);",
  );
  db.exec("DELETE FROM messages WHERE conversation_id NOT IN (SELECT id FROM conversations);");
}

export function closeDatabase(db: DatabaseSync): void {
  try {
    db.close();
  } catch {
    /* already closed */
  }
}
