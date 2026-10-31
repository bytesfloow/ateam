import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Braces,
  ChevronRight,
  Code2,
  Info,
  Lock,
  Pencil,
  Plus,
  Save,
  Sparkles,
  TerminalSquare,
  Trash2,
  Users,
  Wrench,
} from 'lucide-react';
import type { BuiltinToolInfo, CustomTool, JsonSchema } from '@shared/types';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CopyButton } from '../components/CopyButton';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { Field } from '../components/Field';
import { Spinner } from '../components/Spinner';
import { formatDateTime, truncate } from '../lib/format';
import { useToast } from '../lib/toast';

const DEFAULT_SCHEMA = `{
  "type": "object",
  "properties": {
    "text": {
      "type": "string",
      "description": "输入文本"
    }
  },
  "required": ["text"],
  "additionalProperties": false
}`;

const CODE_TEMPLATE = `async (args, ctx) => {
  // ctx.workdir  当前智能体在本任务中的工作目录
  // ctx.require  加载 Node.js 模块，例如 ctx.require('node:fs')
  // ctx.fetch    发起网络请求
  return \`收到参数：\${JSON.stringify(args)}\`;
}`;

interface ToolDraft {
  name: string;
  description: string;
  parametersText: string;
  code: string;
}

const EMPTY_DRAFT: ToolDraft = {
  name: '',
  description: '',
  parametersText: DEFAULT_SCHEMA,
  code: CODE_TEMPLATE,
};

const CATEGORY_LABELS: Record<BuiltinToolInfo['category'], string> = {
  file: '文件',
  shell: '命令',
  web: '联网',
  collaboration: '协作',
};

interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
}

function schemaRows(schema: JsonSchema) {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchemaProperty>;
  const required = (schema.required ?? []) as string[];
  return Object.entries(properties).map(([name, prop]) => ({
    name,
    type: Array.isArray(prop.enum) ? prop.enum.map(String).join(' | ') : prop.type ?? 'any',
    required: required.includes(name),
    description: prop.description ?? '',
  }));
}

