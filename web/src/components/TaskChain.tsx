import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Check,
  ChevronRight,
  Eye,
  FileText,
  FolderOpen,
  GitBranch,
  PauseCircle,
  RotateCcw,
  Square,
  User,
} from 'lucide-react';
import {
  bfsNodeOrder,
  isTerminalNode,
  type DeliverableFile,
  type Pipeline,
  type TaskSummary,
  type Turn,
} from '@shared/types';
import { api } from '../api';
import { AgentAvatar } from './AgentAvatar';
import { Badge } from './Badge';
import { ConfirmDialog } from './ConfirmDialog';
import { DeliverablePreviewModal } from './DeliverablePreview';
import { Field } from './Field';
import { Modal } from './Modal';
import { Spinner } from './Spinner';
import { useTurnActivity } from '../lib/activity';
import { cn, formatBytes, truncate, TURN_STATUS_META } from '../lib/format';
import { useToast } from '../lib/toast';

type TaskLike = TaskSummary & { turns?: Turn[]; pipeline?: Pipeline | null };

function targetLabel(turn: Turn): string {
  if (!turn.target) return '';
  if (turn.target.type === 'agent') return turn.target.agentName ?? '交接对象';
  if (turn.target.type === 'human') return '用户验收';
  return '任务结束';
}

