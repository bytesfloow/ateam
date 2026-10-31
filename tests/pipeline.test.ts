import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../server/src/db';
import { Store } from '../server/src/store';

let root: string;
let db: ReturnType<typeof openDatabase>;
let store: Store;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-pipeline-'));
  db = openDatabase(':memory:');
  store = new Store({ db, workspaceRoot: root });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('pipeline store', () => {
  it('creates, lists, updates and deletes pipelines', () => {
    const first = randomUUID();
    const second = randomUUID();
    const planner = store.createAgent({ name: '策划' });
    const maker = store.createAgent({ name: '执行' });

    const pipeline = store.createPipeline({
      name: '交付流水线',
      description: '从需求到交付',
      nodes: [
        { id: first, agentId: planner.id, isStart: true, x: 0, y: 100 },
        { id: second, agentId: maker.id, x: 300, y: 100 },
      ],
      edges: [
        {
          id: 'e1',
          from: first,
          to: second,
          triggerPrompt: '策划已完成，交付目录：{deliverables}，请开始产出',
        },
      ],
    });

    expect(pipeline.name).toBe('交付流水线');
    expect(pipeline.description).toBe('从需求到交付');
    expect(pipeline.nodes.map((node) => node.agentId)).toEqual([planner.id, maker.id]);
    expect(pipeline.nodes[0].isStart).toBe(true);
    expect(pipeline.nodes[0].x).toBe(0);
    expect(pipeline.edges.map((edge) => edge.id)).toEqual(['e1']);
    expect(pipeline.createdAt).toBeTruthy();

    expect(store.listPipelines().map((item) => item.id)).toEqual([pipeline.id]);
    expect(store.getPipeline(pipeline.id)).toMatchObject({ name: '交付流水线' });

    // 未提供节点 id / 连线 id 时由服务端生成。
    const auto = store.createPipeline({
      name: '单节点流水线',
      nodes: [{ agentId: planner.id }],
    });
    expect(auto.nodes[0].id).toBeTruthy();
    expect(auto.nodes[0].id).not.toBe(first);
    expect(auto.nodes[0].x).toBe(0);
    expect(auto.edges).toEqual([]);
    expect(store.listPipelines()).toHaveLength(2);

    const updated = store.updatePipeline(pipeline.id, {
      name: '交付流水线 v2',
      description: '改版说明',
      nodes: [
        { id: first, agentId: planner.id, isStart: true, x: 10, y: 20 },
        { id: second, agentId: maker.id, x: 310, y: 20 },
      ],
      edges: [
        { id: 'e1', from: first, to: second, triggerPrompt: '新触发提示词', handoffCondition: '' },
      ],
    });
    expect(updated.name).toBe('交付流水线 v2');
    expect(updated.nodes[0].x).toBe(10);
    expect(updated.edges[0].triggerPrompt).toBe('新触发提示词');
    expect(updated.nodes[0].id).toBe(first);

    expect(() =>
      store.createPipeline({ name: '单节点流水线', nodes: [{ agentId: maker.id }] }),
    ).toThrow(/同名流水线/);

    expect(store.deletePipeline(auto.id).id).toBe(auto.id);
    expect(store.getPipeline(auto.id)).toBeNull();
    expect(store.listPipelines()).toHaveLength(1);
    expect(() => store.deletePipeline('00000000-0000-4000-8000-000000000000')).toThrow(/流水线不存在/);
  });

  it('validates nodes, edges and graph rules', () => {
    const planner = store.createAgent({ name: '策划' });
    const maker = store.createAgent({ name: '执行' });

    expect(() => store.createPipeline({ name: '空流水线', nodes: [] })).toThrow(/至少需要一个/);
    expect(() =>
      store.createPipeline({
        name: '重复智能体',
        nodes: [{ agentId: planner.id }, { agentId: planner.id }],
      }),
    ).toThrow(/只能是一个节点/);
    expect(() =>
      store.createPipeline({ name: '坏智能体', nodes: [{ agentId: 'missing-agent' }] }),
    ).toThrow(/智能体不存在/);

    const startId = randomUUID();
    const midId = randomUUID();
    const endId = randomUUID();

    // 连线缺触发提示词 → 拒绝（路由 zod 层限制 min(1)，store 层同样兜底）。
    expect(() =>
      store.createPipeline({
        name: '缺提示词',
        nodes: [{ id: startId, agentId: planner.id }, { id: endId, agentId: maker.id }],
        edges: [{ from: startId, to: endId, triggerPrompt: '  ' }],
      }),
    ).toThrow(/任务触发提示词/);

    // 自环 → 拒绝。
    expect(() =>
      store.createPipeline({
        name: '自环',
        nodes: [{ id: startId, agentId: planner.id }, { id: endId, agentId: maker.id }],
        edges: [{ from: startId, to: startId, triggerPrompt: '交给自己' }],
      }),
    ).toThrow(/不允许/);

    // 双起点（显式标记两个）→ 拒绝。
    const reviewer0 = store.createAgent({ name: '评审0' });
    expect(() =>
      store.createPipeline({
        name: '双起点',
        nodes: [
          { id: startId, agentId: planner.id, isStart: true },
          { id: midId, agentId: maker.id, isStart: true },
          { id: endId, agentId: reviewer0.id },
        ],
        edges: [
          { from: startId, to: endId, triggerPrompt: 'A' },
          { from: midId, to: endId, triggerPrompt: 'B' },
        ],
      }),
    ).toThrow(/起点必须唯一/);

    // 没标起点（多节点）→ 拒绝。
    expect(() =>
      store.createPipeline({
        name: '无起点',
        nodes: [
          { id: startId, agentId: planner.id },
          { id: endId, agentId: reviewer0.id },
        ],
        edges: [{ from: startId, to: endId, triggerPrompt: 'A' }],
      }),
    ).toThrow(/标记.*起点|起点/);

    // 多出边但缺交接条件 → 拒绝。
    const reviewer = store.createAgent({ name: '评审' });
    expect(() =>
      store.createPipeline({
        name: '缺条件',
        nodes: [
          { id: startId, agentId: planner.id, isStart: true },
          { id: midId, agentId: maker.id },
          { id: endId, agentId: reviewer.id },
        ],
        edges: [
          { from: startId, to: midId, triggerPrompt: '开始' },
          { from: midId, to: startId, triggerPrompt: '返工' },
          { from: midId, to: endId, triggerPrompt: '通过' },
        ],
      }),
    ).toThrow(/交接条件/);

    // 多出边 + 每条都写条件 → 通过（起点带返工入线的环也合法）。
    const ok = store.createPipeline({
      name: '带条件',
      nodes: [
        { id: startId, agentId: planner.id, isStart: true },
        { id: midId, agentId: maker.id },
        { id: endId, agentId: reviewer.id },
      ],
      edges: [
        { from: startId, to: midId, triggerPrompt: '开始' },
        { from: midId, to: startId, triggerPrompt: '返工', handoffCondition: '评审不通过时返工' },
        { from: midId, to: endId, triggerPrompt: '归档', handoffCondition: '评审通过时归档' },
      ],
    });
    expect(ok.edges).toHaveLength(3);

    // 从起点不可达的节点 → 拒绝。
    const orphan = randomUUID();
    expect(() =>
      store.createPipeline({
        name: '孤儿节点',
        nodes: [
          { id: startId, agentId: planner.id, isStart: true },
          { id: endId, agentId: reviewer.id },
          { id: orphan, agentId: store.createAgent({ name: '旁观者' }).id },
        ],
        edges: [{ from: startId, to: endId, triggerPrompt: 'A' }, { from: orphan, to: endId, triggerPrompt: 'B' }],
      }),
    ).toThrow(/不可达/);
  });

  it('refuses to delete an agent that is still used by a pipeline', () => {
    const agent = store.createAgent({ name: '被引用者' });
    store.createAgent({ name: '无关者' });
    const pipeline = store.createPipeline({
      name: '引用检查',
      nodes: [{ agentId: agent.id }],
    });

    expect(() => store.deleteAgent(agent.id)).toThrow(/仍被流水线使用/);
    expect(() => store.deleteAgent(agent.id)).toThrow(new RegExp(pipeline.name));
    expect(store.getAgent(agent.id)).not.toBeNull();
  });

  it('snapshots the pipeline on the task and blocks deleting a pipeline with an active task', () => {
    const planner = store.createAgent({ name: '策划' });
    const maker = store.createAgent({ name: '执行' });
    const first = randomUUID();
    const second = randomUUID();
    const pipeline = store.createPipeline({
      name: '快照流水线',
      description: '原始简介',
      nodes: [
        { id: first, agentId: planner.id, isStart: true, x: 0, y: 0 },
        { id: second, agentId: maker.id, x: 300, y: 0 },
      ],
      edges: [{ id: 'e1', from: first, to: second, triggerPrompt: '开始产出' }],
    });

    const created = store.createTask({
      task: '写一份方案',
      pipeline,
      node: pipeline.nodes[0],
      agent: planner,
    });

    const detail = store.getTaskDetail(created.taskId)!;
    expect(detail.pipelineId).toBe(pipeline.id);
    expect(detail.pipelineName).toBe('快照流水线');
    expect(detail.currentNodeId).toBe(first);
    expect(detail.pipelineStep).toBe(1);
    expect(detail.pipelineTotal).toBe(2);
    expect(detail.pipeline?.name).toBe('快照流水线');
    expect(detail.pipeline?.edges).toHaveLength(1);
    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0].nodeId).toBe(first);
    expect(detail.turns[0].seq).toBe(1);

    expect(() => store.deletePipeline(pipeline.id)).toThrow(/进行中的任务/);

    const next = store.createTurn(created.taskId, maker, pipeline.nodes[1]);
    expect(next.seq).toBe(2);
    const moved = store.getTask(created.taskId)!;
    expect(moved.currentNodeId).toBe(second);
    expect(moved.pipelineStep).toBe(2);

    // 任务启动后修改流水线：快照保持不变。
    store.updatePipeline(pipeline.id, {
      name: '快照流水线改名',
      description: '改版简介',
      nodes: [
        { id: first, agentId: planner.id, isStart: true, x: 1, y: 1 },
        { id: second, agentId: maker.id, x: 2, y: 2 },
      ],
      edges: [{ id: 'e1', from: first, to: second, triggerPrompt: '新的触发提示词' }],
    });
    const snapshot = store.getTaskDetail(created.taskId)!;
    expect(snapshot.pipelineName).toBe('快照流水线');
    expect(snapshot.pipeline?.name).toBe('快照流水线');
    expect(snapshot.pipeline?.description).toBe('原始简介');
    expect(snapshot.pipeline?.edges?.[0]?.triggerPrompt).toBe('开始产出');
    expect(store.getPipeline(pipeline.id)?.name).toBe('快照流水线改名');

    // 任务结束后才允许删除流水线。
    store.updateTask(created.taskId, { status: 'aborted' });
    expect(store.deletePipeline(pipeline.id).id).toBe(pipeline.id);
    expect(store.listPipelines()).toHaveLength(0);
  });
});
