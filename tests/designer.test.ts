import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../server/src/db';
import { DesignerRuntime } from '../server/src/designer';
import { RuntimeEvents } from '../server/src/events';
import { MockProvider } from './helpers/MockProvider';
import { type LlmProvider, type LlmRequest, type LlmResponse } from '../server/src/llm';
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
  designer: DesignerRuntime;
  provider: TestProvider;
  root: string;
  dispose: () => void;
}

const harnesses: Harness[] = [];

function createHarness(handler: Handler): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-designer-test-'));
  const db = openDatabase(':memory:');
  const store = new Store({ db, workspaceRoot: root });
  const provider = new TestProvider(handler);
  const designer = new DesignerRuntime({
    store,
    events: new RuntimeEvents(),
    providerFactory: () => provider,
  });
  designer.ensureReady();
  const harness: Harness = {
    store,
    designer,
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

/** 等一轮对话跑完（设计师回到空闲）。 */
async function waitForIdle(designer: DesignerRuntime): Promise<void> {
  await waitFor(() => !designer.busy);
}

function toolCall(name: string, args: unknown): LlmResponse {
  return {
    content: '',
    toolCalls: [{ id: `call_${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) }],
  };
}

function textReply(content: string): LlmResponse {
  return { content, toolCalls: [] };
}

describe('designer agent', () => {
  it('ensures the designer agent with a fixed slug and keeps it stable', () => {
    const { store } = createHarness(() => textReply('好'));
    const agent = store.getDesignerAgent();
    expect(agent).not.toBeNull();
    expect(agent!.slug).toBe('designer');
    expect(agent!.name).toBe('流水线设计师');

    // 再次 ensure 不重复创建、不覆盖人类维护过的定义。
    store.updateAgent(agent!.id, { description: '人类改过的描述' });
    const again = store.getDesignerAgent();
    expect(again!.id).toBe(agent!.id);
    expect(again!.description).toBe('人类改过的描述');
  });

  it('rejects deleting the designer and using it as a pipeline node', () => {
    const { store } = createHarness(() => textReply('好'));
    const designer = store.getDesignerAgent()!;
    expect(() => store.deleteAgent(designer.id)).toThrow(/不能删除/);
    expect(() =>
      store.createPipeline({
        name: '含设计师',
        nodes: [{ agentId: designer.id, isStart: true }],
        edges: [],
      }),
    ).toThrow(/不能作为流水线节点/);
  });
});

describe('designer conversation loop', () => {
  it('runs a chat turn: tools available, reply persisted as a message', async () => {
    const { designer, provider, store } = createHarness(() => textReply('好的，请告诉我你想要的流水线。'));
    const session = designer.createSession();
    designer.sendMessage(session.id, '帮我搭一条翻译流水线');
    await waitForIdle(designer);

    const detail = designer.getSessionDetail(session.id);
    expect(detail.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(detail.messages[0].content).toContain('翻译流水线');
    expect(detail.messages[1].content).toContain('流水线');
    // 管理工具已注册进模型请求。
    const toolNames = provider.calls[0].tools.map((tool) => tool.function.name);
    expect(toolNames).toContain('apply_changes');
    expect(toolNames).toContain('get_agent');
    expect(toolNames).toContain('list_feedback');
    // 系统提示词包含全局清单与对话式变更规则。
    expect(provider.calls[0].messages[0].role).toBe('system');
    const systemPrompt = String(provider.calls[0].messages[0].content);
    expect(systemPrompt).toContain('apply_changes');
    expect(systemPrompt).toContain('工作目录');
    // 消息里不回传图片，但落库消息保留该列（此处无图片）。
    expect(store.listDesignerMessages(session.id)).toHaveLength(2);
  });

  it('resumes a session with history and titles it from the first message', async () => {
    let turn = 0;
    const { designer } = createHarness(() => (turn++ === 0 ? textReply('第一次回复') : textReply('第二次回复')));
    const session = designer.createSession();
    designer.sendMessage(session.id, '我想做一条内容审校流水线');
    await waitForIdle(designer);
    designer.sendMessage(session.id, '再补充一个环节');
    await waitForIdle(designer);

    const detail = designer.getSessionDetail(session.id);
    expect(detail.messages).toHaveLength(4);
    expect(detail.messages[0].content).toContain('内容审校');
    expect(detail.session.title).toContain('内容审校');
    // 第二次请求的 history 带上了首轮消息（system + 2 条历史 + 新 user）。
    expect(turn).toBe(2);
  });

  it('rejects a second message while busy and supports stop', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { designer } = createHarness(async () => {
      await gate;
      return textReply('慢回复');
    });
    const session = designer.createSession();
    designer.sendMessage(session.id, '慢慢想');
    await waitFor(() => designer.busy);
    expect(() => designer.sendMessage(session.id, '第二条')).toThrow(/正在处理上一条消息/);
    expect(designer.stop()).toBe(true);
    release!();
    await waitForIdle(designer);
    const detail = designer.getSessionDetail(session.id);
    expect(detail.messages.at(-1)?.content).toContain('停止');
  });

  it('never exposes handoff and completes a round with the real MockProvider', async () => {
    // 回归：makeBuiltinTools 会强制注入 handoff（流水线环节专用）；设计师必须过滤掉它，
    // 否则 Mock 模型在写完文件后会反复调用 handoff，形成无限工具调用循环。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-designer-mock-'));
    const db = openDatabase(':memory:');
    try {
      const store = new Store({ db, workspaceRoot: root });
      const provider = new MockProvider();
      const mockDesigner = new DesignerRuntime({
        store,
        events: new RuntimeEvents(),
        providerFactory: () => provider,
      });
      mockDesigner.ensureReady();
      const session = mockDesigner.createSession();
      mockDesigner.sendMessage(session.id, '用 Mock 跑一轮');
      await waitFor(() => !mockDesigner.busy, 10_000);
      const messages = store.listDesignerMessages(session.id);
      const roles = messages.map((message) => message.role);
      expect(roles[0]).toBe('user');
      expect(roles.at(-1)).toBe('assistant');
      expect(messages.some((message) => message.name === 'handoff')).toBe(false);
      // 工具清单里没有 handoff（read/write 正常提供）。
      expect(store.listDesignerMessages(session.id)).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'write' })]),
      );
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('appends an error note when the model call fails', async () => {
    const { designer } = createHarness(() => {
      throw new Error('模型炸了');
    });
    const session = designer.createSession();
    designer.sendMessage(session.id, '你好');
    await waitForIdle(designer);
    const detail = designer.getSessionDetail(session.id);
    expect(detail.messages.at(-1)?.meta.error).toBe(true);
    expect(detail.messages.at(-1)?.content).toContain('模型炸了');
  });

  it('publishes designer.delta events while streaming the reply', async () => {
    const deltas: string[] = [];
    const texts = ['你好', '你好！我是', '你好！我是流水线设计师。'];
    const { designer } = createHarness((request: LlmRequest) => {
      // 模拟流式到达：正文逐段变长，onProgress 携带截至当前的累计文本。
      for (const text of texts) {
        request.onProgress?.({
          contentChars: text.length,
          reasoningChars: 0,
          toolChars: 0,
          elapsedMs: 10,
          contentText: text,
          reasoningText: '',
        });
      }
      return textReply(texts.at(-1)!);
    });
    const unsubscribe = designer.events.subscribe((event) => {
      if (event.type === 'designer.delta' && event.sessionId) deltas.push(event.text ?? '');
    });

    const session = designer.createSession();
    designer.sendMessage(session.id, '打个招呼');
    await waitForIdle(designer);
    unsubscribe();

    // 去重后按序推送了每一段累计文本，最后一段与落库消息一致。
    expect(deltas).toEqual(texts);
    const detail = designer.getSessionDetail(session.id);
    const finalText = detail.messages.at(-1)!.content;
    expect(finalText).toBe(texts.at(-1));
    expect(deltas.at(-1)).toBe(finalText);
  });

  it('streams designer.reasoning events and persists reasoning into the assistant message', async () => {
    const reasonings: string[] = [];
    const { designer, store } = createHarness((request: LlmRequest) => {
      request.onProgress?.({
        contentChars: 3,
        reasoningChars: 8,
        toolChars: 0,
        elapsedMs: 5,
        contentText: '想好了',
        reasoningText: '一步步推理的过程',
      });
      return { content: '想好了', toolCalls: [], reasoning: '一步步推理的过程' };
    });
    const unsubscribe = designer.events.subscribe((event) => {
      if (event.type === 'designer.reasoning' && event.sessionId) reasonings.push(event.text ?? '');
    });
    const session = designer.createSession();
    designer.sendMessage(session.id, '先思考再回答');
    await waitForIdle(designer);
    unsubscribe();

    // 思考文本通过 designer.reasoning 流式推送（累计文本，整段替换）。
    expect(reasonings).toEqual(['一步步推理的过程']);
    // 落库：思考内容挂在 assistant 消息的 meta 上，供前端折叠展示。
    const assistant = store
      .listDesignerMessages(session.id)
      .find((message) => message.role === 'assistant');
    expect(assistant?.meta.reasoning).toBe('一步步推理的过程');
  });
});

describe('designer change execution（对话式变更：认可后直接生效）', () => {
  it('applies changes immediately via apply_changes without any approval step', async () => {
    let call = 0;
    const { designer, store } = createHarness((request: LlmRequest) => {
      call += 1;
      if (call === 1) {
        return toolCall('apply_changes', {
          title: '新建翻译官智能体',
          summary: '为将来的翻译流水线准备岗位。',
          changes: [
            {
              op: 'create_agent',
              agent: {
                name: '翻译官',
                description: '把输入文档翻译成目标语言。',
                responsibilities: '阅读输入文档，产出高质量译文。',
                deliverable: 'output/译文.md',
                tools: { builtin: ['read', 'write'], custom: [] },
              },
            },
          ],
        });
      }
      expect(request.messages.at(-1)?.role).toBe('tool');
      return textReply('变更已生效，可以试运行了。');
    });
    const session = designer.createSession();
    designer.sendMessage(session.id, '帮我建一个翻译智能体');
    const record = await waitFor(() => {
      const detail = designer.getSessionDetail(session.id);
      return detail.proposals.find((item) => item.status === 'applied') ?? null;
    });
    expect(record.title).toBe('新建翻译官智能体');
    expect(record.changes[0]).toMatchObject({ op: 'create_agent' });
    // 变更记录挂在触发它的助手消息上。
    const detail = designer.getSessionDetail(session.id);
    const assistantIds = detail.messages.filter((message) => message.role === 'assistant').map((message) => message.id);
    expect(assistantIds).toContain(record.messageId);
    // 无需任何确认操作：工具调用结束即已生效。
    const created = store.getAgentByName('翻译官');
    expect(created).not.toBeNull();
    expect(created!.tools.builtin).toEqual(['read', 'write']);
    expect(record.decidedAt).not.toBeNull();
  });

  it('marks a change failed when a step cannot apply, keeping earlier steps', async () => {
    // 前置校验只做存在性检查，「删除仍被流水线使用的智能体」能通过校验、在执行时失败。
    let call = 0;
    const { designer, store } = createHarness(() => {
      call += 1;
      if (call === 1) {
        return toolCall('apply_changes', {
          title: '建新岗并删旧岗',
          summary: '第 2 项在执行时应被「仍被流水线使用」拦下。',
          changes: [
            { op: 'create_agent', agent: { name: '新岗', description: 'x', responsibilities: 'x' } },
            { op: 'delete_agent', agentName: '旧岗' },
          ],
        });
      }
      return textReply('好');
    });
    const old = store.createAgent({ name: '旧岗', description: 'x', responsibilities: 'x' });
    const node = { id: 'n1', agentId: old.id, isStart: true, x: 0, y: 0 };
    store.createPipeline({ name: '单环节', nodes: [node], edges: [] });

    const session = designer.createSession();
    designer.sendMessage(session.id, '测试失败路径');
    await waitForIdle(designer);
    const record = designer.getSessionDetail(session.id).proposals[0];
    expect(record.status).toBe('failed');
    expect(record.error).toContain('失败');
    expect(record.error).toContain('前 1 项已生效');
    // 第 1 项已生效并保留，第 2 项失败后旧岗与流水线原样保留。
    expect(store.getAgentByName('新岗')).not.toBeNull();
    expect(store.getAgentByName('旧岗')).not.toBeNull();
    expect(store.listPipelines()).toHaveLength(1);
  });

  it('blocks changes that modify or delete the designer itself', async () => {
    let call = 0;
    const { designer } = createHarness(() => {
      call += 1;
      if (call === 1) {
        return toolCall('apply_changes', {
          title: '自我修改',
          summary: '不允许',
          changes: [{ op: 'delete_agent', agentName: '流水线设计师' }],
        });
      }
      return textReply('好');
    });
    const session = designer.createSession();
    designer.sendMessage(session.id, '把自己删了');
    await waitForIdle(designer);
    const detail = designer.getSessionDetail(session.id);
    expect(detail.proposals).toHaveLength(0);
    const toolMessage = detail.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('不能通过 apply_changes 修改或删除');
    expect(call).toBe(2);
  });

  it('applies pipeline graphs with agent-name node references', async () => {
    let call = 0;
    const { designer, store } = createHarness(() => {
      call += 1;
      if (call === 1) {
        return toolCall('apply_changes', {
          title: '建两环节流水线',
          summary: '节点 agentId 直接填智能体名称。',
          changes: [
            {
              op: 'create_pipeline',
              pipeline: {
                name: '来源到去处',
                description: '两环节测试流水线',
                nodes: [
                  { id: 'n1', agentId: '来源', isStart: true, x: 0, y: 0 },
                  { id: 'n2', agentId: '去处', x: 240, y: 0 },
                ],
                edges: [{ from: 'n1', to: 'n2', triggerPrompt: '上游交付：{deliverables}，原始任务：{task}' }],
              },
            },
          ],
        });
      }
      return textReply('好');
    });
    store.createAgent({ name: '来源', description: 'x', responsibilities: 'x' });
    store.createAgent({ name: '去处', description: 'x', responsibilities: 'x' });
    const session = designer.createSession();
    designer.sendMessage(session.id, '搭一条两环节流水线');
    await waitForIdle(designer);
    const pipeline = store.listPipelines()[0];
    expect(pipeline.nodes.map((node) => store.getAgent(node.agentId)?.name)).toEqual(['来源', '去处']);
    expect(pipeline.edges).toHaveLength(1);
    expect(pipeline.edges[0].triggerPrompt).toContain('{deliverables}');
    expect(call).toBe(2);
  });
});

describe('designer change reference resolution（同一次变更先创建、后引用）', () => {
  it('applies one change set that creates skills, agents and a pipeline together', async () => {
    // 复现反馈 3dcd1a1b 的场景：create_skill ×2 → create_agent（引用同批技能）→ create_pipeline（引用同批智能体）。
    let call = 0;
    const { designer, store } = createHarness(() => {
      call += 1;
      if (call === 1) {
        return toolCall('apply_changes', {
          title: '一次变更搭完整流水线',
          summary: '技能 → 智能体 → 流水线，同一次变更内先创建、后引用。',
          changes: [
            { op: 'create_skill', skill: { name: '分析方法论', description: 'x', content: '# 方法论' } },
            { op: 'create_skill', skill: { name: '资源档案', description: 'x', content: '# 档案' } },
            {
              op: 'create_agent',
              agent: { name: '雷达', description: 'x', responsibilities: 'x', skillIds: ['分析方法论', '资源档案'] },
            },
            {
              op: 'create_agent',
              agent: { name: '策划', description: 'x', responsibilities: 'x', skillIds: ['分析方法论'] },
            },
            {
              op: 'create_pipeline',
              pipeline: {
                name: '发现流水线',
                nodes: [
                  { id: 'n1', agentId: '雷达', isStart: true, x: 0, y: 0 },
                  { id: 'n2', agentId: '策划', x: 240, y: 0 },
                ],
                edges: [{ from: 'n1', to: 'n2', triggerPrompt: '上游交付：{deliverables}' }],
              },
            },
          ],
        });
      }
      return textReply('好');
    });
    const session = designer.createSession();
    designer.sendMessage(session.id, '一次性搭好整条流水线');
    await waitForIdle(designer);
    const record = designer.getSessionDetail(session.id).proposals[0];
    expect(record.status).toBe('applied');
    const skills = store.listSkills();
    expect(skills.map((skill) => skill.name)).toEqual(['分析方法论', '资源档案']);
    const methodology = skills.find((skill) => skill.name === '分析方法论')!;
    const archive = skills.find((skill) => skill.name === '资源档案')!;
    const radar = store.getAgentByName('雷达')!;
    const planner = store.getAgentByName('策划')!;
    // 名称引用在应用时解析成真实 id，顺序与创建一致。
    expect(radar.skillIds).toEqual([methodology.id, archive.id]);
    expect(planner.skillIds).toEqual([methodology.id]);
    expect(store.listPipelines()[0].nodes.map((node) => store.getAgent(node.agentId)?.name)).toEqual(['雷达', '策划']);
  });

  it('rejects referencing an object that a later change creates (forward reference)', async () => {
    let call = 0;
    const { designer } = createHarness(() => {
      call += 1;
      if (call === 1) {
        return toolCall('apply_changes', {
          title: '后向引用',
          summary: '引用后序才创建的技能。',
          changes: [
            { op: 'create_agent', agent: { name: '读者', description: 'x', responsibilities: 'x', skillIds: ['规范'] } },
            { op: 'create_skill', skill: { name: '规范', description: 'x', content: '# 规范' } },
          ],
        });
      }
      return textReply('好');
    });
    const session = designer.createSession();
    designer.sendMessage(session.id, '测试后向引用');
    await waitForIdle(designer);
    const detail = designer.getSessionDetail(session.id);
    expect(detail.proposals).toHaveLength(0);
    const toolMessage = detail.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('第 2 项才创建');
    expect(call).toBe(2);
  });

  it('rejects deleting an object created earlier in the same proposal', async () => {
    let call = 0;
    const { designer, store } = createHarness(() => {
      call += 1;
      if (call === 1) {
        return toolCall('apply_changes', {
          title: '先建后删',
          summary: '同一对象先创建又删除。',
          changes: [
            { op: 'create_skill', skill: { name: '临时技能', description: 'x', content: '# 临时' } },
            { op: 'delete_skill', skillName: '临时技能' },
          ],
        });
      }
      return textReply('好');
    });
    const session = designer.createSession();
    designer.sendMessage(session.id, '测试先建后删');
    await waitForIdle(designer);
    const detail = designer.getSessionDetail(session.id);
    expect(detail.proposals).toHaveLength(0);
    const toolMessage = detail.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('矛盾的变更');
    expect(store.listSkills()).toHaveLength(0);
  });

  it('rejects referencing an object deleted earlier in the same change set', async () => {
    let call = 0;
    const { designer, store } = createHarness(() => {
      call += 1;
      if (call === 1) {
        return toolCall('apply_changes', {
          title: '先删后引',
          summary: '引用被本变更删除的技能。',
          changes: [
            { op: 'delete_skill', skillName: '旧规范' },
            { op: 'create_agent', agent: { name: '引用者', description: 'x', responsibilities: 'x', skillIds: ['旧规范'] } },
          ],
        });
      }
      return textReply('好');
    });
    store.createSkill({ name: '旧规范', content: '# 旧规范' });
    const session = designer.createSession();
    designer.sendMessage(session.id, '测试先删后引');
    await waitForIdle(designer);
    const detail = designer.getSessionDetail(session.id);
    expect(detail.proposals).toHaveLength(0);
    const toolMessage = detail.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('已在本变更第 1 项被删除');
    // 校验失败：删除没有发生，技能原样保留。
    expect(store.listSkills()).toHaveLength(1);
  });

  it('rejects duplicate create names within one proposal', async () => {
    let call = 0;
    const { designer } = createHarness(() => {
      call += 1;
      if (call === 1) {
        return toolCall('apply_changes', {
          title: '重复创建',
          summary: '同名技能创建两次。',
          changes: [
            { op: 'create_skill', skill: { name: '重复技能', description: 'x', content: '# a' } },
            { op: 'create_skill', skill: { name: '重复技能', description: 'x', content: '# b' } },
          ],
        });
      }
      return textReply('好');
    });
    const session = designer.createSession();
    designer.sendMessage(session.id, '测试重名');
    await waitForIdle(designer);
    const detail = designer.getSessionDetail(session.id);
    expect(detail.proposals).toHaveLength(0);
    const toolMessage = detail.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('重复创建同名技能');
  });

  it('allows delete-then-recreate of the same name in one change set', async () => {
    let call = 0;
    const { designer, store } = createHarness(() => {
      call += 1;
      if (call === 1) {
        return toolCall('apply_changes', {
          title: '删旧建新',
          summary: '删除旧技能后按同名重建。',
          changes: [
            { op: 'delete_skill', skillName: '旧版技能' },
            { op: 'create_skill', skill: { name: '旧版技能', description: '新版', content: '# 新版' } },
          ],
        });
      }
      return textReply('好');
    });
    const oldSkill = store.createSkill({ name: '旧版技能', content: '# 旧版' });
    const session = designer.createSession();
    designer.sendMessage(session.id, '删除并重建技能');
    await waitForIdle(designer);
    const applied = designer.getSessionDetail(session.id).proposals[0];
    expect(applied.status).toBe('applied');
    const skills = store.listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('旧版技能');
    expect(skills[0].id).not.toBe(oldSkill.id);
    expect(skills[0].description).toBe('新版');
  });
});

describe('designer sessions & reset', () => {
  it('lists sessions with counts and deletes a session with its data', async () => {
    const { designer, store } = createHarness(() => textReply('回复'));
    const session = designer.createSession();
    designer.sendMessage(session.id, '列表会话测试');
    await waitForIdle(designer);
    const sessions = designer.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].messageCount).toBe(2);
    expect(sessions[0].lastMessagePreview).toContain('回复');

    designer.deleteSession(session.id);
    expect(designer.listSessions()).toHaveLength(0);
    expect(store.listDesignerMessages(session.id)).toHaveLength(0);
    expect(store.listDesignerProposals(session.id)).toHaveLength(0);
  });

  it('resetAll clears sessions and workspace but keeps the designer agent', async () => {
    const { designer, store } = createHarness(() => textReply('回复'));
    const session = designer.createSession();
    designer.sendMessage(session.id, '重置测试');
    await waitForIdle(designer);
    fs.writeFileSync(path.join(store.designerWorkspaceDir(), '草稿.md'), '草稿');

    await designer.resetAll();
    expect(designer.listSessions()).toHaveLength(0);
    expect(fs.existsSync(path.join(store.designerWorkspaceDir(), '草稿.md'))).toBe(false);
    expect(store.getDesignerAgent()).not.toBeNull();
  });
});

describe('designer single conversation（压缩上下文 / 清空对话记录）', () => {
  function usageReply(content: string): LlmResponse {
    return {
      content,
      toolCalls: [],
      usage: { promptTokens: 1500, completionTokens: 400, reasoningTokens: 0, cachedTokens: 0, totalTokens: 1900 },
    };
  }

  it('compresses older turns into a persisted summary and excludes them from later requests', async () => {
    const summarizeRequests: LlmRequest[] = [];
    const chatRequests: LlmRequest[] = [];
    const { designer, store } = createHarness((request: LlmRequest) => {
      // 摘要请求：单条 user 消息、无工具。
      if (request.tools.length === 0 && request.messages.length === 1) {
        summarizeRequests.push(request);
        return { content: '用户要搭一条翻译流水线，已确认中译英方向。', toolCalls: [] };
      }
      chatRequests.push(request);
      return usageReply('好的');
    });
    store.updateSettings({ llm: { maxContextTokens: 2000 } });

    const session = designer.createSession();
    for (const text of ['第一问', '第二问', '第三问']) {
      designer.sendMessage(session.id, text);
      await waitForIdle(designer);
    }
    const before = store.listDesignerMessages(session.id);
    expect(before).toHaveLength(6);

    const result = await designer.compressConversation();
    expect(result.compressed).toBeGreaterThanOrEqual(1);
    expect(summarizeRequests).toHaveLength(1);
    // 摘要输入包含被压缩的对话原文。
    const summaryPrompt = String(summarizeRequests[0].messages[0].content);
    expect(summaryPrompt).toContain('前情提要');
    expect(summaryPrompt).toContain('[用户] 第一问');

    const compactedSeq = store.getDesignerSession(session.id)!.compactedSeq;
    expect(compactedSeq).toBe(before[result.compressed - 1].seq);
    expect(store.getDesignerSession(session.id)!.summary).toContain('翻译流水线');
    // 界面历史不受影响：消息原样保留。
    expect(store.listDesignerMessages(session.id)).toHaveLength(6);

    // 压缩后的下一轮请求：系统提示词带提要，历史里不再有被压缩的消息。
    designer.sendMessage(session.id, '第四问');
    await waitForIdle(designer);
    const next = chatRequests.at(-1)!;
    const systemPrompt = String(next.messages[0].content);
    expect(systemPrompt).toContain('前情提要（更早对话的要点');
    expect(systemPrompt).toContain('翻译流水线');
    const sentText = next.messages.map((message) => String(message.content ?? '')).join('\n');
    expect(sentText).not.toContain('第一问');
    expect(sentText).toContain('第四问');
  });

  it('returns 0 when usage stays below the watermark or no usage exists', async () => {
    // 没有会话：404。
    const empty = createHarness(() => usageReply('好'));
    await expect(empty.designer.compressConversation()).rejects.toThrow(/还没有对话/);

    // 没有发过消息（无实测用量）、或用量低于水位：不压缩。
    const { designer, store } = createHarness(() => usageReply('好'));
    const session = designer.createSession();
    await expect(designer.compressConversation()).resolves.toEqual({ compressed: 0 });

    designer.sendMessage(session.id, '轻量对话');
    await waitForIdle(designer);
    await expect(designer.compressConversation()).resolves.toEqual({ compressed: 0 });
    expect(store.getDesignerSession(session.id)!.compactedSeq).toBe(0);
    expect(store.getDesignerSession(session.id)!.summary).toBe('');
  });

  it('rejects compression while a reply is running', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { designer } = createHarness(async () => {
      await gate;
      return usageReply('慢回复');
    });
    const session = designer.createSession();
    designer.sendMessage(session.id, '慢慢想');
    await waitFor(() => designer.busy);
    await expect(designer.compressConversation()).rejects.toThrow(/请先停止|正在回复/);
    designer.stop();
    release!();
    await waitForIdle(designer);
  });

  it('clears the conversation: messages, change records and uploads go, workspace stays', async () => {
    const { designer, store } = createHarness(() => textReply('回复'));
    const session = designer.createSession();
    designer.sendMessage(session.id, '清空测试');
    await waitForIdle(designer);
    const upload = store.saveDesignerUpload(session.id, '附件.txt', Buffer.from('内容'));
    const record = store.createDesignerProposal({
      sessionId: session.id,
      messageId: null,
      title: '已生效的变更',
      summary: '',
      changes: [],
      status: 'applied',
    });
    const workspaceFile = path.join(store.designerWorkspaceDir(), '产出.md');
    fs.writeFileSync(workspaceFile, '保留我');

    designer.clearConversation();
    expect(designer.listSessions()).toHaveLength(0);
    expect(store.listDesignerMessages(session.id)).toHaveLength(0);
    expect(store.getDesignerProposal(record.id)).toBeNull();
    expect(fs.existsSync(path.join(store.designerWorkspaceDir(), upload.path))).toBe(false);
    // 工作目录文件与设计师智能体保留。
    expect(fs.existsSync(workspaceFile)).toBe(true);
    expect(store.getDesignerAgent()).not.toBeNull();

    // 清空后下一条消息自动创建全新会话；向不存在的会话发消息仍被拒绝。
    expect(() => designer.sendMessage('does-not-exist', '不应成功')).toThrow(/会话不存在/);
    const again = designer.createSession();
    designer.sendMessage(again.id, '重新开始');
    await waitForIdle(designer);
    expect(designer.listSessions()).toHaveLength(1);
    expect(store.listDesignerMessages(again.id)[0].content).toBe('重新开始');
  });

  it('rejects clearing while a reply is running', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { designer } = createHarness(async () => {
      await gate;
      return textReply('慢回复');
    });
    const session = designer.createSession();
    designer.sendMessage(session.id, '慢慢想');
    await waitFor(() => designer.busy);
    expect(() => designer.clearConversation()).toThrow(/请先停止再清空/);
    designer.stop();
    release!();
    await waitForIdle(designer);
    // 停止后可清空。
    designer.clearConversation();
    expect(designer.listSessions()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 附件（上传到工作目录 + 模型按路径自行读取）                              */
/* ------------------------------------------------------------------ */

/** 最小 PNG 字节（带文件签名即可，read_image 按签名识别格式）。 */
function pngBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('fake-png-content'),
  ]);
}

describe('designer attachments', () => {
  it('uploads into the session workspace and injects a path list into the model request', async () => {
    const { designer, provider, store } = createHarness(() => textReply('已收到附件。'));
    const session = designer.createSession();
    const png = pngBytes();
    const saved = store.saveDesignerUpload(session.id, '截图.png', png);
    expect(saved.image).toBe(true);
    expect(saved.path).toBe(`uploads/${session.id}/${saved.name}`);
    expect(saved.size).toBe(png.length);

    designer.sendMessage(session.id, '请看这张图', [{ path: saved.path, name: saved.name }]);
    await waitForIdle(designer);

    const messages = store.listDesignerMessages(session.id);
    // 落库正文保持用户原文；附件清单登记在 meta。
    expect(messages[0].content).toBe('请看这张图');
    expect(messages[0].meta.attachments).toEqual([
      expect.objectContaining({ name: '截图.png', path: saved.path, image: true, size: png.length }),
    ]);
    // 模型请求的最后一条 user 消息带附件路径说明。
    const request = provider.calls[0];
    const lastUser = [...request.messages].reverse().find((message) => message.role === 'user');
    const sent = String(lastUser?.content ?? '');
    expect(sent).toContain('请看这张图');
    expect(sent).toContain(saved.path);
    expect(sent).toContain('read_image');
  });

  it('allows attachment-only messages and validates attachment refs', async () => {
    const { designer, store } = createHarness(() => textReply('好'));
    const session = designer.createSession();
    const saved = store.saveDesignerUpload(session.id, '说明.txt', Buffer.from('内容', 'utf8'));
    expect(saved.image).toBe(false);

    // 只发附件、不带文字：允许。
    designer.sendMessage(session.id, '', [{ path: saved.path }]);
    await waitForIdle(designer);
    expect(store.listDesignerMessages(session.id)[0].meta.attachments).toHaveLength(1);

    // 空消息 + 无附件：拒绝。
    expect(() => designer.sendMessage(session.id, '', [])).toThrow(/消息内容不能为空/);
    // 附件数量超限：拒绝。
    const many = Array.from({ length: 11 }, () => ({ path: saved.path }));
    expect(() => designer.sendMessage(session.id, 'x', many)).toThrow(/最多携带/);
    // 路径穿越：拒绝。
    expect(() => designer.sendMessage(session.id, 'x', [{ path: '../../../secrets.txt' }])).toThrow(/附件路径不合法/);
    // 不存在的附件：拒绝。
    expect(() => designer.sendMessage(session.id, 'x', [{ path: `uploads/${session.id}/missing.png` }])).toThrow(
      /附件不存在/,
    );
  });

  it('keeps read_image result images in the loop so the designer can see uploads (regression)', async () => {
    let call = 0;
    let imagePath = '';
    const { designer, provider, store } = createHarness((request: LlmRequest) => {
      call += 1;
      if (call === 1) return toolCall('read_image', { file_path: imagePath });
      // 第二轮请求：工具结果图片必须已经写进模型历史（此前设计师循环会把图片丢弃）。
      const toolMessage = request.messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(toolMessage!.images).toHaveLength(1);
      expect(toolMessage!.images![0].mimeType).toBe('image/png');
      expect(toolMessage!.images![0].dataBase64.length).toBeGreaterThan(0);
      return textReply('看到图了');
    });
    const session = designer.createSession();
    const png = pngBytes();
    const saved = store.saveDesignerUpload(session.id, 'photo.png', png);
    imagePath = saved.path;

    designer.sendMessage(session.id, '看看这张图', [{ path: saved.path }]);
    await waitForIdle(designer);

    expect(call).toBe(2);
    const messages = designer.getSessionDetail(session.id).messages;
    const toolMessage = messages.find((message) => message.role === 'tool' && message.name === 'read_image');
    expect(toolMessage).toBeDefined();
    // 工具结果消息存档了图片（read_image 的多模态结果不再丢失）。
    expect(toolMessage!.images).toHaveLength(1);
    expect(toolMessage!.images![0].mimeType).toBe('image/png');
    // provider.calls[0] 已在 handler 中断言图片进入历史。
    expect(provider.calls.length).toBe(2);
  });

  it('removes the session upload directory when the session is deleted', async () => {
    const { designer, store } = createHarness(() => textReply('好'));
    const session = designer.createSession();
    store.saveDesignerUpload(session.id, 'a.txt', Buffer.from('hello'));
    store.saveDesignerUpload(session.id, 'b.txt', Buffer.from('world'));
    const dir = store.designerUploadDir(session.id);
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(true);

    designer.deleteSession(session.id);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('uniquifies uploaded filenames instead of overwriting', () => {
    const { designer, store } = createHarness(() => textReply('好'));
    const session = designer.createSession();
    const first = store.saveDesignerUpload(session.id, '图.png', Buffer.from('one'));
    const second = store.saveDesignerUpload(session.id, '图.png', Buffer.from('two'));
    expect(first.path).not.toBe(second.path);
    expect(second.name).toBe('图.png');
    expect(fs.readFileSync(path.join(store.designerWorkspaceDir(), second.path), 'utf8')).toBe('two');
  });
});

describe('designer profile', () => {
  it('exposes the live system prompt, effective tools, skills and runtime info', () => {
    const { designer, store } = createHarness(() => textReply('好'));
    const profile = designer.getProfile();
    expect(profile.agent.slug).toBe('designer');
    // 系统提示词是实时拼装版（含全局清单与工作规则）。
    expect(profile.systemPrompt).toContain('系统现状');
    expect(profile.systemPrompt).toContain('apply_changes');
    expect(profile.systemPrompt).toContain('工作目录');

    // 工具 = 生效内置/自定义（过滤 handoff）+ 设计师专属管理工具。
    const sourceOf = new Map(profile.tools.map((tool) => [tool.name, tool.source]));
    expect(sourceOf.get('read')).toBe('builtin');
    expect(sourceOf.get('apply_changes')).toBe('designer');
    expect(sourceOf.get('get_agent')).toBe('designer');
    expect(profile.tools.map((tool) => tool.name)).not.toContain('handoff');

    // 运行时信息来自全局配置（档案未覆盖模型时用默认）。
    expect(profile.runtime.model).toBe(store.getLlmConfig().model);
    expect(profile.runtime.maxContextTokens).toBeGreaterThan(0);
    expect(profile.skills).toEqual([]);

    // 档案勾选技能后：技能出现在详情；load_skill 只在智能体配置了技能时注册。
    const skill = store.createSkill({ name: '写作规范', content: '# 写作规范' });
    store.updateAgent(profile.agent.id, {
      skillIds: [skill.id],
      tools: { builtin: [...profile.agent.tools.builtin, 'load_skill'] },
    });
    const updated = designer.getProfile();
    expect(updated.skills.map((item) => item.name)).toEqual(['写作规范']);
    expect(updated.tools.map((tool) => tool.name)).toContain('load_skill');
  });
});

describe('designer run records & feedback loop', () => {
  it('lists tasks, drills into a task with get_task and resolves feedback', async () => {
    let call = 0;
    let taskId = '';
    let turnId = '';
    let feedbackId = '';
    const { designer, store } = createHarness(() => {
      call += 1;
      if (call === 1) return toolCall('list_tasks', { limit: 10 });
      if (call === 2) return toolCall('get_task', { id: taskId.slice(0, 8), turn_id: turnId.slice(0, 8) });
      if (call === 3) {
        return toolCall('resolve_feedback', { id: feedbackId.slice(0, 8), status: 'resolved', note: '已转为改进' });
      }
      return textReply('复盘完成');
    });

    const agent = store.createAgent({ name: '环节甲', responsibilities: '试运行' });
    const pipeline = store.createPipeline({
      name: '复盘流水线',
      nodes: [{ agentId: agent.id, isStart: true }],
      edges: [],
    });
    const created = store.createTask({ task: '试运行任务：检查复盘链路', pipeline, node: pipeline.nodes[0], agent });
    taskId = created.taskId;
    turnId = created.turnId;
    const feedback = store.createFeedback({
      agentId: agent.id,
      agentName: agent.name,
      taskName: '试运行任务：检查复盘链路',
      taskId,
      turnId,
      category: 'prompt',
      severity: 'medium',
      content: '触发提示词没有说明输出格式，导致交接内容不稳定。',
      contextSnapshot: { task: '试运行任务：检查复盘链路', turnSeq: 1, messages: [] },
    });
    feedbackId = feedback.id;

    const session = designer.createSession();
    designer.sendMessage(session.id, '帮我看看刚才那次试运行跑得怎么样');
    await waitForIdle(designer);

    const messages = designer.getSessionDetail(session.id).messages;
    const byName = (name: string) =>
      messages.find((message) => message.role === 'tool' && message.name === name);

    const listOutput = byName('list_tasks');
    expect(listOutput).toBeDefined();
    expect(listOutput!.content).toContain('复盘流水线');
    expect(listOutput!.content).toContain('试运行任务：检查复盘链路');
    expect(listOutput!.content).toContain('running');

    const taskOutput = byName('get_task');
    expect(taskOutput).toBeDefined();
    expect(taskOutput!.content).toContain('环节 1');
    expect(taskOutput!.content).toContain('环节甲');
    // 本环节未真正执行：系统提示词还没有留档，get_task 如实说明。
    expect(taskOutput!.content).toContain('尚未执行');

    const resolveOutput = byName('resolve_feedback');
    expect(resolveOutput).toBeDefined();
    expect(resolveOutput!.content).toContain('已标记为「resolved」');
    expect(store.getFeedback(feedback.id)!.status).toBe('resolved');
    expect(store.getFeedback(feedback.id)!.resolutionNote).toContain('已转为改进');
  });

  it('list_feedback returns the full snapshot when given an id', async () => {
    let call = 0;
    let feedbackId = '';
    const { designer, store } = createHarness(() => {
      call += 1;
      if (call === 1) return toolCall('list_feedback', { id: feedbackId.slice(0, 8) });
      return textReply('知道了');
    });
    const feedback = store.createFeedback({
      agentId: null,
      agentName: '某智能体',
      taskName: '示例任务',
      taskId: null,
      turnId: null,
      category: 'tool',
      severity: 'low',
      content: '希望系统提供导出 Excel 的自定义工具。',
      contextSnapshot: { task: '示例任务原文', turnSeq: 2, messages: [{ role: 'user', content: '第一条消息' }] },
    });
    feedbackId = feedback.id;

    const session = designer.createSession();
    designer.sendMessage(session.id, '看看这条反馈的完整内容');
    await waitForIdle(designer);

    const toolMessage = designer
      .getSessionDetail(session.id)
      .messages.find((message) => message.role === 'tool' && message.name === 'list_feedback');
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.content).toContain('希望系统提供导出 Excel 的自定义工具。');
    expect(toolMessage!.content).toContain('示例任务原文');
    expect(toolMessage!.content).toContain('第一条消息');
    expect(toolMessage!.content).toContain('open');
  });
});
