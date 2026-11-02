import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  Eye,
  Pencil,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Users,
  Wrench,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  BUILTIN_TOOL_NAMES,
  DESIGNER_SLUG,
  type Agent,
  type AgentInput,
  type AgentToolsConfig,
  type BuiltinToolInfo,
} from '@shared/types';
import { api } from '../api';
import { AgentAvatar } from '../components/AgentAvatar';
import { Badge } from '../components/Badge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { Field } from '../components/Field';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { Spinner } from '../components/Spinner';
import { Tabs } from '../components/Tabs';
import { cn } from '../lib/format';
import { useToast } from '../lib/toast';

const ACCENTS = ['#6d8cff', '#38bdf8', '#34d399', '#f59e0b', '#f472b6', '#a78bfa', '#fb7185', '#2dd4bf'];
const DEFAULT_BUILTINS = BUILTIN_TOOL_NAMES.filter((name) => name !== 'handoff');

type EditorTab = 'basic' | 'tools' | 'skills' | 'prompt';

interface Draft {
  name: string;
  description: string;
  /** 任务说明（必填）：写清本环节要做哪些事、做到什么程度。 */
  responsibilities: string;
  /** 交付要求：这个岗位需要交付什么、以什么形式。 */
  deliverable: string;
  /** 工作指南：岗位工作方法与思考方式。 */
  guide: string;
  /** 训练型智能体的完整系统提示词（由训练师撰写）；仅编辑训练型智能体时使用。 */
  prompt: string;
  model: string;
  temperature: string;
  toolsBuiltin: string[];
  toolsCustom: string[];
  skillIds: string[];
  accent: string;
}

function newDraft(index: number): Draft {
  return {
    name: '',
    description: '',
    responsibilities: '',
    deliverable: '',
    guide: '',
    prompt: '',
    model: '',
    temperature: '',
    toolsBuiltin: [...DEFAULT_BUILTINS],
    toolsCustom: [],
    skillIds: [],
    accent: ACCENTS[index % ACCENTS.length],
  };
}

function agentToDraft(agent: Agent): Draft {
  return {
    name: agent.name,
    description: agent.description,
    responsibilities: agent.responsibilities,
    deliverable: agent.deliverable,
    guide: agent.guide,
    prompt: agent.prompt ?? '',
    model: agent.model ?? '',
    temperature: agent.temperature === null ? '' : String(agent.temperature),
    toolsBuiltin: agent.tools.builtin,
    toolsCustom: agent.tools.custom,
    skillIds: agent.skillIds,
    accent: agent.accent,
  };
}

