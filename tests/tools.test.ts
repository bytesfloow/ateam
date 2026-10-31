import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Agent } from '../shared/types';
import { BUILTIN_TOOL_NAMES } from '../shared/types';
import { openDatabase } from '../server/src/db';
import { htmlToMarkdown } from '../server/src/html-text';
import { Store } from '../server/src/store';
import { resolveTools, type ToolContext, type ToolResult } from '../server/src/tools';
import { fetchPageAsMarkdown, validateFetchUrl, WebToolError } from '../server/src/web-tools';

function makeContext(store: Store, agent: Agent, workdir: string): ToolContext {
  return {
    store,
    runtime: { notifyFeedback: () => undefined },
    agent,
    workdir,
    taskId: '11111111-1111-1111-1111-111111111111',
    turnId: 'turn-1',
    turnSeq: 1,
    task: '测试任务',
    conversationId: 'conv-1',
    signal: new AbortController().signal,
    settings: store.getRuntimeSettings(),
    systemPrompt: 'system',
    pipeline: { id: 'p', name: 'P', description: '', nodes: [], edges: [], createdAt: '', updatedAt: '' },
    node: { id: 'n1', agentId: agent.id, isStart: true, x: 0, y: 0 },
    outgoing: [],
    completed: null,
    observations: new Map(),
  };
}

