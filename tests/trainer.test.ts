import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../server/src/db';
import { Runtime } from '../server/src/runtime';
import { RuntimeEvents } from '../server/src/events';
import { TrainerRuntime } from '../server/src/trainer';
import type { LlmProvider, LlmRequest, LlmResponse } from '../server/src/llm';
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
    if (this.calls.length > 60) {
      throw new Error(`请求熔断：${request.meta?.agentName} 已发起 ${this.calls.length} 次请求，疑似死循环`);
    }
    return this.handler(request);
  }
}

interface Harness {
  store: Store;
  runtime: Runtime;
  trainer: TrainerRuntime;
  provider: TestProvider;
  root: string;
  dispose: () => void;
}

const harnesses: Harness[] = [];

function createHarness(handler: Handler): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-trainer-test-'));
  const db = openDatabase(':memory:');
  const store = new Store({ db, workspaceRoot: root });
  const provider = new TestProvider(handler);
  const runtime = new Runtime({ store, providerFactory: () => provider });
  const trainer = new TrainerRuntime({ store, events: new RuntimeEvents(), providerFactory: () => provider, taskRuntime: runtime });
  trainer.ensureReady();
  const harness: Harness = {
    store,
    runtime,
    trainer,
    provider,
    root,
    dispose: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

async function waitFor<T>(check: () => T | undefined | null | false, timeout = 4000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 等一轮对话跑完（训练师回到空闲）。 */
async function waitForIdle(trainer: TrainerRuntime): Promise<void> {
  await waitFor(() => !trainer.busy);
}

function toolCall(name: string, args: unknown, text = ''): LlmResponse {
  return {
    content: text,
    toolCalls: [{ id: `call_${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) }],
  };
}

function textReply(content: string): LlmResponse {
  return { content, toolCalls: [] };
}

/** 区分训练师对话与测试任务：任务智能体按名字分流。 */
function byAgent(map: Record<string, (request: LlmRequest) => LlmResponse>): Handler {
  return (request) => {
    const name = request.meta?.agentName ?? '';
    const handler = map[name];
    if (!handler) throw new Error(`未配置的智能体：${name}`);
    return handler(request);
  };
}

describe('trainer agent', () => {
  it('ensures the trainer agent with a fixed slug and keeps it stable', () => {
    const { store } = createHarness(() => textReply('好'));
    const agent = store.getTrainerAgent();
    expect(agent).not.toBeNull();
    expect(agent!.slug).toBe('trainer');
    expect(agent!.name).toBe('智能体训练师');

    // 再次 ensure 不重复创建、不覆盖人类维护过的定义。
    store.updateAgent(agent!.id, { description: '人类改过的描述' });
    const again = store.getTrainerAgent();
    expect(again!.id).toBe(agent!.id);
    expect(again!.description).toBe('人类改过的描述');
  });

  it('系统提示词包含三条训练规则：从 0 写提示词、先讲思路再动手、改完必测并请用户评审', () => {
    const { trainer } = createHarness(() => textReply('好'));
    const profile = trainer.getProfile();
    const prompt = profile.systemPrompt;
    // 规则一：创建的智能体必须写清输入 / 职责与工作目标 / 交付要求，且提示词完全从 0 撰写。
    expect(prompt).toContain('从 0');
    expect(prompt).toContain('输入');
    expect(prompt).toContain('职责与工作目标');
    expect(prompt).toContain('交付要求');
    // 规则二：改完必测 + 用户评审 + 反馈迭代下一轮。
    expect(prompt).toContain('start_test_task');
    expect(prompt).toContain('评审');
    // 规则三：动 apply_changes 前先讲思路、等用户认可。
    expect(prompt).toContain('先讲思路再动手');
    expect(prompt).toContain('认可');
    // 能力边界：内置工具统一授予、不可删除修改。
    expect(prompt).toContain('内置工具');
  });

  it('apply_changes 从 0 创建智能体并留档，随后可更新它的全部参数', async () => {
    let step = 0;
    const { store, trainer } = createHarness(
      byAgent({
        智能体训练师: () => {
          if (step === 0) {
            step += 1;
            return toolCall('apply_changes', {
              title: '新建简报助手',
              summary: '从 0 打造每日简报智能体',
              changes: [
                {
                  op: 'create_agent',
                  agent: {
                    name: '简报助手',
                    description: '每天产出一份简报',
                    responsibilities: '输入：一句话主题。职责：围绕主题写 200 字简报。交付：markdown 文件。',
                    temperature: 0.2,
                  },
                },
              ],
            });
          }
          return textReply('已创建，马上启动测试任务。');
        },
      }),
    );
    trainer.createSession();
    const session = store.listTrainerSessions()[0]!;
    trainer.sendMessage(session.id, '帮我做一个简报助手');
    await waitForIdle(trainer);

    const created = store.getAgentByName('简报助手');
    expect(created).not.toBeNull();
    expect(created!.temperature).toBe(0.2);
    const proposals = store.listTrainerProposals(session.id);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.status).toBe('applied');
  });

  it('apply_changes 拒绝流水线变更与对系统角色的变更', async () => {
    let step = 0;
    const { store, trainer } = createHarness(() => {
      if (step === 0) {
        step += 1;
        return toolCall('apply_changes', {
          title: '越权变更',
          summary: '试图建流水线并修改训练师',
          changes: [
            { op: 'create_pipeline', pipeline: { name: 'P', description: '', nodes: [], edges: [] } },
          ],
        });
      }
      return textReply('明白了，越权了。');
    });
    trainer.createSession();
    const session = store.listTrainerSessions()[0]!;
    trainer.sendMessage(session.id, '顺手把流水线也建了吧');
    await waitForIdle(trainer);

    const toolMessage = store
      .listTrainerMessages(session.id)
      .find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('不在训练师的变更范围内');
    // 越权变更不留生效记录。
    expect(store.listTrainerProposals(session.id)).toHaveLength(0);

    // 对系统角色的变更被拒绝（训练师自己）。
    let replied = false;
    let step2 = 0;
    const harness2 = createHarness(() => {
      if (step2 === 0) {
        step2 += 1;
        return toolCall('apply_changes', {
          title: '改训练师',
          summary: '试图修改训练师提示词',
          changes: [{ op: 'update_agent', agentName: '智能体训练师', agent: { description: '被改' } }],
        });
      }
      return textReply('知道了。');
    });
    harness2.trainer.createSession();
    const session2 = harness2.store.listTrainerSessions()[0]!;
    harness2.trainer.sendMessage(session2.id, '把你自己改了');
    await waitForIdle(harness2.trainer);
    const tool2 = harness2.store
      .listTrainerMessages(session2.id)
      .find((message) => message.role === 'tool');
    expect(tool2?.content).toContain('是系统角色');
    expect(harness2.store.getTrainerAgent()!.description).not.toBe('被改');
    replied = true;
    expect(replied).toBe(true);
  });

  it('start_test_task 把「智能体训练台」指向目标智能体并启动任务；活动任务存在时拒绝再次启动', async () => {
    let step = 0;
    const { store, trainer, runtime } = createHarness(
      byAgent({
        智能体训练师: () => {
          if (step === 0) {
            step += 1;
            return toolCall('start_test_task', { agent: '简报助手', task: '以「秋天」为主题产出一期简报' });
          }
          return textReply('测试任务已启动，请用户评审。');
        },
        简报助手: () => toolCall('handoff', { folder: 'output' }, '简报正文：秋天是一个收获的季节。（终点交付）'),
      }),
    );
    store.createAgent({
      name: '简报助手',
      description: '每天产出一份简报',
      responsibilities: '输入：主题。职责：写简报。交付：文本。',
    });

    trainer.createSession();
    const session = store.listTrainerSessions()[0]!;
    trainer.sendMessage(session.id, '启动一轮测试');
    await waitForIdle(trainer);

    // 测试流水线：单节点指向目标智能体、无连线（即终点）。
    const pipeline = store.listPipelines().find((item) => item.name === '智能体训练台');
    expect(pipeline).toBeDefined();
    expect(pipeline!.nodes).toHaveLength(1);
    expect(pipeline!.nodes[0]!.agentId).toBe(store.getAgentByName('简报助手')!.id);
    expect(pipeline!.edges).toHaveLength(0);

    // 任务已启动并跑到等待验收。
    const task = store.listTasks(10)[0];
    expect(task).toBeDefined();
    expect(task!.pipelineName).toBe('智能体训练台');
    await waitFor(() => store.listTasks(10)[0]?.status === 'waiting_human');

    // 已有活动任务（等待验收也算）时再次启动被拒绝。
    // 训练师每轮对话是「工具调用 + 文本收尾」两次请求：奇数次请求发起 start_test_task，偶数次收尾。
    let step2 = 0;
    const harness2 = createHarness(
      byAgent({
        智能体训练师: () => {
          step2 += 1;
          if (step2 % 2 === 1) {
            return toolCall('start_test_task', { agent: '简报助手', task: '再来一轮' });
          }
          return textReply('好的');
        },
        简报助手: () => toolCall('handoff', { folder: 'output' }, '完成'),
      }),
    );
    harness2.store.createAgent({ name: '简报助手', responsibilities: '写简报' });
    const { store: store2, trainer: trainer2 } = harness2;
    // 训练师对话里触发启动（第一轮已占住活动任务后才发第二轮）。
    trainer2.createSession();
    const session2 = store2.listTrainerSessions()[0]!;
    trainer2.sendMessage(session2.id, '开始测试');
    await waitForIdle(trainer2);
    // 等第一轮任务进入等待验收（活动位被占）。
    await waitFor(() => store2.listTasks(10)[0]?.status === 'waiting_human');
    // 再发一轮：这次 start_test_task 应该报 409。
    trainer2.sendMessage(session2.id, '再启动一轮测试');
    await waitForIdle(trainer2);
    const messages2 = store2.listTrainerMessages(session2.id).filter((message) => message.role === 'tool');
    expect(messages2.some((message) => (message.content ?? '').includes('已有未结束的任务'))).toBe(true);
  });

  it('视野收窄：没有 list_agents；系统角色不可查；任务类工具只见测试任务', async () => {
    let req = 0;
    let foreignId = '';
    let trainingId = '';
    const { store, trainer, runtime } = createHarness(
      byAgent({
        智能体训练师: () => {
          req += 1;
          if (req === 1) {
            return toolCall('start_test_task', { agent: '简报助手', task: '以「秋天」为主题产出一期简报' });
          }
          if (req === 2) return toolCall('list_tasks', {});
          if (req === 3) return toolCall('get_task', { id: foreignId.slice(0, 8) });
          if (req === 4) return toolCall('stop_test_task', { id: foreignId.slice(0, 8) });
          return textReply('好的');
        },
        简报助手: () => toolCall('handoff', { folder: 'output' }, '简报完成'),
        杂活员: () => toolCall('handoff', { folder: 'output' }, '杂活完成'),
      }),
    );

    // 提示词与工具清单：没有系统级视野。
    const profile = trainer.getProfile();
    expect(profile.tools.some((tool) => tool.name === 'list_agents')).toBe(false);
    for (const name of ['get_agent', 'apply_changes', 'start_test_task', 'stop_test_task', 'list_tasks', 'get_task']) {
      expect(profile.tools.some((tool) => tool.name === name)).toBe(true);
    }
    expect(profile.systemPrompt).not.toContain('流水线');
    expect(profile.systemPrompt).not.toContain('设计师');
    expect(profile.systemPrompt).not.toContain('系统清单');

    // 训练对象 + 一条外部流水线的任务（不属于训练师视野）。
    const agent = store.createAgent({ name: '简报助手', responsibilities: '写简报' });
    const foreignPipeline = store.createPipeline({
      name: '其他流水线',
      description: '',
      nodes: [{ agentId: agent.id }],
      edges: [],
    });
    const foreign = runtime.startTask({ pipelineId: foreignPipeline.id, task: '干点别的活' });
    foreignId = foreign.id;
    await waitFor(() => store.listTasks(200).find((task) => task.id === foreignId)?.status === 'waiting_human');
    runtime.terminateTask(foreignId, '外部任务先终止');

    trainer.createSession();
    const session = store.listTrainerSessions()[0]!;
    trainer.sendMessage(session.id, '开始训练');
    await waitForIdle(trainer);

    const toolMessages = store.listTrainerMessages(session.id).filter((message) => message.role === 'tool');
    expect(toolMessages.length).toBe(4);
    const trainingTask = store.listTasks(200).find((task) => task.pipelineName === '智能体训练台');
    expect(trainingTask).toBeDefined();
    trainingId = trainingTask!.id;
    const listMessage = toolMessages[1]!.content;
    expect(listMessage).toContain(trainingId.slice(0, 8));
    expect(listMessage).toContain('共 1 条任务');
    expect(listMessage).not.toContain(foreignId.slice(0, 8));
    expect(toolMessages[2]!.content).toContain('找不到测试任务');
    expect(toolMessages[3]!.content).toContain('找不到可终止的测试任务');
  });

  it('stop_test_task 终止进行中的测试任务', async () => {
    let step = 0;
    const { store, trainer } = createHarness(
      byAgent({
        智能体训练师: () => {
          if (step === 0) {
            step += 1;
            return toolCall('start_test_task', { agent: '慢智能体', task: '慢慢做' });
          }
          return toolCall('stop_test_task', { reason: '任务跑偏了' });
        },
        慢智能体: () => toolCall('handoff', { folder: 'output' }, '做完了'),
      }),
    );
    store.createAgent({ name: '慢智能体', responsibilities: '做事' });

    trainer.createSession();
    const session = store.listTrainerSessions()[0]!;
    trainer.sendMessage(session.id, '先启动再停掉');
    await waitForIdle(trainer);

    const task = store.listTasks(10)[0];
    expect(task).toBeDefined();
    expect(task!.status).toBe('aborted');
  });
});
