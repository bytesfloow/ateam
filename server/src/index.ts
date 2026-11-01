import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { DB_PATH, ensureBaseDirs, HOST, PORT, VERSION, WEB_DIST, WORKSPACE_ROOT } from './config';
import { openDatabase } from './db';
import { DesignerRuntime } from './designer';
import { RuntimeEvents } from './events';
import { apiErrorHandler } from './http';
import { Runtime } from './runtime';
import { createApiRouter } from './routes';
import { Store } from './store';

ensureBaseDirs();

const db = openDatabase(DB_PATH);
const store = new Store({ db, workspaceRoot: WORKSPACE_ROOT });
const events = new RuntimeEvents();
const runtime = new Runtime({ store, events });
const designer = new DesignerRuntime({ store, events });
designer.ensureReady();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

app.use('/api', createApiRouter({ store, runtime, designer }));

const indexHtml = path.join(WEB_DIST, 'index.html');
if (fs.existsSync(indexHtml)) {
  app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.sendFile(indexHtml);
  });
} else {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next();
      return;
    }
    res
      .status(200)
      .type('html')
      .send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>A-Team</title></head>
<body style="font-family:system-ui;background:#0b0e14;color:#e6e9f0;padding:48px;line-height:1.8">
<h1>A-Team API 已启动</h1>
<p>前端尚未构建。开发时请运行 <code>pnpm dev</code> 并访问 Vite 地址（默认 5310）；生产模式请先运行 <code>pnpm build</code> 再执行 <code>pnpm start</code>。</p>
<p>API 根路径：<code>/api</code></p>
</body></html>`);
  });
}

app.use(apiErrorHandler);

app.use((_req, res) => {
  res.status(404).json({ error: '资源不存在' });
});

const server = app.listen(PORT, HOST, () => {
  const llm = store.getLlmConfig();
  console.log('');
  console.log('  ╭────────────────────────────────────────────╮');
  console.log('  │  A-Team · 轻量智能体编排系统               │');
  console.log('  ╰────────────────────────────────────────────╯');
  console.log(`  版本      ${VERSION}`);
  console.log(`  地址      http://${HOST}:${PORT}`);
  console.log(`  数据库    ${DB_PATH}`);
  console.log(`  工作目录  ${WORKSPACE_ROOT}`);
  console.log(`  模型      ${llm.model} @ ${llm.baseUrl}`);
  console.log('');
});

server.requestTimeout = 0;
server.headersTimeout = 65_000;

function shutdown(signal: string): void {
  console.log(`\n收到 ${signal}，正在关闭…`);
  server.close(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('[process] 未处理的 Promise 拒绝:', reason);
});
