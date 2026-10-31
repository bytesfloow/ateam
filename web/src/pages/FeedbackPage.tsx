import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Check,
  ChevronRight,
  Inbox,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  FEEDBACK_CATEGORIES,
  type Feedback,
  type FeedbackStatus,
} from '@shared/types';
import { api } from '../api';
import { AgentAvatar } from '../components/AgentAvatar';
import { Badge } from '../components/Badge';
import { CopyButton } from '../components/CopyButton';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { Spinner } from '../components/Spinner';
import {
  cn,
  FEEDBACK_CATEGORY_META,
  FEEDBACK_SEVERITY_META,
  FEEDBACK_STATUS_META,
  formatDateTime,
  formatFullDateTime,
  truncate,
} from '../lib/format';
import { useToast } from '../lib/toast';

const STATUS_TABS: { value: FeedbackStatus | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'open', label: '待处理' },
  { value: 'resolved', label: '已处理' },
  { value: 'ignored', label: '已忽略' },
];

export function FeedbackPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<FeedbackStatus | 'all'>('all');
  const [category, setCategory] = useState('all');
  const [agentId, setAgentId] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Feedback | null>(null);
  const [note, setNote] = useState('');

  const feedbackQuery = useQuery({
    queryKey: ['feedback', status, category, agentId],
    queryFn: () => api.listFeedback(status, category, agentId),
    refetchInterval: 12000,
  });
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: api.listAgents });
  const agents = agentsQuery.data?.agents ?? [];

  const items = feedbackQuery.data?.items ?? [];
  const counts = feedbackQuery.data?.counts ?? { all: 0, open: 0, resolved: 0, ignored: 0 };

  useEffect(() => {
    setNote(selected?.resolutionNote ?? '');
  }, [selected?.id, selected?.resolutionNote]);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return items;
    return items.filter(
      (item) =>
        item.content.toLowerCase().includes(keyword) ||
        item.agentName.toLowerCase().includes(keyword) ||
        item.taskName.toLowerCase().includes(keyword),
    );
  }, [items, search]);

  const updateMutation = useMutation({
    mutationFn: ({ nextStatus }: { nextStatus: FeedbackStatus }) => {
      if (!selected) throw new Error('没有选中的反馈');
      return api.updateFeedback(selected.id, {
        status: nextStatus,
        resolutionNote: note,
      });
    },
    onSuccess: (data) => {
      setSelected(data.feedback);
      setNote(data.feedback.resolutionNote);
      void queryClient.invalidateQueries({ queryKey: ['feedback'] });
      void queryClient.invalidateQueries({ queryKey: ['status'] });
      toast.success('反馈状态已更新');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const saveNoteMutation = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('没有选中的反馈');
      return api.updateFeedback(selected.id, {
        status: selected.status,
        resolutionNote: note,
      });
    },
    onSuccess: (data) => {
      setSelected(data.feedback);
      void queryClient.invalidateQueries({ queryKey: ['feedback'] });
      toast.success('处理备注已保存');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="page-stack">
      <div className="page-intro">
        <div>
          <h2>反馈中心</h2>
          <p>智能体在工作中遇到不合理的提示词、难用的工具或流程问题，或对系统、上下游智能体有建议时，会通过 submit_feedback 提交到这里。</p>
        </div>
        <Badge tone={counts.open > 0 ? 'warning' : 'success'}>{counts.open} 条待处理</Badge>
      </div>

      <section className="card feedback-card">
        <div className="feedback-toolbar">
          <div className="filter-chips">
            {STATUS_TABS.map((tab) => (
              <button
                type="button"
                key={tab.value}
                className={cn('filter-chip', status === tab.value && 'is-active')}
                onClick={() => setStatus(tab.value)}
              >
                {tab.label}
                <span>{counts[tab.value] ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="feedback-filters">
            <select className="select select--sm" value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="all">全部分类</option>
              {FEEDBACK_CATEGORIES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
            <select className="select select--sm" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              <option value="">全部智能体</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            <div className="library-search feedback-search">
              <Search size={15} />
              <input
                className="input input--search"
                value={search}
                placeholder="搜索反馈…"
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
        </div>

        {feedbackQuery.isLoading ? (
          <div className="loading-panel">
            <Spinner size={20} /> 正在加载反馈…
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title={counts.all === 0 ? '还没有反馈' : '没有匹配的反馈'}
            description={
              counts.all === 0
                ? '当智能体在阶段中调用 submit_feedback 时，反馈会出现在这里。'
                : '试试切换状态、分类或清空筛选条件。'
            }
            compact
          />
        ) : (
          <div className="feedback-list">
            {filtered.map((feedback) => (
              <FeedbackRow key={feedback.id} feedback={feedback} onOpen={() => setSelected(feedback)} />
            ))}
          </div>
        )}
      </section>

      <Drawer
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        width={780}
        title={
          selected ? (
            <span className="drawer-title">
              反馈详情
              <Badge tone={FEEDBACK_CATEGORY_META[selected.category].tone}>
                {FEEDBACK_CATEGORY_META[selected.category].label}
              </Badge>
              <Badge tone={FEEDBACK_STATUS_META[selected.status].tone}>
                {FEEDBACK_STATUS_META[selected.status].label}
              </Badge>
            </span>
          ) : (
            '反馈详情'
          )
        }
        description={
          selected ? (
            <span className="drawer-subtitle">
              <AgentAvatar name={selected.agentName} size="xs" />
              {selected.agentName}
              <span className="dot-sep">·</span>
              {formatFullDateTime(selected.createdAt)}
            </span>
          ) : null
        }
        footer={
          selected ? (
            <div className="drawer-footer-row drawer-footer-row--between">
              <div className="button-row">
                {selected.status === 'open' ? (
                  <>
                    <button
                      type="button"
                      className="button button--primary button--sm"
                      onClick={() => updateMutation.mutate({ nextStatus: 'resolved' })}
                      disabled={updateMutation.isPending}
                    >
                      {updateMutation.isPending ? <Spinner size={14} /> : <Check size={14} />}
                      标记已处理
                    </button>
                    <button
                      type="button"
                      className="button button--ghost button--sm"
                      onClick={() => updateMutation.mutate({ nextStatus: 'ignored' })}
                      disabled={updateMutation.isPending}
                    >
                      <X size={14} />
                      忽略
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="button button--secondary button--sm"
                    onClick={() => updateMutation.mutate({ nextStatus: 'open' })}
                    disabled={updateMutation.isPending}
                  >
                    <RotateCcw size={14} />
                    重新打开
                  </button>
                )}
              </div>
              <button type="button" className="button button--secondary" onClick={() => setSelected(null)}>
                关闭
              </button>
            </div>
          ) : null
        }
      >
        {selected ? (
          <div className="feedback-detail">
            <div className="feedback-detail-meta">
              <Badge tone={FEEDBACK_SEVERITY_META[selected.severity].tone}>
                {FEEDBACK_SEVERITY_META[selected.severity].label}
              </Badge>
              <span>任务：{selected.taskName || '（未关联任务）'}</span>
              {selected.taskId ? (
                <span>
                  <Link className="inline-link" to={`/tasks/${selected.taskId}`}>
                    {selected.contextSnapshot?.turnSeq ? `第 ${selected.contextSnapshot.turnSeq} 环节` : '查看任务'}
                    <ChevronRight size={12} />
                  </Link>
                </span>
              ) : null}
              {selected.taskId ? (
                <span className="mono">
                  {selected.taskId.slice(0, 8)}
                  <CopyButton value={selected.taskId} label="复制" />
                </span>
              ) : null}
            </div>

            <div className="feedback-content-block">
              <div className="detail-label">反馈内容</div>
              <p>{selected.content}</p>
            </div>

            {selected.contextSnapshot ? (
              <div className="feedback-context">
                <div className="detail-label">提交时的上下文快照</div>
                {selected.contextSnapshot.task ? (
                  <div className="context-block">
                    <span>任务</span>
                    <p>{truncate(selected.contextSnapshot.task, 800)}</p>
                  </div>
                ) : null}
                {selected.contextSnapshot.systemPrompt ? (
                  <details className="context-details">
                    <summary>系统提示词片段</summary>
                    <pre>{selected.contextSnapshot.systemPrompt}</pre>
                  </details>
                ) : null}
                {selected.contextSnapshot.messages.length > 0 ? (
                  <details className="context-details" open>
                    <summary>最近 {selected.contextSnapshot.messages.length} 条上下文消息</summary>
                    <div className="context-messages">
                      {selected.contextSnapshot.messages.map((message, index) => (
                        <div className="context-message" key={`${message.role}-${index}`}>
                          <span className={cn('context-role', `context-role--${message.role}`)}>{message.role}</span>
                          <pre>{message.content}</pre>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            ) : null}

            <div className="feedback-resolution">
              <div className="detail-label">处理备注</div>
              <textarea
                className="textarea"
                rows={5}
                value={note}
                maxLength={2000}
                placeholder="记录你准备如何优化系统，例如：调整提示词模板、修复工具参数、补充技能说明…"
                onChange={(event) => setNote(event.target.value)}
              />
              <div className="feedback-resolution-foot">
                <span className="muted">{note.length}/2000</span>
                <button
                  type="button"
                  className="button button--secondary button--sm"
                  onClick={() => saveNoteMutation.mutate()}
                  disabled={saveNoteMutation.isPending}
                >
                  {saveNoteMutation.isPending ? <Spinner size={14} /> : null}
                  保存备注
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}

function FeedbackRow({ feedback, onOpen }: { feedback: Feedback; onOpen: () => void }) {
  const category = FEEDBACK_CATEGORY_META[feedback.category];
  const severity = FEEDBACK_SEVERITY_META[feedback.severity];
  const status = FEEDBACK_STATUS_META[feedback.status];
  return (
    <button type="button" className={cn('feedback-row', `feedback-row--${feedback.status}`)} onClick={onOpen}>
      <span className={cn('severity-bar', `severity-bar--${feedback.severity}`)} />
      <div className="feedback-row-main">
        <div className="feedback-row-head">
          <Badge tone={category.tone}>{category.label}</Badge>
          <Badge tone={status.tone}>{status.label}</Badge>
          <span className="feedback-agent">
            <AgentAvatar name={feedback.agentName} size="xs" />
            {feedback.agentName}
          </span>
          <span className="feedback-time">{formatDateTime(feedback.createdAt)}</span>
        </div>
        <p>{truncate(feedback.content, 220)}</p>
        <div className="feedback-row-foot">
          <span>{severity.label}</span>
          <span className="dot-sep">·</span>
          <span>{feedback.taskName || '（未关联任务）'}</span>
          {feedback.contextSnapshot?.turnSeq ? (
            <>
              <span className="dot-sep">·</span>
              <span>第 {feedback.contextSnapshot.turnSeq} 环节</span>
            </>
          ) : null}
          <span className="feedback-open">
            查看
            <ArrowRight size={13} />
          </span>
        </div>
      </div>
    </button>
  );
}
