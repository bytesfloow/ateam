import fs from 'node:fs';
import path from 'node:path';
import type { Agent, HandoffFolder } from '../../shared/types';
import type { Store } from './store';

/** 交接目录投递失败：源目录缺失或路径越界。 */
export class DeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryError';
  }
}

function isInside(parent: string, child: string): boolean {
  const root = path.resolve(parent);
  const target = path.resolve(child);
  return target === root || target.startsWith(root + path.sep);
}

const INBOX_DIR = 'inbox';
const FINAL_DIR = 'final';
/** 同名冲突时最多尝试的版本号，避免异常情况下无限循环。 */
const MAX_VERSION = 999;

/**
 * 计算交接目录在接收方工作区中的相对路径。
 *
 * 接收方一律放在 `inbox/<发送方 slug>/<原相对路径>`；如果交接的目录本身来自
 * 之前收到的 `inbox/<旧发送方>/...`，则去掉这段旧前缀，避免层层嵌套。
 */
export function inboxRelativePath(senderSlug: string, sourcePath: string): string {
  const parts = sourcePath
    .split('/')
    .filter((part) => part.length > 0 && part !== '.');
  const normalized = parts[0] === INBOX_DIR && parts.length > 2 ? parts.slice(2) : parts;
  return [INBOX_DIR, senderSlug, ...normalized].join('/');
}

/** 在目录名后加版本后缀：`a/b` → `a/b-v2`（整个目录一起改名，绝不覆盖）。 */
export function versionedRelativePath(rel: string, version: number): string {
  if (version <= 1) return rel;
  const dir = path.posix.dirname(rel);
  const base = path.posix.basename(rel);
  const name = `${base}-v${version}`;
  return dir === '.' ? name : `${dir}/${name}`;
}

/** 统计目录内文件数量与总字节数（递归，跳过符号链接）。 */
export function statFolder(root: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(child);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += fs.statSync(child).size;
        } catch {
          /* 读不到大小就只计数量 */
        }
      }
    }
  }
  return { files, bytes };
}

/** 列出目录内的全部文件（相对任务工作区的路径，正斜杠），上限保护。 */
export function listFolderFiles(root: string, maxFiles = 5000): { path: string; name: string; size: number }[] {
  const result: { path: string; name: string; size: number }[] = [];
  const walk = (dir: string, prefix: string): void => {
    if (result.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const entry of entries) {
      if (result.length >= maxFiles) return;
      const child = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(child, rel);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(child).size;
        } catch {
          /* ignore */
        }
        result.push({ path: rel, name: entry.name, size });
      }
    }
  };
  walk(root, '');
  return result;
}

/** 校验源目录合法，返回（源绝对路径、规范化的相对路径、统计信息）。 */
function inspectSourceFolder(senderRoot: string, folderRel: string): { source: string; rel: string; files: number; bytes: number } {
  const parts = folderRel
    .split(/[\\/]/)
    .filter((part) => part.length > 0 && part !== '.');
  if (parts.length === 0 || parts.includes('..')) {
    throw new DeliveryError('交接目录路径不合法');
  }
  const rel = parts.join('/');
  const source = path.resolve(senderRoot, ...parts);
  if (!isInside(senderRoot, source)) {
    throw new DeliveryError(`只能交接发送方工作区内的目录：${folderRel}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(source);
  } catch {
    throw new DeliveryError(`交接目录不存在：${folderRel}`);
  }
  if (!stat.isDirectory()) throw new DeliveryError(`交接单元必须是目录：${folderRel}`);
  const stats = statFolder(source);
  return { source, rel, files: stats.files, bytes: stats.bytes };
}

/**
 * 在目标根目录内为交接目录挑一个不冲突的落点（整目录加 -v2 后缀，绝不覆盖）。
 * 返回相对 targetRoot 的路径与绝对落点。
 */
function allocateTargetDir(targetRoot: string, preferredRel: string): { rel: string; dest: string } {
  let rel = preferredRel;
  let version = 1;
  while (fs.existsSync(path.resolve(targetRoot, rel))) {
    version += 1;
    if (version > MAX_VERSION) throw new DeliveryError(`目标目录中同名目录过多，无法交付：${preferredRel}`);
    rel = versionedRelativePath(preferredRel, version);
  }
  const dest = path.resolve(targetRoot, rel);
  if (!isInside(targetRoot, dest)) throw new DeliveryError(`交接目标路径越界：${rel}`);
  return { rel, dest };
}

function copyFolderTree(source: string, dest: string, sourceRel: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.cpSync(source, dest, { recursive: true, filter: (src) => !fs.lstatSync(src).isSymbolicLink() });
  } catch (error) {
    throw new DeliveryError(
      `复制目录失败：${sourceRel} → ${dest}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
}

export interface DeliverFolderParams {
  store: Store;
  taskId: string;
  senderSlug: string;
  target: Agent;
  /** 相对发送方任务工作区的目录路径。 */
  folderRel: string;
}

/**
 * 把交接目录从发送方工作区整目录递归复制到接收方工作区的 inbox 下。
 * 同名冲突时整个目录自动追加版本后缀（-v2、-v3……），交接本身不会失败。
 */
export function deliverHandoffFolder(params: DeliverFolderParams): HandoffFolder {
  const { store, taskId, senderSlug, target, folderRel } = params;
  const senderRoot = store.agentTaskWorkspaceDir(taskId, senderSlug);
  const targetRoot = store.ensureAgentTaskWorkspace(taskId, target.slug);
  const source = inspectSourceFolder(senderRoot, folderRel);
  const { rel, dest } = allocateTargetDir(targetRoot, inboxRelativePath(senderSlug, source.rel));
  copyFolderTree(source.source, dest, source.rel);
  return {
    path: source.rel,
    name: path.posix.basename(source.rel),
    files: source.files,
    bytes: source.bytes,
    deliveredPath: rel,
    deliveredTo: target.id,
  };
}

export interface DeliverFinalParams {
  store: Store;
  taskId: string;
  senderSlug: string;
  folderRel: string;
}

/**
 * 终点环节：把交接目录复制到任务目录的 final/ 下，交给用户验收。
 * 同样绝不覆盖，同名时整个目录追加版本后缀。
 */
export function deliverToFinal(params: DeliverFinalParams): HandoffFolder {
  const { store, taskId, senderSlug, folderRel } = params;
  const senderRoot = store.agentTaskWorkspaceDir(taskId, senderSlug);
  const finalRoot = store.ensureTaskFinalDir(taskId);
  const source = inspectSourceFolder(senderRoot, folderRel);
  const { rel, dest } = allocateTargetDir(finalRoot, source.rel);
  copyFolderTree(source.source, dest, source.rel);
  return {
    path: source.rel,
    name: path.posix.basename(source.rel),
    files: source.files,
    bytes: source.bytes,
    deliveredPath: `${FINAL_DIR}/${rel}`,
    deliveredTo: 'human',
  };
}

/** final 目录名常量（store / 路由共用）。 */
export const TASK_FINAL_DIR = FINAL_DIR;