export function ToolsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ToolDraft>(EMPTY_DRAFT);
  const [deleteTarget, setDeleteTarget] = useState<CustomTool | null>(null);
  const [detailTool, setDetailTool] = useState<BuiltinToolInfo | null>(null);

  const toolsQuery = useQuery({ queryKey: ['tools'], queryFn: api.listTools });

  const tools = toolsQuery.data?.tools ?? [];
  const builtin = toolsQuery.data?.builtin ?? [];
  const usage = toolsQuery.data?.usage ?? {};
  const editing = editingId ? tools.find((tool) => tool.id === editingId) ?? null : null;
  const detailUsage = detailTool ? usage[detailTool.name] ?? [] : [];
  const detailRows = detailTool ? schemaRows(detailTool.parameters) : [];
  const detailSchemaText = detailTool ? JSON.stringify(detailTool.parameters, null, 2) : '';

  const builtinGroups = useMemo(() => {
    const groups = new Map<BuiltinToolInfo['category'], BuiltinToolInfo[]>();
    for (const tool of builtin) {
      const list = groups.get(tool.category) ?? [];
      list.push(tool);
      groups.set(tool.category, list);
    }
    return [...groups.entries()];
  }, [builtin]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const name = draft.name.trim();
      if (!/^[a-z][a-z0-9_]{1,40}$/.test(name)) {
        throw new Error('工具名称需以小写字母开头，只能包含小写字母、数字和下划线，长度 2-41');
      }
      if (!draft.description.trim()) throw new Error('请填写工具描述');
      let parameters: Record<string, unknown>;
      try {
        const parsed = JSON.parse(draft.parametersText) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('必须是 JSON 对象');
        }
        parameters = parsed as Record<string, unknown>;
      } catch (error) {
        throw new Error(`参数 Schema 不是合法 JSON：${(error as Error).message}`);
      }
      if (parameters.type !== 'object') throw new Error('参数 Schema 的 type 必须为 "object"');
      try {
        const factory = new Function(`"use strict"; return (${draft.code});`)();
        if (typeof factory !== 'function') throw new Error('必须是函数');
      } catch (error) {
        throw new Error(`工具代码无法编译：${(error as Error).message}`);
      }
      const payload = {
        name,
        description: draft.description.trim(),
        parameters,
        code: draft.code,
      };
      if (editing) return api.updateTool(editing.id, payload);
      return api.createTool(payload);
    },
    onSuccess: (data) => {
      setOpen(false);
      setEditingId(null);
      void queryClient.invalidateQueries({ queryKey: ['tools'] });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      toast.success(editing ? '工具已更新' : `工具「${data.tool.name}」已创建`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteTool(id),
    onSuccess: () => {
      setDeleteTarget(null);
      setOpen(false);
      setEditingId(null);
      void queryClient.invalidateQueries({ queryKey: ['tools'] });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      toast.success('工具已删除');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function openCreate() {
    setEditingId(null);
    setDraft({ ...EMPTY_DRAFT });
    setOpen(true);
  }

  function openEdit(tool: CustomTool) {
    setEditingId(tool.id);
    setDraft({
      name: tool.name,
      description: tool.description,
      parametersText: JSON.stringify(tool.parameters, null, 2),
      code: tool.code,
    });
    setOpen(true);
  }

  function requestDelete(tool: CustomTool) {
    const used = usage[tool.id] ?? [];
    if (used.length > 0) {
      toast.error(`该工具仍被 ${used.map((agent) => agent.name).join('、')} 使用，请先在智能体中取消勾选`);
      return;
    }
    setDeleteTarget(tool);
  }

  return (
    <div className="page-stack">
      <div className="page-intro">
        <div>
          <h2>工具库</h2>
          <p>内置工具开箱即用；自定义工具用 JavaScript 编写，在智能体本任务的工作目录中执行。</p>
        </div>
        <button type="button" className="button button--primary" onClick={openCreate}>
          <Plus size={15} />
          新建自定义工具
        </button>
      </div>

      <section className="card">
        <div className="section-head">
          <div>
            <h3>自定义工具</h3>
            <p>工具定义保存在 SQLite 中，按智能体授权后暴露给模型。</p>
          </div>
          <Badge tone="neutral">{tools.length} 个</Badge>
        </div>

        {toolsQuery.isLoading ? (
          <div className="loading-inline">
            <Spinner size={16} /> 加载中…
          </div>
        ) : tools.length === 0 ? (
          <EmptyState
            icon={Code2}
            title="还没有自定义工具"
            description="当内置工具不够用时，可以写一个小函数：调用本地命令、处理文件、访问内部 API 等。"
            compact
            action={
              <button type="button" className="button button--secondary button--sm" onClick={openCreate}>
                <Plus size={14} />
                创建第一个工具
              </button>
            }
          />
        ) : (
          <div className="tool-grid">
            {tools.map((tool) => {
              const used = usage[tool.id] ?? [];
              return (
                <article className="tool-card" key={tool.id}>
                  <div className="tool-card-head">
                    <span className="tool-icon">
                      <Wrench size={17} />
                    </span>
                    <div className="tool-card-title">
                      <h3>{tool.name}</h3>
                      <p>{tool.description}</p>
                    </div>
                    <div className="tool-card-actions">
                      <button type="button" className="icon-button" title="编辑" onClick={() => openEdit(tool)}>
                        <Pencil size={15} />
                      </button>
                      <button
                        type="button"
                        className="icon-button icon-button--danger"
                        title={used.length > 0 ? '仍被智能体使用' : '删除'}
                        onClick={() => requestDelete(tool)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                  <pre className="code-snippet">{truncate(tool.code, 220)}</pre>
                  <div className="tool-card-foot">
                    <Badge tone={used.length > 0 ? 'success' : 'neutral'}>
                      {used.length > 0 ? `${used.length} 个智能体使用` : '未使用'}
                    </Badge>
                    <span className="muted">{formatDateTime(tool.updatedAt)} 更新</span>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="card">
        <div className="section-head">
          <div>
            <h3>内置工具</h3>
            <p>这些工具由系统实现，无需编写代码。点击工具可查看参数详情；智能体可在「工具」页签中按需启用。</p>
          </div>
          <Badge tone="accent">{builtin.length} 个</Badge>
        </div>
        <div className="builtin-groups">
          {builtinGroups.map(([category, items]) => (
            <div className="builtin-group" key={category}>
              <div className="builtin-group-head">
                <span>{CATEGORY_LABELS[category]}</span>
                <span className="muted">{items.length}</span>
              </div>
              {items.map((tool) => (
                <button
                  type="button"
                  className="builtin-row"
                  key={tool.name}
                  onClick={() => setDetailTool(tool)}
                  title={`查看「${tool.label}」详情`}
                >
                  <span className="builtin-icon">
                    {category === 'file' ? <Braces size={15} /> : category === 'shell' ? <TerminalSquare size={15} /> : <Sparkles size={15} />}
                  </span>
                  <div>
                    <strong>
                      {tool.label}
                      <code>{tool.name}</code>
                    </strong>
                    <p>{tool.description}</p>
                  </div>
                  {tool.name === 'complete_stage' ? <Badge tone="accent">系统必备</Badge> : null}
                  <ChevronRight size={15} className="builtin-row-open" />
                </button>
              ))}
            </div>
          ))}
        </div>
      </section>

      <Drawer
        open={open}
        onClose={() => {
          if (!saveMutation.isPending) setOpen(false);
        }}
        title={editing ? `编辑工具「${editing.name}」` : '新建自定义工具'}
        description="工具代码在本机 Node.js 进程中执行，没有沙箱隔离，请只运行你信任的代码。"
        width={900}
        footer={
          <div className="drawer-footer-row drawer-footer-row--between">
            <div>
              {editing ? (
                <button
                  type="button"
                  className="button button--danger-ghost button--sm"
                  onClick={() => requestDelete(editing)}
                >
                  <Trash2 size={14} />
                  删除工具
                </button>
              ) : null}
            </div>
            <div className="button-row">
              <button type="button" className="button button--ghost" onClick={() => setOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending || !draft.name.trim()}
              >
                {saveMutation.isPending ? <Spinner size={15} /> : <Save size={15} />}
                {editing ? '保存修改' : '创建工具'}
              </button>
            </div>
          </div>
        }
      >
        <div className="editor-section">
          <div className="form-grid form-grid--2">
            <Field
              label="工具名称"
              required
              hint="模型看到的名字。小写字母开头，可含数字与下划线，例如 fetch_ticket。"
            >
              <input
                className="input"
                value={draft.name}
                maxLength={41}
                placeholder="fetch_ticket"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </Field>
            <Field label="工具描述" required hint="模型据此判断何时调用，写清能力、输入与返回。">
              <input
                className="input"
                value={draft.description}
                maxLength={500}
                placeholder="根据工单号获取工单详情"
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </Field>
          </div>

          <div className="code-section">
            <div className="code-section-head">
              <div>
                <strong>参数 Schema</strong>
                <span>JSON Schema，用于约束模型传入的参数。</span>
              </div>
              <button
                type="button"
                className="button button--ghost button--sm"
                onClick={() => setDraft({ ...draft, parametersText: DEFAULT_SCHEMA })}
              >
                使用示例
              </button>
            </div>
            <textarea
              className="textarea code-editor"
              rows={12}
              spellCheck={false}
              value={draft.parametersText}
              onChange={(event) => setDraft({ ...draft, parametersText: event.target.value })}
            />
          </div>

          <div className="code-section">
            <div className="code-section-head">
              <div>
                <strong>工具实现</strong>
                <span>一个 async 函数，返回字符串或可 JSON 序列化的值。</span>
              </div>
              <CopyButton value={CODE_TEMPLATE} label="复制模板" />
            </div>
            <textarea
              className="textarea code-editor code-editor--tall"
              rows={18}
              spellCheck={false}
              value={draft.code}
              onChange={(event) => setDraft({ ...draft, code: event.target.value })}
            />
          </div>

          <div className="docs-grid">
            <div className="docs-card">
              <h4>
                <Code2 size={15} />
                上下文 ctx
              </h4>
              <ul>
                <li>
                  <code>ctx.workdir</code> 当前智能体在本任务中的工作目录绝对路径
                </li>
                <li>
                  <code>ctx.agent</code> {'{ id, name }'}
                </li>
                <li>
                  <code>ctx.taskId</code> / <code>ctx.turnId</code> / <code>ctx.turnSeq</code> 当前任务、回合与第几个环节
                </li>
                <li>
                  <code>ctx.signal</code> 终止信号，可用于中断长时间操作
                </li>
                <li>
                  <code>ctx.require</code> 加载 Node.js 模块
                </li>
                <li>
                  <code>ctx.fetch</code> 发起 HTTP 请求
                </li>
              </ul>
            </div>
            <div className="docs-card docs-card--warning">
              <h4>
                <Lock size={15} />
                执行说明
              </h4>
              <ul>
                <li>代码在本机服务进程中执行，没有沙箱隔离。</li>
                <li>工具超时按「设置 → 运行参数」执行，默认 600 秒（10 分钟），超时后会被标记失败。</li>
                <li>返回值超过输出上限会被截断。</li>
                <li>参数会在调用前按 JSON Schema 校验。</li>
              </ul>
            </div>
          </div>
        </div>
      </Drawer>

      <Drawer
        open={Boolean(detailTool)}
        onClose={() => setDetailTool(null)}
        title={
          detailTool ? (
            <span className="drawer-title">
              {detailTool.label}
              <code>{detailTool.name}</code>
            </span>
          ) : (
            '工具详情'
          )
        }
        description={detailTool?.description}
        width={680}
        footer={
          <div className="drawer-footer-row">
            <button type="button" className="button button--secondary" onClick={() => setDetailTool(null)}>
              关闭
            </button>
          </div>
        }
      >
        {detailTool ? (
          <div className="editor-section">
            <div className="builtin-detail-meta">
              <Badge tone="neutral">{CATEGORY_LABELS[detailTool.category]}</Badge>
              {detailTool.conditional === 'skills' ? <Badge tone="warning">需启用技能后可用</Badge> : null}
              {detailUsage.length > 0 ? (
                <Badge tone="success">{detailUsage.length} 个智能体启用</Badge>
              ) : (
                <Badge tone="neutral">暂无智能体启用</Badge>
              )}
            </div>

            <div className="code-section">
              <div className="code-section-head">
                <div>
                  <strong>参数说明</strong>
                  <span>调用该工具时传入的参数。</span>
                </div>
              </div>
              {detailRows.length === 0 ? (
                <p className="muted builtin-detail-empty">该工具没有参数。</p>
              ) : (
                <div className="param-table">
                  <div className="param-table-head">
                    <span>参数</span>
                    <span>类型</span>
                    <span>必填</span>
                    <span>说明</span>
                  </div>
                  {detailRows.map((row) => (
                    <div className="param-row" key={row.name}>
                      <code>{row.name}</code>
                      <span className="mono">{row.type}</span>
                      <span>{row.required ? <Badge tone="danger">必填</Badge> : <Badge tone="neutral">可选</Badge>}</span>
                      <span>{row.description}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="code-section">
              <div className="code-section-head">
                <div>
                  <strong>参数 Schema</strong>
                  <span>实际暴露给模型的 JSON Schema。</span>
                </div>
                <CopyButton value={detailSchemaText} label="复制" />
              </div>
              <pre className="code-snippet builtin-schema">{detailSchemaText}</pre>
            </div>

            <div className="docs-grid">
              <div className="docs-card">
                <h4>
                  <Info size={15} />
                  使用说明
                </h4>
                <ul>
                  <li>在智能体编辑器的「工具」页签中勾选后，该工具才会暴露给模型。</li>
                  {detailTool.conditional === 'skills' ? <li>仅当智能体至少启用一个技能时可用。</li> : null}
                  <li>参数在调用前按 JSON Schema 校验；工具超时默认 600 秒。</li>
                  <li>返回内容超过输出上限时会被截断。</li>
                </ul>
              </div>
              <div className="docs-card">
                <h4>
                  <Users size={15} />
                  启用的智能体
                </h4>
                {detailUsage.length === 0 ? (
                  <ul>
                    <li>还没有智能体启用该工具。</li>
                  </ul>
                ) : (
                  <div className="button-row">
                    {detailUsage.map((agent) => (
                      <Badge key={agent.id} tone="accent">
                        {agent.name}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除这个工具？"
        description={
          <>
            将删除工具「{deleteTarget?.name}」。如果它仍被智能体使用，系统会阻止删除。
          </>
        }
        confirmLabel="删除工具"
        busy={deleteMutation.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
      />
    </div>
  );
}
