import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Bot,
  Brain,
  CircleAlert,
  DraftingCompass,
  Eraser,
  FileCheck2,
  FileText,
  FolderOpen,
  FoldVertical,
  Gauge,
  Info,
  Paperclip,
  Send,
  Square,
  Wrench,
  X,
} from 'lucide-react';
import type {
  DesignerAttachment,
  DesignerChangeOp,
  DesignerMessage,
  DesignerProfile,
  DesignerProposal,
  DesignerProposalStatus,
  DesignerToolInfo,
  Skill,
  TokenUsage,
  ToolCallView,
} from '@shared/types';
import { DESIGNER_MAX_ATTACHMENTS, DESIGNER_UPLOAD_MAX_BYTES } from '@shared/types';
import { api } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DesignerWorkspaceDrawer } from '../components/DesignerWorkspaceDrawer';
import { EmptyState } from '../components/EmptyState';
import { Markdown } from '../components/Markdown';
import { Badge } from '../components/Badge';
import { Drawer } from '../components/Drawer';
import { Modal } from '../components/Modal';
import { Spinner } from '../components/Spinner';
import { Tabs } from '../components/Tabs';
import { CopyButton } from '../components/CopyButton';
import { useDesignerStream, useDesignerStatus } from '../lib/designerStream';
import { cn, formatBytes, formatDateTime, type Tone } from '../lib/format';
import { useToast } from '../lib/toast';

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

/** token 数紧凑展示：980 / 12.3k / 1.00M。 */
function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/** 上下文占用百分比：小于 10% 保留一位小数，其余取整。 */
function formatContextPercent(used: number, total: number): string {
  if (total <= 0) return '—';
  const ratio = (used / total) * 100;
  return `${ratio.toFixed(ratio >= 10 ? 0 : 1)}%`;
}

/* ------------------------------------------------------------------ */
/* 变更卡片（对话式变更的执行留档，无需用户操作）                          */
/* ------------------------------------------------------------------ */

const PROPOSAL_STATUS_META: Record<DesignerProposalStatus, { label: string; tone: 'warning' | 'success' | 'neutral' | 'danger' }> = {
  // pending / rejected 是旧版「提案 + 界面确认」流程的遗留状态，只读展示。
  pending: { label: '旧版待确认', tone: 'neutral' },
  applied: { label: '已生效', tone: 'success' },
  rejected: { label: '旧版已驳回', tone: 'neutral' },
  failed: { label: '执行中断', tone: 'danger' },
};

function changeSummary(change: DesignerChangeOp): { kind: string; title: string; detail?: string } {
  switch (change.op) {
    case 'create_agent':
      return { kind: '新建智能体', title: change.agent.name ?? '', detail: change.agent.description };
    case 'update_agent':
      return { kind: '修改智能体', title: change.agentName ?? change.agentId ?? '', detail: change.agent.description };
    case 'delete_agent':
      return { kind: '删除智能体', title: change.agentName ?? change.agentId ?? '' };
    case 'create_pipeline':
      return {
        kind: '新建流水线',
        title: change.pipeline.name ?? '',
        detail: `${change.pipeline.nodes?.length ?? 0} 个节点 · ${change.pipeline.edges?.length ?? 0} 条连线`,
      };
    case 'update_pipeline':
      return {
        kind: '重建流水线（整图替换）',
        title: change.pipelineName ?? change.pipelineId ?? '',
        detail: `${change.pipeline.nodes?.length ?? 0} 个节点 · ${change.pipeline.edges?.length ?? 0} 条连线`,
      };
    case 'delete_pipeline':
      return { kind: '删除流水线', title: change.pipelineName ?? change.pipelineId ?? '' };
    case 'create_tool':
      return { kind: '新建工具', title: change.tool.name ?? '', detail: change.tool.description };
    case 'update_tool':
      return { kind: '修改工具', title: change.toolName ?? change.toolId ?? '', detail: change.tool.description };
    case 'delete_tool':
      return { kind: '删除工具', title: change.toolName ?? change.toolId ?? '' };
    case 'create_skill':
      return { kind: '新建技能', title: change.skill.name ?? '', detail: change.skill.description };
    case 'update_skill':
      return { kind: '修改技能', title: change.skillName ?? change.skillId ?? '', detail: change.skill.description };
    case 'delete_skill':
      return { kind: '删除技能', title: change.skillName ?? change.skillId ?? '' };
  }
}

