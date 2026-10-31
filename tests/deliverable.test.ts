import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { HandoffFolder } from '../shared/types';
import { openDatabase } from '../server/src/db';
import { createTasksRouter } from '../server/src/routes/tasks';
import type { Runtime } from '../server/src/runtime';
import { Store } from '../server/src/store';

let root: string;
let store: Store;
let app: Express;
let server: http.Server;
let baseUrl: string;
let taskId: string;
let turnId: string;
let agentWorkspace: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-deliverable-'));
  const db = openDatabase(':memory:');
  store = new Store({ db, workspaceRoot: root });
  app = express();
  app.use(express.json());
  // 交付物接口只依赖 store；runtime 仅被同路由下的启动/终止接口使用。
  app.use('/api/tasks', createTasksRouter({ store, runtime: {} as Runtime }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  baseUrl = `http://127.0.0.1:${address.port}`;

  const agent = store.createAgent({ name: '信息侦察员' });
  const pipeline = store.createPipeline({
    name: '交付预览流水线',
    nodes: [{ agentId: agent.id }],
  });
  const created = store.createTask({
    task: '搜集 AI 热点',
    pipeline,
    node: pipeline.nodes[0],
    agent,
  });
  taskId = created.taskId;
  turnId = created.turnId;
  agentWorkspace = store.agentTaskWorkspaceDir(taskId, agent.slug);
});

beforeEach(() => {
  fs.rmSync(agentWorkspace, { recursive: true, force: true });
  fs.mkdirSync(path.join(agentWorkspace, 'output'), { recursive: true });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  fs.rmSync(root, { recursive: true, force: true });
});

function registerFolder(folder: Partial<HandoffFolder> & { path: string }): void {
  const full: HandoffFolder = {
    name: folder.name ?? path.posix.basename(folder.path),
    files: folder.files ?? 0,
    bytes: folder.bytes ?? 0,
    ...folder,
  };
  store.updateTurn(turnId, {
    handoffFolder: full,
    output: '已完成',
    target: { type: 'human' },
  });
  store.updateTask(taskId, { status: 'waiting_human' });
}

interface PreviewResponse {
  status: number;
  body: {
    deliverable?: {
      kind: string;
      content?: string;
      truncated?: boolean;
      mimeType: string;
      name: string;
      size: number;
      path: string;
    };
    error?: string;
  };
}

async function preview(query: string): Promise<PreviewResponse> {
  const response = await fetch(`${baseUrl}/api/tasks/${taskId}/turns/${turnId}/deliverable?${query}`);
  return { status: response.status, body: (await response.json()) as PreviewResponse['body'] };
}

