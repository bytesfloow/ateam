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

/** 等全部任务回合跑完（无 busy 智能体且没有 running 任务）。 */
async function waitForTasksIdle(harness: Harness): Promise<void> {
  await waitFor(() => {
    const active = harness.store.findActiveTestTask() ?? harness.store.findActiveTask();
    return !active || !['running'].includes(active.status);
  });
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

/** 被训智能体的标准替身：先写交付文件再 submit（submit 的目录必须真实存在）。 */
function submitAfterWrite(text = '交付完成'): (request: LlmRequest) => LlmResponse {
  let n = 0;
  return () => {
    n += 1;
    if (n === 1) {
      return toolCall('write', { file_path: 'output/report.md', content: '# 交付\n测试产出。' });
    }
    return toolCall('submit', { folder: 'output' }, text);
  };
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

  it('系统提示词：正向描述工作规则，不含负向划界与模板禁令', () => {
    const { trainer } = createHarness(() => textReply('好'));
    const prompt = trainer.getProfile().systemPrompt;
    // 工作流正向规则。
    expect(prompt).toContain('先讲思路再动手');
    expect(prompt).toContain('认可');
    expect(prompt).toContain('start_test_task');
    expect(prompt).toContain('评审');
    expect(prompt).toContain('get_agent');
    // 能力边界（系统约定，正向表述）。
    expect(prompt).toContain('内置工具');
    // 训练位状态段：无训练对象时明确提示。
    expect(prompt).toContain('当前没有正在训练的智能体');
    // 不再出现负向划界句与「从 0 撰写/不要沿用模板」式自我冲突禁令。
    expect(prompt).not.toContain('不在你的职责内');
    expect(prompt).not.toContain('不要沿用');
    expect(prompt).not.toContain('完全从 0 撰写');
  });

  it('get_agent 无参数：无训练对象时提示；create 后自动成为训练对象并返回详情', async () => {
    let step = 0;
    const { store, trainer } = createHarness(
      byAgent({
        智能体训练师: () => {
          if (step === 0) {
            step += 1;
            return toolCall('get_agent', {});
          }
          if (step === 1) {
            step += 1;
            return toolCall('apply_changes', {
              title: '新建简报助手',
              summary: '打造每日简报智能体',
              changes: [
                {
                  op: 'create_agent',
                  agent: {
                    name: '简报助手',
                    description: '每天产出一份简报',
                    prompt: '你是简报助手。输入：一句话主题。职责：围绕主题写 200 字简报，事实需可溯源。交付：markdown 文件。',
                    temperature: 0.2,
                  },
                },
              ],
            });
          }
          if (step === 2) {
            step += 1;
            return toolCall('get_agent', {});
          }
          return textReply('训练对象已就绪。');
        },
      }),
    );

    trainer.createSession();
    const session = store.listTrainerSessions()[0]!;
    trainer.sendMessage(session.id, '先看当前训练对象，再创建一个');
    await waitForIdle(trainer);

    // 训练位：create_agent 后自动占用。
    const focus = store.trainerFocusAgent();
    expect(focus).not.toBeNull();
    expect(focus!.name).toBe('简报助手');
    expect(focus!.prompt).toContain('你是简报助手');
    // 训练型智能体不参与流水线模板（prompt 非空即训练型）。
    const stored = store.getAgentByName('简报助手')!;
    expect(stored.prompt).not.toBeNull();

    // get_agent 的返回：无对象 → 提示；有对象 → 含提示词原文。
    const toolMessages = store
      .listTrainerMessages(session.id)
      .filter((message) => message.role === 'tool' && message.name === 'get_agent');
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]!.content).toContain('当前没有正在训练的智能体');
    expect(toolMessages[1]!.content).toContain('你是简报助手');
  });

  it('create_agent 缺 prompt 被拒绝；四件套字段被剥离不落库', async () => {
    let step = 0;
    const { store, trainer } = createHarness(
      byAgent({
        智能体训练师: () => {
          if (step === 0) {
            step += 1;
            return toolCall('apply_changes', {
              title: '缺提示词',
              summary: '缺 prompt 的创建',
              changes: [
                {
                  op: 'create_agent',
                  agent: { name: '残缺智能体', responsibilities: '任务说明' },
                },
              ],
            });
          }
          if (step === 1) {
            step += 1;
            // update_agent 夹带流水线字段：应被剥离（只允许 prompt 等训练师字段）。
            return toolCall('apply_changes', {
              title: '夹带四件套',
              summary: '尝试写入流水线字段',
              changes: [
                {
                  op: 'update_agent',
                  agent: { responsibilities: '越权写入任务说明', prompt: '合法的提示词更新' },
                },
              ],
            });
          }
          return textReply('完成');
        },
      }),
    );

    trainer.createSession();
    const session = store.listTrainerSessions()[0]!;
    trainer.sendMessage(session.id, '试试越权');
    await waitForIdle(trainer);

    // 第一次 create 因缺 prompt 失败，没有创建任何智能体、没有训练位。
    expect(store.getAgentByName('残缺智能体')).toBeNull();

    // 第二次 update：当前没有训练对象，也应失败（不能凭空更新）。
    expect(store.trainerFocusAgent()).toBeNull();
  });

  it('update_agent 面向训练对象；带 name 切换训练对象；流水线成员不可接管', async () => {
    let step = 0;
    const { store, trainer } = createHarness(
      byAgent({
        智能体训练师: () => {
          if (step === 0) {
            step += 1;
            return toolCall('apply_changes', {
              title: '创建',
              summary: '创建训练对象',
              changes: [
                { op: 'create_agent', agent: { name: '候选A', prompt: 'A 的提示词' } },
              ],
            });
          }
          if (step === 1) {
            step += 1;
            return toolCall('apply_changes', {
              title: '改名训练对象',
              summary: '更新 A',
              changes: [
                { op: 'update_agent', agent: { name: '候选A改', prompt: 'A 的新提示词' } },
              ],
            });
          }
          if (step === 2) {
            step += 1;
            // 试图接管流水线成员：应被拒绝。
            return toolCall('apply_changes', {
              title: '接管流水线成员',
              summary: '切换训练对象',
              changes: [
                { op: 'update_agent', name: '流水线成员', agent: {} },
              ],
            });
          }
          return textReply('完成');
        },
      }),
    );

    // 预置：一个流水线成员智能体 + 一条引用它的流水线。
    const member = store.createAgent({ name: '流水线成员', responsibilities: '做事' });
    store.createPipeline({
      name: '业务流水线',
      nodes: [{ id: 'n1', agentId: member.id, isStart: true, x: 0, y: 0 }],
      edges: [],
    });

    trainer.createSession();
    const session = store.listTrainerSessions()[0]!;
    trainer.sendMessage(session.id, '走一遍训练位切换');
    await waitForIdle(trainer);

    // 训练位跟随改名后的对象。
    const focus = store.trainerFocusAgent();
    expect(focus?.name).toBe('候选A改');
    expect(focus?.prompt).toBe('A 的新提示词');

    const messages = store.listTrainerMessages(session.id).filter((message) => message.role === 'tool');
    const lastChange = messages[messages.length - 1]!.content;
    expect(lastChange).toContain('流水线');
  });

  it('start_test_task：无参启动试运行（kind=test），提示词为训练师原文，工具含 submit 不含 handoff；流水线任务在跑不阻塞', async () => {
    let step = 0;
    const harness = createHarness(
      byAgent({
        智能体训练师: () => {
          if (step === 0) {
            step += 1;
            return toolCall('apply_changes', {
              title: '创建测试对象',
              summary: '创建',
              changes: [
                {
                  op: 'create_agent',
                  agent: {
                    name: '简报助手',
                    description: '简报',
                    prompt: '你是简报助手，围绕主题写 200 字简报，交付 markdown 文件。',
                  },
                },
              ],
            });
          }
          return toolCall('start_test_task', { task: '主题：多智能体协作' });
        },
        简报助手: submitAfterWrite('简报写好了'),
      }),
    );
    const { store, runtime, trainer, provider } = harness;

    // 预置一条用户流水线 + 一个成员智能体，先启动一个流水线任务占住互斥位。
    const member = store.createAgent({ name: '流水线成员', responsibilities: '做事' });
    store.createPipeline({
      name: '业务流水线',
      nodes: [{ id: 'n1', agentId: member.id, isStart: true, x: 0, y: 0 }],
      edges: [],
    });
    const bizStarted = runtime.startTask({ pipelineId: store.listPipelines()[0]!.id, task: '业务任务' });
    expect(bizStarted.status).toBe('running');

    trainer.createSession();
    const session = store.listTrainerSessions()[0]!;
    trainer.sendMessage(session.id, '创建并测试');
    await waitForIdle(trainer);

    // 试运行任务在流水线任务占用期间也能启动（两类互斥独立）。
    const testTask = await waitFor(
      () => store.listTasks(50).find((task) => task.kind === 'test' && task.status !== 'aborted'),
    );
    expect(testTask.kind).toBe('test');
    expect(store.findActiveTestTask()?.id).toBe(testTask.id);

    // 等试运行完成：submit 交付后转 waiting_human。
    await waitFor(() => {
      const current = store.getTaskDetail(testTask.id);
      return current?.status === 'waiting_human' ? current : null;
    });
    const detail = store.getTaskDetail(testTask.id)!;
    expect(detail.turns).toHaveLength(1);
    // 系统提示词 = 训练师原文 + 运行注入；不含流水线模板。
    const systemPrompt = store.getTurnSystemPrompt(detail.turns[0]!.id) ?? '';
    expect(systemPrompt).toContain('你是简报助手');
    expect(systemPrompt).not.toContain('流水线的一员');
    expect(systemPrompt).not.toContain('智能体训练台');
    expect(systemPrompt).toContain('submit');
    expect(systemPrompt).not.toContain('handoff 交接');
    // 工具清单：submit 在、handoff 不在。
    const taskRequest = provider.calls.find(
      (call) => call.meta?.agentName === '简报助手' && call.tools?.length,
    );
    const toolNames = (taskRequest?.tools ?? []).map((tool) => tool.function.name);
    expect(toolNames).toContain('submit');
    expect(toolNames).not.toContain('handoff');
    // 交付目录进了 final。
    expect(detail.turns[0]!.handoffFolder?.deliveredPath).toContain('final');

    // 清理：终止流水线任务，避免影响后续断言（本 harness 内即可）。
    runtime.terminateTask(bizStarted.id, '测试收尾');
  });

  it('start_test_task 拒绝无提示词的训练对象；试运行互斥：活动试运行任务存在时拒绝再次启动', async () => {
    let step = 0;
    const harness = createHarness(
      byAgent({
        智能体训练师: () => {
          if (step === 0) {
            step += 1;
            return toolCall('apply_changes', {
              title: '创建无提示词对象',
              summary: '创建',
              changes: [
                { op: 'create_agent', agent: { name: '空白智能体', prompt: '占位提示词' } },
              ],
            });
          }
          if (step === 1) {
            step += 1;
            return toolCall('start_test_task', { task: '第一轮' });
          }
          if (step === 2) {
            step += 1;
            // 再次启动：已有活动试运行任务，应拒绝。
            return toolCall('start_test_task', { task: '第二轮' });
          }
          return toolCall('stop_test_task', { reason: '收尾' });
        },
        空白智能体: submitAfterWrite('好了'),
      }),
    );
    const { store, trainer } = harness;

    trainer.createSession();
    const session = store.listTrainerSessions()[0]!;
    trainer.sendMessage(session.id, '跑一遍互斥');
    await waitForIdle(trainer);
    // 第一轮试运行被 stop 终止：等它落到 aborted。
    const firstTest = await waitFor(() => store.listTasks(50).find((task) => task.kind === 'test'));
    await waitFor(() => (store.getTaskDetail(firstTest.id)?.status === 'aborted' ? true : null));

    const toolMessages = store
      .listTrainerMessages(session.id)
      .filter((message) => message.role === 'tool' && message.name === 'start_test_task');
    // 第二次启动被拒（409 文案进入工具结果）。
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[1]!.meta?.toolStatus === 'error' || toolMessages[1]!.content.includes('未结束')).toBe(true);
  });

  it('视野：无 list_agents；get_agent 不接受参数；任务类工具只见试运行任务', async () => {
    let trainingId = '';
    let step = 0;
    const { store, runtime, trainer } = createHarness(
      byAgent({
        智能体训练师: () => {
          step += 1;
          if (step === 1) {
            return toolCall('apply_changes', {
              title: '创建',
              summary: '创建训练对象',
              changes: [
                { op: 'create_agent', agent: { name: '被训对象', prompt: '被训对象的提示词' } },
              ],
            });
          }
          if (step === 2) {
            return toolCall('start_test_task', { task: '试运行任务' });
          }
          if (step === 3) {
            return toolCall('list_tasks', {});
          }
          // 第二轮对话（trainingId 已赋值）时才查详情；第一轮先收尾。
          if (trainingId) {
            return toolCall('get_task', { id: trainingId });
          }
          return textReply('试运行已发起，稍后看详情。');
        },
        被训对象: submitAfterWrite('完成'),
      }),
    );

    // 预置一个用户的流水线任务（应不可见）。
    const member = store.createAgent({ name: '业务成员', responsibilities: '做事' });
    store.createPipeline({
      name: '业务流水线',
      nodes: [{ id: 'n1', agentId: member.id, isStart: true, x: 0, y: 0 }],
      edges: [],
    });
    const biz = runtime.startTask({ pipelineId: store.listPipelines()[0]!.id, task: '业务任务' });
    runtime.terminateTask(biz.id, '立即终止，仅留记录');

    trainer.createSession();
    const session = store.listTrainerSessions()[0]!;
    trainer.sendMessage(session.id, '走一遍视野');
    await waitForIdle(trainer);

    const testTask = await waitFor(() => store.listTasks(50).find((task) => task.kind === 'test'));
    trainingId = testTask.id;
    // 补一次对话触发 get_task。
    trainer.sendMessage(session.id, '看看任务详情');
    await waitForIdle(trainer);

    const toolMessages = store
      .listTrainerMessages(session.id)
      .filter((message) => message.role === 'tool');
    const listContent = toolMessages.find((message) => message.name === 'list_tasks')?.content ?? '';
    // 只见试运行任务，不见业务任务。
    expect(listContent).not.toContain('业务流水线');
    expect(listContent).toContain('试运行');
    const getContent = toolMessages.find((message) => message.name === 'get_task')?.content ?? '';
    // get_task 输出去流水线化：不出现「环节链路 / 交接」字样。
    expect(getContent).not.toContain('环节链路');
    expect(getContent).not.toContain('交接');
    expect(getContent).toContain('运行记录');

    // 工具注册表：无 list_agents。
    const profile = trainer.getProfile();
    const toolNames = profile.tools.map((tool) => tool.name);
    expect(toolNames).not.toContain('list_agents');
  });

  it('stop_test_task 终止进行中的试运行任务', async () => {
    let step = 0;
    const { store, trainer } = createHarness(
      byAgent({
        智能体训练师: () => {
          if (step === 0) {
            step += 1;
            return toolCall('apply_changes', {
              title: '创建',
              summary: '创建',
              changes: [
                { op: 'create_agent', agent: { name: '慢智能体', prompt: '慢慢做的智能体' } },
              ],
            });
          }
          if (step === 1) {
            step += 1;
            return toolCall('start_test_task', { task: '慢慢做' });
          }
          return toolCall('stop_test_task', { reason: '任务跑偏了' });
        },
        慢智能体: submitAfterWrite('做完了'),
      }),
    );

    trainer.createSession();
    const session = store.listTrainerSessions()[0]!;
    trainer.sendMessage(session.id, '先启动再停掉');
    await waitForIdle(trainer);

    const task = store.listTasks(10).find((item) => item.kind === 'test');
    expect(task).toBeDefined();
    expect(task!.status).toBe('aborted');
  });

  it('apply_changes 越权：流水线类变更被拒绝', async () => {
    const { store, trainer } = createHarness(
      byAgent({
        智能体训练师: () =>
          toolCall('apply_changes', {
            title: '越权',
            summary: '试图创建流水线',
            changes: [{ op: 'create_pipeline', pipeline: { name: '私搭流水线', nodes: [], edges: [] } }],
          }),
      }),
    );

    trainer.createSession();
    const session = store.listTrainerSessions()[0]!;
    trainer.sendMessage(session.id, '试试越权');
    await waitForIdle(trainer);

    expect(store.listPipelines().find((pipeline) => pipeline.name === '私搭流水线')).toBeUndefined();
    const toolMessage = store
      .listTrainerMessages(session.id)
      .find((message) => message.role === 'tool' && message.name === 'apply_changes');
    expect(toolMessage?.meta?.toolStatus).toBe('error');
  });

  it('训练位跨会话持久：新会话的系统提示词包含当前训练对象', () => {
    const { store, trainer } = createHarness(() => textReply('好'));
    const created = store.createAgent({
      name: '持久对象',
      prompt: '持久对象的提示词',
    });
    store.setTrainerFocusAgentId(created.id);

    const prompt = trainer.getProfile().systemPrompt;
    expect(prompt).toContain('持久对象');
    // 删除训练对象后训练位悬空自动失效。
    store.deleteAgent(created.id);
    expect(store.trainerFocusAgent()).toBeNull();
  });
});
