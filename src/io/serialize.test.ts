import { describe, expect, it } from 'vitest';

import { SCHEMA_VERSION } from '@/domain/model';
import { createEmptyProject } from '@/domain/project';
import { toyProject } from '@/testing/toyProject';

import { migrate } from './migrate';
import { fromJson, suggestFileName, toJson } from './serialize';

describe('toJson / fromJson', () => {
  it('round-trips the toy project exactly', () => {
    const original = toyProject();
    const result = fromJson(toJson(original));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.doc).toEqual(original);
  });

  it('round-trips an empty project exactly', () => {
    const original = createEmptyProject();
    const result = fromJson(toJson(original));
    expect(result.ok).toBe(true);
    expect(result.doc).toEqual(original);
  });

  it('is byte-stable once the schema has normalised key order', () => {
    // The first parse reorders keys to the schema's declaration order; from
    // there on, export must be a fixed point so files stop churning in git.
    const first = fromJson(toJson(toyProject()));
    expect(first.doc).toBeDefined();
    const canonical = toJson(first.doc!);
    const second = fromJson(canonical);
    expect(second.doc).toBeDefined();
    expect(toJson(second.doc!)).toBe(canonical);
  });

  it('reports malformed JSON in Japanese', () => {
    const result = fromJson('{ not json');
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/JSON として読み取れませんでした/);
  });

  it('reports a schema mismatch with the offending path', () => {
    const broken = JSON.parse(toJson(toyProject())) as Record<string, unknown>;
    (broken['settings'] as Record<string, unknown>)['activeDate'] = '2026/04/06';
    const result = fromJson(JSON.stringify(broken));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('settings.activeDate');
  });

  it('rejects a document written by a newer version', () => {
    const future = JSON.parse(toJson(toyProject())) as Record<string, unknown>;
    future['schemaVersion'] = SCHEMA_VERSION + 5;
    const result = fromJson(JSON.stringify(future));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('新しいバージョン');
  });

  it('suggests a filesystem-safe, ASCII-only name', () => {
    expect(suggestFileName(createEmptyProject({ name: 'a/b:c' }))).toBe('a_b_c.rosim.json');
    expect(suggestFileName(createEmptyProject({ name: 'Oimachi Line' }))).toBe(
      'Oimachi-Line.rosim.json',
    );
    // A purely Japanese title has no ASCII stem to keep.
    expect(suggestFileName(createEmptyProject({ name: '大井町線' }))).toBe('project.rosim.json');
  });
});

describe('migrate', () => {
  it('is a no-op at the current schema version', () => {
    const raw = JSON.parse(toJson(toyProject())) as Record<string, unknown>;
    const result = migrate(raw);
    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(result.raw).toBe(raw);
  });

  it('rejects anything that is not an object', () => {
    expect(migrate([1, 2, 3]).errors).toHaveLength(1);
    expect(migrate('nope').errors).toHaveLength(1);
    expect(migrate(null).errors).toHaveLength(1);
  });
});
