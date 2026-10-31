import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Bot, CircleDot, Pencil, Plus, Trash2, Workflow } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import type { Pipeline } from '@shared/types';
import { api } from '../api';
import { AgentAvatar } from '../components/AgentAvatar';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { Spinner } from '../components/Spinner';
import { useToast } from '../lib/toast';

export function PipelinesPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [deleteTarget, setDeleteTarget] = useState<Pipeline | null>(null);

  const pipelinesQuery = useQuery({ queryKey: ['pipelines'], queryFn: api.listPipelines });
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: api.listAgents });
  const pipelines = pipelinesQuery.data?.pipelines ?? [];
  const agents = agentsQuery.data?.agents ?? [];

  const agentMap = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deletePipeline(id),
    onSuccess: () => {
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['pipelines'] });
      toast.success('流水线已删除');
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

  return (
    <div className="page-stack">
      <div className="page-intro">
        <div>
          <h2>流水线</h2>
          <p>
            画布上每个节点是一个智能体，带箭头的连线就是交接规则：上游完成后交付一个文件夹，系统用连线上的「任务触发提示词」自动启动下游。没有出线的节点是终点，交付文件夹交给你验收。
          </p>
        </div>
        <button
          type="button"
          className="button button--primary"
          onClick={() => navigate('/pipelines/new')}
          disabled={agents.length === 0}
        >
          <Plus size={15} />
          新建流水线
        </button>
      </div>

      {agents.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Bot}
            title="还没有智能体"
            description="流水线上的每个节点都要绑定一个智能体，请先创建智能体。"
            action={
              <Link className="button button--primary" to="/agents">
                去创建智能体
                <ArrowRight size={14} />
              </Link>
            }
          />
        </div>
      ) : pipelines.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Workflow}
            title="还没有流水线"
            description="至少创建一条流水线，才能在任务页发起任务。"
            action={
              <button
                type="button"
                className="button button--primary"
                onClick={() => navigate('/pipelines/new')}
              >
                <Plus size={15} />
                创建第一条流水线
              </button>
            }
          />
        </div>
      ) : (
        <div className="pipeline-grid">
          {pipelines.map((pipeline) => (
            <article className="card pipeline-card" key={pipeline.id}>
              <div className="pipeline-card-head">
                <div>
                  <h3>{pipeline.name}</h3>
                  <p>{pipeline.description || '（无简介）'}</p>
                </div>
                <div className="pipeline-card-actions">
                  <button
                    type="button"
                    className="icon-button"
                    title="在画布上编辑"
                    onClick={() => navigate(`/pipelines/${pipeline.id}/edit`)}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-button icon-button--danger"
                    title="删除"
                    onClick={() => setDeleteTarget(pipeline)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>

              <div className="pipeline-chain">
                <div className="pipeline-node">
                  {pipeline.nodes.slice(0, 8).map((node) => {
                    const agent = agentMap.get(node.agentId);
                    return (
                      <span className="pipeline-node-chip" key={node.id} title={agent?.description ?? ''}>
                        {agent ? <AgentAvatar name={agent.name} accent={agent.accent} size="sm" /> : <Bot size={16} />}
                        <span>{agent?.name ?? '已删除'}</span>
                      </span>
                    );
                  })}
                  {pipeline.nodes.length > 8 ? <span className="muted">…共 {pipeline.nodes.length} 个节点</span> : null}
                </div>
              </div>

              <div className="pipeline-card-foot">
                <span>
                  <CircleDot size={13} />
                  {pipeline.nodes.length} 个节点 · {pipeline.edges.length} 条连线
                </span>
                <Link className="text-link" to={`/?pipeline=${encodeURIComponent(pipeline.id)}`}>
                  用它发起任务
                  <ArrowRight size={13} />
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`删除流水线「${deleteTarget?.name ?? ''}」？`}
        description="只删除流水线配置，不影响智能体和历史任务；历史任务使用启动时的快照。"
        confirmLabel="删除流水线"
        busy={deleteMutation.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
      />
    </div>
  );
}
