import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  ClipboardList,
  Eye,
  FileText,
  FolderOpen,
  MessageSquare,
  ScrollText,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import type { ConversationMessage, DeliverableFile, TurnDetail as TurnDetailData } from '@shared/types';
import { api } from '../api';
import {
  cn,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatFullDateTime,
  HANDOFF_TARGET_META,
  TURN_STATUS_META,
  truncate,
} from '../lib/format';
import { AgentAvatar } from './AgentAvatar';
import { Badge } from './Badge';
import { CopyButton } from './CopyButton';
import { DeliverablePreviewModal } from './DeliverablePreview';
import { Drawer } from './Drawer';
import { EmptyState } from './EmptyState';
import { Markdown } from './Markdown';
import { Spinner } from './Spinner';
import { Tabs } from './Tabs';

type TabValue = 'chat' | 'input' | 'prompt' | 'files';

export function TurnDetailDrawer({
  taskId,
  turnId,
  open,
  onClose,
}: {
  taskId: string | null;
  turnId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<TabValue>('chat');
  const query = useQuery({
    queryKey: ['turn', taskId, turnId],
    queryFn: () => api.getTurnDetail(taskId!, turnId!),
    enabled: open && Boolean(taskId && turnId),
    refetchInterval: (q) => {
      const detail = q.state.data?.detail;
      return detail && detail.turn.status === 'running' ? 1500 : false;
    },
  });

  useEffect(() => {
    if (open) setTab('chat');
  }, [open, turnId]);

  const detail = query.data?.detail;
  const turn = detail?.turn;
  const meta = turn ? TURN_STATUS_META[turn.status] : null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={880}
      title={
        <span className="drawer-title">
          {turn ? <span className="stage-index stage-index--sm">{turn.seq}</span> : null}
          {turn ? `第 ${turn.seq} 环节 · ${turn.agentName}` : '回合详情'}
          {meta ? <Badge tone={meta.tone}>{meta.label}</Badge> : null}
        </span>
      }
      description={
        turn ? (
          <span className="drawer-subtitle">
            <AgentAvatar name={turn.agentName} accent={turn.agentAccent} size="xs" />
            {turn.agentName}
            <span className="dot-sep">·</span>
            {formatDuration(turn.startedAt, turn.finishedAt)}
            <span className="dot-sep">·</span>
            {turn.iterations} 轮
            {turn.target ? (
              <>
                <span className="dot-sep">·</span>
                <Badge tone={HANDOFF_TARGET_META[turn.target.type].tone}>
                  {HANDOFF_TARGET_META[turn.target.type].label}
                  {turn.target.agentName ? ` → ${turn.target.agentName}` : ''}
                </Badge>
              </>
            ) : null}
          </span>
        ) : null
      }
      footer={
        <div className="drawer-footer-row">
          <button type="button" className="button button--secondary" onClick={onClose}>
            关闭
          </button>
        </div>
      }
    >
      {query.isLoading ? (
        <div className="loading-panel">
          <Spinner size={20} />
          正在加载回合详情…
        </div>
      ) : query.isError || !detail ? (
        <div className="error-panel">{(query.error as Error)?.message ?? '回合详情加载失败'}</div>
      ) : (
        <>
          <div className="stage-summary">
            <div className="stage-summary-item">
              <span>文本回复</span>
              <strong>{detail.turn.output ? `${detail.turn.output.length} 字符` : '暂无'}</strong>
            </div>
            <div className="stage-summary-item">
              <span>对话消息</span>
              <strong>{detail.messages.length} 条</strong>
            </div>
            <div className="stage-summary-item">
              <span>交付文件夹</span>
              <strong>{detail.turn.handoffFolder ? `${detail.turn.handoffFolder.name}/ · ${detail.turn.handoffFolder.files} 文件` : '未交接'}</strong>
            </div>
            <div className="stage-summary-item">
              <span>ReAct 轮数</span>
              <strong>{detail.turn.iterations}</strong>
            </div>
            <div className="stage-summary-item">
              <span>Token 消耗</span>
              <strong
                title={`输入 ${detail.usage.promptTokens.toLocaleString()} · 输出 ${detail.usage.completionTokens.toLocaleString()} · 思考 ${detail.usage.reasoningTokens.toLocaleString()} · 缓存命中 ${detail.usage.cachedTokens.toLocaleString()}`}
              >
                {detail.usage.totalTokens > 0 ? detail.usage.totalTokens.toLocaleString() : '—'}
              </strong>
            </div>
          </div>

          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'chat', label: '对话', count: detail.messages.length },
              { value: 'input', label: '本环节输入' },
              { value: 'prompt', label: '系统提示词' },
              {
                value: 'files',
                label: '交付文件夹',
                count: detail.turn.handoffFolder?.files ?? 0,
              },
            ]}
          />

          {tab === 'chat' ? <ChatView key={detail.turn.id} detail={detail} /> : null}
          {tab === 'input' ? <InputView text={detail.turn.input} /> : null}
          {tab === 'prompt' ? <SystemPromptView text={detail.systemPrompt} /> : null}
          {tab === 'files' ? <FilesView detail={detail} /> : null}
        </>
      )}
    </Drawer>
  );
}

