import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ReactFlow,
  ReactFlowProvider,
  getNodesBounds,
  getViewportForBounds,
  useReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Bot,
  ChevronLeft,
  GitBranch,
  Info,
  Play,
  Plus,
  Save,
  Trash2,
  User,
  Workflow,
  X,
} from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DESIGNER_SLUG, type Agent, type Pipeline, type PipelineInput } from '@shared/types';
import { api } from '../api';
import { AgentAvatar } from '../components/AgentAvatar';
import { Badge } from '../components/Badge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { Field } from '../components/Field';
import { Modal } from '../components/Modal';
import { Spinner } from '../components/Spinner';
import { cn, truncate } from '../lib/format';
import { useToast } from '../lib/toast';

/** 拖拽传输智能体 ID 的 dataTransfer 类型。 */
const DRAG_MIME = 'application/x-ateam-agent';

/** 画布节点近似尺寸（.flow-agent-node 宽 212），落点取鼠标处居中。 */
const NODE_HALF_WIDTH = 106;
const NODE_HALF_HEIGHT = 50;

interface DraftNode {
  id: string;
  agentId: string;
  isStart: boolean;
  x: number;
  y: number;
  /** 画布节点的测量尺寸（React Flow 经 dimensions 变更回传）。受控模式下必须存回草稿，
   * 否则每次渲染节点都被视为“未测量”而保持 visibility:hidden，鼠标事件全部落到画布上。 */
  width?: number;
  height?: number;
}

interface DraftEdge {
  id: string;
  from: string;
  to: string;
  triggerPrompt: string;
  handoffCondition: string;
}

interface Draft {
  name: string;
  description: string;
  nodes: DraftNode[];
  edges: DraftEdge[];
}

