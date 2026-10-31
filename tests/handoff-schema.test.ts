import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOL_INFOS, HANDOFF_TOOL_DESCRIPTION } from '../server/src/tools';

interface SchemaShape {
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
}

describe('handoff tool schema', () => {
  const tool = BUILTIN_TOOL_INFOS.find((item) => item.name === 'handoff')!;
  const parameters = tool.parameters as SchemaShape;
  const validate = new Ajv({ allErrors: true, strict: false }).compile(parameters);

  it('only exposes folder and optional target', () => {
    const properties = parameters.properties ?? {};
    expect(Object.keys(properties).sort()).toEqual(['folder', 'target']);
    expect(parameters.required).toEqual(['folder']);
    // 旧的自由交接与文本参数已全部删除。
    const serialized = JSON.stringify(parameters);
    expect(serialized).not.toContain('summary');
    expect(serialized).not.toContain('deliverables');
    expect(serialized).not.toContain('next_node');
    expect(serialized).not.toContain('next_steps');
    expect(serialized).not.toContain('open_questions');
    expect(serialized).not.toContain('target_type');
    expect(HANDOFF_TOOL_DESCRIPTION).toContain('文件夹');
    expect(HANDOFF_TOOL_DESCRIPTION).toContain('流水线');
  });

  it('requires a folder path', () => {
    expect(validate({ folder: 'output' })).toBe(true);
    expect(validate({ folder: 'output/deliverables' })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ folder: '' })).toBe(false);
    expect(validate({ target: '架构师' })).toBe(false);
  });

  it('keeps target optional at the schema level', () => {
    // 是否必填取决于当前节点的出边数量，由运行时在工具执行时校验。
    expect(validate({ folder: 'output' })).toBe(true);
    expect(validate({ folder: 'output', target: '架构师' })).toBe(true);
    expect(validate({ folder: 'output', unknown: 'x' })).toBe(false);
  });
});
