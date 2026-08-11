import { describe, expect, it } from 'vitest';

import { SCHEMA_VERSION } from '@/domain/model';
import { createEmptyProject, DEFAULT_VALIDATION_CONFIG } from '@/domain/project';
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

  it('upgrades a v1 document into one that rosters no crew', () => {
    // A v1 file predates 乗務員 entirely: the three collections and the eight
    // working-rule numbers are simply absent, and "absent" means "nobody has
    // written a crew plan", not "the file is broken".
    const raw = JSON.parse(toJson(toyProject())) as Record<string, unknown>;
    raw['schemaVersion'] = 1;
    delete raw['crew'];
    delete raw['crewDuties'];
    delete raw['crewAssignments'];
    const cfg = raw['validationConfig'] as Record<string, unknown>;
    for (const key of Object.keys(cfg)) {
      if (key.startsWith('crew')) delete cfg[key];
    }

    const result = migrate(raw);
    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual([1]);
    expect(result.raw['schemaVersion']).toBe(SCHEMA_VERSION);

    const parsed = fromJson(JSON.stringify(result.raw));
    expect(parsed.errors).toEqual([]);
    expect(parsed.doc!.crewDuties.allIds).toEqual([]);
    expect(parsed.doc!.crew.allIds).toEqual([]);
    expect(parsed.doc!.crewAssignments.allIds).toEqual([]);
    expect(parsed.doc!.validationConfig.crewMaxContinuousWorkSec).toBe(
      DEFAULT_VALIDATION_CONFIG.crewMaxContinuousWorkSec,
    );
  });

  it('keeps whatever crew settings a v1 file somehow already has', () => {
    const raw = JSON.parse(toJson(toyProject())) as Record<string, unknown>;
    raw['schemaVersion'] = 1;
    (raw['validationConfig'] as Record<string, unknown>)['crewMinBreakSec'] = 42;
    const result = migrate(raw);
    expect(
      (result.raw['validationConfig'] as Record<string, unknown>)['crewMinBreakSec'],
    ).toBe(42);
  });
});
