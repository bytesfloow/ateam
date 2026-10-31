import { randomUUID } from 'node:crypto';
import type { LlmProvider, LlmRequest, LlmResponse } from '../../server/src/llm';

/**
 * Deterministic offline model used only by the test-suite（产品已移除 Mock 模式）.
 * It exercises the real ReAct loop: reads the deliverable path first（write 覆盖已有文件前必须先读），
 * then writes a mock deliverable into output/, then hands off that folder.
 * It hands the task along the first outgoing edge for the first turns.
 */
export class MockProvider implements LlmProvider {
  readonly id = 'mock';

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const available = new Set(request.tools.map((tool) => tool.function.name));
    const lastUser = [...request.messages].reverse().find((message) => message.role === 'user');
    const taskText = ((typeof lastUser?.content === 'string' ? lastUser.content : '') ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 600);

    const toolMessages = request.messages.filter((message) => message.role === 'tool');
    const readAttempted = toolMessages.some((message) => message.name === 'read');
    const wroteFile = toolMessages.some(
      (message) => message.name === 'write' && !(message.content ?? '').startsWith('工具执行失败'),
    );

    // 第一步：先读后写。覆盖已有交付文件（如重试场景）必须先 read 观测，否则 write 会被守卫拒绝。
    if (available.has('write') && !wroteFile) {
      if (available.has('read') && !readAttempted) {
        return {
          content: '我先确认交付文件是否已存在，再写入本环节的交付内容。',
          toolCalls: [
            {
              id: `call_${randomUUID().slice(0, 8)}`,
              name: 'read',
              arguments: JSON.stringify({ file_path: 'output/说明.md' }),
            },
          ],
        };
      }
      const deliverable =
        `# 第 ${request.meta.turnSeq} 环节 · Mock 交付物\n\n` +
        `- 智能体：${request.meta.agentName}\n` +
        `- 任务：${request.meta.taskId}\n` +
        `- 时间：${new Date().toISOString()}\n\n` +
        `## 输入摘要\n\n${taskText}\n\n` +
        '## 说明\n\n本文件由内置 Mock 模型生成，用于验证工具调用、文件夹交付与流水线推进。\n';
      return {
        content: `我先为本次工作生成一份交付文件。`,
        toolCalls: [
          {
            id: `call_${randomUUID().slice(0, 8)}`,
            name: 'write',
            arguments: JSON.stringify({ file_path: 'output/说明.md', content: deliverable }),
          },
        ],
      };
    }

    if (available.has('handoff')) {
      if (!wroteFile && !available.has('write')) {
        return {
          content:
            `【Mock】「${request.meta.agentName}」第 ${request.meta.turnSeq} 环节已完成，但本回合没有 write 工具，` +
            '无法生成交付文件（交接要求交付文件夹内至少有一个文件）。请在智能体配置中启用 write 后重试。',
          toolCalls: [],
        };
      }
      const { nextAgentNames, turnSeq } = request.meta;
      return {
        content: `【Mock】「${request.meta.agentName}」在第 ${turnSeq} 环节完成工作，提交交付文件夹 output。任务摘要：${taskText.slice(0, 240)}`,
        toolCalls: [
          {
            id: `call_${randomUUID().slice(0, 8)}`,
            name: 'handoff',
            arguments: JSON.stringify({
              folder: 'output',
              ...(nextAgentNames.length > 1 ? { target: nextAgentNames[0] } : {}),
            }),
          },
        ],
      };
    }

    return {
      content:
        `【Mock 模式】${request.meta.agentName} 已完成本次工作。\n\n` +
        `任务摘要：${taskText.slice(0, 300)}\n\n` +
        '（测试替身输出：用于离线验证工具调用、文件夹交付与流水线推进。）',
      toolCalls: [],
    };
  }
}
