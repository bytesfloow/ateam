import fs from 'node:fs';
import path from 'node:path';
import type { SkillFile } from '../../shared/types';
import { AppError } from './errors';

/** 技能包是随技能一起分发的文件集合，限制总大小避免把数据库和任务上下文撑爆。 */
export const SKILL_FILE_LIMITS = {
  maxFiles: 100,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
};

/** 文档里引用脚本的占位符：{{script:文件名}}，文件名在单个技能包内唯一。 */
const SCRIPT_PLACEHOLDER_RE = /\{\{script:([^{}]*)\}\}/g;
const INVALID_SEGMENT_CHARS = /[<>:"|?*{}\u0000-\u001f]/;

/** 规范化技能包内的相对路径；拒绝绝对路径、越界路径与 Windows 非法字符。 */
export function normalizeSkillFilePath(input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) throw new AppError(400, '文件路径不能为空');
  const normalized = raw.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new AppError(400, '文件路径必须是技能包内的相对路径');
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new AppError(400, '文件路径不能包含空目录、. 或 ..');
  }
  for (const segment of segments) {
    if (segment.length > 80) throw new AppError(400, '文件名或目录名不能超过 80 个字符');
    if (INVALID_SEGMENT_CHARS.test(segment)) {
      throw new AppError(400, `路径「${segment}」包含不允许的字符（< > : " | ? * { } 等）`);
    }
    if (segment.startsWith('.')) throw new AppError(400, '不允许创建隐藏文件或隐藏目录');
    if (/[. ]$/.test(segment)) throw new AppError(400, '文件名不能以空格或点结尾');
  }
  const filePath = segments.join('/');
  if (filePath.length > 200) throw new AppError(400, '文件路径不能超过 200 个字符');
  if (filePath === 'SKILL.md') throw new AppError(400, 'SKILL.md 是技能正文，请在 Markdown 编辑器中直接修改');
  return filePath;
}

/** scripts/ 下的文件视为脚本，可被文档用占位符引用。 */
export function isSkillScriptPath(filePath: string): boolean {
  return filePath.startsWith('scripts/');
}

export function scriptFileName(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

/** 提取文档中引用的脚本名（按大小写不敏感去重，保持首次出现的写法）。 */
export function extractScriptReferences(content: string): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const match of content.matchAll(SCRIPT_PLACEHOLDER_RE)) {
    const name = match[1].trim();
    if (!name) throw new AppError(400, '技能文档中存在空的脚本占位符 {{script:}}');
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(name);
  }
  return refs;
}

/** 保存正文前校验：所有占位符都必须能对应到当前技能包中的脚本。 */
export function assertSkillReferences(content: string, scriptNames: string[]): void {
  const refs = extractScriptReferences(content);
  if (refs.length === 0) return;
  const available = new Set(scriptNames.map((name) => name.toLowerCase()));
  const missing = refs.filter((name) => !available.has(name.toLowerCase()));
  if (missing.length > 0) {
    const list = missing.map((name) => `「${name}」`).join('、');
    throw new AppError(400, `技能文档引用了不存在的脚本：${list}。请先添加脚本或修正占位符。`);
  }
}

export function scriptNamesOf(files: SkillFile[]): string[] {
  return files.filter((file) => file.script).map((file) => scriptFileName(file.path));
}

function assertInside(parent: string, child: string): void {
  const root = path.resolve(parent);
  const target = path.resolve(child);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new AppError(500, '技能包路径越界');
  }
}

/** 把 {{script:文件名}} 替换为技能副本内的绝对路径（统一用 /，便于跨 shell 使用）。 */
export function resolveSkillPlaceholders(content: string, skillDir: string, files: SkillFile[]): string {
  const byName = new Map<string, SkillFile>();
  for (const file of files) {
    if (!file.script) continue;
    byName.set(scriptFileName(file.path).toLowerCase(), file);
  }
  return content.replace(SCRIPT_PLACEHOLDER_RE, (_match, raw: string) => {
    const name = raw.trim();
    const file = byName.get(name.toLowerCase());
    if (!file) throw new AppError(500, `技能包缺少脚本「${name}」，无法解析占位符`);
    const absolute = path.resolve(skillDir, ...file.path.split('/'));
    assertInside(skillDir, absolute);
    return absolute.split(path.sep).join('/');
  });
}

/** 脚本改名时同步更新 SKILL.md 中的占位符，避免留下悬空引用。 */
export function renameScriptReferences(content: string, oldName: string, newName: string): string {
  return content.replace(SCRIPT_PLACEHOLDER_RE, (match, raw: string) =>
    raw.trim().toLowerCase() === oldName.toLowerCase() ? `{{script:${newName}}}` : match,
  );
}

/** 工作区里的技能副本目录名：可读的名称片段 + 技能 ID 前缀，保证同一任务内不冲突。 */
export function skillPackageDirName(name: string, id: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'skill';
  return `${slug}-${id.slice(0, 8)}`;
}

export interface MaterializedSkillFile {
  path: string;
  bytes: Uint8Array;
}

/** 把技能包写入智能体任务工作区；目录结构原样保留，SKILL.md 写入已解析的正文。 */
export function materializeSkillPackage(
  skillDir: string,
  files: MaterializedSkillFile[],
  skillMarkdown: string,
): void {
  fs.rmSync(skillDir, { recursive: true, force: true });
  fs.mkdirSync(skillDir, { recursive: true });
  for (const file of files) {
    const target = path.resolve(skillDir, ...file.path.split('/'));
    assertInside(skillDir, target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.bytes);
  }
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMarkdown, 'utf8');
}

export interface SkillScriptRuntime {
  command: string;
  label: string;
}

/** 按扩展名给出运行命令；无法识别的文件不提供默认命令。 */
export function skillScriptRuntime(filePath: string): SkillScriptRuntime | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return { command: 'node', label: 'Node.js' };
    case '.py':
      return { command: 'python', label: 'Python' };
    case '.ps1':
      return { command: 'powershell -File', label: 'PowerShell' };
    case '.sh':
      return { command: 'bash', label: 'Shell' };
    case '.bat':
    case '.cmd':
      return { command: 'cmd /c', label: 'Batch' };
    default:
      return null;
  }
}