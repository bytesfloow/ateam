import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Bot,
  ChevronRight,
  CircleDot,
  Clock3,
  Workflow,
  Play,
  Sparkles,
  User,
  Zap,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { bfsNodeOrder, isTerminalNode, type TaskSummary } from '@shared/types';
import { api } from '../api';
import { AgentAvatar } from '../components/AgentAvatar';
import { EmptyState } from '../components/EmptyState';
import { Badge } from '../components/Badge';
import { Spinner } from '../components/Spinner';
import {
  HumanTakeoverPanel,
  RetryTaskButton,
  TaskChain,
  TaskStatusBanner,
  TerminateTaskButton,
} from '../components/TaskChain';
import { TurnDetailDrawer } from '../components/TurnDetail';
import { cn, formatDateTime, formatDuration, TASK_STATUS_META, truncate } from '../lib/format';
import { useToast } from '../lib/toast';

export function TasksPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const presetPipelineId = searchParams.get('pipeline') ?? '';
  const [task, setTask] = useState(() => window.localStorage.getItem('ateam:task-draft') ?? '');
  const [pipelineId, setPipelineId] = useState(presetPipelineId);
  const [selectedTurn, setSelectedTurn] = useState<string | null>(null);

  useEffect(() => {
    if (task) window.localStorage.setItem('ateam:task-draft', task);
    else window.localStorage.removeItem('ateam:task-draft');
  }, [task]);

  useEffect(() => {
    if (presetPipelineId) setPipelineId(presetPipelineId);
  }, [presetPipelineId]);

  const pipelinesQuery = useQuery({ queryKey: ['pipelines'], queryFn: api.listPipelines });
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: api.listAgents });
  const statusQuery = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: 5000 });
  const activeTaskId = statusQuery.data?.status.activeTask?.id ?? null;
  const taskQuery = useQuery({
    queryKey: ['task', activeTaskId],
    queryFn: () => api.getTask(activeTaskId!),
    enabled: Boolean(activeTaskId),
    refetchInterval: (query) => {
      const current = query.state.data?.task;
      return current && ['running', 'paused', 'waiting_human'].includes(current.status) ? 1500 : false;
    },
  });
  const tasksQuery = useQuery({ queryKey: ['tasks'], queryFn: () => api.listTasks(10), refetchInterval: 15000 });

  const pipelines = pipelinesQuery.data?.pipelines ?? [];
  const agents = agentsQuery.data?.agents ?? [];
  const agentMap = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const activeTask = taskQuery.data?.task ?? null;
  const isActive = activeTask
    ? ['running', 'paused', 'waiting_human'].includes(activeTask.status)
    : false;
  const selectedPipeline = pipelines.find((item) => item.id === pipelineId) ?? pipelines[0] ?? null;

  useEffect(() => {
    if (!pipelineId && pipelines.length > 0) setPipelineId(pipelines[0].id);
  }, [pipelineId, pipelines]);

  const startMutation = useMutation({
    mutationFn: () => api.startTask({ task: task.trim(), pipelineId: selectedPipeline?.id ?? '' }),
    onSuccess: () => {
      setTask('');
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['status'] });
      toast.success('任务已开始');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const seedMutation = useMutation({
    mutationFn: api.seedDemo,
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.success('示例流水线已创建');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (pipelinesQuery.isLoading || agentsQuery.isLoading) {
    return (
      <div className="loading-panel">
        <Spinner size={22} /> 正在加载…
      </div>
    );
  }

  if (agents.length === 0 || pipelines.length === 0) {
    return (
      <div className="page-stack">
        <section className="card hero-card hero-card--empty">
          <div className="hero-copy">
            <div className="eyebrow">
              <Sparkles size={13} /> GET STARTED
            </div>
            <h2>搭建你的第一条智能体流水线</h2>
            <p>
              在画布上把智能体连成流程：每个智能体是一个节点，节点之间用带箭头的线交接。连线上的「任务触发提示词」会在下游启动时自动注入它的对话；终点节点的交付文件夹交给你验收。
            </p>
          </div>
          <div className="onboarding-steps">
            <div className="onboarding-step">
              <span className="step-number">1</span>
              <div>
                <strong>创建智能体</strong>
                <p>为每个工位配置岗位提示词、工具与技能。</p>
              </div>
              <Link className="button button--secondary button--sm" to="/agents">
                去创建
                <ArrowRight size={14} />
              </Link>
            </div>
            <div className="onboarding-step">
              <span className="step-number">2</span>
              <div>
                <strong>编排流水线</strong>
                <p>在画布上把智能体连成流程，为每条连线写任务触发提示词。</p>
              </div>
              <Link className="button button--secondary button--sm" to="/pipelines">
                去编排
                <ArrowRight size={14} />
              </Link>
            </div>
          </div>
          <div className="hero-actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => seedMutation.mutate()}
              disabled={seedMutation.isPending || agents.length > 0}
            >
              {seedMutation.isPending ? <Spinner size={15} /> : <Zap size={15} />}
              一键加载示例流水线
            </button>
            <span className="muted">包含策划、执行、审校三个工位与一条三步流水线，可作为起步模板直接改造使用</span>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="page-stack">
      {activeTask ? (
        <section className="card run-card">
          <div className="run-head">
            <div className="run-head-main">
              <div className="run-eyebrow">
                <span>{isActive ? '当前任务' : '本次任务'}</span>
                {(() => {
                  const meta = TASK_STATUS_META[activeTask.status];
                  return (
                    <Badge tone={meta.tone} dot={activeTask.status === 'running'}>
                      {meta.label}
                    </Badge>
                  );
                })()}
                <span className="run-time">
                  <Clock3 size={13} />
                  {formatDateTime(activeTask.createdAt)}
                  <span className="dot-sep">·</span>
                  {formatDuration(activeTask.createdAt, activeTask.finishedAt)}
                </span>
              </div>
              <h3 className="run-task">{activeTask.task}</h3>
              <div className="run-progress">
                <span>
                  <Workflow size={13} className="inline-icon" />
                  {activeTask.pipelineName || '流水线'} · 共 {activeTask.pipelineTotal || 0} 个节点
                  {activeTask.currentAgentName ? ` · 当前 ${activeTask.currentAgentName}` : ''}
                  {activeTask.status === 'waiting_human' ? ' · 等待你验收' : ''}
                </span>
              </div>
            </div>
            <div className="run-actions">
              {activeTask.status === 'paused' || activeTask.status === 'failed' ? (
                <>
                  <RetryTaskButton task={activeTask} />
                  <TerminateTaskButton taskId={activeTask.id} />
                </>
              ) : null}
              {activeTask.status === 'running' ? <TerminateTaskButton taskId={activeTask.id} /> : null}
            </div>
          </div>

          {activeTask.status === 'waiting_human' ? <HumanTakeoverPanel task={activeTask} /> : null}
          <TaskStatusBanner task={activeTask} />

          <TaskChain task={activeTask} onSelectTurn={setSelectedTurn} selectedTurnId={selectedTurn} />
        </section>
      ) : null}

      {!isActive ? (
        <section className="card start-card">
          <div className="start-head">
            <div className="start-icon">
              <Zap size={18} />
            </div>
            <div>
              <h3>发起一个新任务</h3>
              <p>描述目标、限制条件与期望产出，并选择一条流水线。任务会从起点节点开始，沿连线自动推进。</p>
            </div>
          </div>
          <textarea
            className="textarea start-textarea"
            placeholder="例如：为一款面向程序员的桌面机械键盘写一份 800 字左右的产品发布文案，突出三个卖点，并在工作目录中产出 Markdown 文件。"
            value={task}
            onChange={(event) => setTask(event.target.value)}
            rows={4}
          />
          <div className="start-foot start-foot--pipeline">
            <div className="start-pipeline-picker">
              <Workflow size={15} className="muted" />
              <select
                className="select"
                value={selectedPipeline?.id ?? ''}
                onChange={(event) => setPipelineId(event.target.value)}
              >
                {pipelines.map((pipeline) => (
                  <option key={pipeline.id} value={pipeline.id}>
                    {pipeline.name} · {pipeline.nodes.length} 个节点
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="button button--primary"
              disabled={!task.trim() || !selectedPipeline || startMutation.isPending}
              onClick={() => startMutation.mutate()}
            >
              {startMutation.isPending ? <Spinner size={15} /> : <Play size={15} />}
              开始任务
            </button>
          </div>
          {selectedPipeline ? (
            <div className="start-pipeline-preview">
              {(() => {
                const order = bfsNodeOrder(selectedPipeline);
                return order.map((node, index) => {
                  const agent = agentMap.get(node.agentId);
                  const terminal = isTerminalNode(selectedPipeline, node.id);
                  return (
                    <span className="start-pipeline-step" key={node.id} title={agent?.description ?? ''}>
                      <span className="start-pipeline-index">{index + 1}</span>
                      {agent ? <AgentAvatar name={agent.name} accent={agent.accent} size="sm" /> : <Bot size={14} />}
                      <span className="start-pipeline-label">
                        {agent?.name ?? '智能体已删除'}
                        <em>{terminal ? '终点' : '交接下游'}</em>
                      </span>
                      {index < order.length - 1 ? <ChevronRight size={13} className="muted" /> : null}
                      {terminal ? (
                        <Badge tone="warning">
                          <User size={11} className="inline-icon" />
                          交付给你
                        </Badge>
                      ) : null}
                    </span>
                  );
                });
              })()}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="card recent-card">
        <div className="section-head">
          <div>
            <h3>最近任务</h3>
            <p>保留每次任务的完整环节记录与产出，直到你执行一键清空。</p>
          </div>
        </div>
        {tasksQuery.isLoading ? (
          <div className="loading-inline">
            <Spinner size={16} /> 加载中…
          </div>
        ) : (tasksQuery.data?.tasks.length ?? 0) === 0 ? (
          <EmptyState
            icon={CircleDot}
            title="还没有任务"
            description="发起第一个任务后，历史会显示在这里。"
            compact
          />
        ) : (
          <div className="run-list">
            {tasksQuery.data!.tasks.map((item) => (
              <TaskRow key={item.id} task={item} />
            ))}
          </div>
        )}
      </section>

      <TurnDetailDrawer
        taskId={activeTask?.id ?? null}
        turnId={selectedTurn}
        open={Boolean(selectedTurn)}
        onClose={() => setSelectedTurn(null)}
      />
    </div>
  );
}

function TaskRow({ task }: { task: TaskSummary }) {
  const meta = TASK_STATUS_META[task.status];
  return (
    <Link className="run-row" to={`/tasks/${task.id}`}>
      <span className={cn('run-row-bar', `run-row-bar--${task.status}`)} />
      <div className="run-row-main">
        <div className="run-row-title">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <span>{truncate(task.task, 90)}</span>
        </div>
        <div className="run-row-meta">
          <span>{formatDateTime(task.createdAt)}</span>
          <span className="dot-sep">·</span>
          <span>
            <Workflow size={12} className="inline-icon" />
            {task.pipelineName || '流水线'} · {task.pipelineTotal || 0} 个节点
          </span>
          <span className="dot-sep">·</span>
          <span>{task.turnCount} 个环节</span>
          <span className="dot-sep">·</span>
          <span>{formatDuration(task.createdAt, task.finishedAt)}</span>
          {task.currentAgentName ? (
            <>
              <span className="dot-sep">·</span>
              <span>
                <Bot size={12} className="inline-icon" />
                {task.currentAgentName}
              </span>
            </>
          ) : null}
        </div>
      </div>
      <ChevronRight size={16} className="run-row-arrow" />
    </Link>
  );
}
