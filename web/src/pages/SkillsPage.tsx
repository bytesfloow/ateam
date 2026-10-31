import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Braces,
  FileCode2,
  FilePlus2,
  FileText,
  Image as ImageIcon,
  Pencil,
  Plus,
  Save,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import type { Skill, SkillFile, SkillFileEncoding } from '@shared/types';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { CodeEditor, type CodeEditorHandle, type CodeLanguage } from '../components/CodeEditor';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { Field } from '../components/Field';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { Spinner } from '../components/Spinner';
import { Tabs } from '../components/Tabs';
import { cn } from '../lib/format';
import { useToast } from '../lib/toast';

const SKILL_TEMPLATE = `# 技能名称

## 适用场景

说明这个技能适合在什么任务、什么阶段使用。

## 工作步骤

1. 第一步：先确认输入与目标。
2. 第二步：按明确的方法处理。
3. 第三步：检查结果是否满足验收标准。

## 脚本（可选）

如果技能包含脚本，说明每个脚本的用途、参数与示例。编辑时可用「插入脚本」按钮引用脚本。

## 输出要求

- 结论先行，给出可直接使用的成果。
- 列出关键依据与风险。
`;

const MAX_FILE_BYTES = 512 * 1024;

const SCRIPT_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'sh', 'ps1', 'bat', 'cmd']);
const TEXT_EXTENSIONS = new Set([
  'md',
  'markdown',
  'txt',
  'json',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'py',
  'sh',
  'ps1',
  'bat',
  'cmd',
  'yaml',
  'yml',
  'toml',
  'ini',
  'csv',
  'html',
  'css',
  'scss',
  'xml',
  'svg',
  'sql',
  'go',
  'rs',
  'java',
  'c',
  'h',
  'cpp',
  'hpp',
  'rb',
  'php',
  'lua',
]);

interface Draft {
  name: string;
  description: string;
  content: string;
}

const EMPTY_DRAFT: Draft = { name: '', description: '', content: SKILL_TEMPLATE };

function skillToDraft(skill: Skill): Draft {
  return { name: skill.name, description: skill.description, content: skill.content };
}

