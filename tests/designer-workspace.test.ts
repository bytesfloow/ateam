import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../server/src/db';
import type { DesignerRuntime } from '../server/src/designer';
import { apiErrorHandler } from '../server/src/http';
import { createDesignerRouter } from '../server/src/routes/designer';
import type { Runtime } from '../server/src/runtime';
import { Store } from '../server/src/store';

let root: string;
let store: Store;
let app: Express;
let server: http.Server;
let baseUrl: string;
let workspace: string;

interface ListingEntry {
  path: string;
  name: string;
  type: 'dir' | 'file';
  size: number;
}

interface ListingResponse {
  status: number;
  body: {
    listing?: { path: string; truncated: boolean; entries: ListingEntry[] };
    error?: string;
  };
}

interface PreviewResponse {
  status: number;
  headers: Headers;
  body: {
    file?: {
      path: string;
      name: string;
      size: number;
      kind: string;
      mimeType: string;
      content?: string;
      truncated?: boolean;
    };
    error?: string;
  };
}

async function list(query: string): Promise<ListingResponse> {
  const response = await fetch(`${baseUrl}/api/designer/workspace?${query}`);
  return { status: response.status, body: (await response.json()) as ListingResponse['body'] };
}

async function fetchWorkspace(query: string): Promise<PreviewResponse> {
  const response = await fetch(`${baseUrl}/api/designer/workspace?${query}`);
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json')
    ? ((await response.json()) as PreviewResponse['body'])
    : {};
  return { status: response.status, headers: response.headers, body };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-designer-ws-'));
  const db = openDatabase(':memory:');
  store = new Store({ db, workspaceRoot: root });
  app = express();
  app.use(express.json());
  // 工作目录接口只依赖 store；designer / runtime 仅被同路由下的其他接口使用。
  app.use(
    '/api/designer',
    createDesignerRouter({
      store,
      designer: {} as DesignerRuntime,
      runtime: {} as Runtime,
    }),
  );
  // 与生产入口一致：AppError → JSON（否则 Express 默认返回 HTML 错误页）。
  app.use(apiErrorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  baseUrl = `http://127.0.0.1:${address.port}`;

  workspace = store.ensureDesignerWorkspace();
  fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'uploads', 'session-1'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'notes', 'todo.md'), '# 待办');
  fs.writeFileSync(path.join(workspace, 'uploads', 'session-1', 'ref.txt'), '参考材料');
  fs.writeFileSync(path.join(workspace, '方案.md'), '# 方案\n\n正文');
  // 只有 PNG 签名头即可：类型识别按扩展名，不解析内容。
  fs.writeFileSync(path.join(workspace, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  fs.writeFileSync(path.join(workspace, 'data.bin'), Buffer.from([0x00, 0x01, 0x00, 0x02]));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('GET /api/designer/workspace', () => {
  it('lists the root with folders first and forward-slash relative paths', async () => {
    const { status, body } = await list('mode=list');
    expect(status).toBe(200);
    expect(body.listing?.path).toBe('');
    expect(body.listing?.truncated).toBe(false);
    const entries = body.listing?.entries ?? [];
    // 文件夹在前（按名称排序）；文件顺序依赖 locale collation，只断言集合。
    expect(entries.filter((entry) => entry.type === 'dir').map((entry) => entry.path)).toEqual([
      'notes',
      'uploads',
    ]);
    expect(entries.filter((entry) => entry.type === 'file').map((entry) => entry.name).sort()).toEqual([
      'data.bin',
      'logo.png',
      '方案.md',
    ]);
    const uploads = entries.find((entry) => entry.path === 'uploads');
    expect(uploads?.name).toBe('uploads');
  });

  it('lists a nested directory via the path parameter', async () => {
    const { status, body } = await list(`mode=list&path=${encodeURIComponent('uploads/session-1')}`);
    expect(status).toBe(200);
    expect(body.listing?.path).toBe('uploads/session-1');
    expect(body.listing?.entries.map((entry) => entry.name)).toEqual(['ref.txt']);
    expect(body.listing?.entries[0]?.size).toBe(Buffer.byteLength('参考材料'));
  });

  it('previews a text file with decoded content', async () => {
    const { status, body } = await fetchWorkspace(`mode=preview&path=${encodeURIComponent('方案.md')}`);
    expect(status).toBe(200);
    expect(body.file?.kind).toBe('text');
    expect(body.file?.mimeType).toBe('text/markdown');
    expect(body.file?.content).toBe('# 方案\n\n正文');
    expect(body.file?.truncated).toBeUndefined();
  });

  it('treats non-UTF-8 content as binary even with a text-ish name', async () => {
    fs.writeFileSync(path.join(workspace, 'fake.txt'), Buffer.from([0x00, 0xff, 0x00, 0xfe]));
    const { status, body } = await fetchWorkspace('mode=preview&path=fake.txt');
    expect(status).toBe(200);
    expect(body.file?.kind).toBe('binary');
    expect(body.file?.content).toBeUndefined();
  });

  it('marks oversized text previews as truncated', async () => {
    fs.writeFileSync(path.join(workspace, 'big.txt'), '汉'.repeat(300_000));
    const { status, body } = await fetchWorkspace('mode=preview&path=big.txt');
    expect(status).toBe(200);
    expect(body.file?.truncated).toBe(true);
    expect((body.file?.content ?? '').length).toBeLessThan(300_000);
    expect((body.file?.content ?? '').length).toBeGreaterThan(0);
  });

  it('serves raw bytes inline for images', async () => {
    const response = await fetch(`${baseUrl}/api/designer/workspace?mode=raw&path=logo.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/png');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('downloads a file as an attachment with the original name', async () => {
    const response = await fetch(`${baseUrl}/api/designer/workspace?mode=download&path=${encodeURIComponent('方案.md')}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition') ?? '').toContain('attachment');
    expect(response.headers.get('content-disposition') ?? "").toContain("filename*=UTF-8''");
    expect(Buffer.from(await response.arrayBuffer()).toString('utf-8')).toBe('# 方案\n\n正文');
  });

  it('normalizes harmless inner .. to a path still inside the workspace', async () => {
    const { status, body } = await list(`mode=list&path=${encodeURIComponent('uploads/..')}`);
    expect(status).toBe(200);
    expect(body.listing?.path).toBe('');
  });

  it('rejects paths escaping the workspace', async () => {
    for (const bad of ['../secret.txt', 'notes/../../secret.txt', '..\\secret.txt', '/etc/hosts']) {
      const listed = await list(`mode=list&path=${encodeURIComponent(bad)}`);
      expect(listed.status, `list 应拒绝 ${bad}`).toBe(400);
      const previewed = await fetchWorkspace(`mode=preview&path=${encodeURIComponent(bad)}`);
      expect(previewed.status, `preview 应拒绝 ${bad}`).toBe(400);
    }
  });

  it('rejects listing a file and missing paths', async () => {
    const fileAsDir = await list(`mode=list&path=${encodeURIComponent('方案.md')}`);
    expect(fileAsDir.status).toBe(400);
    const missing = await list('mode=list&path=nope');
    expect(missing.status).toBe(404);
    const missingFile = await fetchWorkspace('mode=preview&path=nope.txt');
    expect(missingFile.status).toBe(404);
    const dirAsFile = await fetchWorkspace(`mode=preview&path=${encodeURIComponent('notes')}`);
    expect(dirAsFile.status).toBe(400);
  });
});
