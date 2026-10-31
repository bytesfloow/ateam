import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../server/src/db';
import { Store } from '../server/src/store';

function tempStore(): { store: Store; file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-settings-'));
  const file = path.join(dir, 'data.db');
  const db = openDatabase(file);
  const store = new Store({ db, workspaceRoot: path.join(dir, 'workspaces') });
  return {
    store,
    file,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function writeRawSettings(file: string, values: Record<string, unknown>): void {
  const db = openDatabase(file);
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const [key, value] of Object.entries(values)) upsert.run(key, JSON.stringify(value));
  db.close();
}

describe('runtime timeout defaults', () => {
  it('defaults both timeouts to ten minutes', () => {
    const { store, cleanup } = tempStore();
    try {
      const runtime = store.getRuntimeSettings();
      expect(runtime.toolTimeoutMs).toBe(600_000);
      expect(runtime.commandTimeoutMs).toBe(600_000);
    } finally {
      cleanup();
    }
  });

  it('migrates the old two-minute defaults but keeps customized values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-settings-'));
    const file = path.join(dir, 'data.db');
    try {
      // 模拟旧版本数据库：两个值都停留在旧默认 120000。
      const seed = openDatabase(file);
      seed.close();
      writeRawSettings(file, {
        'runtime.toolTimeoutMs': 120_000,
        'runtime.commandTimeoutMs': 300_000,
      });

      const db = openDatabase(file);
      const store = new Store({ db, workspaceRoot: path.join(dir, 'workspaces') });
      const runtime = store.getRuntimeSettings();
      expect(runtime.toolTimeoutMs).toBe(600_000); // 旧默认值升级
      expect(runtime.commandTimeoutMs).toBe(300_000); // 用户自定义值保留
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not overwrite a later manual change back to two minutes', () => {
    const { store, file, cleanup } = tempStore();
    try {
      store.updateSettings({ runtime: { toolTimeoutMs: 120_000 } });
      const db = store.db;
      const reopened = new Store({ db, workspaceRoot: path.join(path.dirname(file), 'workspaces') });
      expect(reopened.getRuntimeSettings().toolTimeoutMs).toBe(120_000);
    } finally {
      cleanup();
    }
  });
});
