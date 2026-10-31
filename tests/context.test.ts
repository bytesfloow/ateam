import { describe, expect, it } from 'vitest';
import type { LlmMessage } from '../server/src/llm';
import { planHistoryCompression, truncateLargeToolMessages } from '../server/src/runtime';

function historyWithTwoGroups(): LlmMessage[] {
  return [
    { role: 'user', content: '任务说明' },
    { role: 'assistant', content: '好的' },
    { role: 'tool', content: 'x'.repeat(100), toolCallId: 'call_1', name: 'read' },
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '完成' },
  ];
}

describe('planHistoryCompression', () => {
  it('keeps history untouched without measured usage or below the watermark', () => {
    const history = historyWithTwoGroups();
    expect(
      planHistoryCompression({ history, systemPrompt: 'sys', knownTokens: null, thresholdTokens: 2_000 }),
    ).toBe(0);
    expect(
      planHistoryCompression({ history, systemPrompt: 'sys', knownTokens: 1_999, thresholdTokens: 2_000 }),
    ).toBe(0);
  });

  it('drops the oldest user-turn group when measured usage exceeds the watermark', () => {
    const history = historyWithTwoGroups();
    // 实测 10,000 token，远超 2,000 的水位：丢掉第一组（user + assistant + tool），保留最后一组。
    expect(
      planHistoryCompression({ history, systemPrompt: 'sys', knownTokens: 10_000, thresholdTokens: 2_000 }),
    ).toBe(3);
    expect(history).toHaveLength(5); // 纯函数，不修改入参
  });

  it('never drops the only remaining user-turn group', () => {
    const history: LlmMessage[] = [
      { role: 'user', content: '任务说明' },
      { role: 'assistant', content: '好的' },
      { role: 'tool', content: 'x'.repeat(100), toolCallId: 'call_1', name: 'read' },
    ];
    expect(
      planHistoryCompression({ history, systemPrompt: 'sys', knownTokens: 100_000, thresholdTokens: 1_000 }),
    ).toBe(0);
  });
});

describe('truncateLargeToolMessages', () => {
  it('truncates oversized tool outputs and leaves other messages alone', () => {
    const history: LlmMessage[] = [
      { role: 'user', content: 'y'.repeat(5_000) },
      { role: 'assistant', content: 'z'.repeat(5_000) },
      { role: 'tool', content: 'a'.repeat(5_000), toolCallId: 'call_1', name: 'bash' },
      { role: 'tool', content: 'small', toolCallId: 'call_2', name: 'bash' },
    ];
    const truncated = truncateLargeToolMessages(history);
    expect(truncated).toBe(1);
    expect(history[0].content).toHaveLength(5_000);
    expect(history[1].content).toHaveLength(5_000);
    expect(history[2].content!.length).toBeLessThan(500);
    expect(history[2].content).toContain('工具输出已截断');
    expect(history[2].content).toContain('原文共 5000 字符');
    expect(history[3].content).toBe('small');
  });
});