/** 流水线进度：按连线图的 BFS 顺序展示节点（分支只展示主线顺序）。 */
export function PipelineProgress({ task }: { task: TaskLike }) {
  const pipeline = task.pipeline;
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: api.listAgents });
  const agentMap = useMemo(() => new Map((agentsQuery.data?.agents ?? []).map((a) => [a.id, a])), [agentsQuery.data]);
  const order = useMemo(() => (pipeline ? bfsNodeOrder(pipeline) : []), [pipeline]);
  if (!pipeline || order.length === 0) return null;
  const currentIndex = order.findIndex((node) => node.id === task.currentNodeId);
  // 任务已验收完成时，所有节点（含终点）都视为已完成；
  // 否则终点节点会因 currentNodeId 停在自己身上而一直显示「待用户验收」图标。
  const taskCompleted = task.status === 'completed';
  return (
    <div className="pipeline-progress" aria-label="流水线进度">
      {order.map((node, index) => {
        const agent = agentMap.get(node.agentId);
        const terminal = isTerminalNode(pipeline, node.id);
        const done = taskCompleted || (currentIndex >= 0 && index < currentIndex);
        const current = !taskCompleted && !done && index === currentIndex && task.status !== 'aborted';
        const upcoming = !done && !current && index > currentIndex;
        return (
          <Fragment key={node.id}>
            <div
              className={cn(
                'pipeline-progress-step',
                done && 'is-done',
                current && 'is-current',
                upcoming && 'is-upcoming',
              )}
              title={agent?.name ?? '（智能体已删除）'}
            >
              <span className="pipeline-progress-index">
                {done ? <Check size={11} /> : terminal ? <User size={11} /> : index + 1}
              </span>
              <span className="pipeline-progress-name">{agent?.name ?? '？'}</span>
            </div>
            {index < order.length - 1 ? (
              <span className={cn('pipeline-progress-line', done && 'is-done')} aria-hidden="true" />
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}

export function TaskChain({
  task,
  onSelectTurn,
  selectedTurnId,
}: {
  task: TaskLike;
  onSelectTurn: (turnId: string) => void;
  selectedTurnId?: string | null;
}) {
  const turns = task.turns ?? [];
  // 同一时刻只有一个回合在跑，取最后一个 running 的回合订阅生成心跳。
  const runningTurnId = [...turns].reverse().find((turn) => turn.status === 'running')?.id ?? null;
  const activity = useTurnActivity(runningTurnId);
  return (
    <>
      <PipelineProgress task={task} />
      <div className="stage-flow">
        {turns.map((turn, index) => {
          const meta = TURN_STATUS_META[turn.status];
          const active = turn.status === 'running';
          const live = active && runningTurnId === turn.id ? activity?.detail : null;
          return (
            <Fragment key={turn.id}>
              <button
                type="button"
                className={cn('stage-card', `stage-card--${turn.status}`)}
                onClick={() => onSelectTurn(turn.id)}
              >
                <div className="stage-card-top">
                  <span className="stage-number">{turn.seq}</span>
                  <Badge tone={meta.tone} dot={active}>
                    {meta.label}
                  </Badge>
                </div>
                <div className="stage-card-agent">
                  <AgentAvatar name={turn.agentName} accent={turn.agentAccent} size="sm" />
                  <div>
                    <strong>第 {turn.seq} 环节</strong>
                    <span>{turn.agentName}</span>
                  </div>
                </div>
                <div className="stage-card-output">
                  {turn.status === 'running'
                    ? live ?? '智能体正在处理中…'
                    : turn.status === 'failed'
                      ? turn.error ?? '执行失败'
                      : turn.status === 'aborted'
                        ? '本环节已终止'
                        : truncate(turn.output || (turn.handoffFolder ? `已交付文件夹「${turn.handoffFolder.name}」` : '（无文本产出）'), 150)}
                </div>
                <div className="stage-card-foot">
                  <span>
                    <FolderOpen size={13} />
                    {turn.handoffFolder ? `${turn.handoffFolder.files} 文件` : '未交接'}
                  </span>
                  {turn.target ? (
                    <span title={targetLabel(turn)}>
                      {turn.target.type === 'agent' ? <ArrowRight size={13} /> : <User size={13} />}
                      {targetLabel(turn)}
                    </span>
                  ) : null}
                  <span className="stage-open">
                    查看
                    <ArrowRight size={13} />
                  </span>
                </div>
              </button>
              {index < turns.length - 1 ? (
                <div className="stage-connector" aria-hidden="true">
                  <ChevronRight size={18} />
                </div>
              ) : null}
            </Fragment>
          );
        })}
        {task.status === 'waiting_human' ? (
          <>
            <div className="stage-connector" aria-hidden="true">
              <ChevronRight size={18} />
            </div>
            <div className="stage-card stage-card--waiting_confirmation">
              <div className="stage-card-top">
                <span className="stage-number">
                  <User size={13} />
                </span>
                <Badge tone="warning" dot>
                  待验收
                </Badge>
              </div>
              <div className="stage-card-agent">
                <span className="stage-human-slot">
                  <User size={18} />
                </span>
                <div>
                  <strong>流水线已跑完</strong>
                  <span>最后由你验收交付文件夹</span>
                </div>
              </div>
              <div className="stage-card-output">
                {turns.length > 0
                  ? truncate(
                      turns[turns.length - 1].output ||
                        (turns[turns.length - 1].handoffFolder
                          ? `已交付文件夹「${turns[turns.length - 1].handoffFolder?.name ?? ''}」`
                          : '（无文本产出）'),
                      150,
                    )
                  : '等待验收'}
              </div>
              {turns.length > 0 && turns[turns.length - 1].handoffFolder ? (
                <div className="stage-card-foot">
                  <span>
                    <FolderOpen size={13} />
                    交付文件夹（{turns[turns.length - 1].handoffFolder?.files ?? 0} 个文件）可在下方预览
                  </span>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}

/** 流水线跑完后的验收面板：预览交付文件夹内容并宣布完成。 */
export function HumanTakeoverPanel({ task }: { task: TaskLike }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [completeOpen, setCompleteOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<DeliverableFile | null>(null);

  const turns = task.turns ?? [];
  const handoverTurn =
    [...turns].reverse().find((turn) => turn.target?.type === 'human') ?? turns[turns.length - 1] ?? null;

  const filesQuery = useQuery({
    queryKey: ['deliverableList', task.id, handoverTurn?.id ?? ''],
    queryFn: () => api.listDeliverables(task.id, handoverTurn!.id),
    enabled: Boolean(handoverTurn && handoverTurn.handoffFolder),
    staleTime: 10_000,
  });
  const files = filesQuery.data?.files ?? [];

  const completeMutation = useMutation({
    mutationFn: () => api.completeTaskByHuman(task.id),
    onSuccess: () => {
      setCompleteOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['task', task.id] });
      void queryClient.invalidateQueries({ queryKey: ['status'] });
      toast.success('任务已完成');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="confirm-banner">
      <div className="confirm-banner-icon">
        <User size={22} />
      </div>
      <div className="confirm-banner-copy">
        <strong>流水线已跑完，等待你验收</strong>
        <p>
          终点环节的交付文件夹已复制到工作区 final\
          {handoverTurn?.handoffFolder
            ? `：${handoverTurn.handoffFolder.deliveredPath ?? handoverTurn.handoffFolder.path}（${formatBytes(handoverTurn.handoffFolder.bytes)}）`
            : ''}
          。下方可直接预览各文件，确认无误后宣布任务完成。
        </p>
        {handoverTurn && files.length > 0 ? (
          <div className="human-deliverables">
            <div className="human-deliverables-head">
              <FileText size={13} />
              最终交付物（{files.length} 个文件，点击可预览内容）
            </div>
            <div className="human-deliverable-list">
              {files.map((file) => (
                <button
                  type="button"
                  key={file.path}
                  className="human-deliverable"
                  title={file.path}
                  onClick={() => setPreviewFile(file)}
                >
                  <FileText size={14} />
                  <span className="human-deliverable-name">{file.name}</span>
                  <span className="human-deliverable-size">{formatBytes(file.size)}</span>
                  <Eye size={13} />
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="human-assign-row">
          <button
            type="button"
            className="button button--primary button--sm"
            onClick={() => setCompleteOpen(true)}
            disabled={completeMutation.isPending}
          >
            <CheckCircle2 size={14} />
            验收完成
          </button>
        </div>
      </div>
      {handoverTurn ? (
        <DeliverablePreviewModal
          taskId={task.id}
          turnId={handoverTurn.id}
          file={previewFile}
          open={Boolean(previewFile)}
          onClose={() => setPreviewFile(null)}
        />
      ) : null}
      <ConfirmDialog
        open={completeOpen}
        title="确认验收并结束任务？"
        description="任务将立即结束，之后不能再继续处理。"
        confirmLabel="完成任务"
        busy={completeMutation.isPending}
        onCancel={() => setCompleteOpen(false)}
        onConfirm={() => completeMutation.mutate()}
      />
    </div>
  );
}

export function TerminateTaskButton({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: () => api.terminateTask(taskId),
    onSuccess: () => {
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['task', taskId] });
      void queryClient.invalidateQueries({ queryKey: ['status'] });
      toast.info('任务已终止');
    },
    onError: (error: Error) => toast.error(error.message),
  });
  return (
    <>
      <button type="button" className="button button--danger-ghost" onClick={() => setOpen(true)}>
        <Square size={14} />
        终止
      </button>
      <ConfirmDialog
        open={open}
        title="终止这个任务？"
        description="正在执行的智能体会立即停止，任务不再继续。已产生的对话与文件会保留。"
        confirmLabel="终止任务"
        busy={mutation.isPending}
        onCancel={() => setOpen(false)}
        onConfirm={() => mutation.mutate()}
      />
    </>
  );
}

/** 暂停任务的操作入口：在当前节点重跑（可附补充指示）。 */
export function RetryTaskButton({ task }: { task: TaskLike }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');

  const mutation = useMutation({
    mutationFn: () => api.retryTask(task.id, { note: note.trim() || undefined }),
    onSuccess: () => {
      setOpen(false);
      setNote('');
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['task', task.id] });
      void queryClient.invalidateQueries({ queryKey: ['status'] });
      toast.success('已从当前节点重试');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const close = () => {
    if (mutation.isPending) return;
    setOpen(false);
    setNote('');
  };

  return (
    <>
      <button type="button" className="button button--primary" onClick={() => setOpen(true)}>
        <RotateCcw size={14} />
        重试本节点
      </button>
      <Modal
        open={open}
        onClose={close}
        title={`由「${task.currentAgentName || '当前节点智能体'}」重跑这一环节？`}
        description="会追加新的一个环节，由该智能体重做；已产生的对话、交付物与工作区文件都会保留。"
        footer={
          <>
            <button type="button" className="button button--ghost" onClick={close} disabled={mutation.isPending}>
              取消
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? <Spinner size={15} /> : <RotateCcw size={15} />}
              重试
            </button>
          </>
        }
      >
        <div className="callout callout--warning">
          <AlertCircle size={15} />
          新的环节会重新调用模型。若上次失败是模型输出过长或超时，可在下面写明补充指示，或先在设置里调大「模型请求超时」。
        </div>
        <Field label="给它的补充指示（可选）" hint="例如：先写大纲再补细节，单次输出不要超过 3000 字。">
          <textarea
            className="textarea"
            rows={4}
            value={note}
            maxLength={2000}
            onChange={(event) => setNote(event.target.value)}
            placeholder="这次希望它注意什么？"
          />
        </Field>
      </Modal>
    </>
  );
}

export function TaskStatusBanner({ task }: { task: TaskLike }) {
  const turns = task.turns ?? [];
  const who = task.currentAgentName ?? '当前节点';
  if (task.status === 'paused') {
    return (
      <div className="banner banner--danger">
        <PauseCircle size={16} />
        <div>
          <strong>流水线停在第 {task.pipelineStep || turns.length} 环节「{who}」</strong>
          <p>{task.error ?? '本环节执行失败'}。可以重试本节点，或终止任务。</p>
        </div>
      </div>
    );
  }
  if (task.status === 'failed') {
    return (
      <div className="banner banner--danger">
        <AlertCircle size={16} />
        <div>
          <strong>任务失败</strong>
          <p>{task.error ?? '未知错误'}</p>
        </div>
      </div>
    );
  }
  if (task.status === 'aborted') {
    return (
      <div className="banner banner--danger">
        <AlertCircle size={16} />
        <div>
          <strong>任务已终止</strong>
          <p>{task.error ?? ''}</p>
        </div>
      </div>
    );
  }
  if (task.status === 'completed') {
    return (
      <div className="banner banner--success">
        <CheckCircle2 size={16} />
        <div>
          <strong>任务已完成</strong>
          <p>共 {turns.length} 个环节，由用户验收确认。</p>
        </div>
      </div>
    );
  }
  if (task.status === 'running') {
    return (
      <div className="banner banner--info">
        <GitBranch size={16} />
        <div>
          <strong>
            正在跑第 {turns.length || 1} 环节 · {who}
          </strong>
          <p>本环节完成后，系统会按连线把交付文件夹交给交接对象并自动启动它。</p>
        </div>
      </div>
    );
  }
  return null;
}
