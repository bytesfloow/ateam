import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, ConversationMessage, Pipeline, TaskDetail, TaskStatus } from '../shared/types';
import { openDatabase } from '../server/src/db';
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from '../server/src/llm';
import { Runtime } from '../server/src/runtime';
import { Store } from '../server/src/store';

type Handler = (request: LlmRequest) => LlmResponse | Promise<LlmResponse>;

class TestProvider implements LlmProvider {
  readonly id = 'test';
  calls: LlmRequest[] = [];
  private readonly handler: Handler;

  constructor(handler: Handler) {
    this.handler = handler;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.calls.push(request);
    return this.handler(request);
  }
}

interface Harness {
  store: Store;
  runtime: Runtime;
  provider: TestProvider;
  root: string;
  dispose: () => Promise<void>;
}

let harness: Harness | null = null;
const disposers: (() => void)[] = [];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function createHarness(handler: Handler): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-test-'));
  const db = openDatabase(':memory:');
  const store = new Store({ db, workspaceRoot: root });
  const provider = new TestProvider(handler);
  const runtime = new Runtime({ store, providerFactory: () => provider });
  const h: Harness = {
    store,
    runtime,
    provider,
    root,
    dispose: async () => {
      for (const fn of disposers.splice(0)) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
      const run = store.findActiveTask();
      if (run) {
        try {
          runtime.terminateTask(run.id);
        } catch {
          /* ignore */
        }
      }
      await waitFor(() => runtime.getStatus().busyAgents.length === 0, 3000).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        db.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  harness = h;
  return h;
}

async function waitFor(check: () => boolean | Promise<boolean>, timeout = 6000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`waitFor timeout after ${timeout}ms`);
}

function final(text: string): LlmResponse {
  return { content: text, toolCalls: [] };
}

const shellToolName = process.platform === 'win32' ? 'pwsh' : 'bash';

function toolCall(name: string, args: Record<string, unknown>, content = '', id = `call_${name}_${Math.random().toString(16).slice(2, 6)}`): LlmResponse {
  return {
    content,
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  };
}

function createAgents(store: Store, names: string[]): Agent[] {
  return names.map((name) =>
    store.createAgent({
      name,
      guide: `你是测试智能体 ${name}。`,
      maxIterations: 10,
    }),
  );
}

interface NextSpec {
  key: string;
  /** 任务触发提示词；省略时用默认模板（内含 {deliverables}/{task}/{sender} 占位符）。 */
  prompt?: string;
  /** 交接条件（源节点多出边时必填）。 */
  condition?: string;
}

interface NodeSpec {
  key: string;
  agent: Agent;
  next?: NextSpec[];
  /** 起点标记；省略时第一个节点为起点。 */
  start?: boolean;
}

const defaultTrigger = (fromKey: string): string =>
  `${fromKey}已完成，交付目录：{deliverables}。请继续任务：{task}（来自{sender}）`;

function createPipeline(store: Store, name: string, specs: NodeSpec[], description = ''): Pipeline {
  const ids = new Map(specs.map((spec) => [spec.key, randomUUID()]));
  const nodes = specs.map((spec, index) => ({
    id: ids.get(spec.key)!,
    agentId: spec.agent.id,
    isStart: spec.start ?? index === 0,
    x: 0,
    y: 0,
  }));
  const edges = specs.flatMap((spec) =>
    (spec.next ?? []).map((item) => {
      const to = ids.get(item.key);
      if (!to) throw new Error(`unknown next node: ${item.key}`);
      return {
        id: `${ids.get(spec.key)!}->${to}`,
        from: ids.get(spec.key)!,
        to,
        triggerPrompt: item.prompt ?? defaultTrigger(spec.key),
        handoffCondition: item.condition ?? '',
      };
    }),
  );
  return store.createPipeline({ name, description, nodes, edges });
}

function taskDetail(store: Store, taskId: string): TaskDetail {
  const task = store.getTaskDetail(taskId);
  if (!task) throw new Error('task missing');
  return task;
}

async function waitForStatus(h: Harness, taskId: string, status: TaskStatus, timeout = 6000): Promise<TaskDetail> {
  await waitFor(() => taskDetail(h.store, taskId).status === status, timeout);
  return taskDetail(h.store, taskId);
}

function toolMessages(store: Store, turnId: string): ConversationMessage[] {
  const conversation = store.getTurnConversation(turnId);
  if (!conversation) return [];
  return store.listMessages(conversation.id).filter((message) => message.role === 'tool');
}

function systemPromptOf(request: LlmRequest): string {
  return request.messages.find((message) => message.role === 'system')?.content ?? '';
}

afterEach(async () => {
  if (harness) {
    const h = harness;
    harness = null;
    await h.dispose();
  }
});