function newId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  return `node-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function emptyDraft(): Draft {
  return { name: '', description: '', nodes: [], edges: [] };
}

function pipelineToDraft(pipeline: Pipeline): Draft {
  return {
    name: pipeline.name,
    description: pipeline.description,
    nodes: pipeline.nodes.map((node) => ({
      id: node.id,
      agentId: node.agentId,
      isStart: node.isStart,
      x: node.x,
      y: node.y,
    })),
    edges: pipeline.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      triggerPrompt: edge.triggerPrompt,
      handoffCondition: edge.handoffCondition,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* 画布节点：智能体卡片                                                 */
/* ------------------------------------------------------------------ */

interface AgentNodeData extends Record<string, unknown> {
  agent: Agent | null;
  isStart: boolean;
  isTerminal: boolean;
  outCount: number;
  onRemove: (id: string) => void;
  onToggleStart: (id: string) => void;
}

function AgentFlowNode({ id, data }: NodeProps & { id: string; data: AgentNodeData }) {
  const { agent, isStart, isTerminal, outCount, onRemove, onToggleStart } = data;
  return (
    <div className={cn('flow-agent-node', isStart && 'is-start', isTerminal && 'is-terminal')}>
      <Handle type="target" position={Position.Left} className="flow-handle" />
      {isStart ? (
        <button
          type="button"
          className="flow-node-start is-on"
          title="起点：用户任务直接交给它（点击取消）"
          onClick={(event) => {
            event.stopPropagation();
            onToggleStart(id);
          }}
        >
          <Play size={11} />
          起点
        </button>
      ) : (
        <button
          type="button"
          className="flow-node-start"
          title="设为起点：用户任务直接交给这个节点"
          onClick={(event) => {
            event.stopPropagation();
            onToggleStart(id);
          }}
        >
          <Play size={11} />
        </button>
      )}
      <button
        type="button"
        className="flow-node-remove"
        title="从画布移除该节点（同时删除相关连线）"
        onClick={(event) => {
          event.stopPropagation();
          onRemove(id);
        }}
      >
        <X size={12} />
      </button>
      {agent ? (
        <>
          <div className="flow-node-head">
            <AgentAvatar name={agent.name} accent={agent.accent} size="sm" />
            <strong>{agent.name}</strong>
          </div>
          <p className="flow-node-desc">{truncate(agent.description || '（无描述）', 40)}</p>
          <div className="flow-node-badges">
            {isStart ? <Badge tone="accent">起点</Badge> : null}
            {isTerminal ? (
              <Badge tone="warning">
                <User size={10} className="inline-icon" />
                终点·交用户
              </Badge>
            ) : (
              <Badge tone="neutral">{outCount} 个交接对象</Badge>
            )}
            {outCount > 1 ? (
              <Badge tone="info">
                <GitBranch size={10} className="inline-icon" />
                需交接条件
              </Badge>
            ) : null}
          </div>
        </>
      ) : (
        <div className="flow-node-head">
          <Bot size={18} />
          <strong>智能体已删除</strong>
        </div>
      )}
      <Handle type="source" position={Position.Right} className="flow-handle" />
    </div>
  );
}

const nodeTypes = { agent: AgentFlowNode };

/* ------------------------------------------------------------------ */
/* 页面：/pipelines/new 与 /pipelines/:pipelineId/edit                  */
/* ------------------------------------------------------------------ */

export function PipelineEditorPage() {
  return (
    <ReactFlowProvider>
      <PipelineEditor />
    </ReactFlowProvider>
  );
}

function PipelineEditor() {
  const { pipelineId } = useParams<{ pipelineId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const reactFlow = useReactFlow();

  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [baseline, setBaseline] = useState<string>(() => JSON.stringify(emptyDraft()));
  const [initialized, setInitialized] = useState(false);
  const [edgeModalId, setEdgeModalId] = useState<string | null>(null);
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const [dragOverCanvas, setDragOverCanvas] = useState(false);
  const [draggingAgentId, setDraggingAgentId] = useState<string | null>(null);

  const pipelinesQuery = useQuery({ queryKey: ['pipelines'], queryFn: api.listPipelines });
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: api.listAgents });
  const agents = agentsQuery.data?.agents ?? [];
  const agentMap = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const editing = useMemo(
    () => (pipelineId ? pipelinesQuery.data?.pipelines.find((item) => item.id === pipelineId) ?? null : null),
    [pipelineId, pipelinesQuery.data],
  );

  // 编辑模式：等数据就绪后把流水线转成草稿（只初始化一次）。
  useEffect(() => {
    if (initialized) return;
    if (!pipelineId) {
      setBaseline(JSON.stringify(emptyDraft()));
      setInitialized(true);
      return;
    }
    if (pipelinesQuery.isLoading || !editing) return;
    const loaded = pipelineToDraft(editing);
    setDraft(loaded);
    setBaseline(JSON.stringify(loaded));
    setInitialized(true);
  }, [initialized, pipelineId, pipelinesQuery.isLoading, editing]);

  // 编辑模式下自动适配视口一次（等节点测量完成后直接 setViewport，绕开 fitView 的队列机制——
  // 受控模式下 reactFlow.fitView() 依赖后续渲染 flush 队列，可能永远挂起）；
  // 新建模式绝不自动 fit——fitView 会把视口缩放/平移，导致刚拖到光标处的卡片“滑走”，
  // 用户再按原位置抓取时按到的是画布背景（表现为“拖卡片却平移整个画布”）。
  const didFitRef = useRef(false);
  useEffect(() => {
    if (!pipelineId || !initialized || draft.nodes.length === 0) return;
    let cancelled = false;
    let attempts = 0;
    const tryFit = () => {
      if (cancelled || didFitRef.current) return;
      attempts += 1;
      const rect = canvasRef.current?.getBoundingClientRect();
      // 受控模式下 getNodes() 只是 props 镜像、measured 恒为空；尺寸在内部 nodeLookup 里
      const internalNodes = draft.nodes
        .map((node) => reactFlow.getInternalNode(node.id))
        .filter((node): node is NonNullable<typeof node> => node != null);
      const ready =
        internalNodes.length === draft.nodes.length &&
        rect != null &&
        internalNodes.every((node) => (node.measured?.width ?? 0) > 0 && (node.measured?.height ?? 0) > 0);
      if (ready && rect) {
        const bounds = getNodesBounds(internalNodes);
        const viewport = getViewportForBounds(bounds, rect.width, rect.height, 0.3, 1.5, 0.12);
        void reactFlow.setViewport(viewport, { duration: 200 });
        didFitRef.current = true;
        return;
      }
      if (attempts < 40 && !cancelled) window.setTimeout(tryFit, 80);
    };
    tryFit();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineId, initialized]);

  // onConnect / 拖拽落点等回调里读取最新草稿，避免闭包过期。
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const canvasRef = useRef<HTMLDivElement>(null);

  const dirty = JSON.stringify(draft) !== baseline;
  const placedAgentIds = new Set(draft.nodes.map((node) => node.agentId));
  // 设计师是系统管理员，不参与任务交付，不能作为流水线节点。
  const availableAgents = agents.filter(
    (agent) => agent.slug !== DESIGNER_SLUG && !placedAgentIds.has(agent.id),
  );

  function addAgentToCanvas(agent: Agent, position?: { x: number; y: number }) {
    const current = draftRef.current;
    if (current.nodes.some((node) => node.agentId === agent.id)) {
      toast.info(`「${agent.name}」已在画布上：同一个智能体只能添加一次`);
      return;
    }
    if (current.nodes.length >= 30) {
      toast.error('一条流水线最多 30 个节点');
      return;
    }
    setDraft((c) => {
      const index = c.nodes.length;
      const pos = position ?? { x: 80 + (index % 4) * 260, y: 60 + Math.floor(index / 4) * 200 };
      return {
        ...c,
        nodes: [
          ...c.nodes,
          { id: newId(), agentId: agent.id, isStart: index === 0, x: Math.round(pos.x), y: Math.round(pos.y) },
        ],
      };
    });
  }

  function toggleStart(nodeId: string) {
    setDraft((current) => {
      const target = current.nodes.find((node) => node.id === nodeId);
      if (!target) return current;
      const turningOff = target.isStart;
      return {
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === nodeId ? { ...node, isStart: !turningOff } : turningOff ? node : { ...node, isStart: false },
        ),
      };
    });
  }

  function removeNode(nodeId: string) {
    setDraft((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => node.id !== nodeId),
      edges: current.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
    }));
  }

  const onNodesChange = useCallback((changes: NodeChange<Node>[]) => {
    setDraft((current) => {
      let nodes = current.nodes;
      let changed = false;
      const removed = new Set<string>();
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          const { x, y } = change.position;
          nodes = nodes.map((node) => (node.id === change.id ? { ...node, x, y } : node));
          changed = true;
        } else if (change.type === 'dimensions' && change.dimensions) {
          const { width, height } = change.dimensions;
          if (nodes.some((node) => node.id === change.id && (node.width !== width || node.height !== height))) {
            nodes = nodes.map((node) =>
              node.id === change.id ? { ...node, width, height } : node,
            );
            changed = true;
          }
        } else if (change.type === 'remove') {
          removed.add(change.id);
        }
      }
      if (removed.size === 0) return changed ? { ...current, nodes } : current;
      const keptNodes = nodes.filter((node) => !removed.has(node.id));
      return {
        ...current,
        nodes: keptNodes,
        edges: current.edges.filter((edge) => !removed.has(edge.from) && !removed.has(edge.to)),
      };
    });
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => {
    setDraft((current) => {
      const removed = changes.filter((change) => change.type === 'remove').map((change) => change.id);
      if (removed.length === 0) return current;
      return { ...current, edges: current.edges.filter((edge) => !removed.includes(edge.id)) };
    });
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const from = connection.source;
    const to = connection.target;
    if (draftRef.current.edges.some((edge) => edge.from === from && edge.to === to)) return;
    const id = newId();
    setDraft((current) => ({
      ...current,
      edges: [...current.edges, { id, from, to, triggerPrompt: '', handoffCondition: '' }],
    }));
    // 新建的连线立即打开表单填写触发提示词
    setEdgeModalId(id);
  }, []);

  /* 拖拽：从右侧列表拖智能体到画布落点 */

  function onCanvasDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes(DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!dragOverCanvas) setDragOverCanvas(true);
  }

  function onCanvasDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) return;
    setDragOverCanvas(false);
  }

  function onCanvasDrop(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOverCanvas(false);
    setDraggingAgentId(null);
    const agentId = event.dataTransfer.getData(DRAG_MIME);
    const agent = agentId ? agentMap.get(agentId) : undefined;
    if (!agent) return;
    const point = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    addAgentToCanvas(agent, { x: point.x - NODE_HALF_WIDTH, y: point.y - NODE_HALF_HEIGHT });
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const name = draft.name.trim();
      if (!name) throw new Error('请填写流水线名称');
      if (draft.nodes.length === 0) throw new Error('先把智能体拖到画布上，再保存流水线');
      if (new Set(draft.nodes.map((node) => node.agentId)).size !== draft.nodes.length) {
        throw new Error('同一个智能体只能是一个节点');
      }
      const startCount = draft.nodes.filter((node) => node.isStart).length;
      if (draft.nodes.length > 1 && startCount !== 1) {
        throw new Error(startCount === 0 ? '请在画布上把一个节点标记为起点（用户任务直接交给它）' : `起点必须唯一，当前标了 ${startCount} 个起点`);
      }
      const nameOf = (nodeId: string) =>
        agentMap.get(draft.nodes.find((node) => node.id === nodeId)?.agentId ?? '')?.name ?? '？';
      for (const edge of draft.edges) {
        if (!edge.triggerPrompt.trim()) {
          throw new Error(`连线「${nameOf(edge.from)} → ${nameOf(edge.to)}」还没有填写任务触发提示词，点击连线可补填`);
        }
      }
      const outCount = new Map<string, number>();
      for (const edge of draft.edges) outCount.set(edge.from, (outCount.get(edge.from) ?? 0) + 1);
      for (const edge of draft.edges) {
        if ((outCount.get(edge.from) ?? 0) >= 2 && !edge.handoffCondition.trim()) {
          throw new Error(`「${nameOf(edge.from)}」有多个交接对象，连线「${nameOf(edge.from)} → ${nameOf(edge.to)}」必须填写交接条件`);
        }
      }
      const payload: PipelineInput = {
        name,
        description: draft.description.trim(),
        nodes: draft.nodes.map((node) => ({
          id: node.id,
          agentId: node.agentId,
          isStart: node.isStart || draft.nodes.length === 1,
          x: Math.round(node.x),
          y: Math.round(node.y),
        })),
        edges: draft.edges.map((edge) => ({
          id: edge.id,
          from: edge.from,
          to: edge.to,
          triggerPrompt: edge.triggerPrompt.trim(),
          handoffCondition: edge.handoffCondition.trim(),
        })),
      };
      if (editing) return api.updatePipeline(editing.id, payload);
      return api.createPipeline(payload);
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['pipelines'] });
      void queryClient.invalidateQueries({ queryKey: ['status'] });
      toast.success(editing ? '流水线已更新' : `流水线「${data.pipeline.name}」已创建`);
      navigate('/pipelines');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function goBack() {
    navigate('/pipelines');
  }

  function tryCancel() {
    if (dirty && !saveMutation.isPending) {
      setConfirmAbandon(true);
      return;
    }
    goBack();
  }

  if (pipelinesQuery.isLoading || agentsQuery.isLoading || !initialized) {
    return (
      <div className="loading-panel">
        <Spinner size={22} /> 正在加载…
      </div>
    );
  }

  if (pipelineId && !editing) {
    return (
      <div className="card">
        <EmptyState
          icon={Workflow}
          title="流水线不存在或已被删除"
          description="这条流水线可能已被删除，返回列表重新选择。"
          action={
            <Link className="button button--primary" to="/pipelines">
              返回流水线列表
            </Link>
          }
        />
      </div>
    );
  }

  /* React Flow 视图：从 draft 派生 */
  const flowNodes: Node[] = draft.nodes.map((node) => {
    const outgoing = draft.edges.filter((edge) => edge.from === node.id);
    return {
      id: node.id,
      type: 'agent',
      position: { x: node.x, y: node.y },
      // 受控模式下 React Flow 重建内部节点时只认用户节点上的 measured；
      // 不回传的话节点会在每次渲染后回到未测量（visibility:hidden）状态。
      measured:
        node.width != null && node.height != null ? { width: node.width, height: node.height } : undefined,
      data: {
        agent: agentMap.get(node.agentId) ?? null,
        isStart: node.isStart || draft.nodes.length === 1,
        isTerminal: outgoing.length === 0,
        outCount: outgoing.length,
        onRemove: removeNode,
        onToggleStart: toggleStart,
      },
    };
  });

  const flowEdges: Edge[] = draft.edges.map((edge) => {
    const outCount = draft.edges.filter((item) => item.from === edge.from).length;
    const invalid = !edge.triggerPrompt.trim() || (outCount >= 2 && !edge.handoffCondition.trim());
    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: 'default',
      markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: invalid ? '#f472b6' : '#6d8cff' },
      style: { stroke: invalid ? '#f472b6' : '#6d8cff', strokeWidth: 2, strokeDasharray: edge.triggerPrompt.trim() ? undefined : '6 4' },
      label: invalid ? '待填写' : undefined,
      labelStyle: { fill: '#f9a8d4', fontSize: 11 },
      data: { edge },
    };
  });

  return (
    <div className="page-stack pipeline-editor-page">
      <div className="page-intro">
        <div>
          <Link className="text-link pipeline-editor-back" to="/pipelines">
            <ChevronLeft size={13} />
            返回流水线列表
          </Link>
          <h2>{editing ? `编辑流水线：${editing.name}` : '新建流水线'}</h2>
          <p>
            把右侧智能体拖到画布（或点击添加；同一智能体只能上画布一次）。拖动节点排布；点击节点左上角的 ▶
            把「接手用户任务的节点」设为起点（全图恰好一个）；从节点右侧圆点拖到另一节点的左侧圆点即连线；点击连线填写任务触发提示词（多出边时还要填交接条件）。
          </p>
        </div>
        <div className="button-row">
          <button type="button" className="button button--ghost" onClick={tryCancel} disabled={saveMutation.isPending}>
            取消
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !draft.name.trim() || draft.nodes.length === 0}
          >
            {saveMutation.isPending ? <Spinner size={15} /> : <Save size={15} />}
            {editing ? '保存修改' : '创建流水线'}
          </button>
        </div>
      </div>

      <div className="editor-section">
        <div className="form-grid form-grid--2">
          <Field label="流水线名称" required hint="在任务列表中显示。">
            <input
              className="input"
              value={draft.name}
              maxLength={60}
              placeholder="例如：产品-研发-测试"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>
          <Field label="一句话简介" hint="会注入每个智能体的提示词，帮助它理解整条流水线的目标。">
            <input
              className="input"
              value={draft.description}
              maxLength={500}
              placeholder="例如：从 PRD 到架构设计再到评审"
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </Field>
        </div>

        <div className="flow-editor">
          <div
            ref={canvasRef}
            className={cn('flow-editor-canvas', dragOverCanvas && 'is-drop-over')}
            onDragOver={onCanvasDragOver}
            onDragLeave={onCanvasDragLeave}
            onDrop={onCanvasDrop}
          >
            {draft.nodes.length === 0 ? (
              <div className="flow-editor-empty">
                <Workflow size={22} />
                <strong>画布还是空的</strong>
                <p>{dragOverCanvas ? '松手，把智能体放到这里' : '把右侧智能体拖到画布（或点击添加），再拖线连接它们。'}</p>
              </div>
            ) : null}
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onEdgeClick={(_, edge) => setEdgeModalId(edge.id)}
              minZoom={0.3}
              proOptions={{ hideAttribution: true }}
              deleteKeyCode={['Backspace', 'Delete']}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1.5} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>

          <aside className="flow-editor-side">
            <div className="flow-side-head">
              <strong>智能体</strong>
              <span className="muted">拖到画布，或点击添加</span>
            </div>
            {availableAgents.length === 0 ? (
              <p className="muted flow-side-hint">
                {agents.length === 0 ? '还没有智能体，请先在「智能体」页创建。' : '所有智能体都已在画布上。'}
              </p>
            ) : (
              <div className="flow-side-list">
                {availableAgents.map((agent) => (
                  <div
                    key={agent.id}
                    className={cn('flow-side-item', draggingAgentId === agent.id && 'is-dragging')}
                    role="button"
                    tabIndex={0}
                    title={`拖到画布，或点击添加「${agent.name}」`}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData(DRAG_MIME, agent.id);
                      event.dataTransfer.setData('text/plain', agent.name);
                      event.dataTransfer.effectAllowed = 'copy';
                      setDraggingAgentId(agent.id);
                    }}
                    onDragEnd={() => setDraggingAgentId(null)}
                    onClick={() => addAgentToCanvas(agent)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        addAgentToCanvas(agent);
                      }
                    }}
                  >
                    <AgentAvatar name={agent.name} accent={agent.accent} size="sm" />
                    <span className="flow-side-main">
                      <strong>{agent.name}</strong>
                      <em>{truncate(agent.description || '（无描述）', 32)}</em>
                    </span>
                    <Plus size={14} />
                  </div>
                ))}
              </div>
            )}
            <div className="flow-side-help">
              <Info size={14} />
              <p>
                <strong>任务触发提示词</strong>
                ：连线必填，下游启动时作为它的第一条用户消息注入。可用占位符：{'{deliverables}'}＝上游交付目录、
                {'{task}'}＝原始任务、{'{sender}'}＝上游智能体名。
              </p>
              <p>
                <strong>交接条件</strong>
                ：某个节点连出 2 条以上的线时每条必填，会写进该节点智能体的系统提示词，指导它交接时用 target 选择交给谁。
              </p>
              <p><strong>起点</strong>：节点左上角 ▶ 标记，用户任务直接交给它，全图恰好一个。</p>
              <p><strong>终点</strong>：没有出线的节点，交付文件夹复制到 final\ 交给你验收。</p>
            </div>
          </aside>
        </div>
      </div>

      <EdgeFormModal
        draft={draft}
        edgeId={edgeModalId}
        agentMap={agentMap}
        onClose={() => setEdgeModalId(null)}
        onPatch={(edgeId, patch) =>
          setDraft((current) => ({
            ...current,
            edges: current.edges.map((edge) => (edge.id === edgeId ? { ...edge, ...patch } : edge)),
          }))
        }
        onDelete={(edgeId) => {
          setDraft((current) => ({ ...current, edges: current.edges.filter((edge) => edge.id !== edgeId) }));
          setEdgeModalId(null);
        }}
      />

      <ConfirmDialog
        open={confirmAbandon}
        title="放弃未保存的修改？"
        description="画布上的改动还没有保存，返回列表后这些修改会丢失。"
        confirmLabel="放弃修改"
        busy={saveMutation.isPending}
        onCancel={() => setConfirmAbandon(false)}
        onConfirm={() => {
          setConfirmAbandon(false);
          goBack();
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 连线表单：任务触发提示词 + 交接条件                                   */
/* ------------------------------------------------------------------ */

function EdgeFormModal({
  draft,
  edgeId,
  agentMap,
  onClose,
  onPatch,
  onDelete,
}: {
  draft: Draft;
  edgeId: string | null;
  agentMap: Map<string, Agent>;
  onClose: () => void;
  onPatch: (edgeId: string, patch: Partial<DraftEdge>) => void;
  onDelete: (edgeId: string) => void;
}) {
  const edge = edgeId ? draft.edges.find((item) => item.id === edgeId) ?? null : null;
  if (!edge) return null;
  const sourceName = agentNameOf(draft, agentMap, edge.from);
  const targetName = agentNameOf(draft, agentMap, edge.to);
  const outCount = draft.edges.filter((item) => item.from === edge.from).length;
  const conditionRequired = outCount >= 2;
  const canSave = edge.triggerPrompt.trim().length > 0 && (!conditionRequired || edge.handoffCondition.trim().length > 0);

  return (
    <Modal
      open
      onClose={onClose}
      width={640}
      title={
        <span className="drawer-title">
          <GitBranch size={15} />
          连线：{sourceName} → {targetName}
        </span>
      }
      description={
        sourceName === targetName ? null : (
          <span className="muted">
            {sourceName}完成工作并交付文件夹后，系统按这条连线启动 {targetName}，并把下面的触发提示词作为它的第一条用户消息。
          </span>
        )
      }
      footer={
        <div className="button-row button-row--split">
          <button type="button" className="button button--danger-ghost" onClick={() => onDelete(edge.id)}>
            <Trash2 size={14} />
            删除连线
          </button>
          <div className="button-row">
            <button type="button" className="button button--ghost" onClick={onClose}>
              关闭
            </button>
            <button type="button" className="button button--secondary" disabled={!canSave} onClick={onClose}>
              这个连线先这样
            </button>
          </div>
        </div>
      }
    >
      <Field
        label="任务触发提示词"
        required
        hint="运行时替换占位符后注入下游。{deliverables}＝交付目录在其工作区的路径；{task}＝原始任务；{sender}＝上游智能体名。"
      >
        <textarea
          className="textarea"
          rows={5}
          value={edge.triggerPrompt}
          maxLength={20_000}
          placeholder={`例如：${sourceName}已完成 PRD 编写，PRD 文件目录：{deliverables}，请开始设计项目架构`}
          onChange={(event) => onPatch(edge.id, { triggerPrompt: event.target.value })}
        />
      </Field>
      <Field
        label={conditionRequired ? '交接条件' : '交接条件（可选）'}
        required={conditionRequired}
        hint={
          conditionRequired
            ? `「${sourceName}」有 ${outCount} 个交接对象：写清什么情况下才交给「${targetName}」，这段会注入它的系统提示词。`
            : '唯一交接对象时无需交接条件，交接后系统自动走这条线。'
        }
      >
        <textarea
          className="textarea"
          rows={3}
          value={edge.handoffCondition}
          maxLength={20_000}
          placeholder={conditionRequired ? `例如：审核通过、无阻塞问题时交给${targetName}；发现需返工的问题时交给上游` : ''}
          onChange={(event) => onPatch(edge.id, { handoffCondition: event.target.value })}
        />
      </Field>
      {conditionRequired && !edge.handoffCondition.trim() ? (
        <div className="callout callout--warning">
          <Info size={15} />
          同一条线上还有其它 {outCount - 1} 条出边：每条出边都必须填写交接条件，否则无法保存。
        </div>
      ) : null}
    </Modal>
  );
}

function agentNameOf(draft: Draft, agentMap: Map<string, Agent>, nodeId: string): string {
  const node = draft.nodes.find((item) => item.id === nodeId);
  if (!node) return '？';
  return agentMap.get(node.agentId)?.name ?? '（智能体已删除）';
}
