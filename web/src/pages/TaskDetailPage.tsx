import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Bot, Clock3, Workflow } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
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
import { formatDateTime, formatDuration, TASK_STATUS_META } from '../lib/format';

export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const [selectedTurn, setSelectedTurn] = useState<string | null>(null);

  const taskQuery = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api.getTask(taskId!),
    enabled: Boolean(taskId),
    refetchInterval: (query) => {
      const task = query.state.data?.task;
      return task && ['running', 'paused', 'waiting_human'].includes(task.status) ? 1500 : false;
    },
  });

  if (taskQuery.isLoading) {
    return (
      <div className="loading-panel">
        <Spinner size={22} /> 正在加载任务…
      </div>
    );
  }

  if (taskQuery.isError || !taskQuery.data) {
    return (
      <div className="error-panel">
        {(taskQuery.error as Error)?.message ?? '任务不存在'}
        <Link className="button button--secondary button--sm" to="/">
          <ArrowLeft size={14} />
          返回任务列表
        </Link>
      </div>
    );
  }

  const task = taskQuery.data.task;
  const meta = TASK_STATUS_META[task.status];
  const isActive = ['running', 'paused', 'waiting_human'].includes(task.status);

  return (
    <div className="page-stack">
      <section className="card run-card">
        <div className="run-head">
          <div className="run-head-main">
            <div className="run-eyebrow">
              <Link className="text-link" to="/">
                <ArrowLeft size={13} />
                任务列表
              </Link>
              <Badge tone={meta.tone} dot={task.status === 'running'}>
                {meta.label}
              </Badge>
              <span className="run-time">
                <Clock3 size={13} />
                {formatDateTime(task.createdAt)}
                <span className="dot-sep">·</span>
                {formatDuration(task.createdAt, task.finishedAt)}
              </span>
            </div>
            <h3 className="run-task">{task.task}</h3>
            <div className="run-progress">
              <span>
                <Workflow size={13} className="inline-icon" />
                {task.pipelineName || '流水线'} · 共 {task.pipelineTotal || 0} 个节点
                {task.currentAgentName ? (
                  <>
                    <span className="dot-sep">·</span>
                    <Bot size={12} className="inline-icon" />
                    {task.currentAgentName}
                  </>
                ) : null}
                {task.status === 'waiting_human' ? ' · 等待你验收' : ''}
              </span>
            </div>
          </div>
          <div className="run-actions">
            {task.status === 'paused' || task.status === 'failed' ? (
              <>
                <RetryTaskButton task={task} />
                <TerminateTaskButton taskId={task.id} />
              </>
            ) : null}
            {task.status === 'running' ? <TerminateTaskButton taskId={task.id} /> : null}
          </div>
        </div>

        {task.status === 'waiting_human' ? <HumanTakeoverPanel task={task} /> : null}
        <TaskStatusBanner task={task} />

        <TaskChain task={task} onSelectTurn={setSelectedTurn} selectedTurnId={selectedTurn} />
      </section>

      <TurnDetailDrawer
        taskId={task.id}
        turnId={selectedTurn}
        open={Boolean(selectedTurn)}
        onClose={() => setSelectedTurn(null)}
      />
    </div>
  );
}