function baseName(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

function extensionOf(filePath: string): string {
  const name = baseName(filePath);
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

function languageForPath(filePath: string): CodeLanguage {
  if (filePath === 'SKILL.md' || extensionOf(filePath) === 'md') return 'markdown';
  const ext = extensionOf(filePath);
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'].includes(ext)) return 'javascript';
  if (ext === 'py') return 'python';
  if (ext === 'json') return 'json';
  return 'text';
}

function runtimeLabel(filePath: string): string {
  switch (extensionOf(filePath)) {
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return 'Node.js';
    case 'py':
      return 'Python';
    case 'sh':
      return 'Shell';
    case 'ps1':
      return 'PowerShell';
    case 'bat':
    case 'cmd':
      return 'Batch';
    default:
      return '脚本';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function normalizePathInput(value: string): string {
  return value.trim().replace(/\\/g, '/');
}

function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  if (['application/json', 'application/javascript', 'application/xml', 'image/svg+xml'].includes(file.type)) {
    return true;
  }
  return TEXT_EXTENSIONS.has(extensionOf(file.name));
}

async function readFilePayload(file: File): Promise<{ content: string; encoding: SkillFileEncoding }> {
  if (isTextFile(file)) return { content: await file.text(), encoding: 'utf8' };
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return { content: btoa(binary), encoding: 'base64' };
}

interface FileDraftState {
  content: string;
  encoding: SkillFileEncoding;
}

export function SkillsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [search, setSearch] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);

  const [activePath, setActivePath] = useState('SKILL.md');
  const [fileContents, setFileContents] = useState<Record<string, FileDraftState>>({});
  const [fileDrafts, setFileDrafts] = useState<Record<string, string>>({});
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const [scriptPickerOpen, setScriptPickerOpen] = useState(false);
  const [addFileOpen, setAddFileOpen] = useState(false);
  const [addPath, setAddPath] = useState('');
  const [addContent, setAddContent] = useState('');
  const [addEncoding, setAddEncoding] = useState<SkillFileEncoding>('utf8');
  const [addHasSource, setAddHasSource] = useState(false);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renamePath, setRenamePath] = useState('');
  const [deleteFilePath, setDeleteFilePath] = useState<string | null>(null);

  const editorRef = useRef<CodeEditorHandle>(null);
  const pendingInsert = useRef<string | null>(null);

  const skillsQuery = useQuery({ queryKey: ['skills'], queryFn: api.listSkills });
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: api.listAgents });
  const skills = skillsQuery.data?.skills ?? [];
  const agents = agentsQuery.data?.agents ?? [];

  const current = selected && selected !== 'new' ? skills.find((skill) => skill.id === selected) ?? null : null;
  const isNew = selected === 'new';
  const currentFiles = current?.files ?? [];
  const scriptFiles = useMemo(() => currentFiles.filter((file) => file.script), [currentFiles]);
  const activeFile = activePath === 'SKILL.md' ? null : currentFiles.find((file) => file.path === activePath) ?? null;

  function resetFileState() {
    setActivePath('SKILL.md');
    setFileContents({});
    setFileDrafts({});
    setFileLoading(false);
    setFileError(null);
  }

  useEffect(() => {
    if (skills.length === 0) {
      if (selected !== null && selected !== 'new') {
        setSelected(null);
        setDraft(EMPTY_DRAFT);
        resetFileState();
      }
      return;
    }
    if (selected === null) {
      setSelected(skills[0].id);
      setDraft(skillToDraft(skills[0]));
      resetFileState();
      return;
    }
    if (selected !== 'new' && !skills.some((skill) => skill.id === selected)) {
      setSelected(skills[0].id);
      setDraft(skillToDraft(skills[0]));
      resetFileState();
    }
  }, [skills, selected]);

  useEffect(() => {
    if (activePath !== 'SKILL.md' && current && !currentFiles.some((file) => file.path === activePath)) {
      setActivePath('SKILL.md');
    }
  }, [activePath, current, currentFiles]);

  useEffect(() => {
    if (!current || activePath === 'SKILL.md') return;
    if (fileContents[activePath]) return;
    const file = currentFiles.find((item) => item.path === activePath);
    if (!file || !file.text) return;
    let cancelled = false;
    setFileLoading(true);
    setFileError(null);
    api
      .getSkillFile(current.id, activePath)
      .then((response) => {
        if (cancelled) return;
        setFileContents((previous) => ({
          ...previous,
          [activePath]: { content: response.content, encoding: response.encoding },
        }));
      })
      .catch((error: Error) => {
        if (!cancelled) setFileError(error.message);
      })
      .finally(() => {
        if (!cancelled) setFileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [current, currentFiles, activePath, fileContents]);

  const metaDirty = isNew
    ? Boolean(draft.name || draft.description || draft.content !== SKILL_TEMPLATE)
    : current
      ? draft.name !== current.name ||
        draft.description !== current.description ||
        draft.content !== current.content
      : false;

  const dirtyFilePaths = useMemo(
    () =>
      Object.keys(fileDrafts).filter(
        (filePath) => fileDrafts[filePath] !== (fileContents[filePath]?.content ?? ''),
      ),
    [fileDrafts, fileContents],
  );
  const dirty = metaDirty || dirtyFilePaths.length > 0;

  const usage = useMemo(() => {
    if (!current) return [];
    return agents.filter((agent) => agent.skillIds.includes(current.id));
  }, [agents, current]);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return skills;
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(keyword) ||
        skill.description.toLowerCase().includes(keyword) ||
        skill.content.toLowerCase().includes(keyword),
    );
  }, [skills, search]);

  function applySkill(skill: Skill) {
    queryClient.setQueryData<{ skills: Skill[] }>(['skills'], (previous) => {
      if (!previous) return previous;
      const exists = previous.skills.some((item) => item.id === skill.id);
      return {
        skills: exists
          ? previous.skills.map((item) => (item.id === skill.id ? skill : item))
          : [...previous.skills, skill],
      };
    });
    setSelected(skill.id);
    setDraft(skillToDraft(skill));
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft.name.trim()) throw new Error('请填写技能名称');
      if (isNew) {
        const data = await api.createSkill({
          name: draft.name.trim(),
          description: draft.description.trim(),
          content: draft.content,
        });
        return { skill: data.skill, savedDrafts: {} as Record<string, string> };
      }
      if (!current) throw new Error('技能不存在');
      const savedDrafts: Record<string, string> = {};
      for (const filePath of dirtyFilePaths) {
        const content = fileDrafts[filePath];
        await api.putSkillFile(current.id, { path: filePath, content, encoding: 'utf8' });
        savedDrafts[filePath] = content;
      }
      const data = await api.updateSkill(current.id, {
        name: draft.name.trim(),
        description: draft.description.trim(),
        content: draft.content,
      });
      return { skill: data.skill, savedDrafts };
    },
    onSuccess: async ({ skill, savedDrafts }) => {
      await queryClient.invalidateQueries({ queryKey: ['skills'] });
      applySkill(skill);
      setFileContents((previous) => {
        const next = { ...previous };
        for (const [filePath, content] of Object.entries(savedDrafts)) {
          next[filePath] = { content, encoding: 'utf8' };
        }
        return next;
      });
      setFileDrafts({});
      toast.success(current ? '技能已更新' : '技能已创建');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteSkill(id),
    onSuccess: () => {
      setDeleteOpen(false);
      setSelected(null);
      setDraft(EMPTY_DRAFT);
      resetFileState();
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      toast.success('技能已删除');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const addFileMutation = useMutation({
    mutationFn: async () => {
      if (!current) throw new Error('请先保存技能');
      const filePath = normalizePathInput(addPath);
      if (!filePath) throw new Error('请填写文件路径');
      const data = await api.putSkillFile(current.id, {
        path: filePath,
        content: addContent,
        encoding: addEncoding,
      });
      return { skill: data.skill, filePath, content: addContent, encoding: addEncoding };
    },
    onSuccess: ({ skill, filePath, content, encoding }) => {
      applySkill(skill);
      setFileContents((previous) => ({ ...previous, [filePath]: { content, encoding } }));
      setFileDrafts((previous) => {
        const next = { ...previous };
        delete next[filePath];
        return next;
      });
      setActivePath(filePath);
      setMode('edit');
      setAddFileOpen(false);
      setAddPath('');
      setAddContent('');
      setAddEncoding('utf8');
      setAddHasSource(false);
      toast.success('文件已添加');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const renameFileMutation = useMutation({
    mutationFn: async () => {
      if (!current || !renameTarget) throw new Error('文件不存在');
      const to = normalizePathInput(renamePath);
      if (!to) throw new Error('请填写新的文件路径');
      const data = await api.renameSkillFile(current.id, renameTarget, to);
      return { skill: data.skill, from: renameTarget, to };
    },
    onSuccess: ({ skill, from, to }) => {
      applySkill(skill);
      setFileContents((previous) => {
        const next = { ...previous };
        if (next[from]) {
          next[to] = next[from];
          delete next[from];
        }
        return next;
      });
      setFileDrafts((previous) => {
        const next = { ...previous };
        if (next[from] !== undefined) {
          next[to] = next[from];
          delete next[from];
        }
        return next;
      });
      if (activePath === from) setActivePath(to);
      setRenameTarget(null);
      setRenamePath('');
      toast.success('文件已重命名');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const deleteFileMutation = useMutation({
    mutationFn: async (filePath: string) => {
      if (!current) throw new Error('技能不存在');
      const data = await api.deleteSkillFile(current.id, filePath);
      return { skill: data.skill, filePath };
    },
    onSuccess: ({ skill, filePath }) => {
      applySkill(skill);
      setFileContents((previous) => {
        const next = { ...previous };
        delete next[filePath];
        return next;
      });
      setFileDrafts((previous) => {
        const next = { ...previous };
        delete next[filePath];
        return next;
      });
      if (activePath === filePath) setActivePath('SKILL.md');
      setDeleteFilePath(null);
      toast.success('文件已删除');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function createNew() {
    setSelected('new');
    setDraft({ ...EMPTY_DRAFT });
    setMode('edit');
    resetFileState();
  }

  function selectSkill(skill: Skill) {
    setSelected(skill.id);
    setDraft(skillToDraft(skill));
    setMode('edit');
    resetFileState();
  }

  function selectFile(filePath: string) {
    setActivePath(filePath);
    setMode('edit');
    setFileError(null);
  }

  function ensureCanManageFiles(): boolean {
    if (!current) {
      toast.info('请先保存技能，再添加脚本或素材');
      return false;
    }
    if (dirty) {
      toast.error('请先保存当前修改，再管理技能文件');
      return false;
    }
    return true;
  }

  function openAddFile() {
    if (!ensureCanManageFiles()) return;
    setAddPath('');
    setAddContent('');
    setAddEncoding('utf8');
    setAddHasSource(false);
    setAddFileOpen(true);
  }

  function openRename(filePath: string) {
    if (!ensureCanManageFiles()) return;
    setRenameTarget(filePath);
    setRenamePath(filePath);
  }

  async function handlePickAddFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      toast.error(`单个文件不能超过 ${Math.round(MAX_FILE_BYTES / 1024)} KB`);
      return;
    }
    const payload = await readFilePayload(file);
    const ext = extensionOf(file.name);
    setAddPath(`${SCRIPT_EXTENSIONS.has(ext) ? 'scripts' : 'assets'}/${file.name}`);
    setAddContent(payload.content);
    setAddEncoding(payload.encoding);
    setAddHasSource(true);
  }

  function openScriptPicker() {
    if (!current) {
      toast.info('请先保存技能');
      return;
    }
    if (scriptFiles.length === 0) {
      toast.info('当前技能还没有脚本，请先添加 scripts/ 目录下的文件');
      return;
    }
    setScriptPickerOpen(true);
  }

  function insertAtCursor(text: string) {
    if (editorRef.current) {
      editorRef.current.insertAtCursor(text);
      return;
    }
    setDraft((previous) => ({
      ...previous,
      content: `${previous.content}${previous.content.endsWith('\n') || !previous.content ? '' : '\n'}${text}`,
    }));
  }

  function insertScript(file: SkillFile) {
    const token = `'{{script:${baseName(file.path)}}}'`;
    setScriptPickerOpen(false);
    if (activePath !== 'SKILL.md' || mode !== 'edit') {
      pendingInsert.current = token;
      if (activePath !== 'SKILL.md') setActivePath('SKILL.md');
      if (mode !== 'edit') setMode('edit');
      return;
    }
    insertAtCursor(token);
  }

  useEffect(() => {
    if (mode !== 'edit' || !pendingInsert.current) return;
    const text = pendingInsert.current;
    pendingInsert.current = null;
    // 等编辑器完成挂载后再插入；用 setTimeout 而不是 rAF，后台标签页里也能执行。
    const timer = window.setTimeout(() => insertAtCursor(text), 0);
    return () => window.clearTimeout(timer);
  }, [mode, activePath]);

  const activeText = activePath === 'SKILL.md' ? draft.content : fileDrafts[activePath] ?? fileContents[activePath]?.content ?? '';

  return (
    <div className="page-stack">
      <div className="page-intro">
        <div>
          <h2>技能库</h2>
          <p>
            技能是可按需加载的指令包，支持 Markdown 说明书、脚本与素材。系统提示词只放名称与描述，模型调用
            load_skill 时才会把技能包复制到工作区并读取全文。
          </p>
        </div>
        <button type="button" className="button button--primary" onClick={createNew}>
          <Plus size={15} />
          新建技能
        </button>
      </div>

      <div className="split-layout">
        <aside className="card library-list">
          <div className="library-search">
            <Search size={15} />
            <input
              className="input input--search"
              value={search}
              placeholder="搜索技能…"
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="library-items">
            {skillsQuery.isLoading ? (
              <div className="loading-inline">
                <Spinner size={16} /> 加载中…
              </div>
            ) : filtered.length === 0 ? (
              <div className="library-empty">{search ? '没有匹配的技能' : '还没有技能'}</div>
            ) : (
              filtered.map((skill) => {
                const used = agents.filter((agent) => agent.skillIds.includes(skill.id)).length;
                const scripts = skill.files.filter((file) => file.script).length;
                return (
                  <button
                    type="button"
                    key={skill.id}
                    className={cn('library-item', selected === skill.id && 'is-active')}
                    onClick={() => selectSkill(skill)}
                  >
                    <span className="library-icon">
                      <Sparkles size={15} />
                    </span>
                    <span className="library-item-main">
                      <strong>{skill.name}</strong>
                      <small>{skill.description || '（无描述）'}</small>
                    </span>
                    {scripts > 0 ? (
                      <span className="library-chip" title={`包含 ${scripts} 个脚本`}>
                        {scripts} 脚本
                      </span>
                    ) : null}
                    {used > 0 ? (
                      <span className="library-count" title={`${used} 个智能体使用`}>
                        {used}
                      </span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <section className="card library-editor">
          {!current && !isNew ? (
            <EmptyState
              icon={FileCode2}
              title="选择一个技能开始编辑"
              description="或者创建一个新的技能包，支持说明书、脚本与素材。"
              action={
                <button type="button" className="button button--primary" onClick={createNew}>
                  <Plus size={15} />
                  新建技能
                </button>
              }
            />
          ) : (
            <>
              <div className="editor-toolbar">
                <div className="editor-toolbar-main">
                  <span className="eyebrow">
                    <Sparkles size={13} />
                    {isNew ? 'NEW SKILL' : 'SKILL'}
                  </span>
                  <h3>{isNew ? '新建技能' : current?.name}</h3>
                </div>
                <div className="button-row">
                  {current ? (
                    <button
                      type="button"
                      className="button button--danger-ghost button--sm"
                      onClick={() => setDeleteOpen(true)}
                    >
                      <Trash2 size={14} />
                      删除
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="button button--primary button--sm"
                    onClick={() => saveMutation.mutate()}
                    disabled={saveMutation.isPending || !draft.name.trim() || (!dirty && !isNew)}
                  >
                    {saveMutation.isPending ? <Spinner size={14} /> : <Save size={14} />}
                    保存
                  </button>
                </div>
              </div>

              <div className="form-grid form-grid--2">
                <Field label="技能名称" required hint="智能体调用 load_skill 时使用的名称。">
                  <input
                    className="input"
                    value={draft.name}
                    maxLength={40}
                    placeholder="例如：结构化交付"
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </Field>
                <Field label="一句话描述" hint="会出现在智能体的系统提示词中，说明何时使用。">
                  <input
                    className="input"
                    value={draft.description}
                    maxLength={300}
                    placeholder="例如：把工作成果整理成目标-过程-结论-风险结构"
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  />
                </Field>
              </div>

              {current ? (
                <div className="skill-usage-line">
                  <Users size={14} />
                  被 {usage.length} 个智能体使用
                  {usage.length > 0 ? (
                    <span className="muted">：{usage.map((agent) => agent.name).join('、')}</span>
                  ) : null}
                  {scriptFiles.length > 0 ? (
                    <span className="muted">· {scriptFiles.length} 个脚本</span>
                  ) : null}
                  <Badge tone={dirty ? 'warning' : 'neutral'}>{dirty ? '有未保存修改' : '已保存'}</Badge>
                </div>
              ) : null}

              <div className="skill-package-grid">
                <aside className="skill-file-tree">
                  <div className="skill-file-tree-head">
                    <span>技能文件</span>
                    <button
                      type="button"
                      className="icon-button icon-button--tiny"
                      onClick={openAddFile}
                      title={current ? '添加脚本或素材' : '先保存技能后添加文件'}
                      aria-label="添加文件"
                    >
                      <FilePlus2 size={15} />
                    </button>
                  </div>
                  <div className="skill-file-tree-items">
                    <div className={cn('skill-file-row', activePath === 'SKILL.md' && 'is-active')}>
                      <button type="button" className="skill-file-main" onClick={() => selectFile('SKILL.md')}>
                        <FileText size={14} />
                        <span className="skill-file-name">SKILL.md</span>
                      </button>
                      <span className="skill-file-tag">说明书</span>
                    </div>
                    {currentFiles.map((file) => (
                      <div
                        key={file.path}
                        className={cn('skill-file-row', activePath === file.path && 'is-active')}
                      >
                        <button
                          type="button"
                          className="skill-file-main"
                          onClick={() => selectFile(file.path)}
                          title={file.path}
                        >
                          {file.script ? (
                            <FileCode2 size={14} />
                          ) : file.text ? (
                            <FileText size={14} />
                          ) : (
                            <ImageIcon size={14} />
                          )}
                          <span className="skill-file-name">{file.path}</span>
                        </button>
                        <button
                          type="button"
                          className="icon-button icon-button--tiny"
                          onClick={() => openRename(file.path)}
                          title="重命名"
                          aria-label={`重命名 ${file.path}`}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          className="icon-button icon-button--tiny"
                          onClick={() => {
                            if (ensureCanManageFiles()) setDeleteFilePath(file.path);
                          }}
                          title="删除"
                          aria-label={`删除 ${file.path}`}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                    {!current ? (
                      <div className="skill-file-empty">保存技能后可以添加 scripts/ 脚本和 assets/ 素材。</div>
                    ) : currentFiles.length === 0 ? (
                      <div className="skill-file-empty">还没有附加文件。点击右上角 + 添加脚本或素材。</div>
                    ) : null}
                  </div>
                </aside>

                <div className="skill-file-editor">
                  <div className="editor-tabs-row">
                    {activePath === 'SKILL.md' ? (
                      <>
                        <Tabs
                          value={mode}
                          onChange={setMode}
                          tabs={[
                            { value: 'edit', label: '编辑 Markdown' },
                            { value: 'preview', label: '预览' },
                          ]}
                        />
                        <div className="skill-editor-actions">
                          <button
                            type="button"
                            className="button button--ghost button--sm"
                            onClick={openScriptPicker}
                            disabled={!current || scriptFiles.length === 0}
                            title={
                              scriptFiles.length === 0
                                ? '先添加 scripts/ 目录下的脚本'
                                : '把脚本引用插入到光标位置'
                            }
                          >
                            <Braces size={14} />
                            插入脚本
                          </button>
                          <span className="muted">{draft.content.length} 字符</span>
                        </div>
                      </>
                    ) : (
                      <>
                        <span className="eyebrow">
                          <FileCode2 size={13} />
                          {activeFile?.script ? 'SCRIPT' : 'FILE'} · {runtimeLabel(activePath)}
                        </span>
                        <span className="muted">
                          {activeFile ? `${formatBytes(activeFile.size)} · ${activeFile.path}` : ''}
                        </span>
                      </>
                    )}
                  </div>

                  {activePath === 'SKILL.md' ? (
                    mode === 'edit' ? (
                      <CodeEditor
                        key={activePath}
                        ref={editorRef}
                        value={draft.content}
                        language="markdown"
                        onChange={(value) => setDraft({ ...draft, content: value })}
                        placeholder={SKILL_TEMPLATE}
                      />
                    ) : (
                      <div className="markdown-preview">
                        <Markdown>{draft.content}</Markdown>
                      </div>
                    )
                  ) : !activeFile ? (
                    <div className="skill-file-empty">文件不存在或已被删除。</div>
                  ) : !activeFile.text ? (
                    <div className="skill-binary">
                      <ImageIcon size={28} />
                      <p>二进制文件不支持在线编辑，可直接下载或删除。</p>
                      <a
                        className="button button--sm"
                        href={current ? api.skillFileUrl(current.id, activeFile.path, true) : '#'}
                      >
                        下载文件
                      </a>
                    </div>
                  ) : fileError ? (
                    <div className="skill-file-empty">{fileError}</div>
                  ) : fileLoading && !fileContents[activePath] ? (
                    <div className="loading-inline">
                      <Spinner size={16} /> 加载文件…
                    </div>
                  ) : (
                    <CodeEditor
                      key={activePath}
                      ref={editorRef}
                      value={activeText}
                      language={languageForPath(activePath)}
                      onChange={(value) =>
                        setFileDrafts((previous) => ({ ...previous, [activePath]: value }))
                      }
                    />
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      <Modal
        open={scriptPickerOpen}
        onClose={() => setScriptPickerOpen(false)}
        title="插入脚本引用"
        description={
          <>
            点击脚本会把 <code>{'{{script:文件名}}'}</code> 插入到 Markdown 光标位置。占位符会带上单引号，
            运行时替换为脚本的绝对路径。
          </>
        }
        width={520}
      >
        <div className="script-picker-list">
          {scriptFiles.map((file) => (
            <button
              key={file.path}
              type="button"
              className="script-picker-item"
              onClick={() => insertScript(file)}
            >
              <FileCode2 size={16} />
              <span className="script-picker-main">
                <strong>{baseName(file.path)}</strong>
                <small>
                  {file.path} · {runtimeLabel(file.path)} · {formatBytes(file.size)}
                </small>
              </span>
              <Braces size={15} />
            </button>
          ))}
        </div>
      </Modal>

      <Modal
        open={addFileOpen}
        onClose={() => setAddFileOpen(false)}
        title="添加技能文件"
        description="脚本放在 scripts/ 下，同一技能内脚本文件名不能重复；其他素材放在 assets/ 下。单个文件不超过 512 KB。"
        footer={
          <>
            <button type="button" className="button" onClick={() => setAddFileOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => addFileMutation.mutate()}
              disabled={addFileMutation.isPending || !addPath.trim()}
            >
              {addFileMutation.isPending ? <Spinner size={14} /> : <Upload size={14} />}
              添加
            </button>
          </>
        }
      >
        <Field label="从本机选择文件" hint="选择后会自动填入路径；文本文件可继续在线编辑。">
          <input type="file" onChange={handlePickAddFile} />
        </Field>
        <Field
          label="文件路径"
          required
          hint="相对技能包根目录，例如 scripts/render.js 或 assets/template.md"
        >
          <input
            className="input"
            value={addPath}
            placeholder="scripts/render.js"
            onChange={(event) => setAddPath(event.target.value)}
          />
        </Field>
        {addHasSource ? (
          <div className="skill-upload-hint">
            已读取文件内容（{addEncoding === 'utf8' ? 'UTF-8 文本' : '二进制，Base64 编码'}）。
          </div>
        ) : (
          <div className="skill-upload-hint">也可以不选文件，直接创建一个空白脚本或文档后在线编辑。</div>
        )}
      </Modal>

      <Modal
        open={Boolean(renameTarget)}
        onClose={() => setRenameTarget(null)}
        title="重命名文件"
        description={
          <>
            脚本改名后，SKILL.md 中的 <code>{'{{script:旧文件名}}'}</code> 会自动更新为新文件名。
          </>
        }
        footer={
          <>
            <button type="button" className="button" onClick={() => setRenameTarget(null)}>
              取消
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => renameFileMutation.mutate()}
              disabled={renameFileMutation.isPending || !renamePath.trim()}
            >
              {renameFileMutation.isPending ? <Spinner size={14} /> : <Save size={14} />}
              保存
            </button>
          </>
        }
      >
        <Field label="新的文件路径" required hint="例如 scripts/render.js">
          <input
            className="input"
            value={renamePath}
            placeholder="scripts/render.js"
            onChange={(event) => setRenamePath(event.target.value)}
          />
        </Field>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteFilePath)}
        title="删除这个文件？"
        description={
          <>
            将删除技能文件「{deleteFilePath}」。
            {deleteFilePath?.startsWith('scripts/')
              ? '如果 SKILL.md 仍在引用该脚本，系统会拒绝删除。'
              : ''}
          </>
        }
        confirmLabel="删除文件"
        busy={deleteFileMutation.isPending}
        onCancel={() => setDeleteFilePath(null)}
        onConfirm={() => {
          if (deleteFilePath) deleteFileMutation.mutate(deleteFilePath);
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        title="删除这个技能？"
        description={
          <>
            将删除技能「{current?.name}」及其全部脚本与素材。
            {usage.length > 0
              ? `它当前被 ${usage.length} 个智能体启用，删除后会自动从这些智能体中移除。`
              : ''}
          </>
        }
        confirmLabel="删除技能"
        busy={deleteMutation.isPending}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          if (current) deleteMutation.mutate(current.id);
        }}
      />
    </div>
  );
}