describe('deliverable folder preview API', () => {
  it('lists files inside the delivered folder', async () => {
    fs.writeFileSync(path.join(agentWorkspace, 'output', 'report.md'), '# 热点新闻', 'utf-8');
    fs.mkdirSync(path.join(agentWorkspace, 'output', 'data'), { recursive: true });
    fs.writeFileSync(path.join(agentWorkspace, 'output', 'data', 'rows.csv'), 'a,b', 'utf-8');
    registerFolder({ path: 'output', files: 2, bytes: 100 });

    const response = await fetch(`${baseUrl}/api/tasks/${taskId}/turns/${turnId}/deliverable?mode=list`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      folder: { path: string; files: number };
      files: { path: string; name: string; size: number }[];
    };
    expect(body.folder.path).toBe('output');
    expect(body.files.map((file) => file.path).sort()).toEqual(['output/data/rows.csv', 'output/report.md']);
  });

  it('exposes the turn system prompt in the turn detail API', async () => {
    const fetchDetail = async () => {
      const response = await fetch(`${baseUrl}/api/tasks/${taskId}/turns/${turnId}`);
      const body = (await response.json()) as {
        detail: { turn: { id: string }; systemPrompt: string | null };
      };
      return body.detail;
    };

    // 尚未执行的环节没有系统提示词
    expect((await fetchDetail()).systemPrompt).toBeNull();

    store.updateTurn(turnId, { systemPrompt: '你是「测试」智能体…' });
    expect((await fetchDetail()).systemPrompt).toBe('你是「测试」智能体…');
  });

  it('previews a markdown file inside the folder with content and metadata', async () => {
    fs.writeFileSync(path.join(agentWorkspace, 'output', 'report.md'), '# 热点新闻\n\n正文内容', 'utf-8');
    registerFolder({ path: 'output', files: 1, bytes: 20 });

    const { status, body } = await preview(`mode=preview&path=${encodeURIComponent('output/report.md')}`);
    expect(status).toBe(200);
    const file = body.deliverable!;
    expect(file.kind).toBe('text');
    expect(file.mimeType).toBe('text/markdown');
    expect(file.name).toBe('report.md');
    expect(file.content).toBe('# 热点新闻\n\n正文内容');
    expect(file.truncated).toBeUndefined();
  });

  it('treats binary content with unknown extension as binary without content', async () => {
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00, 0x48, 0x65]);
    fs.writeFileSync(path.join(agentWorkspace, 'output', 'data.bin'), bytes);
    registerFolder({ path: 'output' });

    const { status, body } = await preview(`mode=preview&path=${encodeURIComponent('output/data.bin')}`);
    expect(status).toBe(200);
    const file = body.deliverable!;
    expect(file.kind).toBe('binary');
    expect(file.content).toBeUndefined();
  });

  it('serves raw bytes for image deliverables and download mode with attachment header', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    fs.writeFileSync(path.join(agentWorkspace, 'output', 'chart.png'), png);
    registerFolder({ path: 'output' });

    const raw = await fetch(
      `${baseUrl}/api/tasks/${taskId}/turns/${turnId}/deliverable?mode=raw&path=${encodeURIComponent('output/chart.png')}`,
    );
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await raw.arrayBuffer()).equals(png)).toBe(true);

    const download = await fetch(
      `${baseUrl}/api/tasks/${taskId}/turns/${turnId}/deliverable?mode=download&path=${encodeURIComponent('output/chart.png')}`,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('chart.png');
  });

  it('rejects paths outside the delivered folder or escaping the workspace', async () => {
    fs.writeFileSync(path.join(agentWorkspace, 'output', 'report.md'), '# 报告', 'utf-8');
    fs.writeFileSync(path.join(agentWorkspace, 'notes.md'), '# 未交接', 'utf-8');
    fs.writeFileSync(path.join(root, 'secret.txt'), '机密', 'utf-8');
    registerFolder({ path: 'output' });

    const outside = await preview(`mode=preview&path=${encodeURIComponent('notes.md')}`);
    expect(outside.status).toBe(404);

    const traversal = await preview(`mode=preview&path=${encodeURIComponent('../secret.txt')}`);
    expect(traversal.status).toBe(400);

    const missingTurn = await fetch(
      `${baseUrl}/api/tasks/${taskId}/turns/00000000-0000-4000-8000-000000000000/deliverable?mode=preview&path=${encodeURIComponent('output/report.md')}`,
    );
    expect(missingTurn.status).toBe(404);
  });

  it('flags truncated text previews for oversized files', async () => {
    const long = `${'很长的内容。'.repeat(90_000)}`;
    fs.writeFileSync(path.join(agentWorkspace, 'output', 'long.txt'), long, 'utf-8');
    registerFolder({ path: 'output', files: 1, bytes: Buffer.byteLength(long) });

    const { status, body } = await preview(`mode=preview&path=${encodeURIComponent('output/long.txt')}`);
    expect(status).toBe(200);
    const file = body.deliverable!;
    expect(file.kind).toBe('text');
    expect(file.truncated).toBe(true);
    expect((file.content ?? '').length).toBeLessThanOrEqual(512 * 1024);
  });
});