function InputView({ text }: { text: string }) {
  if (!text) {
    return <EmptyState icon={ClipboardList} title="还没有输入" compact />;
  }
  return (
    <div className="turn-input-view">
      <pre>{text}</pre>
    </div>
  );
}

function SystemPromptView({ text }: { text: string | null }) {
  if (!text) {
    return (
      <EmptyState
        icon={ScrollText}
        title="系统提示词还没有生成"
        description="本环节开始执行时按当时的智能体配置与流水线快照拼装，并在此留档。"
        compact
      />
    );
  }
  return (
    <div className="turn-input-view">
      <div className="turn-prompt-toolbar">
        <span>本环节实际下发给模型的完整系统提示词 · {text.length.toLocaleString()} 字符</span>
        <CopyButton value={text} label="复制提示词" />
      </div>
      <pre>{text}</pre>
    </div>
  );
}

function ChatView({ detail }: { detail: TurnDetailData }) {
  const messages = detail.messages;
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const firstLoad = useRef(true);

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    if (firstLoad.current) {
      element.scrollTop = element.scrollHeight;
      firstLoad.current = false;
      return;
    }
    if (stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <EmptyState icon={MessageSquare} title="还没有对话" description="回合开始后，智能体的思考与工具调用会显示在这里。" compact />
    );
  }

  return (
    <div
      className="chat-list"
      ref={listRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 140;
      }}
    >
      {messages.map((message) => (
        <ChatMessage key={message.id} message={message} agentName={detail.turn.agentName} />
      ))}
    </div>
  );
}