describe('task runtime', () => {
  it('copies task input files into each agent task workspace', () => {
    const h = createHarness(() => final('unused'));
    const taskId = '11111111-1111-1111-1111-111111111111';
    h.store.ensureTaskWorkspace(taskId);
    const source = path.join(h.store.taskInputDir(taskId), 'brief.md');
    fs.writeFileSync(source, '需求摘要', 'utf8');

    h.store.prepareAgentTaskWorkspace(taskId, 'agent-test01');
    const input = path.join(h.store.agentTaskUserInputDir(taskId, 'agent-test01'), 'brief.md');
    expect(fs.readFileSync(input, 'utf8')).toBe('需求摘要');

    // 人类更新任务级输入后，下一环节准备时会覆盖同名副本
    fs.writeFileSync(source, '需求摘要 v2', 'utf8');
    h.store.prepareAgentTaskWorkspace(taskId, 'agent-test01');
    expect(fs.readFileSync(input, 'utf8')).toBe('需求摘要 v2');
  });

  it('copies the delivered folder into the receiver inbox and waits for human at the terminal node', async () => {
    const h = createHarness((request) => {
      const { agentName, iteration } = request.meta;
      if (agentName === '甲') {
        if (iteration === 1) {
          return toolCall('write', { file_path: 'output/deliverable.md', content: '这是甲的交付文件' });
        }
        return toolCall('handoff', { folder: 'output' }, '甲的产出都放进了 output 目录');
      }
      if (agentName === '乙') {
        if (iteration === 1) {
          return toolCall('write', { file_path: 'output/final.md', content: '乙的最终稿' });
        }
        return toolCall('handoff', { folder: 'output' }, '乙收到并完成');
      }
      return final('不应到达');
    });
    const agents = createAgents(h.store, ['甲', '乙']);
    const pipeline = createPipeline(h.store, '撰写-汇总', [
      { key: '撰写', agent: agents[0], next: [{ key: '汇总' }] },
      { key: '汇总', agent: agents[1] },
    ]);

    const task = h.runtime.startTask({ task: '写一份测试文档', pipelineId: pipeline.id });
    expect(task.status).toBe('running');
    expect(task.pipelineId).toBe(pipeline.id);
    expect(task.pipelineName).toBe('撰写-汇总');
    expect(task.currentAgentName).toBe('甲');
    await waitForStatus(h, task.id, 'waiting_human');

    const waiting = taskDetail(h.store, task.id);
    expect(waiting.status).toBe('waiting_human');
    expect(waiting.pipelineStep).toBe(2);
    expect(waiting.pipelineTotal).toBe(2);
    expect(waiting.currentNodeId).toBe(pipeline.nodes[1].id);
    expect(waiting.currentAgentId).toBeNull();
    expect(waiting.currentAgentName).toBeNull();
    expect(waiting.currentTurnId).toBe(waiting.turns[1].id);
    // 终点交人后仍算未结束任务，不能再开新任务
    expect(() =>
      h.runtime.startTask({ task: '第二个任务', pipelineId: pipeline.id }),
    ).toThrow(/已有未结束的任务（等待用户验收）/);

    const completed = h.runtime.completeTaskByHuman(task.id);
    expect(completed.status).toBe('completed');
    expect(completed.finishedAt).not.toBeNull();
    expect(completed.error).toBeNull();
    expect(() => h.runtime.terminateTask(task.id)).toThrow(/当前任务已经结束/);

    const detail = taskDetail(h.store, task.id);
    expect(detail.turns).toHaveLength(2);
    expect(detail.turns[0].agentName).toBe('甲');
    expect(detail.turns[0].status).toBe('completed');
    expect(detail.turns[0].output).toBe('甲的产出都放进了 output 目录');
    expect(detail.turns[0].target).toMatchObject({
      type: 'agent',
      nodeId: pipeline.nodes[1].id,
      agentId: agents[1].id,
      agentName: '乙',
      edgeId: pipeline.edges[0].id,
    });

    // 起点环节的输入 = 任务原文；下游环节输入 = 触发提示词（占位符已替换，无其它模板段）
    expect(detail.turns[0].input).toBe('写一份测试文档');

    const deliveredFolder = `inbox/${agents[0].slug}/output`;
    expect(detail.turns[1].input).toContain(`交付目录：${deliveredFolder}`);
    expect(detail.turns[1].input).toContain('任务：写一份测试文档');
    expect(detail.turns[1].input).toContain('来自甲');
    expect(detail.turns[1].input).not.toContain('{deliverables}');
    expect(detail.turns[1].input).not.toContain('成果摘要');
    expect(detail.turns[1].input).not.toContain('【你在流水线中的位置】');

    // 交付文件夹记录与整目录复制
    expect(detail.turns[0].handoffFolder).toMatchObject({
      path: 'output',
      name: 'output',
      files: 1,
      deliveredPath: deliveredFolder,
      deliveredTo: agents[1].id,
    });

    // 终点环节：文件夹整目录复制到任务目录 final\ 下
    expect(detail.turns[1].handoffFolder).toMatchObject({
      path: 'output',
      deliveredPath: 'final/output',
      deliveredTo: 'human',
    });
    expect(detail.turns[1].target).toMatchObject({ type: 'human' });

    // 每个智能体在任务内各有一份独立工作区
    const senderRoot = h.store.agentTaskWorkspaceDir(task.id, agents[0].slug);
    const receiverRoot = h.store.agentTaskWorkspaceDir(task.id, agents[1].slug);
    expect(senderRoot).not.toBe(receiverRoot);

    // 甲的原文件保留，乙只在自己的 inbox 副本里看到它
    expect(fs.readFileSync(path.join(senderRoot, 'output', 'deliverable.md'), 'utf8')).toBe('这是甲的交付文件');
    expect(fs.existsSync(path.join(receiverRoot, 'output', 'deliverable.md'))).toBe(false);
    const delivered = path.join(receiverRoot, deliveredFolder, 'deliverable.md');
    expect(fs.existsSync(delivered)).toBe(true);
    expect(fs.readFileSync(delivered, 'utf8')).toBe('这是甲的交付文件');

    // 终点交付复制到 final/
    const finalCopy = path.join(h.store.taskFinalDir(task.id), 'output', 'final.md');
    expect(fs.existsSync(finalCopy)).toBe(true);
    expect(fs.readFileSync(finalCopy, 'utf8')).toBe('乙的最终稿');

    // 系统提示词包含流水线定位与文件夹交接规则
    const firstPrompt = systemPromptOf(h.provider.calls[0]);
    expect(firstPrompt).toContain('## 流水线');
    expect(firstPrompt).toContain('甲（我）');
    expect(firstPrompt).toContain('自动把交付文件夹交给「乙」');
    const secondPrompt = systemPromptOf(
      h.provider.calls.find((call) => call.meta.agentName === '乙')!,
    );
    expect(secondPrompt).toContain('上一环节：「甲」已完成并交接给你');
    expect(secondPrompt).toContain('本节点是流水线终点');
  });

  it('persists the assembled system prompt on each turn for the detail view', async () => {
    const h = createHarness((request) => {
      const { agentName, iteration } = request.meta;
      if (agentName === '甲') {
        if (iteration === 1) return toolCall('write', { file_path: 'output/deliverable.md', content: '甲的交付' });
        return toolCall('handoff', { folder: 'output' }, '甲完成');
      }
      if (agentName === '乙') {
        if (iteration === 1) return toolCall('write', { file_path: 'output/final.md', content: '乙终稿' });
        return toolCall('handoff', { folder: 'output' }, '乙完成');
      }
      return final('不应到达');
    });
    const agents = createAgents(h.store, ['甲', '乙']);
    const pipeline = createPipeline(h.store, '提示词留档', [
      { key: '撰写', agent: agents[0], next: [{ key: '汇总' }] },
      { key: '汇总', agent: agents[1] },
    ]);

    const task = h.runtime.startTask({ task: '写一份测试文档', pipelineId: pipeline.id });
    await waitForStatus(h, task.id, 'waiting_human');

    const turns = taskDetail(h.store, task.id).turns;
    const firstPrompt = h.store.getTurnSystemPrompt(turns[0].id);
    expect(firstPrompt).not.toBeNull();
    // 落库内容 = 本环节实际下发给模型的系统提示词
    expect(firstPrompt).toBe(systemPromptOf(h.provider.calls[0]));
    expect(firstPrompt).toContain('你是「甲」智能体，是「提示词留档」流水线的一员，你的主要职责是：');
    expect(firstPrompt).toContain('## 流水线');
    expect(firstPrompt).toContain('自动把交付文件夹交给「乙」');
    expect(firstPrompt).toContain('## 运行环境');

    const secondPrompt = h.store.getTurnSystemPrompt(turns[1].id);
    expect(secondPrompt).toBe(
      systemPromptOf(h.provider.calls.find((call) => call.meta.agentName === '乙')!),
    );
    expect(secondPrompt).toContain('你是「乙」智能体');
    expect(secondPrompt).toContain('本节点是流水线终点');

    expect(h.store.getTurnSystemPrompt('不存在的回合')).toBeNull();
  });

  it('auto-versions same-name delivered folders (-v2, -v3) instead of overwriting or failing', async () => {
    const h = createHarness((request) => {
      const { agentName, turnSeq, iteration } = request.meta;
      if (agentName === '甲') {
        if (iteration === 1) return toolCall('write', { file_path: `output/dup-${turnSeq}.md`, content: `甲第 ${turnSeq} 环节` });
        return toolCall('handoff', { folder: 'output' });
      }
      if (agentName === '乙') {
        if (iteration === 1) return toolCall('write', { file_path: 'output/review.md', content: `乙第 ${turnSeq} 环节审阅` });
        // 前两轮交回甲返工（多出边 → target 必填），第三轮交给终点丙
        if (turnSeq >= 6) return toolCall('handoff', { folder: 'output', target: '丙' });
        return toolCall('handoff', { folder: 'output', target: '甲' });
      }
      if (agentName === '丙') {
        if (iteration === 1) return toolCall('write', { file_path: 'output/final.md', content: '终稿' });
        return toolCall('handoff', { folder: 'output' });
      }
      return final('不应到达');
    });
    const agents = createAgents(h.store, ['甲', '乙', '丙']);
    const pipeline = createPipeline(h.store, '返工循环', [
      { key: '甲', agent: agents[0], next: [{ key: '乙' }] },
      {
        key: '乙',
        agent: agents[1],
        next: [
          { key: '甲', condition: '产出有阻塞问题时返工给甲' },
          { key: '丙', condition: '产出可用时交给丙终验' },
        ],
      },
      { key: '丙', agent: agents[2] },
    ]);

    const task = h.runtime.startTask({ task: '同名交付目录版本测试', pipelineId: pipeline.id });
    await waitForStatus(h, task.id, 'waiting_human');

    const detail = taskDetail(h.store, task.id);
    expect(detail.turns.map((turn) => turn.agentName)).toEqual(['甲', '乙', '甲', '乙', '甲', '乙', '丙']);

    const receiverRoot = h.store.agentTaskWorkspaceDir(task.id, agents[1].slug);
    const firstPath = `inbox/${agents[0].slug}/output`;
    const secondPath = `inbox/${agents[0].slug}/output-v2`;
    const thirdPath = `inbox/${agents[0].slug}/output-v3`;
    expect(detail.turns[0].handoffFolder?.deliveredPath).toBe(firstPath);
    expect(detail.turns[2].handoffFolder?.deliveredPath).toBe(secondPath);
    expect(detail.turns[4].handoffFolder?.deliveredPath).toBe(thirdPath);
    expect(fs.existsSync(path.join(receiverRoot, firstPath, 'dup-1.md'))).toBe(true);
    expect(fs.existsSync(path.join(receiverRoot, secondPath, 'dup-3.md'))).toBe(true);
    expect(fs.existsSync(path.join(receiverRoot, thirdPath, 'dup-5.md'))).toBe(true);
    // 后续环节的输入里出现的是实际带版本号的目录
    expect(detail.turns[3].input).toContain(secondPath);
    expect(detail.turns[5].input).toContain(thirdPath);
    // 交接没有报「已存在」类错误
    expect(
      toolMessages(h.store, detail.turns[2].id).some((message) => message.content.includes('无法交付')),
    ).toBe(false);

    h.runtime.completeTaskByHuman(task.id);
  });

  it('rejects a missing folder, then accepts the delivered folder', async () => {
    const h = createHarness((request) => {
      if (request.meta.iteration === 1) {
        return toolCall('handoff', { folder: 'nope' });
      }
      if (request.meta.iteration === 2) {
        return toolCall('write', { file_path: 'output/说明.md', content: '# 说明\n\n本环节没有其它产出。' });
      }
      return toolCall('handoff', { folder: 'output' });
    });
    const agents = createAgents(h.store, ['甲']);
    const pipeline = createPipeline(h.store, '单节点交付', [{ key: '产出', agent: agents[0] }]);

    const task = h.runtime.startTask({ task: '目录校验测试', pipelineId: pipeline.id });
    await waitForStatus(h, task.id, 'waiting_human');
    const detail = taskDetail(h.store, task.id);
    expect(detail.turns[0].handoffFolder).toMatchObject({ path: 'output', files: 1 });

    const messages = toolMessages(h.store, detail.turns[0].id);
    expect(messages.some((message) => message.content.includes('交接目录不存在'))).toBe(true);

    h.runtime.completeTaskByHuman(task.id);
  });

  it('allows an empty folder but keeps everything inside the workspace', async () => {
    const h = createHarness((request) => {
      if (request.meta.iteration === 1) {
        // 试图交接工作区之外的目录 → 拒绝
        return toolCall('handoff', { folder: '../evil' });
      }
      if (request.meta.iteration === 2) {
        return toolCall('handoff', { folder: 'empty' });
      }
      return toolCall('handoff', { folder: 'output' });
    });
    const agents = createAgents(h.store, ['甲']);
    const pipeline = createPipeline(h.store, '空目录', [{ key: '产出', agent: agents[0] }]);

    const task = h.runtime.startTask({ task: '空目录与越界', pipelineId: pipeline.id });
    await waitForStatus(h, task.id, 'waiting_human');
    const detail = taskDetail(h.store, task.id);
    expect(detail.turns[0].handoffFolder).toMatchObject({ path: 'output', files: 0 });

    const messages = toolMessages(h.store, detail.turns[0].id);
    expect(messages.some((message) => message.content.includes('交接目录路径不合法'))).toBe(true);
    expect(messages.some((message) => message.content.includes('交接目录不存在'))).toBe(true);

    h.runtime.completeTaskByHuman(task.id);
  });

  it('injects pipeline position, conditions and delivery rules into the system prompt', async () => {
    const prompts = new Map<string, string>();
    const h = createHarness((request) => {
      const { agentName, iteration } = request.meta;
      if (iteration === 1) prompts.set(agentName, systemPromptOf(request));
      if (iteration === 1) return toolCall('write', { file_path: `output/${agentName}.md`, content: `${agentName}产出` });
      return toolCall('handoff', { folder: 'output' });
    });
    const agents = createAgents(h.store, ['甲', '乙', '丙']);
    h.store.updateAgent(agents[1].id, { description: '按计划完成实际产出' });
    const pipeline = createPipeline(
      h.store,
      '需求-实现-验收',
      [
        { key: '需求', agent: agents[0], next: [{ key: '实现', prompt: '需求已交付：{deliverables}，未知量 {unknownVar} 保留' }] },
        { key: '实现', agent: agents[1], next: [{ key: '验收' }] },
        { key: '验收', agent: agents[2] },
      ],
      '从需求到验收的完整流水线',
    );

    const task = h.runtime.startTask({ task: '提示词流水线定位测试', pipelineId: pipeline.id });
    await waitForStatus(h, task.id, 'waiting_human');
    const detail = taskDetail(h.store, task.id);

    const first = prompts.get('甲')!;
    expect(first).toContain('## 流水线');
    expect(first).toContain('需求-实现-验收 —— 从需求到验收的完整流水线');
    expect(first).toContain('甲（我）');
    // 逐环节清单：智能体名称 + 一句话描述
    expect(first).toContain('1. 甲（我）');
    expect(first).toContain('2. 乙：按计划完成实际产出');
    expect(first).toContain('3. 丙');
    expect(first).not.toContain('团队成员：');
    expect(first).toContain('上一环节：没有，你是这条流水线的起点');
    expect(first).toContain('自动把交付文件夹交给「乙」');
    // 开头一句话合并身份、流水线归属与职责；不再有独立的「角色与职责」章节
    expect(first).toContain('你是「甲」智能体，是「需求-实现-验收」流水线的一员，你的主要职责是：');
    expect(first).not.toContain('## 角色与职责');
    expect(first.indexOf('你是「甲」智能体')).toBeLessThan(first.indexOf('## 流水线'));

    // 「本环节任务」章节直接展示任务说明原文，不含系统模板行
    expect(first).toContain('## 本环节任务');
    expect(first).not.toContain('任务来源：');
    expect(first).not.toContain('具体工作（按你的职责逐条落实）');
    expect(first).not.toContain('完成标准：');

    // 「交付要求」章节始终存在：未填写时输出默认说明
    expect(first).toContain('## 交付要求');
    expect(first).not.toContain('## 交付内容');
    expect(first).toContain('未单独填写：默认把成果放进');
    expect(first.indexOf('## 本环节任务')).toBeLessThan(first.indexOf('## 交付要求'));
    expect(first.indexOf('## 交付要求')).toBeLessThan(first.indexOf('## 运行环境'));

    const second = prompts.get('乙')!;
    expect(second).toContain('上一环节：「甲」已完成并交接给你');
    expect(second).toContain('自动把交付文件夹交给「丙」');

    const third = prompts.get('丙')!;
    expect(third).toContain('上一环节：「乙」已完成并交接给你');
    expect(third).toContain('交接对象：没有，本节点是流水线终点');

    // 工作规则改成文件夹交接
    expect(first).toContain('## 工作规则');
    expect(first).toContain('用 folder 交出这个目录');
    expect(first).toContain('同名目录不会覆盖');
    expect(first).not.toContain('next_node');
    expect(first).not.toContain('deliverables 至少包含 1 个文件');

    // 下游输入 = 连线触发提示词；未识别的 {xxx} 原样保留
    expect(detail.turns[1].input).toContain('需求已交付：inbox/');
    expect(detail.turns[1].input).toContain('{unknownVar}');
    expect(detail.turns[1].input).not.toContain('{deliverables}');

    expect(detail.pipelineStep).toBe(3);
    expect(detail.pipelineTotal).toBe(3);

    h.runtime.completeTaskByHuman(task.id);
  });

  it('requires target for multiple outgoing edges and follows the chosen branch', async () => {
    let prompts = '';
    let callsToOtherBranch = 0;
    const h = createHarness((request) => {
      const { agentName, iteration } = request.meta;
      if (agentName === '甲') {
        if (iteration === 1) {
          prompts = systemPromptOf(request);
          return toolCall('write', { file_path: 'output/plan.md', content: '分派计划' });
        }
        if (iteration === 2) {
          // 多出边时漏传 target，应被驳回
          return toolCall('handoff', { folder: 'output' });
        }
        if (iteration === 3) {
          // 指定的 target 不在候选里，应被驳回
          return toolCall('handoff', { folder: 'output', target: '不存在的人' });
        }
        return toolCall('handoff', { folder: 'output', target: '丙' });
      }
      if (agentName === '乙') {
        callsToOtherBranch += 1;
        return final('不应走到分支乙');
      }
      if (agentName === '丙') {
        if (iteration === 1) return toolCall('write', { file_path: 'output/result.md', content: '丙的产出' });
        return toolCall('handoff', { folder: 'output' });
      }
      return final('不应到达');
    });
    const agents = createAgents(h.store, ['甲', '乙', '丙']);
    const pipeline = createPipeline(h.store, '分支流水线', [
      {
        key: '分派',
        agent: agents[0],
        next: [
          { key: '分支乙', prompt: '乙线任务：{task}', condition: '需要快速原型时交给乙' },
          { key: '分支丙', prompt: '丙线任务：{deliverables}', condition: '需要完整实现时交给丙' },
        ],
      },
      { key: '分支乙', agent: agents[1] },
      { key: '分支丙', agent: agents[2] },
    ]);

    const task = h.runtime.startTask({ task: '多候选分支测试', pipelineId: pipeline.id });
    await waitForStatus(h, task.id, 'waiting_human');

    expect(prompts).toContain('「乙」：交接条件：需要快速原型时交给乙');
    expect(prompts).toContain('「丙」：交接条件：需要完整实现时交给丙');
    const detail = taskDetail(h.store, task.id);
    expect(detail.turns).toHaveLength(2);
    expect(detail.turns[0].target).toMatchObject({
      type: 'agent',
      nodeId: pipeline.nodes[2].id,
      agentName: '丙',
    });
    expect(detail.turns[1].agentName).toBe('丙');
    expect(callsToOtherBranch).toBe(0);

    const messages = toolMessages(h.store, detail.turns[0].id);
    expect(messages.some((message) => message.content.includes('必须用 target 指明交给哪一个'))).toBe(true);
    expect(messages.some((message) => message.content.includes('target 必须是本节点的交接对象之一'))).toBe(true);

    h.runtime.completeTaskByHuman(task.id);
  });

  it('pauses on a failed turn and retries with the same edge trigger prompt', async () => {
    let failFirstAttempt = true;
    const retryPrompts: string[] = [];
    const h = createHarness((request) => {
      const { agentName, iteration } = request.meta;
      if (agentName === '甲') {
        if (iteration === 1) return toolCall('write', { file_path: 'output/deliverable.md', content: '甲的交付内容' });
        return toolCall('handoff', { folder: 'output' });
      }
      if (agentName === '乙') {
        retryPrompts.push(systemPromptOf(request));
        if (failFirstAttempt) {
          failFirstAttempt = false;
          throw new LlmError('模型请求超时（600 秒内没有新数据）');
        }
        if (iteration === 1) return toolCall('write', { file_path: 'output/result.md', content: '乙的成果' });
        return toolCall('handoff', { folder: 'output' });
      }
      return final('不应到达');
    });
    const agents = createAgents(h.store, ['甲', '乙']);
    const pipeline = createPipeline(h.store, '交付-重试', [
      { key: '交付', agent: agents[0], next: [{ key: '处理', prompt: '甲已交付 {deliverables}，请处理' }] },
      { key: '处理', agent: agents[1] },
    ]);

    const task = h.runtime.startTask({ task: '重跑失败的一个环节', pipelineId: pipeline.id });
    await waitForStatus(h, task.id, 'paused');

    const paused = taskDetail(h.store, task.id);
    expect(paused.status).toBe('paused');
    expect(paused.pipelineStep).toBe(2);
    expect(paused.currentNodeId).toBe(pipeline.nodes[1].id);
    expect(paused.currentTurnId).toBe(paused.turns[1].id);
    expect(paused.turns).toHaveLength(2);
    expect(paused.turns[1].status).toBe('failed');
    expect(paused.turns[1].error).toContain('模型请求超时');
    expect(paused.error).toContain('模型请求超时');
    expect(() =>
      h.runtime.startTask({ task: '暂停时的新任务', pipelineId: pipeline.id }),
    ).toThrow(/已有未结束的任务（已暂停）/);

    const retried = h.runtime.retryTask(task.id, { note: '这次先列大纲再展开' });
    expect(retried.status).toBe('running');
    expect(retried.error).toBeNull();
    await waitForStatus(h, task.id, 'waiting_human');

    const detail = taskDetail(h.store, task.id);
    expect(detail.turns.map((turn) => turn.seq)).toEqual([1, 2, 3]);
    expect(detail.turns[2].agentName).toBe('乙');
    expect(detail.turns[2].status).toBe('completed');
    expect(detail.turns[2].input).toContain(`甲已交付 inbox/${agents[0].slug}/output，请处理`);
    expect(detail.turns[2].input).toContain('【用户的补充指示】');
    expect(detail.turns[2].input).toContain('这次先列大纲再展开');

    // 重试环节的系统提示词仍应把真正的上游标为「上一环节」，而不是失败的本环节。
    expect(retryPrompts).toHaveLength(3);
    expect(retryPrompts[1]).toContain('上一环节：「甲」已完成并交接给你');
    expect(retryPrompts[1]).not.toContain('上一环节：「乙」');

    // 失败的那一个环节保持原样，作为历史记录保留
    expect(taskDetail(h.store, task.id).turns[1].status).toBe('failed');
    h.runtime.completeTaskByHuman(task.id);
  });

  it('retries a first-turn failure without a previous handoff', async () => {
    let attempts = 0;
    const h = createHarness(() => {
      attempts += 1;
      if (attempts === 1) throw new LlmError('模型请求超时（600 秒内没有新数据）');
      if (attempts === 2) return toolCall('write', { file_path: 'output/result.md', content: '恢复后的成果' });
      return toolCall('handoff', { folder: 'output' });
    });
    const agents = createAgents(h.store, ['甲']);
    const pipeline = createPipeline(h.store, '首个环节重试', [{ key: '起点', agent: agents[0] }]);

    const task = h.runtime.startTask({ task: '第一个环节就失败', pipelineId: pipeline.id });
    await waitForStatus(h, task.id, 'paused');
    h.runtime.retryTask(task.id);
    await waitForStatus(h, task.id, 'waiting_human');

    const detail = taskDetail(h.store, task.id);
    expect(detail.turns.map((turn) => turn.seq)).toEqual([1, 2]);
    expect(detail.turns[1].input).toBe('第一个环节就失败');

    h.runtime.completeTaskByHuman(task.id);
  });

  it('pauses instead of finishing when an agent stops without handoff', async () => {
    const h = createHarness(() => final('我只是说了句话，没有交接'));
    const agents = createAgents(h.store, ['健忘者']);
    const pipeline = createPipeline(h.store, '无交接流水线', [{ key: '唯一', agent: agents[0] }]);

    const task = h.runtime.startTask({ task: '无交接测试', pipelineId: pipeline.id });
    await waitForStatus(h, task.id, 'paused');

    const detail = taskDetail(h.store, task.id);
    expect(detail.status).toBe('paused');
    expect(detail.turns[0].status).toBe('failed');
    expect(detail.error).toContain('没有产生有效交接');
    expect(detail.currentNodeId).toBe(pipeline.nodes[0].id);
  });

  it('only allows retry on paused tasks and complete only on waiting_human tasks', async () => {
    const h = createHarness((request) => {
      if (request.meta.iteration === 1) return toolCall('write', { file_path: 'output/result.md', content: '成果' });
      return toolCall('handoff', { folder: 'output' });
    });
    const agents = createAgents(h.store, ['甲']);
    const pipeline = createPipeline(h.store, '状态校验', [{ key: '节点', agent: agents[0] }]);

    const task = h.runtime.startTask({ task: '状态校验测试', pipelineId: pipeline.id });
    await waitForStatus(h, task.id, 'waiting_human');

    expect(() => h.runtime.retryTask(task.id)).toThrow(/只有暂停或失败的任务可以重试/);
    h.runtime.completeTaskByHuman(task.id);
    expect(() => h.runtime.retryTask(task.id)).toThrow(/只有暂停或失败的任务可以重试/);
    expect(() => h.runtime.completeTaskByHuman(task.id)).toThrow(/当前任务不在等待人类处理状态/);
    expect(() => h.runtime.terminateTask(task.id)).toThrow(/当前任务已经结束/);
  });

  it('rejects a second task while one is active and validates the pipeline reference', async () => {
    const gate = deferred();
    disposers.push(() => gate.resolve());
    const h = createHarness(async (request) => {
      await gate.promise;
      if (request.meta.iteration === 1) return toolCall('write', { file_path: 'output/result.md', content: '成果' });
      return toolCall('handoff', { folder: 'output' });
    });
    const agents = createAgents(h.store, ['甲']);
    const pipeline = createPipeline(h.store, '运行中校验', [{ key: '节点', agent: agents[0] }]);

    expect(() =>
      h.runtime.startTask({ task: '不存在的流水线', pipelineId: '00000000-0000-4000-8000-000000000000' }),
    ).toThrow(/流水线不存在/);

    const task = h.runtime.startTask({ task: '第一个任务', pipelineId: pipeline.id });
    await waitFor(() => h.runtime.getStatus().busyAgents.length > 0);
    expect(() => h.runtime.startTask({ task: '第二个任务', pipelineId: pipeline.id })).toThrow(
      /已有未结束的任务（执行中）/,
    );
    gate.resolve();
    await waitForStatus(h, task.id, 'waiting_human');
    h.runtime.completeTaskByHuman(task.id);
  });

  it('terminates a running task', async () => {
    const gate = deferred();
    disposers.push(() => gate.resolve());
    const h = createHarness(async () => {
      await gate.promise;
      return toolCall('handoff', { folder: 'output' });
    });
    const agents = createAgents(h.store, ['甲']);
    const pipeline = createPipeline(h.store, '终止运行', [{ key: '节点', agent: agents[0] }]);

    const task = h.runtime.startTask({ task: '终止测试', pipelineId: pipeline.id });
    await waitFor(() => h.runtime.getStatus().busyAgents.length > 0);

    const terminated = h.runtime.terminateTask(task.id);
    gate.resolve();
    expect(terminated.status).toBe('aborted');
    expect(terminated.error).toBe('任务已被用户终止');
    await waitFor(() => h.runtime.getStatus().busyAgents.length === 0);
    expect(h.runtime.getStatus().activeTask).toBeNull();
    const detail = taskDetail(h.store, task.id);
    expect(detail.status).toBe('aborted');
    expect(detail.turns[0].status).toBe('aborted');
  });

  it('terminates paused and waiting_human tasks', async () => {
    let mode: 'forget' | 'deliver' = 'forget';
    const h = createHarness((request) => {
      if (mode === 'forget') return final('没有交接');
      if (request.meta.iteration === 1) return toolCall('write', { file_path: 'output/result.md', content: '成果' });
      return toolCall('handoff', { folder: 'output' });
    });
    const agents = createAgents(h.store, ['甲']);
    const pipeline = createPipeline(h.store, '终止暂停', [{ key: '节点', agent: agents[0] }]);

    const first = h.runtime.startTask({ task: '暂停后终止', pipelineId: pipeline.id });
    await waitForStatus(h, first.id, 'paused');
    expect(h.runtime.terminateTask(first.id).status).toBe('aborted');

    mode = 'deliver';
    const second = h.runtime.startTask({ task: '等待人类时终止', pipelineId: pipeline.id });
    await waitForStatus(h, second.id, 'waiting_human');
    const terminated = h.runtime.terminateTask(second.id);
    expect(terminated.status).toBe('aborted');
    expect(terminated.finishedAt).not.toBeNull();
    expect(h.runtime.getStatus().activeTask).toBeNull();
  });

  it('resets task data and task workspaces while keeping configuration and feedback', async () => {
    const h = createHarness((request) => {
      if (request.meta.iteration === 1) return toolCall('write', { file_path: 'output/result.md', content: '成果' });
      return toolCall('handoff', { folder: 'output' });
    });
    const agents = createAgents(h.store, ['甲', '乙']);
    const pipeline = createPipeline(h.store, '重置流水线', [{ key: '节点', agent: agents[0] }]);

    const task = h.runtime.startTask({ task: '清空测试', pipelineId: pipeline.id });
    await waitForStatus(h, task.id, 'waiting_human');
    h.runtime.completeTaskByHuman(task.id);

    const taskRoot = path.join(h.root, 'tasks', task.id);
    const taskFile = path.join(h.store.agentTaskWorkspaceDir(task.id, agents[0].slug), 'output', 'task-keep.txt');
    fs.mkdirSync(path.dirname(taskFile), { recursive: true });
    fs.writeFileSync(taskFile, 'task data should be deleted', 'utf8');
    const feedback = h.store.createFeedback({
      agentId: agents[0].id,
      agentName: agents[0].name,
      taskName: '清空测试',
      taskId: task.id,
      turnId: null,
      category: 'tool',
      severity: 'medium',
      content: '工具不好用',
      contextSnapshot: null,
    });

    const result = await h.runtime.resetAll();
    expect(result.tasks).toBe(1);
    expect(h.store.listTasks()).toHaveLength(0);
    expect(h.store.listAgents()).toHaveLength(2);
    expect(h.store.listPipelines()).toHaveLength(1);
    expect(h.store.listFeedback()).toHaveLength(1);
    expect(h.store.getFeedback(feedback.id)?.status).toBe('open');
    expect(fs.existsSync(taskFile)).toBe(false);
    expect(fs.existsSync(taskRoot)).toBe(false);
    expect(h.runtime.getStatus().activeTask).toBeNull();
  });

  it('executes a custom JavaScript tool and a shell command', async () => {
    const h = createHarness((request) => {
      if (request.meta.iteration === 1) return toolCall('greet', { name: '世界' });
      if (request.meta.iteration === 2) return toolCall(shellToolName, { command: 'echo hello-ateam' });
      if (request.meta.iteration === 3) return toolCall('write', { file_path: 'output/tools.md', content: '工具测试' });
      return toolCall('handoff', { folder: 'output' });
    });
    const agents = createAgents(h.store, ['工具人']);
    const tool = h.store.createTool({
      name: 'greet',
      description: '生成一句问候',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      code: "async (args, ctx) => `你好，${args.name}；工作目录：${ctx.workdir}`",
    });
    h.store.updateAgent(agents[0].id, {
      tools: { builtin: [shellToolName, 'write'], custom: [tool.id] },
    });
    const pipeline = createPipeline(h.store, '工具流水线', [{ key: '工具', agent: agents[0] }]);

    const task = h.runtime.startTask({ task: '工具测试', pipelineId: pipeline.id });
    await waitForStatus(h, task.id, 'waiting_human');
    const detail = taskDetail(h.store, task.id);
    const messages = toolMessages(h.store, detail.turns[0].id);
    expect(messages.some((message) => message.content.includes('你好，世界'))).toBe(true);
    expect(messages.some((message) => message.content.includes('hello-ateam'))).toBe(true);
    expect(detail.turns[0].handoffFolder?.files).toBe(1);
    h.runtime.completeTaskByHuman(task.id);
  });

  it('reports the real exit code when a shell command fails', async () => {
    const h = createHarness((request) => {
      if (request.meta.iteration === 1) {
        return toolCall('write', { file_path: 'output/说明.md', content: '退出码测试' });
      }
      if (request.meta.iteration === 2) return toolCall(shellToolName, { command: 'node -e "process.exit(3)"' });
      return toolCall('handoff', { folder: 'output' });
    });
    const agents = createAgents(h.store, ['退出码测试']);
    h.store.updateAgent(agents[0].id, { tools: { builtin: [shellToolName, 'write'], custom: [] } });
    const pipeline = createPipeline(h.store, '退出码流水线', [{ key: '测试', agent: agents[0] }]);

    const task = h.runtime.startTask({ task: '退出码测试', pipelineId: pipeline.id });
    await waitForStatus(h, task.id, 'waiting_human', 15000);
    const detail = taskDetail(h.store, task.id);
    const messages = toolMessages(h.store, detail.turns[0].id);
    expect(messages.some((message) => message.content.includes('退出码：3'))).toBe(true);
    h.runtime.completeTaskByHuman(task.id);
  });

  // Windows PowerShell 5.1 默认按 ANSI 码页读无 BOM 文件：write 写出的 UTF-8 中文会变乱码。
  it.skipIf(process.platform !== 'win32')('lets PowerShell read UTF-8 files written by write', async () => {
    const h = createHarness((request) => {
      if (request.meta.iteration === 1) {
        return toolCall('write', { file_path: 'output/中文.json', content: '{"标题":"内燃机的工作原理"}' });
      }
      if (request.meta.iteration === 2) {
        return toolCall(shellToolName, {
          command:
            'if ((Get-Content "output/中文.json" -Raw).Contains("内燃机")) { Write-Output "UTF8-OK" } else { Write-Output "MOJIBAKE" }',
        });
      }
      return toolCall('handoff', { folder: 'output' });
    });
    const agents = createAgents(h.store, ['编码测试']);
    h.store.updateAgent(agents[0].id, { tools: { builtin: [shellToolName, 'write'], custom: [] } });
    const pipeline = createPipeline(h.store, '编码流水线', [{ key: '测试', agent: agents[0] }]);

    const task = h.runtime.startTask({ task: '编码测试', pipelineId: pipeline.id });
    await waitForStatus(h, task.id, 'waiting_human');
    const detail = taskDetail(h.store, task.id);
    const messages = toolMessages(h.store, detail.turns[0].id);
    const shell = messages.find((message) => message.content.includes('退出码'));
    expect(shell?.content).toContain('UTF8-OK');
    h.runtime.completeTaskByHuman(task.id);
  });

  // 修复前：PowerShell 的非终止错误不影响退出码，命令失败也会被报成「退出码：0」。
  it.skipIf(process.platform !== 'win32')('fails the tool when PowerShell reports an error', async () => {
    const h = createHarness((request) => {
      if (request.meta.iteration === 1) {
        return toolCall('write', { file_path: 'output/说明.md', content: '占位' });
      }
      if (request.meta.iteration === 2) {
        return toolCall(shellToolName, { command: 'Get-Content "output/不存在.json" -Raw; Write-Output "done"' });
      }
      return toolCall('handoff', { folder: 'output' });
    });
    const agents = createAgents(h.store, ['报错测试']);
    h.store.updateAgent(agents[0].id, { tools: { builtin: [shellToolName, 'write'], custom: [] } });
    const pipeline = createPipeline(h.store, '报错流水线', [{ key: '测试', agent: agents[0] }]);

    const task = h.runtime.startTask({ task: '报错测试', pipelineId: pipeline.id });
    await waitForStatus(h, task.id, 'waiting_human');
    const detail = taskDetail(h.store, task.id);
    const messages = toolMessages(h.store, detail.turns[0].id);
    const shell = messages.find((message) => message.content.includes('退出码'));
    expect(shell?.content).toContain('退出码：1');
    expect(shell?.content).not.toContain('done');
    h.runtime.completeTaskByHuman(task.id);
  });

  it('loads an enabled skill and stores agent feedback with a context snapshot', async () => {
    const h = createHarness((request) => {
      if (request.meta.iteration === 1) return toolCall('load_skill', { name: '测试技能' });
      if (request.meta.iteration === 2) {
        return toolCall('submit_feedback', {
          category: 'prompt',
          severity: 'medium',
          content: '系统提示词里没有说明交付格式，容易遗漏文件。',
        });
      }
      if (request.meta.iteration === 3) {
        return toolCall('write', { file_path: 'output/skill.md', content: '技能与反馈测试' });
      }
      return toolCall('handoff', { folder: 'output' });
    });
    const skill = h.store.createSkill({
      name: '测试技能',
      description: '用于测试的技能',
      content: '# 测试技能\n\n请输出 Markdown。',
    });
    const agents = createAgents(h.store, ['反馈者']);
    h.store.updateAgent(agents[0].id, { skillIds: [skill.id] });
    const pipeline = createPipeline(h.store, '技能流水线', [{ key: '技能', agent: agents[0] }]);

    const task = h.runtime.startTask({ task: '技能与反馈测试', pipelineId: pipeline.id });
    await waitForStatus(h, task.id, 'waiting_human');
    h.runtime.completeTaskByHuman(task.id);

    const detail = taskDetail(h.store, task.id);
    const messages = h.store.listMessages(h.store.getTurnConversation(detail.turns[0].id)!.id);
    expect(
      messages.some((message) => message.role === 'tool' && message.content.includes('请输出 Markdown')),
    ).toBe(true);

    const feedback = h.store.listFeedback();
    expect(feedback).toHaveLength(1);
    expect(feedback[0].category).toBe('prompt');
    expect(feedback[0].severity).toBe('medium');
    expect(feedback[0].agentName).toBe('反馈者');
    expect(feedback[0].taskId).toBe(task.id);
    expect(feedback[0].contextSnapshot?.messages.length).toBeGreaterThan(0);
    expect(feedback[0].contextSnapshot?.turnSeq).toBe(1);
  });

  it('loads a skill package with scripts and resolves placeholders into the agent workspace', async () => {
    const h = createHarness((request) => {
      if (request.meta.iteration === 1) return toolCall('load_skill', { name: '脚本技能' });
      if (request.meta.iteration === 2) {
        return toolCall('write', { file_path: 'output/result.md', content: '脚本技能已加载' });
      }
      return toolCall('handoff', { folder: 'output' });
    });
    const skill = h.store.createSkill({
      name: '脚本技能',
      description: '带脚本的技能',
      content: "# 脚本技能\n\n运行：node '{{script:hello.js}}'",
    });
    h.store.upsertSkillFile(skill.id, {
      path: 'scripts/hello.js',
      content: "console.log('hello from skill');",
    });
    const agents = createAgents(h.store, ['脚本执行者']);
    h.store.updateAgent(agents[0].id, { skillIds: [skill.id] });
    const pipeline = createPipeline(h.store, '脚本流水线', [{ key: '脚本', agent: agents[0] }]);

    const task = h.runtime.startTask({ task: '脚本技能测试', pipelineId: pipeline.id });
    await waitForStatus(h, task.id, 'waiting_human');
    h.runtime.completeTaskByHuman(task.id);

    const detail = taskDetail(h.store, task.id);
    const loaded = toolMessages(h.store, detail.turns[0].id).find((message) =>
      message.content.includes('技能文件'),
    );
    expect(loaded).toBeTruthy();
    expect(loaded!.content).toContain('scripts/hello.js');
    expect(loaded!.content).toContain('可直接执行的脚本');
    expect(loaded!.content).not.toContain('{{script:');

    const workspace = h.store.agentTaskWorkspaceDir(task.id, agents[0].slug);
    const skillsRoot = path.join(workspace, '.skills');
    const packageDirs = fs.readdirSync(skillsRoot);
    expect(packageDirs).toHaveLength(1);
    const packageDir = path.join(skillsRoot, packageDirs[0]);
    expect(fs.readFileSync(path.join(packageDir, 'scripts', 'hello.js'), 'utf8')).toContain(
      'hello from skill',
    );
    expect(fs.readFileSync(path.join(packageDir, 'SKILL.md'), 'utf8')).not.toContain('{{script:');
  });

  it('recovers from a context-overflow error by truncating oversized tool output and retrying', async () => {
    let calls = 0;
    const h = createHarness(() => {
      calls += 1;
      if (calls === 1) return toolCall('big_output', {});
      if (calls === 2) throw new LlmError('This model maximum context length is 128000 tokens', 400);
      if (calls === 3) return toolCall('write', { file_path: 'output/result.md', content: '压缩重试完成' });
      return toolCall('handoff', { folder: 'output' });
    });
    const agents = createAgents(h.store, ['压缩者']);
    const tool = h.store.createTool({
      name: 'big_output',
      description: '返回一大段工具输出',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      code: "async () => 'x'.repeat(5000)",
    });
    h.store.updateAgent(agents[0].id, { tools: { builtin: ['write'], custom: [tool.id] } });
    const pipeline = createPipeline(h.store, '压缩流水线', [{ key: '压缩', agent: agents[0] }]);

    const task = h.runtime.startTask({ task: '上下文超限重试测试', pipelineId: pipeline.id });
    await waitForStatus(h, task.id, 'waiting_human');
    h.runtime.completeTaskByHuman(task.id);
    // 第 2 次调用报上下文超限 → 截断工具输出后重试第 3 次成功，再进入第 4 次交接
    expect(calls).toBe(4);
    const retried = h.provider.calls[2].messages.filter((message) => message.role === 'tool');
    expect(retried.some((message) => (message.content ?? '').includes('工具输出已截断'))).toBe(true);
    // 落库记录保持原文，截断只作用于发送副本
    const detail = taskDetail(h.store, task.id);
    const conversation = h.store.getTurnConversation(detail.turns[0].id)!;
    const stored = h.store.listMessages(conversation.id).filter((message) => message.role === 'tool');
    expect(stored.some((message) => message.content === 'x'.repeat(5000))).toBe(true);
  });

  it('passes pipeline-oriented metadata to the model on every call', async () => {
    const h = createHarness((request) => {
      if (request.meta.iteration === 1) return toolCall('write', { file_path: 'output/meta.md', content: '元数据测试' });
      return toolCall('handoff', { folder: 'output' });
    });
    const agents = createAgents(h.store, ['甲']);
    const pipeline = createPipeline(h.store, '元数据流水线', [{ key: '唯一', agent: agents[0] }]);

    const task = h.runtime.startTask({ task: '元数据测试', pipelineId: pipeline.id });
    await waitForStatus(h, task.id, 'waiting_human');
    const first = h.provider.calls[0];
    expect(first.meta).toMatchObject({
      agentName: '甲',
      taskId: task.id,
      turnSeq: 1,
      nextAgentNames: [],
      terminal: true,
      iteration: 1,
    });
    expect(first.meta.turnId).toBe(task.currentTurnId);
    expect(Object.keys(first.meta).sort()).toEqual([
      'agentName',
      'iteration',
      'nextAgentNames',
      'taskId',
      'terminal',
      'turnId',
      'turnSeq',
    ]);
    h.runtime.completeTaskByHuman(task.id);
  });

  it('keeps the pipeline snapshot stable when the pipeline is edited while the task runs', async () => {
    const gate = deferred();
    disposers.push(() => gate.resolve());
    const h = createHarness(async (request) => {
      const { agentName, iteration } = request.meta;
      if (agentName === '甲' && iteration === 1) {
        await gate.promise;
        return toolCall('write', { file_path: 'output/plan.md', content: '计划' });
      }
      if (agentName === '甲') {
        return toolCall('handoff', { folder: 'output' });
      }
      if (iteration === 1) return toolCall('write', { file_path: 'output/final.md', content: '最终稿' });
      return toolCall('handoff', { folder: 'output' });
    });
    const agents = createAgents(h.store, ['甲', '乙']);
    const first = randomUUID();
    const second = randomUUID();
    const pipeline = h.store.createPipeline({
      name: '原始流水线',
      description: '原始简介',
      nodes: [
        { id: first, agentId: agents[0].id, isStart: true, x: 0, y: 0 },
        { id: second, agentId: agents[1].id, x: 300, y: 0 },
      ],
      edges: [{ id: 'e1', from: first, to: second, triggerPrompt: '原始提示词：{deliverables}' }],
    });

    const task = h.runtime.startTask({ task: '快照稳定性测试', pipelineId: pipeline.id });
    await waitFor(() => h.runtime.getStatus().busyAgents.length > 0);
    h.store.updatePipeline(pipeline.id, {
      name: '改版流水线',
      description: '改版简介',
      nodes: [
        { id: first, agentId: agents[0].id, isStart: true, x: 1, y: 1 },
        { id: second, agentId: agents[1].id, x: 2, y: 2 },
      ],
      edges: [{ id: 'e1', from: first, to: second, triggerPrompt: '改版提示词' }],
    });
    gate.resolve();
    await waitForStatus(h, task.id, 'waiting_human');

    expect(h.store.getPipeline(pipeline.id)?.name).toBe('改版流水线');
    const detail = taskDetail(h.store, task.id);
    expect(detail.pipelineName).toBe('原始流水线');
    expect(detail.pipeline?.name).toBe('原始流水线');
    expect(detail.pipeline?.description).toBe('原始简介');
    expect(detail.pipeline?.nodes.map((node) => node.x)).toEqual([0, 300]);
    expect(detail.pipeline?.edges[0].triggerPrompt).toBe('原始提示词：{deliverables}');
    // 下游用的仍是快照里的原始提示词
    expect(detail.turns[1].input).toContain('原始提示词：');
    expect(detail.turns[1].input).not.toContain('改版提示词');
    h.runtime.completeTaskByHuman(task.id);
  });

  it('no longer exposes free-form assignment', () => {
    const h = createHarness(() => final('不会执行'));
    expect((h.runtime as unknown as Record<string, unknown>).assignTask).toBeUndefined();
  });

  it('rejects duplicate agent names within the team', () => {
    const h = createHarness(() => final('不会执行'));
    h.store.createAgent({ name: '甲' });
    expect(() => h.store.createAgent({ name: '甲' })).toThrow(/同名智能体/);
    // 名称唯一性不区分大小写
    h.store.createAgent({ name: 'alice' });
    expect(() => h.store.createAgent({ name: 'Alice' })).toThrow(/同名智能体/);
    // 改名也不能撞名
    const bob = h.store.createAgent({ name: 'bob' });
    expect(() => h.store.updateAgent(bob.id, { name: 'ALICE' })).toThrow(/同名智能体/);
    // 按名称可以取回智能体（连线 target 参数按名称匹配交接对象）
    expect(h.store.getAgentByName(' 甲 ')?.name).toBe('甲');
    expect(h.store.getAgentByName('ALICE')?.name).toBe('alice');
    expect(h.store.getAgentByName('不存在')).toBeNull();
  });

  it('persists and updates the deliverable field', () => {
    const h = createHarness(() => final('不应调用'));
    const agent = h.store.createAgent({ name: '交付字段测试', deliverable: '初版交付内容' });
    expect(agent.deliverable).toBe('初版交付内容');
    const updated = h.store.updateAgent(agent.id, { deliverable: '改版交付内容' });
    expect(updated.deliverable).toBe('改版交付内容');
  });

  it('defaults maxIterations to unlimited (0) for new agents', () => {
    const h = createHarness(() => final('不会执行'));
    const agent = h.store.createAgent({ name: '默认轮数' });
    expect(agent.maxIterations).toBe(0);
  });
});
