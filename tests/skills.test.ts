import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../server/src/db';
import { materializeSkillPackage, resolveSkillPlaceholders } from '../server/src/skill-package';
import { Store } from '../server/src/store';

let root: string;
let store: Store;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-skill-'));
  store = new Store({ db: openDatabase(':memory:'), workspaceRoot: root });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('skill packages', () => {
  it('stores files and materializes SKILL.md with resolved absolute paths', () => {
    const skill = store.createSkill({
      name: '脚本技能',
      content: "# 脚本技能\n\n运行：node '{{script:hello.js}}'",
    });
    store.upsertSkillFile(skill.id, {
      path: 'scripts/hello.js',
      content: "console.log('hello');",
    });

    const files = store.listSkillFiles(skill.id);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'scripts/hello.js', script: true, text: true });

    const skillDir = path.join(root, '.skills', 'scripts-skill');
    const resolved = resolveSkillPlaceholders(store.getSkill(skill.id)!.content, skillDir, files);
    expect(resolved).not.toContain('{{script:');
    expect(resolved).toContain(skillDir.split(path.sep).join('/'));

    materializeSkillPackage(
      skillDir,
      store.getSkillPackageFiles(skill.id).map((item) => ({ path: item.file.path, bytes: item.bytes })),
      resolved,
    );
    expect(fs.readFileSync(path.join(skillDir, 'scripts', 'hello.js'), 'utf8')).toContain(
      "console.log('hello');",
    );
    const copiedDoc = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    expect(copiedDoc).not.toContain('{{script:');
    expect(copiedDoc).toContain('hello.js');
  });

  it('rejects duplicate script file names case-insensitively, including nested folders', () => {
    const skill = store.createSkill({ name: '重名校验' });
    store.upsertSkillFile(skill.id, { path: 'scripts/render.js', content: '// one' });
    expect(() =>
      store.upsertSkillFile(skill.id, { path: 'scripts/tools/Render.js', content: '// two' }),
    ).toThrow(/脚本名称/);
    expect(() =>
      store.upsertSkillFile(skill.id, { path: 'scripts/render.py', content: '# three' }),
    ).not.toThrow();
  });

  it('rejects unsafe paths and reserved SKILL.md', () => {
    const skill = store.createSkill({ name: '路径校验' });
    expect(() => store.upsertSkillFile(skill.id, { path: '../evil.js', content: '' })).toThrow();
    expect(() => store.upsertSkillFile(skill.id, { path: '/tmp/evil.js', content: '' })).toThrow(
      /相对路径/,
    );
    expect(() => store.upsertSkillFile(skill.id, { path: 'SKILL.md', content: '' })).toThrow(
      /SKILL.md/,
    );
    expect(() => store.upsertSkillFile(skill.id, { path: 'scripts/.env', content: '' })).toThrow(
      /隐藏/,
    );
    expect(() => store.upsertSkillFile(skill.id, { path: 'scripts/{bad}.js', content: '' })).toThrow(
      /不允许的字符/,
    );
  });

  it('validates placeholders against existing scripts when saving the document', () => {
    const skill = store.createSkill({ name: '引用校验', content: '还没有引用' });
    expect(() =>
      store.updateSkill(skill.id, { content: "node '{{script:missing.js}}'" }),
    ).toThrow(/不存在的脚本/);
    store.upsertSkillFile(skill.id, { path: 'scripts/missing.js', content: '// ok' });
    const updated = store.updateSkill(skill.id, { content: "node '{{script:missing.js}}'" });
    expect(updated.content).toContain('{{script:missing.js}}');
  });

  it('renames scripts and updates document references', () => {
    const skill = store.createSkill({
      name: '改名联动',
      content: "node '{{script:render.js}}'",
    });
    store.upsertSkillFile(skill.id, { path: 'scripts/render.js', content: '// render' });
    const renamed = store.renameSkillFile(
      skill.id,
      'scripts/render.js',
      'scripts/render-final.js',
    );
    expect(renamed.content).toBe("node '{{script:render-final.js}}'");
    expect(renamed.files.map((file) => file.path)).toEqual(['scripts/render-final.js']);
    expect(() =>
      store.renameSkillFile(skill.id, 'scripts/render-final.js', 'assets/render.js'),
    ).toThrow(/脚本与普通文件/);
  });

  it('blocks deleting a referenced script and allows it after the reference is removed', () => {
    const skill = store.createSkill({
      name: '删除保护',
      content: "node '{{script:keep.js}}'",
    });
    store.upsertSkillFile(skill.id, { path: 'scripts/keep.js', content: '// keep' });
    expect(() => store.deleteSkillFile(skill.id, 'scripts/keep.js')).toThrow(/仍被/);
    store.updateSkill(skill.id, { content: '不再引用' });
    const updated = store.deleteSkillFile(skill.id, 'scripts/keep.js');
    expect(updated.files).toHaveLength(0);
  });

  it('keeps scripts textual and allows binary assets', () => {
    const skill = store.createSkill({ name: '编码校验' });
    expect(() =>
      store.upsertSkillFile(skill.id, {
        path: 'scripts/binary.js',
        content: 'AAAA',
        encoding: 'base64',
      }),
    ).toThrow(/UTF-8/);
    const updated = store.upsertSkillFile(skill.id, {
      path: 'assets/logo.png',
      content: 'AAAA',
      encoding: 'base64',
    });
    const logo = updated.files.find((file) => file.path === 'assets/logo.png');
    expect(logo).toMatchObject({ script: false, text: false });
  });
});