function ChatMessage({ message, agentName }: { message: ConversationMessage; agentName: string }) {
  const isTurnInput = message.meta.kind === 'turn_input';
  const isTool = message.role === 'tool';
  const label = isTurnInput ? '回合输入' : isTool ? `工具结果 · ${message.meta.toolName ?? message.name ?? 'tool'}` : agentName;

  return (
    <div
      className={cn(
        'chat-message',
        isTurnInput && 'chat-message--input',
        isTool && 'chat-message--tool',
        message.role === 'assistant' && 'chat-message--assistant',
        message.meta.toolStatus === 'error' && 'chat-message--error',
      )}
    >
      <div className="chat-message-head">
        <span className="chat-role">
          {isTurnInput ? <ClipboardList size={13} /> : null}
          {isTool ? <TerminalSquare size={13} /> : null}
          {message.role === 'assistant' ? <MessageSquare size={13} /> : null}
          {label}
        </span>
        <span className="chat-time" title={formatFullDateTime(message.createdAt)}>
          {formatDateTime(message.createdAt)}
          {message.meta.toolStatus ? (
            <Badge tone={message.meta.toolStatus === 'error' ? 'danger' : 'success'}>
              {message.meta.toolStatus === 'error' ? '失败' : '成功'}
            </Badge>
          ) : null}
          {message.meta.usage ? (
            <span
              title={`输入 ${message.meta.usage.promptTokens.toLocaleString()} · 输出 ${message.meta.usage.completionTokens.toLocaleString()} · 思考 ${message.meta.usage.reasoningTokens.toLocaleString()} · 缓存命中 ${message.meta.usage.cachedTokens.toLocaleString()}`}
            >
              <Badge tone="neutral">tokens {message.meta.usage.totalTokens.toLocaleString()}</Badge>
            </span>
          ) : null}
        </span>
      </div>

      {message.content ? (
        isTool ? (
          <CollapsiblePre text={message.content} />
        ) : message.role === 'assistant' ? (
          <Markdown>{message.content}</Markdown>
        ) : (
          <CollapsiblePlain text={message.content} />
        )
      ) : null}

      {message.toolCalls.length > 0 ? (
        <div className="tool-calls">
          {message.toolCalls.map((call) => (
            <details className="tool-call" key={call.id}>
              <summary>
                <Wrench size={13} />
                <span>{call.name}</span>
                <span className="tool-call-hint">查看参数</span>
              </summary>
              <pre>{prettyJson(call.arguments)}</pre>
            </details>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CollapsiblePlain({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 900 || text.split('\n').length > 16;
  return (
    <div>
      <div className={cn('collapsible-plain', long && !open && 'is-collapsed')}>{text}</div>
      {long ? (
        <button type="button" className="text-button" onClick={() => setOpen((value) => !value)}>
          {open ? '收起' : '展开全文'}
        </button>
      ) : null}
    </div>
  );
}

function CollapsiblePre({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 900 || text.split('\n').length > 18;
  return (
    <div>
      <div className={cn('tool-result-block', long && !open && 'is-collapsed')}>
        <pre>{text}</pre>
      </div>
      {long ? (
        <button type="button" className="text-button" onClick={() => setOpen((value) => !value)}>
          {open ? '收起结果' : `展开完整结果（${text.length} 字符）`}
        </button>
      ) : null}
    </div>
  );
}

function FilesView({ detail }: { detail: TurnDetailData }) {
  const folder = detail.turn.handoffFolder;
  const [previewFile, setPreviewFile] = useState<DeliverableFile | null>(null);
  const filesQuery = useQuery({
    queryKey: ['deliverableList', detail.turn.taskId, detail.turn.id],
    queryFn: () => api.listDeliverables(detail.turn.taskId, detail.turn.id),
    enabled: Boolean(folder),
    staleTime: 10_000,
  });
  if (!folder) {
    return (
      <EmptyState
        icon={FolderOpen}
        title="没有交付文件夹"
        description="智能体把成果放进一个目录（如 output\\），交接时以整个目录作为交付单元。"
        compact
      />
    );
  }
  const files = filesQuery.data?.files ?? [];
  const deliveredToAgent = detail.turn.target?.type === 'agent';
  return (
    <div className="file-list">
      <div className="callout callout--info">
        <FolderOpen size={15} />
        {deliveredToAgent
          ? `交付文件夹「${folder.name}/」（${folder.files} 个文件，${formatBytes(folder.bytes)}）已由系统整目录复制到「${detail.turn.target?.agentName ?? '交接对象'}」的工作区 ${folder.deliveredPath ?? 'inbox/'} 下，原文件保留在本环节工作区。`
          : `交付文件夹「${folder.name}/」（${folder.files} 个文件，${formatBytes(folder.bytes)}）已复制到任务目录 ${folder.deliveredPath ?? 'final/'}，交给用户验收。`}
      </div>
      {filesQuery.isLoading ? (
        <div className="loading-inline">
          <Spinner size={16} /> 正在列出文件…
        </div>
      ) : files.length === 0 ? (
        <EmptyState icon={FileText} title="文件夹是空的" description="交接了目录，但里面没有文件。" compact />
      ) : (
        files.map((file) => (
          <div className="file-row" key={file.path}>
            <span className="file-icon">
              <FileText size={17} />
            </span>
            <div className="file-main">
              <div className="file-name">{file.name}</div>
              <code>源：{truncate(file.path, 120)}</code>
              <code className="file-delivered">
                接收方：{folder.deliveredPath ? `${folder.deliveredPath}/${file.path.slice(folder.path.length + 1)}` : file.path}
              </code>
            </div>
            <span className="file-size">{formatBytes(file.size)}</span>
            <button
              type="button"
              className="button button--secondary button--sm"
              onClick={() => setPreviewFile(file)}
            >
              <Eye size={14} />
              预览
            </button>
            <CopyButton value={file.path} label="复制路径" />
          </div>
        ))
      )}
      {detail.turn.target ? (
        <div className="callout">
          <ArrowRight size={15} />
          去向：{HANDOFF_TARGET_META[detail.turn.target.type].label}
          {detail.turn.target.agentName ? ` → ${detail.turn.target.agentName}` : ''}
        </div>
      ) : null}
      <DeliverablePreviewModal
        taskId={detail.turn.taskId}
        turnId={detail.turn.id}
        file={previewFile}
        open={Boolean(previewFile)}
        onClose={() => setPreviewFile(null)}
      />
    </div>
  );
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
