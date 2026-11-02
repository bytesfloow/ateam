import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations, openDatabase, type SchemaMigration } from '../server/src/db';
import { Store } from '../server/src/store';

function columnsOf(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name?: unknown }[]).map((row) =>
    String(row.name),
  );
}

function tableNamesOf(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name?: unknown }[]
  ).map((row) => String(row.name));
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

describe('database schema', () => {
  it('creates the pipeline schema on a fresh database', () => {
    const db = openDatabase(':memory:');
    try {
      expect(userVersion(db)).toBe(13);
      expect(tableNamesOf(db)).toEqual(
        expect.arrayContaining([
          'settings',
          'agents',
          'skills',
          'custom_tools',
          'pipelines',
          'tasks',
          'turns',
          'conversations',
          'messages',
          'feedback',
          'designer_sessions',
          'designer_messages',
          'designer_proposals',
        ]),
      );
      expect(columnsOf(db, 'pipelines')).toEqual(
        expect.arrayContaining(['id', 'name', 'description', 'nodes', 'edges', 'created_at', 'updated_at']),
      );
      expect(columnsOf(db, 'tasks')).toEqual(
        expect.arrayContaining(['pipeline_id', 'pipeline_name', 'pipeline_snapshot', 'current_node_id']),
      );
      expect(columnsOf(db, 'turns')).toEqual(
        expect.arrayContaining(['node_id', 'agent_id', 'handoff_folder', 'target', 'system_prompt']),
      );
      // 工具结果图片列（read_image 的多模态存档）。
      expect(columnsOf(db, 'messages')).toContain('images');
      // 环节时代与自由交接时代的列已从 schema 中移除。
      expect(columnsOf(db, 'turns')).not.toContain('node_name');
      expect(columnsOf(db, 'turns')).not.toContain('handoff_files');
      expect(columnsOf(db, 'turns')).not.toContain('handoff_next_steps');
      expect(columnsOf(db, 'turns')).not.toContain('handoff_open_questions');
      expect(columnsOf(db, 'agents')).toContain('deliverable');
      expect(columnsOf(db, 'agents')).not.toContain('handoff_policy');
      expect(columnsOf(db, 'agents')).not.toContain('handoff_agents');
      expect(columnsOf(db, 'agents')).not.toContain('handoff_human');
      expect(columnsOf(db, 'agents')).not.toContain('max_iterations');
    } finally {
      db.close();
    }
  });

  it('resets business tables (keeping settings) when opening a pre-baseline schema', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-db-'));
    const file = path.join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        responsibilities TEXT NOT NULL DEFAULT '',
        guide TEXT NOT NULL DEFAULT '',
        handoff_policy TEXT NOT NULL DEFAULT '',
        model TEXT,
        temperature REAL,
        max_iterations INTEGER NOT NULL DEFAULT 0,
        tools TEXT NOT NULL,
        skill_ids TEXT NOT NULL DEFAULT '[]',
        handoff_agents TEXT NOT NULL DEFAULT '[]',
        handoff_human INTEGER NOT NULL DEFAULT 0,
        accent TEXT NOT NULL DEFAULT '#6d8cff',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      -- 上一版 schema：环节模型 + 文件级交付。
      CREATE TABLE pipelines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        nodes TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        start_agent_id TEXT NOT NULL,
        current_turn_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        node_name TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        agent_accent TEXT NOT NULL,
        status TEXT NOT NULL,
        input TEXT NOT NULL DEFAULT '',
        output TEXT NOT NULL DEFAULT '',
        handoff_files TEXT NOT NULL DEFAULT '[]',
        handoff_next_steps TEXT NOT NULL DEFAULT '',
        target TEXT,
        iterations INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        finished_at TEXT,
        error TEXT
      );
      INSERT INTO settings (key, value) VALUES ('llm.model', '"deepseek-chat"');
      INSERT INTO agents (id, name, slug, responsibilities, tools, created_at, updated_at)
      VALUES ('a1', '旧智能体', 'agent-old', '旧职责', '{"builtin":[],"custom":[]}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO tasks (id, task, status, start_agent_id, current_turn_id, error, created_at, updated_at, finished_at)
      VALUES ('task-old', '旧任务', 'completed', 'a1', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO turns (id, task_id, seq, agent_id, agent_name, agent_accent, status, input, output)
      VALUES ('t1', 'task-old', 1, 'a1', '旧智能体', '#6d8cff', 'completed', '旧输入', '旧输出');
      PRAGMA user_version = 5;
    `);
    old.close();

    const db = openDatabase(file);
    try {
      expect(userVersion(db)).toBe(13);
      expect(tableNamesOf(db)).toContain('pipelines');

      // 业务数据（智能体、流水线、任务、回合等）全部清空，schema 重建。
      const store = new Store({ db, workspaceRoot: path.join(dir, 'workspaces') });
      expect(store.listAgents()).toHaveLength(0);
      expect(store.listTasks()).toHaveLength(0);
      expect(store.listPipelines()).toHaveLength(0);
      expect(columnsOf(db, 'turns')).not.toContain('node_name');
      expect(columnsOf(db, 'turns')).not.toContain('handoff_next_steps');

      // 本机设置保留，避免升级后重填模型配置。
      expect(store.getLlmConfig().model).toBe('deepseek-chat');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('schema migrations', () => {
  function memoryDb(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO settings (key, value) VALUES ('llm.model', '"deepseek-chat"');
      INSERT INTO agents (id, name) VALUES ('a1', '老智能体');
      PRAGMA user_version = 9;
    `);
    return db;
  }

  const stepTo10: SchemaMigration = {
    to: 10,
    up: (db) => db.exec("ALTER TABLE agents ADD COLUMN deliverable TEXT NOT NULL DEFAULT ''"),
  };
  const stepTo11: SchemaMigration = {
    to: 11,
    up: (db) => db.exec("UPDATE agents SET name = name || '（已迁移）'"),
  };

  it('applies steps in order, keeps business data and stamps each version', () => {
    const db = memoryDb();
    try {
      applyMigrations(db, 9, 11, [stepTo10, stepTo11]);
      expect(userVersion(db)).toBe(11);
      // 业务数据在迁移后仍然在场，且第二步的改写已生效。
      const agent = db.prepare('SELECT name, deliverable FROM agents WHERE id = ?').get('a1') as {
        name?: unknown;
        deliverable?: unknown;
      };
      expect(String(agent.name)).toBe('老智能体（已迁移）');
      expect(agent.deliverable).toBe('');
      expect(db.prepare('SELECT value FROM settings').get()).toMatchObject({ value: '"deepseek-chat"' });
    } finally {
      db.close();
    }
  });

  it('skips versions already applied and resumes from the recorded version', () => {
    const db = memoryDb();
    try {
      applyMigrations(db, 9, 10, [stepTo10]);
      expect(userVersion(db)).toBe(10);
      // 从 v10 再跑一遍完整清单：已应用的步骤被跳过，不会重复执行。
      applyMigrations(db, 10, 11, [stepTo10, stepTo11]);
      expect(userVersion(db)).toBe(11);
      const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get('a1') as { name?: unknown };
      expect(String(agent.name)).toBe('老智能体（已迁移）');
    } finally {
      db.close();
    }
  });

  it('rolls back and aborts when a step fails, leaving the database untouched', () => {
    const db = memoryDb();
    try {
      const failing: SchemaMigration = {
        to: 10,
        up: (db) => {
          db.exec("ALTER TABLE agents ADD COLUMN deliverable TEXT NOT NULL DEFAULT ''");
          throw new Error('boom');
        },
      };
      expect(() => applyMigrations(db, 9, 10, [failing])).toThrow(/schema 迁移失败（v9 → v10）.*boom/);
      expect(userVersion(db)).toBe(9);
      // 事务回滚：新列不存在，原数据完好。
      expect(columnsOf(db, 'agents')).not.toContain('deliverable');
      expect(db.prepare('SELECT COUNT(*) AS c FROM agents').get()).toMatchObject({ c: 1 });
    } finally {
      db.close();
    }
  });

  it('refuses to guess when a migration step is missing', () => {
    const db = memoryDb();
    try {
      expect(() => applyMigrations(db, 9, 10, [])).toThrow(/缺少 schema 迁移步骤（数据库 v9，程序 v10）/);
      expect(userVersion(db)).toBe(9);
      expect(db.prepare('SELECT COUNT(*) AS c FROM agents').get()).toMatchObject({ c: 1 });
    } finally {
      db.close();
    }
  });

  it('v9 → v10：设计师单会话迁移（新增压缩列，清空多会话存量数据）', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE designer_sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '新对话',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE designer_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES designer_sessions(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
        CREATE TABLE designer_proposals (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES designer_sessions(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL
        );
        INSERT INTO settings (key, value) VALUES ('llm.model', '"deepseek-chat"');
        INSERT INTO agents (id, name) VALUES ('a1', '老智能体');
        INSERT INTO designer_sessions (id, title, created_at, updated_at)
        VALUES ('s1', '你好', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
               ('s2', '另一条', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
        INSERT INTO designer_messages (id, session_id, seq, role, content, created_at)
        VALUES ('m1', 's1', 1, 'user', '第一条', '2026-01-01T00:00:00.000Z');
        INSERT INTO designer_proposals (id, session_id, title, status, created_at)
        VALUES ('p1', 's1', '待确认提案', 'pending', '2026-01-01T00:00:00.000Z');
        PRAGMA user_version = 9;
      `);

      // 使用应用真实的迁移清单（默认参数）。
      applyMigrations(db, 9, 10);
      expect(userVersion(db)).toBe(10);
      // 会话表带上压缩水位与前情提要两列。
      expect(columnsOf(db, 'designer_sessions')).toEqual(
        expect.arrayContaining(['compacted_seq', 'summary']),
      );
      // 按需求确认：多会话存量数据（消息、提案随会话级联）一次性清空。
      expect(db.prepare('SELECT COUNT(*) AS c FROM designer_sessions').get()).toMatchObject({ c: 0 });
      expect(db.prepare('SELECT COUNT(*) AS c FROM designer_messages').get()).toMatchObject({ c: 0 });
      expect(db.prepare('SELECT COUNT(*) AS c FROM designer_proposals').get()).toMatchObject({ c: 0 });
      // 其他业务数据不受影响。
      expect(db.prepare('SELECT COUNT(*) AS c FROM agents').get()).toMatchObject({ c: 1 });
      expect(db.prepare("SELECT value FROM settings WHERE key = 'llm.model'").get()).toMatchObject({
        value: '"deepseek-chat"',
      });
    } finally {
      db.close();
    }
  });

  it('v10 → v11：移除智能体 max_iterations 列（轮次上限已废弃）', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          max_iterations INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO agents (id, name, max_iterations) VALUES ('a1', '老智能体', 10);
        PRAGMA user_version = 10;
      `);

      // 使用应用真实的迁移清单（默认参数）。
      applyMigrations(db, 10, 11);
      expect(userVersion(db)).toBe(11);
      expect(columnsOf(db, 'agents')).not.toContain('max_iterations');
      expect(db.prepare('SELECT COUNT(*) AS c FROM agents').get()).toMatchObject({ c: 1 });
    } finally {
      db.close();
    }
  });

  it('v12 → v13：试运行任务与流水线任务分离（agents.prompt、tasks.kind、删训练台流水线）', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL DEFAULT '',
          responsibilities TEXT NOT NULL DEFAULT '',
          deliverable TEXT NOT NULL DEFAULT '',
          guide TEXT NOT NULL DEFAULT '',
          model TEXT,
          temperature REAL,
          tools TEXT NOT NULL,
          skill_ids TEXT NOT NULL DEFAULT '[]',
          accent TEXT NOT NULL DEFAULT '#6d8cff',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE pipelines (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          nodes TEXT NOT NULL DEFAULT '[]',
          edges TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE tasks (
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
        INSERT INTO agents (id, name, slug, tools, created_at, updated_at)
        VALUES ('a1', '被训智能体', 'agent-x', '{"builtin":[],"custom":[]}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO pipelines (id, name, nodes, edges, created_at, updated_at)
        VALUES ('p1', '智能体训练台', '[]', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
               ('p2', '业务流水线', '[]', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO tasks (id, task, status, start_agent_id, pipeline_id, pipeline_name, pipeline_snapshot, created_at, updated_at)
        VALUES ('t-test', '试运行', 'completed', 'a1', 'p1', '智能体训练台', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
               ('t-biz', '业务任务', 'completed', 'a1', 'p2', '业务流水线', '{}', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
        PRAGMA user_version = 12;
      `);

      applyMigrations(db, 12, 13);
      expect(userVersion(db)).toBe(13);
      // agents 获得 prompt 列（NULL = 流水线模板型）。
      expect(columnsOf(db, 'agents')).toContain('prompt');
      expect(columnsOf(db, 'tasks')).toContain('kind');
      // 存量「智能体训练台」任务刷为 test，业务任务保持 pipeline。
      const kinds = Object.fromEntries(
        (db.prepare('SELECT id, kind FROM tasks').all() as { id: string; kind: string }[]).map((row) => [row.id, row.kind]),
      );
      expect(kinds).toEqual({ 't-test': 'test', 't-biz': 'pipeline' });
      // 训练台流水线被删除；业务流水线保留。
      const pipelines = (db.prepare('SELECT name FROM pipelines').all() as { name: string }[]).map((row) => row.name);
      expect(pipelines).toEqual(['业务流水线']);
    } finally {
      db.close();
    }
  });
});