export function AgentsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tab, setTab] = useState<EditorTab>('basic');
  const [draft, setDraft] = useState<Draft>(() => newDraft(0));
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);

  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: api.listAgents });
  const toolsQuery = useQuery({ queryKey: ['tools'], queryFn: api.listTools });
  const skillsQuery = useQuery({ queryKey: ['skills'], queryFn: api.listSkills });
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const statusQuery = useQuery({ queryKey: ['status'], queryFn: api.status });

  const agents = agentsQuery.data?.agents ?? [];
  const editingAgent = editingId ? agents.find((agent) => agent.id === editingId) ?? null : null;

  useEffect(() => {
    if (!editorOpen) return;
    if (editingAgent) {
      setDraft(agentToDraft(editingAgent));
      setTab('basic');
    }
  }, [editorOpen, editingId]); // eslint-disable-line react-hooks/exhaustive-deps

  function openCreate() {
    setEditingId(null);
    setDraft(newDraft(agents.length));
    setTab('basic');
    setPreviewText(null);
    setEditorOpen(true);
  }

  function openEdit(agent: Agent) {
    setEditingId(agent.id);
    setDraft(agentToDraft(agent));
    setTab('basic');
    setPreviewText(null);
    setEditorOpen(true);
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const temperature =
        draft.temperature.trim() === '' ? null : Math.min(2, Math.max(0, Number(draft.temperature)));
      if (temperature !== null && !Number.isFinite(temperature)) throw new Error('温度必须是 0-2 之间的数字');
      // 训练型智能体（完整提示词形态，由训练师创建）：只编辑 prompt 与通用配置；
      // 流水线型智能体：编辑四件套，不传 prompt（不改变形态）。
      const isTrained = Boolean(editingAgent?.prompt);
      const payload: AgentInput = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        ...(isTrained
          ? { prompt: draft.prompt }
          : {
              responsibilities: draft.responsibilities,
              deliverable: draft.deliverable,
              guide: draft.guide,
            }),
        model: draft.model.trim() || null,
        temperature,
        tools: {
          builtin: draft.toolsBuiltin,
          custom: draft.toolsCustom,
        } satisfies AgentToolsConfig,
        skillIds: draft.skillIds,
        accent: draft.accent,
      };
      if (!payload.name) throw new Error('请填写智能体名称');
      if (isTrained && !draft.prompt.trim()) throw new Error('请填写完整系统提示词');
      if (!isTrained && !draft.responsibilities.trim()) throw new Error('请填写任务说明');
      if (editingAgent) return api.updateAgent(editingAgent.id, payload);
      return api.createAgent(payload);
    },
    onSuccess: (data) => {
      setEditorOpen(false);
      setEditingId(null);
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      void queryClient.invalidateQueries({ queryKey: ['status'] });
      toast.success(editingAgent ? '智能体已更新' : `智能体「${data.agent.name}」已创建`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteAgent(id),    onSuccess: () => {
      setDeleteTarget(null);
      setEditorOpen(false);
      setEditingId(null);
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      void queryClient.invalidateQueries({ queryKey: ['status'] });
      toast.success('智能体已删除');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const previewMutation = useMutation({
    mutationFn: () => {
      // 训练型智能体预览 prompt 原文 + 最小运行注入；流水线型预览四件套模板组装结果。
      if (editingAgent?.prompt) {
        return api.previewAgentTestPrompt({
          agentId: editingAgent.id,
          name: draft.name.trim() || '（未命名智能体）',
          description: draft.description.trim(),
          prompt: draft.prompt,
          tools: { builtin: draft.toolsBuiltin, custom: draft.toolsCustom },
          skillIds: draft.skillIds,
        });
      }
      return api.previewAgentPrompt({
        name: draft.name.trim() || '（未命名智能体）',
        description: draft.description.trim(),
        responsibilities: draft.responsibilities,
        deliverable: draft.deliverable,
        guide: draft.guide,
        tools: { builtin: draft.toolsBuiltin, custom: draft.toolsCustom },
        skillIds: draft.skillIds,
      });
    },
    onSuccess: (data) => setPreviewText(data.prompt),
    onError: (error: Error) => toast.error(error.message),
  });

  function requestDelete(agent: Agent) {
    setDeleteTarget(agent);
  }

  return (
    <div className="page-stack">
      <div className="page-intro">
        <div>
          <h2>智能体团队</h2>
          <p>每个智能体有独立的岗位说明、工具与技能；把它作为节点连到「流水线」画布上，就能按连线交接。每个环节交付一个文件夹，系统把整个文件夹复制到下游节点的 inbox/。</p>
        </div>
        <button type="button" className="button button--primary" onClick={openCreate}>
          <Plus size={15} />
          新建智能体
        </button>
      </div>

      {agentsQuery.isLoading ? (
        <div className="loading-panel">
          <Spinner size={20} /> 正在加载智能体…
        </div>
      ) : agents.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Bot}
            title="还没有智能体"
            description="先创建几个职责分明的智能体，再把它们编排成一条流水线。"
            action={
              <button type="button" className="button button--primary" onClick={openCreate}>
                <Plus size={15} />
                创建第一个智能体
              </button>
            }
          />
        </div>
      ) : (
        <div className="agent-grid">
          {agents.map((agent) => {
            const busy = statusQuery.data?.status.busyAgents.some((item) => item.agentId === agent.id);
            const isDesigner = agent.slug === DESIGNER_SLUG;
            return (
              <article className="agent-card" key={agent.id}>
                <div className="agent-card-accent" style={{ background: agent.accent }} />
                <div className="agent-card-head">
                  <AgentAvatar name={agent.name} accent={agent.accent} size="md" />
                  <div className="agent-card-title">
                    <h3>{agent.name}</h3>
                    <p>{agent.description || '还没有描述'}</p>
                  </div>
                  <div className="agent-card-actions">
                    <button type="button" className="icon-button" title="编辑" onClick={() => openEdit(agent)}>
                      <Pencil size={15} />
                    </button>
                    {isDesigner ? (
                      <span className="icon-button is-disabled" title="系统内置：流水线设计师不能删除">
                        <Trash2 size={15} />
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="icon-button icon-button--danger"
                        title="删除"
                        onClick={() => requestDelete(agent)}
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                </div>

                <div className="agent-badges">
                  {isDesigner ? <Badge tone="info">系统内置 · 设计师</Badge> : null}
                  {agent.prompt ? <Badge tone="info">训练型</Badge> : null}
                  {busy ? <Badge tone="accent" dot>运行中</Badge> : <Badge tone="success">空闲</Badge>}
                  {agent.model ? <Badge tone="accent">{agent.model}</Badge> : null}
                  <Badge>工具 {agent.tools.builtin.length + agent.tools.custom.length}</Badge>
                  <Badge>技能 {agent.skillIds.length}</Badge>
                </div>

                <button type="button" className="agent-card-open" onClick={() => openEdit(agent)}>
                  编辑配置
                  <ChevronRight size={14} />
                </button>
              </article>
            );
          })}
        </div>
      )}

      <Drawer
        open={editorOpen}
        onClose={() => {
          if (!saveMutation.isPending) setEditorOpen(false);
        }}
        title={editingAgent ? `编辑「${editingAgent.name}」` : '新建智能体'}
        description={
          editingAgent ? '修改会在下一次智能体运行时生效。' : '按步骤完成配置，最后一步可预览拼装后的系统提示词。'
        }
        width={780}
        footer={
          <div className="drawer-footer-row drawer-footer-row--between">
            <div>
              {editingAgent ? (
                <button
                  type="button"
                  className="button button--danger-ghost button--sm"
                  onClick={() => requestDelete(editingAgent)}
                >
                  <Trash2 size={14} />
                  删除智能体
                </button>
              ) : null}
            </div>
            <div className="button-row">
              <button type="button" className="button button--ghost" onClick={() => setEditorOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending || !draft.name.trim()}
              >
                {saveMutation.isPending ? <Spinner size={15} /> : <Save size={15} />}
                {editingAgent ? '保存修改' : '创建智能体'}
              </button>
            </div>
          </div>
        }
      >
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'basic', label: '① 基础' },
            {
              value: 'tools',
              label: '② 工具',
              count: draft.toolsBuiltin.length + draft.toolsCustom.length,
            },
            { value: 'skills', label: '③ 技能', count: draft.skillIds.length },
            { value: 'prompt', label: '④ 系统提示词' },
          ]}
        />

        {tab === 'basic' ? (
          <div className="editor-section">
            <div className="form-grid form-grid--2">
              <Field label="名称" required hint="在任务、流水线和反馈中显示的称呼。">
                <input
                  className="input"
                  value={draft.name}
                  maxLength={40}
                  placeholder="例如：策划师"
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </Field>
              <Field label="一句话描述" hint="帮助你在列表中快速识别角色。">
                <input
                  className="input"
                  value={draft.description}
                  maxLength={300}
                  placeholder="例如：把任务拆解成可执行的计划"
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </Field>
            </div>

            <Field label="角色色" hint="用于头像与阶段卡片的视觉标识。">
              <div className="accent-picker">
                {ACCENTS.map((accent) => (
                  <button
                    type="button"
                    key={accent}
                    className={cn('accent-swatch', draft.accent === accent && 'is-active')}
                    style={{ background: accent }}
                    aria-label={`选择颜色 ${accent}`}
                    onClick={() => setDraft({ ...draft, accent })}
                  >
                    {draft.accent === accent ? <Check size={14} /> : null}
                  </button>
                ))}
              </div>
            </Field>

            <div className="form-grid form-grid--3">
              <Field
                label="模型覆盖"
                hint={
                  settingsQuery.data
                    ? `留空使用全局模型：${settingsQuery.data.settings.llm.model}`
                    : '留空使用全局模型'
                }
              >
                <input
                  className="input"
                  value={draft.model}
                  placeholder="例如 deepseek-chat"
                  onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                />
              </Field>
              <Field label="温度覆盖" hint="0-2，留空继承全局设置。">
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={draft.temperature}
                  placeholder="继承"
                  onChange={(event) => setDraft({ ...draft, temperature: event.target.value })}
                />
              </Field>
            </div>
          </div>
        ) : null}

        {tab === 'prompt' ? (
          <div className="editor-section prompt-fields">
            <div className="prompt-head">
              <div>
                <h3>系统提示词</h3>
                <p>
                  {editingAgent?.prompt
                    ? '这是智能体训练师撰写的完整系统提示词。试运行任务直接使用它；工作区路径、时间、工具与技能清单由系统在运行时附加。'
                    : '这是智能体的「岗位说明书」，由下面的字段拼装而成。名称、流水线位置、技能与工具列表、任务工作区路径由系统按实际配置自动注入，无需手写。'}
                </p>
              </div>
            </div>

            {editingAgent?.prompt ? (
              <Field
                label="完整系统提示词"
                hint="由训练师撰写，可直接修改；这类智能体不参与流水线，只能通过试运行任务使用。"
              >
                <textarea
                  className="textarea textarea--code"
                  value={draft.prompt}
                  rows={22}
                  onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
                />
              </Field>
            ) : (
              <>
                <Field
                  label="任务说明"
                  hint="必填。写清本环节要做哪些事、做到什么程度（验收标准）；系统会把它作为「本环节任务」章节注入提示词。"
                >
                  <textarea
                    className="textarea"
                    value={draft.responsibilities}
                    rows={4}
                    placeholder={'例如：\n把用户的任务拆解为目标、计划与验收标准，产出可直接执行的计划文档。\n1. 通读任务与外部输入，明确目标与范围。\n2. 产出分步执行计划，每步写清输入、产出与完成标准。'}
                    onChange={(event) => setDraft({ ...draft, responsibilities: event.target.value })}
                  />
                </Field>

                <Field
                  label="交付要求"
                  hint="这个岗位需要交付什么、以什么形式（文档 / 表格 / 代码等）。会作为「交付要求」章节自动注入系统提示词；留空则使用默认说明。"
                >
                  <textarea
                    className="textarea"
                    value={draft.deliverable}
                    rows={5}
                    placeholder="例如：一份含来源链接的新闻清单（Markdown 文档），以及全部配图的本地副本；写清交付物的形式与验收要点。"
                    onChange={(event) => setDraft({ ...draft, deliverable: event.target.value })}
                  />
                </Field>

                <Field
                  label="工作指南"
                  hint="这个岗位如何思考与推进工作：方法、边界、遇到问题时的处理方式。交付规则由系统统一约定并写入工作规则，无需在此填写。"
                >
                  <textarea
                    className="textarea"
                    value={draft.guide}
                    rows={10}
                    placeholder="例如：先读 input 目录中的需求文档，再列检查清单……"
                    onChange={(event) => setDraft({ ...draft, guide: event.target.value })}
                  />
                </Field>
              </>
            )}

            <div className="button-row">
              <button
                type="button"
                className="button button--secondary"
                onClick={() => previewMutation.mutate()}
                disabled={previewMutation.isPending}
              >
                {previewMutation.isPending ? <Spinner size={14} /> : <Eye size={14} />}
                预览完整提示词
              </button>
            </div>
          </div>
        ) : null}

        {tab === 'tools' ? (
          <ToolsEditor
            draft={draft}
            setDraft={setDraft}
            builtin={toolsQuery.data?.builtin ?? []}
            customTools={toolsQuery.data?.tools ?? []}
            skillCount={draft.skillIds.length}
          />
        ) : null}

        {tab === 'skills' ? (
          <div className="editor-section">
            <div className="prompt-head">
              <div>
                <h3>启用技能</h3>
                <p>启用的技能只会把名称和描述放进系统提示词；智能体需要时调用 load_skill 读取全文。</p>
              </div>
              <Link className="text-link" to="/skills" onClick={() => setEditorOpen(false)}>
                管理技能库
                <ChevronRight size={14} />
              </Link>
            </div>
            {(skillsQuery.data?.skills.length ?? 0) === 0 ? (
              <EmptyState
                icon={Sparkles}
                title="技能库是空的"
                description="创建 Markdown 技能包后，可以在这里为智能体启用。"
                compact
                action={
                  <Link className="button button--secondary button--sm" to="/skills">
                    去创建技能
                  </Link>
                }
              />
            ) : (
              <div className="check-list">
                {skillsQuery.data!.skills.map((skill) => {
                  const checked = draft.skillIds.includes(skill.id);
                  return (
                    <label className={cn('check-card', checked && 'is-checked')} key={skill.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setDraft({
                            ...draft,
                            skillIds: checked
                              ? draft.skillIds.filter((id) => id !== skill.id)
                              : [...draft.skillIds, skill.id],
                          })
                        }
                      />
                      <div className="check-card-main">
                        <strong>{skill.name}</strong>
                        <p>{skill.description || '（无描述）'}</p>
                      </div>
                      <Badge tone={checked ? 'accent' : 'neutral'}>{skill.content.length} 字符</Badge>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}

      </Drawer>

      <Modal
        open={previewText !== null}
        onClose={() => setPreviewText(null)}
        title="系统提示词预览"
        description="按当前配置拼装后的完整提示词；流水线名称、环节位置与上下游、任务工作区路径与时间会在运行时注入实际值。"
        width={780}
        footer={
          <div className="button-row">
            <button type="button" className="button button--primary" onClick={() => setPreviewText(null)}>
              关闭
            </button>
          </div>
        }
      >
        <Markdown className="prompt-preview-markdown">{previewText ?? ''}</Markdown>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除这个智能体？"
        description={
          <>
            将删除智能体「{deleteTarget?.name}」的配置与独立工作目录。它提交过的反馈会保留。
          </>
        }
        confirmLabel="删除智能体"
        busy={deleteMutation.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
      />
    </div>
  );
}

function ToolsEditor({
  draft,
  setDraft,
  builtin,
  customTools,
  skillCount,
}: {
  draft: Draft;
  setDraft: (draft: Draft) => void;
  builtin: BuiltinToolInfo[];
  customTools: { id: string; name: string; description: string }[];
  skillCount: number;
}) {
  const groups: { key: BuiltinToolInfo['category']; label: string; description: string }[] = [
    { key: 'file', label: '文件', description: '读写、搜索与浏览工作目录' },
    { key: 'shell', label: '命令', description: '在本机执行 Shell 命令' },
    { key: 'collaboration', label: '协作', description: '反馈与技能加载' },
  ];
  const toggleCustom = (id: string) => {
    const checked = draft.toolsCustom.includes(id);
    setDraft({
      ...draft,
      toolsCustom: checked ? draft.toolsCustom.filter((item) => item !== id) : [...draft.toolsCustom, id],
    });
  };

  return (
    <div className="editor-section">
      <div className="prompt-head">
        <div>
          <h3>工具权限</h3>
          <p>内置工具由系统统一授予所有智能体，无需按环节勾选；自定义工具按需授权。</p>
        </div>
        <Link className="text-link" to="/tools">
          管理自定义工具
          <ChevronRight size={14} />
        </Link>
      </div>

      <div className="system-tool-row">
        <div className="system-tool-icon">
          <Check size={14} />
        </div>
        <div>
          <strong>handoff · 交接</strong>
          <p>系统必备工具：用 folder 交出你的交付文件夹（一个目录，含子目录整体打包交接）；有多个交接对象时还要用 target 指明交给谁。系统会把文件夹复制到下游智能体的工作区并按连线上的触发提示词启动它；终点节点的交付文件夹复制到 final\ 交给你验收。</p>
        </div>
        <Badge tone="accent">系统</Badge>
      </div>

      {groups.map((group) => {
        const tools = builtin.filter((tool) => tool.category === group.key && tool.name !== 'handoff');
        if (tools.length === 0) return null;
        return (
          <div className="tool-group" key={group.key}>
            <div className="tool-group-head">
              <strong>{group.label}</strong>
              <span>{group.description}</span>
            </div>
            <div className="check-list">
              {tools.map((tool) => {
                const needsSkill = tool.conditional === 'skills';
                const unavailable = needsSkill && skillCount === 0;
                return (
                  <div className={cn('check-card', 'is-checked', unavailable && 'is-muted')} key={tool.name}>
                    <div className="check-card-main">
                      <strong>
                        {tool.label}
                        <code>{tool.name}</code>
                      </strong>
                      <p>{tool.description}</p>
                      {unavailable ? (
                        <span className="check-hint">为智能体配置技能后可用（load_skill 只在启用技能时出现）</span>
                      ) : null}
                    </div>
                    <Badge tone="success">统一授予</Badge>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="tool-group">
        <div className="tool-group-head">
          <strong>自定义工具</strong>
          <span>在工具库中用 JavaScript 编写</span>
        </div>
        {customTools.length === 0 ? (
          <div className="callout callout--info">
            还没有自定义工具。前往
            <Link className="inline-link" to="/tools">
              工具库
            </Link>
            创建后即可在这里授权。
          </div>
        ) : (
          <div className="check-list">
            {customTools.map((tool) => {
              const checked = draft.toolsCustom.includes(tool.id);
              return (
                <label className={cn('check-card', checked && 'is-checked')} key={tool.id}>
                  <input type="checkbox" checked={checked} onChange={() => toggleCustom(tool.id)} />
                  <div className="check-card-main">
                    <strong>
                      {tool.name}
                      <Wrench size={12} />
                    </strong>
                    <p>{tool.description}</p>
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