function ProposalCard({ proposal }: { proposal: DesignerProposal }) {
  const meta = PROPOSAL_STATUS_META[proposal.status];
  return (
    <div className={cn('proposal-card', `proposal-card--${proposal.status}`)}>
      <div className="proposal-head">
        <FileCheck2 size={16} />
        <strong>{proposal.title}</strong>
        <Badge tone={meta.tone} dot={proposal.status === 'failed'}>
          {meta.label}
        </Badge>
      </div>
      {proposal.summary ? <p className="proposal-summary">{proposal.summary}</p> : null}
      <ol className="proposal-changes">
        {proposal.changes.map((change, index) => {
          const summary = changeSummary(change);
          return (
            <li key={index}>
              <div className="proposal-change-line">
                <span className="proposal-change-kind">{summary.kind}</span>
                <strong>{summary.title || '（未命名）'}</strong>
                {summary.detail ? <span className="proposal-change-detail">{summary.detail}</span> : null}
              </div>
              <details className="proposal-change-raw">
                <summary>查看完整内容</summary>
                <pre>{JSON.stringify(change, null, 2)}</pre>
              </details>
            </li>
          );
        })}
      </ol>
      {proposal.status === 'failed' && proposal.error ? (
        <div className="proposal-error">
          <CircleAlert size={14} />
          {proposal.error}
        </div>
      ) : null}
      <div className="proposal-foot">
        <span className="muted">{formatDateTime(proposal.createdAt)}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 附件                                                                */
/* ------------------------------------------------------------------ */

/** 待发送的附件：上传中 path 为空，完成后携带服务端返回的存储路径。 */
interface PendingAttachment {
  key: string;
  name: string;
  path: string;
  size: number;
  image: boolean;
  uploading: boolean;
}

function AttachmentThumb({
  sessionId,
  attachment,
}: {
  sessionId: string | null;
  attachment: { path: string; image: boolean; name: string };
}) {
  if (attachment.image && attachment.path && sessionId) {
    return (
      <span className="attach-thumb">
        <img src={api.designerUploadUrl(sessionId, attachment.path)} alt={attachment.name} loading="lazy" />
      </span>
    );
  }
  return (
    <span className="attach-thumb">
      <FileText size={15} />
    </span>
  );
}

/** 消息气泡里的附件（点击图片预览、点击其他文件下载）。 */
function SentAttachment({
  sessionId,
  attachment,
  onPreview,
}: {
  sessionId: string;
  attachment: DesignerAttachment;
  onPreview: (image: { url: string; name: string }) => void;
}) {
  return (
    <button
      type="button"
      className="attach-chip attach-chip--sent"
      title={attachment.image ? '点击预览图片' : '点击下载文件'}
      onClick={() =>
        attachment.image
          ? onPreview({ url: api.designerUploadUrl(sessionId, attachment.path), name: attachment.name })
          : window.open(api.designerUploadUrl(sessionId, attachment.path, true), '_blank')
      }
    >
      <AttachmentThumb sessionId={sessionId} attachment={attachment} />
      <span className="attach-meta">
        <span className="attach-name">{attachment.name}</span>
        <span className="attach-size">{formatBytes(attachment.size)}</span>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 工具调用摘要                                                        */
/* ------------------------------------------------------------------ */

/** 摘要优先提取的字段：按常见工具的参数命名习惯排序，命中即用。 */
const TOOL_ARG_FIELDS = [
  'file_path',
  'path',
  'folder',
  'url',
  'query',
  'q',
  'pattern',
  'command',
  'title',
  'name',
  'skillName',
  'agentName',
  'pipelineName',
  'toolName',
  'id',
  'target',
  'status',
];

/** 把一次工具调用的参数压成一行摘要（如 read 显示目标文件、apply_changes 显示变更标题）。 */
function toolCallSummary(call: ToolCallView): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(call.arguments || '{}') as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    /* 参数不是合法 JSON 时跳过字段提取，直接用原文截断 */
    return call.arguments.length > 80 ? `${call.arguments.slice(0, 80)}…` : call.arguments;
  }
  const parts: string[] = [];
  const push = (value: unknown): boolean => {
    if (typeof value === 'string' && value.trim()) {
      parts.push(value.trim().replace(/\s+/g, ' '));
      return true;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(String(value));
      return true;
    }
    return false;
  };
  for (const field of TOOL_ARG_FIELDS) {
    if (parts.length >= 2) break;
    push(args[field]);
  }
  if (parts.length === 0) {
    for (const value of Object.values(args)) {
      if (push(value)) break;
    }
  }
  const summary = parts.join(' · ');
  return summary.length > 80 ? `${summary.slice(0, 80)}…` : summary;
}

/** 思考内容折叠块：默认收起只显示一行预览，展开看全文。 */
function ReasoningBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const preview = text.replace(/\s+/g, ' ').trim();
  return (
    <details className={cn('dmsg-reasoning', streaming && 'dmsg-reasoning--streaming')}>
      <summary title={preview}>
        <Brain size={12} />
        <span className="dmsg-reasoning-label">思考</span>
        <span className="dmsg-reasoning-preview">{preview || '…'}</span>
      </summary>
      <div className="dmsg-reasoning-body">{text}</div>
    </details>
  );
}

/* ------------------------------------------------------------------ */
/* 消息                                                                */
/* ------------------------------------------------------------------ */

function MessageItem({
  message,
  call,
  proposals,
  onPreview,
}: {
  message: DesignerMessage;
  /** 工具结果对应的调用（按 toolCallId 关联），用于展示调用参数。 */
  call?: ToolCallView;
  proposals: DesignerProposal[];
  onPreview: (image: { url: string; name: string }) => void;
}) {
  if (message.role === 'user') {
    const attachments = message.meta.attachments ?? [];
    return (
      <div className="dmsg dmsg--user">
        <div className="dmsg-user-col">
          {attachments.length > 0 ? (
            <div className="dmsg-attachments">
              {attachments.map((attachment) => (
                <SentAttachment
                  key={attachment.path}
                  sessionId={message.sessionId}
                  attachment={attachment}
                  onPreview={onPreview}
                />
              ))}
            </div>
          ) : null}
          {message.content ? <div className="dmsg-bubble">{message.content}</div> : null}
        </div>
      </div>
    );
  }
  if (message.role === 'tool') {
    const summary = call ? toolCallSummary(call) : '';
    return (
      <details className={cn('dmsg-tool', message.meta.toolStatus === 'error' && 'dmsg-tool--error')}>
        <summary title={call?.arguments}>
          <Wrench size={13} />
          工具 {message.name}
          {summary ? <span className="dmsg-call-args">{summary}</span> : null}
          {message.meta.toolStatus === 'error' ? ' · 出错' : ''}
        </summary>
        {call ? <pre className="dmsg-tool-args">{call.arguments}</pre> : null}
        <pre>{message.content}</pre>
      </details>
    );
  }
  return (
    <div className="dmsg dmsg--assistant">
      <div className="dmsg-avatar" aria-hidden="true">
        <DraftingCompass size={16} />
      </div>
      <div className="dmsg-body">
        {message.meta.reasoning ? <ReasoningBlock text={message.meta.reasoning} /> : null}
        {message.content ? (
          <div className={cn('dmsg-text', message.meta.error && 'dmsg-text--error')}>
            <Markdown>{message.content}</Markdown>
          </div>
        ) : null}
        {message.toolCalls.length > 0 ? (
          <div className="dmsg-calls">
            {message.toolCalls.map((item) => {
              const summary = toolCallSummary(item);
              return (
                <span key={item.id} className="dmsg-call" title={item.arguments}>
                  <Wrench size={12} />
                  {item.name}
                  {summary ? <span className="dmsg-call-args">{summary}</span> : null}
                </span>
              );
            })}
          </div>
        ) : null}
        {proposals.map((proposal) => (
          <ProposalCard key={proposal.id} proposal={proposal} />
        ))}
      </div>
    </div>
  );
}

/** 生成中的流式气泡：内容随 designer.delta 整段刷新，落库消息到达后由真实消息取代。 */
function StreamingMessage({ text, reasoning }: { text: string; reasoning: string }) {
  return (
    <div className="dmsg dmsg--assistant">
      <div className="dmsg-avatar" aria-hidden="true">
        <DraftingCompass size={16} />
      </div>
      <div className="dmsg-body">
        {reasoning ? <ReasoningBlock text={reasoning} streaming /> : null}
        <div className="dmsg-text dmsg-text--streaming">
          <Markdown>{text}</Markdown>
          <span className="stream-cursor" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

/**
 * 等待气泡：消息发出后、首个流式内容到达前的设计师消息框，内含打字点 loading 动画。
 * 文本取服务端实时推送的轮次状态（「正在思考」「第 N 轮思考中」「调用工具 xxx」），
 * 流式内容或落库消息到达后由 StreamingMessage / 真实消息取代。
 */
function ThinkingBubble({ detail }: { detail: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setElapsed((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="dmsg dmsg--assistant">
      <div className="dmsg-avatar dmsg-avatar--thinking" aria-hidden="true">
        <DraftingCompass size={16} />
      </div>
      <div className="dmsg-body">
        <div className="dmsg-text dmsg-thinking">
          <span className="typing-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="dmsg-thinking-text">{detail}</span>
          {elapsed > 0 ? <span className="dmsg-thinking-elapsed">已等待 {elapsed}s</span> : null}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 设计师详情抽屉                                                      */
/* ------------------------------------------------------------------ */

const TOOL_SOURCE_META: Record<DesignerToolInfo['source'], { label: string; tone: Tone }> = {
  builtin: { label: '内置', tone: 'info' },
  custom: { label: '自定义', tone: 'warning' },
  designer: { label: '设计师专属', tone: 'accent' },
};

function PromptView({ text }: { text: string }) {
  return (
    <div className="turn-input-view">
      <div className="turn-prompt-toolbar">
        <span>实际下发给模型的完整系统提示词 · {text.length.toLocaleString()} 字符（系统清单实时注入）</span>
        <CopyButton value={text} label="复制提示词" />
      </div>
      <pre>{text}</pre>
    </div>
  );
}

function ToolsView({ tools }: { tools: DesignerToolInfo[] }) {
  return (
    <div className="designer-tool-list">
      {tools.map((tool) => (
        <div key={`${tool.source}-${tool.name}`} className="designer-tool-row">
          <div className="designer-tool-head">
            <Wrench size={13} />
            <code>{tool.name}</code>
            {tool.label ? <span className="designer-tool-label">{tool.label}</span> : null}
            <Badge tone={TOOL_SOURCE_META[tool.source].tone}>{TOOL_SOURCE_META[tool.source].label}</Badge>
          </div>
          <p className="designer-tool-desc">{tool.description}</p>
        </div>
      ))}
    </div>
  );
}

function SkillsView({ skills }: { skills: Skill[] }) {
  if (skills.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="未启用技能"
        description="设计师档案没有勾选任何技能包；如需为它扩充能力，可在「智能体」页编辑它的技能配置。"
        compact
      />
    );
  }
  return (
    <div className="designer-skill-list">
      {skills.map((skill) => (
        <div key={skill.id} className="designer-skill-card">
          <div className="designer-skill-head">
            <strong>{skill.name}</strong>
            <span className="muted">{skill.files.length > 0 ? `${skill.files.length} 个文件` : '仅 SKILL.md'}</span>
          </div>
          <p className="designer-tool-desc">{skill.description || '（无描述）'}</p>
        </div>
      ))}
    </div>
  );
}

function DesignerProfileDrawer({
  open,
  onClose,
  profile,
  isLoading,
}: {
  open: boolean;
  onClose: () => void;
  profile: DesignerProfile | null;
  isLoading: boolean;
}) {
  const [tab, setTab] = useState<'prompt' | 'tools' | 'skills'>('prompt');
  useEffect(() => {
    if (open) setTab('prompt');
  }, [open]);
  const runtime = profile?.runtime;
  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={880}
      title={
        <span className="drawer-title">
          <DraftingCompass size={16} />
          流水线设计师 · 详情
        </span>
      }
      description={
        runtime
          ? `以下内容实时生成，与模型每次请求实际收到的一致 · 模型 ${runtime.model} · 思考${
              runtime.deepThinking ? ` ${runtime.thinkingLevel}` : ' 关闭'
            }`
          : undefined
      }
      footer={
        <div className="drawer-footer-row">
          <Link className="button button--secondary" to="/agents">
            去智能体页编辑
          </Link>
          <button type="button" className="button button--ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      }
    >
      {isLoading || !profile ? (
        <div className="loading-panel">
          <Spinner size={20} />
          正在加载设计师详情…
        </div>
      ) : (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'prompt', label: '系统提示词' },
              { value: 'tools', label: '工具', count: profile.tools.length },
              { value: 'skills', label: '技能', count: profile.skills.length },
            ]}
          />
          {tab === 'prompt' ? <PromptView text={profile.systemPrompt} /> : null}
          {tab === 'tools' ? <ToolsView tools={profile.tools} /> : null}
          {tab === 'skills' ? <SkillsView skills={profile.skills} /> : null}
        </>
      )}
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

export function DesignerPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [clearOpen, setClearOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ url: string; name: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sessionsQuery = useQuery({
    queryKey: ['designer-sessions'],
    queryFn: api.listDesignerSessions,
    refetchInterval: 6000,
  });
  const sessions = sessionsQuery.data?.sessions ?? [];
  const busySessionId = sessionsQuery.data?.busySessionId ?? null;

  // 设计师详情（系统提示词 / 生效工具 / 技能 / 运行时信息），头部徽标与抽屉共用。
  const profileQuery = useQuery({
    queryKey: ['designer-profile'],
    queryFn: api.getDesignerProfile,
    refetchInterval: 20_000,
  });
  const profile = profileQuery.data?.profile ?? null;
  const runtime = profile?.runtime ?? null;

  useEffect(() => {
    if (activeId && sessions.some((session) => session.id === activeId)) return;
    setActiveId(sessions[0]?.id ?? null);
  }, [sessions, activeId]);

  const detailQuery = useQuery({
    queryKey: ['designer-session', activeId],
    queryFn: () => api.getDesignerSession(activeId!),
    enabled: Boolean(activeId),
    refetchInterval: (query) => ((query.state.data?.busy ?? false) ? 3000 : false),
  });
  const detail = detailQuery.data ?? null;
  const isBusyHere = Boolean(activeId) && busySessionId === activeId;
  const isBusyAnywhere = busySessionId !== null;

  // 切换会话时清掉待发送附件：附件路径与会话绑定，不能跨会话发送。
  useEffect(() => {
    setPending([]);
    setDragging(false);
  }, [activeId]);

  const invalidate = (sessionId: string | null) => {
    void queryClient.invalidateQueries({ queryKey: ['designer-sessions'] });
    if (sessionId) void queryClient.invalidateQueries({ queryKey: ['designer-session', sessionId] });
  };

  const sendMutation = useMutation({
    mutationFn: async ({
      id,
      content,
      attachments,
    }: {
      id: string | null;
      content: string;
      attachments: { name: string; path: string }[];
    }) => {
      const sessionId = id ? id : (await api.createDesignerSession()).session.id;
      if (!id) setActiveId(sessionId);
      await api.sendDesignerMessage(sessionId, content, attachments);
      return sessionId;
    },
    onSuccess: (sessionId) => invalidate(sessionId),
    onError: (error: Error) => toast.error(error.message),
  });

  const stopMutation = useMutation({
    mutationFn: api.stopDesigner,
    onSuccess: () => invalidate(activeId),
    onError: (error: Error) => toast.error(error.message),
  });

  /** 手动压缩上下文：compressed=0 表示当前用量未超水位、无需压缩。 */
  const compressMutation = useMutation({
    mutationFn: api.compressDesigner,
    onSuccess: (data) => {
      invalidate(activeId);
      if (data.compressed > 0) {
        toast.success(`已压缩较早的 ${data.compressed} 条消息为「前情提要」`);
      } else {
        toast.info('当前上下文占用不高，暂无需压缩');
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const clearMutation = useMutation({
    mutationFn: api.clearDesignerConversation,
    onSuccess: () => {
      setActiveId(null);
      setClearOpen(false);
      invalidate(null);
      toast.success('对话记录已清空，从全新会话开始');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const messages = detail?.messages ?? [];
  const proposals = detail?.proposals ?? [];

  // 流式上屏：仅当本会话正在回复且已有生成内容时显示流式气泡。
  const stream = useDesignerStream(activeId);
  const streamingText = isBusyHere && stream ? stream.text : '';
  const streamingReasoning = isBusyHere && stream ? stream.reasoning : '';
  // 轮次状态文本（designer.status）：等待气泡与头部徽标用它显示实时进展。
  const status = useDesignerStatus(activeId);
  const statusDetail = status?.detail ?? '';
  // 等待窗口：本会话正在回复但还没有任何流式内容（首字前 / 工具执行与轮次间隙），
  // 此时消息区显示带 loading 动画的设计师气泡，避免长时间「无反馈」的空窗。
  const waitingReply = isBusyHere && !streamingText && !streamingReasoning;

  // 工具结果行按 toolCallId 关联到助手消息里的调用参数。
  const toolCallById = useMemo(() => {
    const map = new Map<string, ToolCallView>();
    for (const message of messages) {
      for (const call of message.toolCalls) map.set(call.id, call);
    }
    return map;
  }, [messages]);

  const proposalsByMessage = useMemo(() => {
    const map = new Map<string, DesignerProposal[]>();
    const orphans: DesignerProposal[] = [];
    for (const proposal of proposals) {
      if (proposal.messageId && messages.some((message) => message.id === proposal.messageId)) {
        const list = map.get(proposal.messageId) ?? [];
        list.push(proposal);
        map.set(proposal.messageId, list);
      } else {
        orphans.push(proposal);
      }
    }
    return { map, orphans };
  }, [proposals, messages]);

  // 自动滚动采用「贴底跟随」：只有用户本来就停在底部附近时，新消息 / 流式增量才跟随滚动；
  // 用户一旦上滚离开底部（回看历史），绝不把视图拽回底部——否则回复生成期间的连续
  // 流式更新会不停重置 scrollTop，表现为滚轮与滚动条完全推不动。
  const lastMessageId = messages.at(-1)?.id ?? '';
  const stickToBottomRef = useRef(true);
  const handleMessagesScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lastMessageId, detail?.busy, streamingText.length, streamingReasoning.length, waitingReply]);
  // 切换会话 / 清空对话后恢复贴底，并立即定位到底部。
  useEffect(() => {
    stickToBottomRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId]);

  /* ---------------- 附件 ---------------- */

  const uploadingCount = pending.filter((item) => item.uploading).length;

  const addFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    if (isBusyAnywhere) {
      toast.error('设计师正在回复，请等本轮结束后再添加附件');
      return;
    }
    const room = DESIGNER_MAX_ATTACHMENTS - pending.length;
    if (room <= 0) {
      toast.error(`一条消息最多携带 ${DESIGNER_MAX_ATTACHMENTS} 个附件`);
      return;
    }
    const withinLimit = files.filter((file) => file.size > 0 && file.size <= DESIGNER_UPLOAD_MAX_BYTES);
    const rejected = files.length - withinLimit.length;
    if (rejected > 0) {
      toast.error(
        `有 ${rejected} 个文件被跳过：单个附件不能超过 ${Math.round(DESIGNER_UPLOAD_MAX_BYTES / 1024 / 1024)} MB 且不能为空`,
      );
    }
    const list = withinLimit.slice(0, room);
    if (list.length === 0) return;

    // 新对话还没有会话：先创建，附件与消息都落进同一个会话。
    let sessionId = activeId;
    if (!sessionId) {
      try {
        const created = await api.createDesignerSession();
        sessionId = created.session.id;
        setActiveId(sessionId);
        invalidate(sessionId);
      } catch (error) {
        toast.error((error as Error).message);
        return;
      }
    }

    for (const file of list) {
      const key = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const image =
        /^image\//i.test(file.type) || /\.(png|jpe?g|gif|webp)$/i.test(file.name);
      setPending((prev) => [
        ...prev,
        { key, name: file.name, path: '', size: file.size, image, uploading: true },
      ]);
      try {
        const { attachment } = await api.uploadDesignerFile(sessionId, file);
        setPending((prev) =>
          prev.map((item) =>
            item.key === key
              ? { key, name: attachment.name, path: attachment.path, size: attachment.size, image: attachment.image, uploading: false }
              : item,
          ),
        );
      } catch (error) {
        setPending((prev) => prev.filter((item) => item.key !== key));
        toast.error(`「${file.name}」上传失败：${(error as Error).message}`);
      }
    }
  };

  /* ---------------- 发送 ---------------- */

  const submit = () => {
    const content = draft.trim();
    const ready = pending.filter((item) => !item.uploading && item.path);
    if (sendMutation.isPending || isBusyAnywhere || uploadingCount > 0) return;
    if (!content && ready.length === 0) return;
    const attachments = ready.map(({ name, path }) => ({ name, path }));
    setDraft('');
    setPending([]);
    sendMutation.mutate({ id: activeId, content, attachments });
  };

  /* ---------------- 头部会话信息 ---------------- */

  const lastUsage: TokenUsage | null = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const usage = messages[i]?.meta?.usage;
      if (usage) return usage;
    }
    return null;
  }, [messages]);
  const usedTokens = lastUsage ? lastUsage.promptTokens + lastUsage.completionTokens : null;
  const contextTitle =
    lastUsage && runtime
      ? `最近一次请求：输入 ${lastUsage.promptTokens.toLocaleString()} · 输出 ${lastUsage.completionTokens.toLocaleString()} · 思考 ${lastUsage.reasoningTokens.toLocaleString()} · 缓存命中 ${lastUsage.cachedTokens.toLocaleString()} tokens；上下文上限 ${runtime.maxContextTokens.toLocaleString()} tokens`
      : '发送第一条消息后显示上下文用量';

  /* ---------------- 压缩上下文 / 清空对话记录 ---------------- */

  /** 压缩水位与后端一致：上下文窗口的 80%。 */
  const COMPRESS_WATERMARK = 0.8;
  // 以最近一次实测用量估算；压缩生效后的真实用量要等下一次请求刷新（期间再点会提示无需压缩）。
  const overWatermark = usedTokens !== null && runtime ? usedTokens >= runtime.maxContextTokens * COMPRESS_WATERMARK : false;
  const compressDisabled =
    !activeId || isBusyAnywhere || compressMutation.isPending || !overWatermark;
  const compressTitle = !activeId
    ? '还没有对话'
    : isBusyAnywhere
      ? '设计师正在回复，请先停止再压缩'
      : compressMutation.isPending
        ? '正在压缩上下文…'
        : overWatermark
          ? '把较早的对话压缩成「前情提要」，模型上下文只保留提要与最近内容（聊天记录保留）'
          : `上下文占用低于 ${COMPRESS_WATERMARK * 100}% 水位，暂无需压缩`;

  // 压缩分隔线：seq ≤ 水位的较早消息仍在界面展示，但已不进入模型上下文。
  const compactedSeq = detail?.session.compactedSeq ?? 0;
  const compressedCount =
    compactedSeq > 0 ? messages.filter((message) => message.seq <= compactedSeq).length : 0;

  return (
    <div className="designer-layout">
      <section className="designer-chat">
        <div className="designer-chat-head">
          <span className="designer-chat-title">
            <DraftingCompass size={16} />
            流水线设计师
          </span>
          <div className="designer-head-tools">
            <div className="designer-meta">
              <span className="meta-pill" title={runtime ? `模型：${runtime.model}` : '正在加载…'}>
                <Bot size={12} />
                <span className="meta-pill-text">{runtime?.model ?? '…'}</span>
              </span>
              <span
                className="meta-pill"
                title={
                  runtime
                    ? runtime.deepThinking
                      ? `深度思考已开启，级别 ${runtime.thinkingLevel}（全局设置，可在「设置」调整）`
                      : '深度思考未开启（全局设置，可在「设置」调整）'
                    : '正在加载…'
                }
              >
                <Brain size={12} />
                {runtime ? (runtime.deepThinking ? `思考 ${runtime.thinkingLevel}` : '思考关') : '…'}
              </span>
              <span className="meta-pill" title={contextTitle}>
                <Gauge size={12} />
                {usedTokens !== null && runtime
                  ? `${formatTokens(usedTokens)} / ${formatTokens(runtime.maxContextTokens)} · ${formatContextPercent(usedTokens, runtime.maxContextTokens)}`
                  : '上下文 —'}
              </span>
            </div>
            {isBusyHere ? (
              <span className="busy-pill">
                <span className="pulse-dot" />
                {statusDetail || '正在思考…'}
              </span>
            ) : (
              <span className="muted designer-chat-hint">提问澄清 → 设计思路 → 认可即执行</span>
            )}
            <div className="designer-actions">
              <button
                type="button"
                className="button button--ghost button--sm"
                title={compressTitle}
                disabled={compressDisabled}
                onClick={() => compressMutation.mutate()}
              >
                {compressMutation.isPending ? <Spinner size={13} /> : <FoldVertical size={14} />}
                压缩上下文
              </button>
              <button
                type="button"
                className="button button--ghost button--sm designer-clear"
                title="清空对话记录：删除全部消息、变更记录与上传附件；工作目录文件与已生效变更保留"
                disabled={!activeId || isBusyAnywhere || clearMutation.isPending}
                onClick={() => setClearOpen(true)}
              >
                <Eraser size={14} />
                清空对话
              </button>
            </div>
            <button
              type="button"
              className="icon-button"
              title="工作目录：浏览与预览设计师的文件"
              onClick={() => setWorkspaceOpen(true)}
            >
              <FolderOpen size={16} />
            </button>
            <button
              type="button"
              className="icon-button"
              title="设计师详情：系统提示词 / 工具 / 技能"
              onClick={() => setProfileOpen(true)}
            >
              <Info size={16} />
            </button>
          </div>
        </div>

        <div className="designer-messages" ref={scrollRef} onScroll={handleMessagesScroll}>
          {!activeId || (messages.length === 0 && !streamingText && !streamingReasoning && !waitingReply) ? (
            <EmptyState icon={DraftingCompass} title="和设计师聊聊你想自动化的流程" />
          ) : (
            <>
              {messages.map((message, index) => (
                <Fragment key={message.id}>
                  <MessageItem
                    message={message}
                    call={message.toolCallId ? toolCallById.get(message.toolCallId) : undefined}
                    proposals={proposalsByMessage.map.get(message.id) ?? []}
                    onPreview={setPreviewImage}
                  />
                  {compressedCount > 0 && index === compressedCount - 1 ? (
                    <div className="designer-compress-divider" title="这些消息已总结为「前情提要」注入系统提示词，不再进入模型上下文">
                      <FoldVertical size={12} />
                      <span>已压缩 {compressedCount} 条较早消息 · 聊天记录保留，模型上下文只含提要与后续内容</span>
                    </div>
                  ) : null}
                </Fragment>
              ))}
              {proposalsByMessage.orphans.map((proposal) => (
                <ProposalCard key={proposal.id} proposal={proposal} />
              ))}
              {streamingText || streamingReasoning ? (
                <StreamingMessage text={streamingText} reasoning={streamingReasoning} />
              ) : waitingReply ? (
                <ThinkingBubble detail={statusDetail || '设计师正在思考…'} />
              ) : null}
            </>
          )}
        </div>

        <form
          className={cn('designer-input', dragging && 'designer-input--dragging')}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onDragOver={(event) => {
            event.preventDefault();
            if (!isBusyAnywhere) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (isBusyAnywhere) return;
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (files.length > 0) void addFiles(files);
          }}
        >
          {pending.length > 0 ? (
            <div className="designer-pending">
              {pending.map((item) => (
                <div key={item.key} className={cn('attach-chip', item.uploading && 'attach-chip--uploading')}>
                  {item.uploading ? (
                    <span className="attach-thumb">
                      <Spinner size={13} />
                    </span>
                  ) : (
                    <AttachmentThumb sessionId={activeId} attachment={item} />
                  )}
                  <span className="attach-meta">
                    <span className="attach-name" title={item.name}>
                      {item.name}
                    </span>
                    <span className="attach-size">{item.uploading ? '上传中…' : formatBytes(item.size)}</span>
                  </span>
                  <button
                    type="button"
                    className="attach-remove"
                    title="移除附件"
                    onClick={() => setPending((prev) => prev.filter((entry) => entry.key !== item.key))}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData?.files ?? []);
              if (files.length > 0) {
                event.preventDefault();
                void addFiles(files);
              }
            }}
            placeholder={
              isBusyAnywhere
                ? '设计师正在回复，请稍候…'
                : '描述你的需求，例如：我想搭一条「翻译 → 校对 → 排版」的文档翻译流水线（可直接粘贴图片或拖入文件）'
            }
            rows={3}
            disabled={isBusyAnywhere}
          />
          <div className="designer-input-actions">
            <span className="muted">Enter 发送 · Shift+Enter 换行 · 支持粘贴图片 / 拖入文件</span>
            <div className="designer-input-buttons">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = '';
                  void addFiles(files);
                }}
              />
              <button
                type="button"
                className="icon-button"
                title="添加附件"
                aria-label="添加附件"
                disabled={isBusyAnywhere}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip size={15} />
              </button>
              {isBusyHere ? (
                <button type="button" className="button button--ghost" onClick={() => stopMutation.mutate()}>
                  <Square size={14} />
                  停止
                </button>
              ) : (
                <button
                  type="submit"
                  className="button button--primary"
                  disabled={
                    (!draft.trim() && pending.filter((item) => !item.uploading && item.path).length === 0) ||
                    isBusyAnywhere ||
                    sendMutation.isPending ||
                    uploadingCount > 0
                  }
                >
                  {sendMutation.isPending ? <Spinner size={14} /> : <Send size={14} />}
                  发送
                </button>
              )}
            </div>
          </div>
        </form>
      </section>

      <DesignerProfileDrawer
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        profile={profile}
        isLoading={profileQuery.isLoading}
      />

      <DesignerWorkspaceDrawer open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} />

      <Modal
        open={previewImage !== null}
        onClose={() => setPreviewImage(null)}
        title={previewImage?.name ?? ''}
        width={920}
        className="image-preview-modal"
      >
        {previewImage ? <img className="image-preview-img" src={previewImage.url} alt={previewImage.name} /> : null}
      </Modal>

      <ConfirmDialog
        open={clearOpen}
        title="清空对话记录？"
        description="将删除全部消息、变更记录与上传的附件；设计师工作目录里的文件与已生效的系统变更不受影响。清空后从全新会话开始。"
        confirmLabel="清空"
        busy={clearMutation.isPending}
        onConfirm={() => clearMutation.mutate()}
        onCancel={() => setClearOpen(false)}
      />
    </div>
  );
}