function toolOf(store: Store, agent: Agent, name: string) {
  const tool = resolveTools(store, agent).find((item) => item.spec.function.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool;
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/* ------------------------------------------------------------------ */
/* read / write / edit 守卫                                            */
/* ------------------------------------------------------------------ */

describe('file tools: read-then-mutate guards', () => {
  it('rejects overwriting an existing file that was never read (FS_NOT_OBSERVED)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-tools-'));
    const db = openDatabase(':memory:');
    const store = new Store({ db, workspaceRoot: root });
    const agent = store.createAgent({ name: '甲' });
    const ctx = makeContext(store, agent, root);
    fs.writeFileSync(path.join(root, 'existing.md'), '旧内容', 'utf8');

    const write = toolOf(store, agent, 'write');
    await expect(
      write.execute({ file_path: 'existing.md', content: '新内容' }, ctx),
    ).rejects.toThrow(/\[FS_NOT_OBSERVED\]/);

    // 先读后写 → 放行
    const read = toolOf(store, agent, 'read');
    await read.execute({ file_path: 'existing.md' }, ctx);
    const result = (await write.execute({ file_path: 'existing.md', content: '新内容' }, ctx)) as string;
    expect(result).toContain('已更新');
    expect(fs.readFileSync(path.join(root, 'existing.md'), 'utf8')).toBe('新内容');
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('allows writing a brand-new file without reading, and records absence from a failed read', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-tools-'));
    const db = openDatabase(':memory:');
    const store = new Store({ db, workspaceRoot: root });
    const agent = store.createAgent({ name: '甲' });
    const ctx = makeContext(store, agent, root);
    const write = toolOf(store, agent, 'write');
    const read = toolOf(store, agent, 'read');

    await expect(write.execute({ file_path: 'output/new.md', content: 'hello' }, ctx)).resolves.toContain('已创建');

    // 读取不存在的文件：报错但登记「确认缺失」，随后创建后可直接覆盖
    await expect(read.execute({ file_path: 'output/absent.md' }, ctx)).rejects.toThrow(/\[FS_NOT_FOUND\]/);
    fs.writeFileSync(path.join(root, 'output', 'absent.md'), '别人创建的', 'utf8');
    await expect(
      write.execute({ file_path: 'output/absent.md', content: '覆盖' }, ctx),
    ).rejects.toThrow(/\[FS_STALE_VERSION\]/);
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects editing a file changed externally after the read (FS_STALE_VERSION)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-tools-'));
    const db = openDatabase(':memory:');
    const store = new Store({ db, workspaceRoot: root });
    const agent = store.createAgent({ name: '甲' });
    const ctx = makeContext(store, agent, root);
    const file = path.join(root, 'doc.md');
    fs.writeFileSync(file, '第一版', 'utf8');
    const read = toolOf(store, agent, 'read');
    const edit = toolOf(store, agent, 'edit');
    await read.execute({ file_path: 'doc.md' }, ctx);

    // 模拟外部（命令/其他程序）修改
    fs.writeFileSync(file, '被外部程序改过的内容，长度不同', 'utf8');
    await expect(
      edit.execute({ file_path: 'doc.md', old_string: '第一版', new_string: '第二版' }, ctx),
    ).rejects.toThrow(/\[FS_STALE_VERSION\]/);
    expect(fs.readFileSync(file, 'utf8')).toContain('被外部程序改过');

    // 重新读取后再编辑 → 放行
    await read.execute({ file_path: 'doc.md' }, ctx);
    await expect(
      edit.execute({ file_path: 'doc.md', old_string: '被外部程序改过的内容', new_string: '已同步' }, ctx),
    ).resolves.toContain('已更新');
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects editing a never-read file and ambiguous matches', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-tools-'));
    const db = openDatabase(':memory:');
    const store = new Store({ db, workspaceRoot: root });
    const agent = store.createAgent({ name: '甲' });
    const ctx = makeContext(store, agent, root);
    fs.writeFileSync(path.join(root, 'code.ts'), 'const a = 1;\nconst a = 2;\n', 'utf8');
    const edit = toolOf(store, agent, 'edit');

    await expect(
      edit.execute({ file_path: 'code.ts', old_string: 'const a = 1;', new_string: 'const b = 1;' }, ctx),
    ).rejects.toThrow(/\[FS_NOT_OBSERVED\]/);

    const read = toolOf(store, agent, 'read');
    await read.execute({ file_path: 'code.ts' }, ctx);
    await expect(
      edit.execute({ file_path: 'code.ts', old_string: 'const a =', new_string: 'const b =' }, ctx),
    ).rejects.toThrow(/\[FS_AMBIGUOUS_EDIT\]/);
    await expect(
      edit.execute({ file_path: 'code.ts', old_string: '不存在的原文', new_string: 'x' }, ctx),
    ).rejects.toThrow(/\[FS_EDIT_NOT_FOUND\]/);
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ */
/* glob / grep                                                         */
/* ------------------------------------------------------------------ */

describe('glob and grep', () => {
  it('glob matches basenames at any depth without a slash, and honors anchors with a slash', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-tools-'));
    const db = openDatabase(':memory:');
    const store = new Store({ db, workspaceRoot: root });
    const agent = store.createAgent({ name: '甲' });
    const ctx = makeContext(store, agent, root);
    fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.ts'), '', 'utf8');
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), '', 'utf8');
    fs.writeFileSync(path.join(root, 'src', 'deep', 'c.ts'), '', 'utf8');
    fs.writeFileSync(path.join(root, 'src', 'readme.md'), '', 'utf8');

    const glob = toolOf(store, agent, 'glob');
    const anywhere = (await glob.execute({ pattern: '*.ts' }, ctx)) as string;
    expect(anywhere).toContain('a.ts');
    expect(anywhere).toContain('src/b.ts');
    expect(anywhere).toContain('src/deep/c.ts');
    expect(anywhere).not.toContain('readme.md');

    const anchored = (await glob.execute({ pattern: 'src/*.ts' }, ctx)) as string;
    expect(anchored).toContain('src/b.ts');
    expect(anchored).not.toContain('src/deep/c.ts');
    expect(anchored).not.toContain('a.ts');
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('grep validates include, is case-sensitive, and returns grouped line hits', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-tools-'));
    const db = openDatabase(':memory:');
    const store = new Store({ db, workspaceRoot: root });
    const agent = store.createAgent({ name: '甲' });
    const ctx = makeContext(store, agent, root);
    fs.writeFileSync(path.join(root, 'a.ts'), 'const alpha = 1;\nconst Beta = 2;\n', 'utf8');
    fs.writeFileSync(path.join(root, 'b.js'), 'alpha again\n', 'utf8');
    const grep = toolOf(store, agent, 'grep');

    await expect(
      grep.execute({ pattern: 'alpha', include: '*.ts,*.js' }, ctx),
    ).rejects.toThrow(/\[GREP_BAD_INCLUDE\].*逗号/);
    await expect(
      grep.execute({ pattern: 'alpha', include: '!*.ts' }, ctx),
    ).rejects.toThrow(/\[GREP_BAD_INCLUDE\].*否定/);

    const filtered = (await grep.execute({ pattern: 'alpha', include: '*.ts' }, ctx)) as string;
    expect(filtered).toContain('a.ts');
    expect(filtered).toContain('1: const alpha = 1;');
    expect(filtered).not.toContain('b.js');

    const caseSensitive = (await grep.execute({ pattern: 'alpha' }, ctx)) as string;
    expect(caseSensitive).not.toContain('Beta');

    const none = (await grep.execute({ pattern: 'zzz-not-there' }, ctx)) as string;
    expect(none).toContain('未找到匹配');
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ */
/* read_image                                                          */
/* ------------------------------------------------------------------ */

describe('read_image', () => {
  it('returns the image as multimodal content detected by file signature', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-tools-'));
    const db = openDatabase(':memory:');
    const store = new Store({ db, workspaceRoot: root });
    const agent = store.createAgent({ name: '甲' });
    const ctx = makeContext(store, agent, root);
    const file = path.join(root, 'pixel.png');
    fs.writeFileSync(file, PNG_1PX);

    const readImage = toolOf(store, agent, 'read_image');
    const result = (await readImage.execute({ file_path: 'pixel.png' }, ctx)) as ToolResult;
    expect(result.content).toContain('已读取图片');
    expect(result.images).toHaveLength(1);
    expect(result.images![0].mimeType).toBe('image/png');
    expect(Buffer.from(result.images![0].dataBase64, 'base64')).toEqual(PNG_1PX);

    // 非图片内容按文件签名拒绝
    fs.writeFileSync(path.join(root, 'fake.png'), 'not an image', 'utf8');
    await expect(readImage.execute({ file_path: 'fake.png' }, ctx)).rejects.toThrow(
      /\[FS_UNSUPPORTED_IMAGE\]/,
    );
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ */
/* html → markdown                                                     */
/* ------------------------------------------------------------------ */

describe('htmlToMarkdown', () => {
  it('converts headings, lists, links and drops scripts', () => {
    const html = `<!DOCTYPE html>
      <html><head><title>测试页面</title><script>alert('x')</script><style>body{color:red}</style></head>
      <body>
        <h1>标题一</h1>
        <p>段落 <strong>加粗</strong> 与 <a href="/page">链接</a>。</p>
        <ul><li>第一项</li><li>第二项<ol><li>嵌套</li></ol></li></ul>
        <pre><code>const x = 1;</code></pre>
      </body></html>`;
    const result = htmlToMarkdown(html, { baseUrl: 'https://example.com/dir/' });
    expect(result.title).toBe('测试页面');
    expect(result.markdown).toContain('# 标题一');
    expect(result.markdown).toContain('**加粗**');
    expect(result.markdown).toContain('[链接](https://example.com/page)');
    expect(result.markdown).toContain('- 第一项');
    // 嵌套有序列表独立编号，且带两级缩进
    expect(result.markdown).toMatch(/- 第二项\n  1\. 嵌套/);
    expect(result.markdown).toContain('const x = 1;');
    expect(result.markdown).not.toContain('alert');
    expect(result.markdown).not.toContain('color:red');
  });

  it('renders GFM tables and decodes entities', () => {
    const html = `<table><tr><th>名称</th><th>值</th></tr><tr><td>A &amp; B</td><td>1 &lt; 2</td></tr></table>`;
    const result = htmlToMarkdown(html);
    expect(result.markdown).toContain('| 名称 | 值 |');
    expect(result.markdown).toContain('| --- | --- |');
    expect(result.markdown).toContain('A & B');
    expect(result.markdown).toContain('1 < 2');
  });

  it('does not swallow the rest of the document at void drop tags like <input>', () => {
    // 回归：input 是空元素、没有 </input> 闭合标签，DROP 跳过逻辑若不识别空元素会吞掉后续全部内容。
    const html = `<body><form><input type="text" name="q"><button>搜</button></form><h1>正文标题</h1><p>正文段落</p></body>`;
    const result = htmlToMarkdown(html);
    expect(result.markdown).toContain('# 正文标题');
    expect(result.markdown).toContain('正文段落');
    expect(result.markdown).not.toContain('搜');
  });
});

/* ------------------------------------------------------------------ */
/* web_fetch                                                           */
/* ------------------------------------------------------------------ */

describe('web_fetch', () => {
  const servers: http.Server[] = [];
  let baseUrl = '';

  beforeAll(async () => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/';
      if (url === '/page') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>OK 页</title></head><body><h1>你好</h1><p>正文内容</p></body></html>');
        return;
      }
      if (url === '/plain') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('纯文本内容');
        return;
      }
      if (url === '/missing') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found here');
        return;
      }
      if (url === '/redirect') {
        res.writeHead(302, { Location: '/page' });
        res.end();
        return;
      }
      if (url === '/redirect-evil') {
        res.writeHead(302, { Location: 'https://evil.example.com/page' });
        res.end();
        return;
      }
      if (url === '/bin') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.from([0, 1, 2]));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address();
    if (address && typeof address === 'object') baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    for (const server of servers) server.close();
  });

  it('rejects invalid URLs upfront', () => {
    expect(() => validateFetchUrl('ftp://example.com')).toThrow(WebToolError);
    expect(() => validateFetchUrl('http://user:pass@example.com')).toThrow(/用户名/);
    expect(() => validateFetchUrl(`http://example.com/${'a'.repeat(3000)}`)).toThrow(/URL 过长/);
    expect(validateFetchUrl(`${baseUrl}/page`).hostname).toBe('127.0.0.1');
  });

  it('fetches an HTML page as markdown with an untrusted-data notice', async () => {
    const result = await fetchPageAsMarkdown({ url: `${baseUrl}/page` });
    expect(result.title).toBe('OK 页');
    expect(result.markdown).toContain('# 你好');
    expect(result.markdown).toContain('正文内容');
  });

  it('returns non-2xx as a result instead of an error', async () => {
    const result = await fetchPageAsMarkdown({ url: `${baseUrl}/missing` });
    expect(result.status).toBe(404);
    expect(result.markdown).toContain('非 2xx');
    expect(result.markdown).toContain('not found here');
  });

  it('follows same-origin redirects but refuses cross-origin ones', async () => {
    const same = await fetchPageAsMarkdown({ url: `${baseUrl}/redirect` });
    expect(same.markdown).toContain('# 你好');
    await expect(fetchPageAsMarkdown({ url: `${baseUrl}/redirect-evil` })).rejects.toThrow(
      /跨源重定向/,
    );
  });

  it('rejects binary content types', async () => {
    await expect(fetchPageAsMarkdown({ url: `${baseUrl}/bin` })).rejects.toThrow(/不支持的内容类型/);
  });

  it('passes raw text through', async () => {
    const result = await fetchPageAsMarkdown({ url: `${baseUrl}/plain` });
    expect(result.markdown).toContain('纯文本内容');
  });
});

/* ------------------------------------------------------------------ */
/* web_search（本地 mock DeepSeek 搜索端点）                             */
/* ------------------------------------------------------------------ */

describe('web_search', () => {
  it('merges and deduplicates results across queries, capping at 8 sources', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-tools-'));
    const db = openDatabase(':memory:');
    const store = new Store({ db, workspaceRoot: root });
    const queries: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.endsWith('/v1/tools/search')) {
        res.writeHead(404);
        res.end();
        return;
      }
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { query: string };
        queries.push(parsed.query);
        const result = (query: string) => ({
          title: `${query} 的结果`,
          url: `https://example.com/${encodeURIComponent(query)}`,
          snippet: '短摘要',
          summary: '长摘要'.repeat(50),
          date: '2026-01-01T00:00:00Z',
          rerank_score: 2,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: [result(parsed.query)] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('no address');
    store.updateSettings({
      webSearch: { searchBaseUrl: `http://127.0.0.1:${address.port}`, searchApiKey: 'test-key' },
    });

    const agent = store.createAgent({ name: '甲' });
    const ctx = makeContext(store, agent, root);
    const search = toolOf(store, agent, 'web_search');
    const output = (await search.execute({ queries: ['深度学习', 'deep learning', '深度学习'] }, ctx)) as string;
    expect(output).toContain('已合并去重');
    expect(output).toContain('[深度学习 的结果](https://example.com/%E6%B7%B1%E5%BA%A6%E5%AD%A6%E4%B9%A0)');
    expect(output).toContain('deep learning');
    // 相同查询去重：只实际发起 2 次
    expect(queries).toHaveLength(2);

    await expect(search.execute({ queries: [] }, ctx)).rejects.toThrow(/\[WEB_BAD_QUERY\]/);
    await expect(search.execute({ queries: ['x'.repeat(200)] }, ctx)).rejects.toThrow(/\[WEB_BAD_QUERY\]/);
    await expect(search.execute({ queries: ['a', 'b', 'c', 'd', 'e'] }, ctx)).rejects.toThrow(
      /\[WEB_BAD_QUERY\]/,
    );

    server.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns a structured error when no key is configured', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-tools-'));
    const db = openDatabase(':memory:');
    const store = new Store({ db, workspaceRoot: root });
    const agent = store.createAgent({ name: '甲' });
    const ctx = makeContext(store, agent, root);
    const search = toolOf(store, agent, 'web_search');
    await expect(search.execute({ queries: ['测试'] }, ctx)).rejects.toThrow(
      /\[WEB_PROVIDER_UNAVAILABLE\]/,
    );
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ */
/* 内置工具统一授予                                                     */
/* ------------------------------------------------------------------ */

describe('builtin tool granting', () => {
  it('grants every builtin tool regardless of the agent toggle list', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-tools-'));
    const db = openDatabase(':memory:');
    const store = new Store({ db, workspaceRoot: root });
    // 档案只勾了 read：运行时也应拿到全部内置工具（开放式任务不裁剪能力）。
    const agent = store.createAgent({ name: '裁剪员', tools: { builtin: ['read'], custom: [] } });
    const names = resolveTools(store, agent).map((item) => item.spec.function.name);
    for (const name of BUILTIN_TOOL_NAMES) {
      if (name === 'load_skill') continue; // load_skill 只在配置了技能时出现
      if (name === 'bash' || name === 'pwsh') continue; // shell 按平台可用性注册
      expect(names).toContain(name);
    }
    // 至少注册了一个 shell 工具（本机可用 bash 或 pwsh 之一）。
    expect(names.some((name) => name === 'bash' || name === 'pwsh')).toBe(true);
    expect(names).not.toContain('load_skill');
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('registers load_skill as soon as the agent has a skill', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-tools-'));
    const db = openDatabase(':memory:');
    const store = new Store({ db, workspaceRoot: root });
    const skill = store.createSkill({ name: '写作规范', content: '# 写作规范' });
    const agent = store.createAgent({ name: '技能户', skillIds: [skill.id] });
    const names = resolveTools(store, agent).map((item) => item.spec.function.name);
    expect(names).toContain('load_skill');
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
