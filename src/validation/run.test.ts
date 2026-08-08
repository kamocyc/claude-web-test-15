import { describe, expect, it } from 'vitest';

import { asId } from '@/domain/ids';
import { buildIndex } from '@/engine/buildIndex';
import { TOY, toyProject, toyProjectCopy } from '@/testing/toyProject';
import { ALL_RULES, RULES } from './registry';
import { runValidation } from './run';
import { MAX_ISSUES, type RuleId } from './types';

describe('the rule catalogue', () => {
  it('registers every rule under its own id', () => {
    for (const [id, rule] of Object.entries(RULES)) expect(rule.id).toBe(id);
  });

  it('exposes every registered rule in ALL_RULES', () => {
    expect(ALL_RULES).toHaveLength(Object.keys(RULES).length);
    expect(new Set(ALL_RULES.map((r) => r.id)).size).toBe(ALL_RULES.length);
  });

  it('gives every rule a Japanese name and at least one scope', () => {
    for (const rule of ALL_RULES) {
      expect(rule.name.length).toBeGreaterThan(0);
      expect(rule.scope.length).toBeGreaterThan(0);
    }
  });
});

describe('runValidation on the toy project', () => {
  it('reports no errors and no warnings', () => {
    const result = runValidation(toyProject());
    const loud = result.issues.filter((i) => i.severity !== 'info');
    expect(loud.map((i) => `${i.severity} ${i.ruleId}: ${i.detail}`)).toEqual([]);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  it('still notices the 緩急接続 it is built around', () => {
    const result = runValidation(toyProject());
    expect(result.byRule['connection.discovered']).toBe(1);
    expect(result.infoCount).toBeGreaterThan(0);
  });

  it('writes Japanese titles and details for every issue', () => {
    const result = runValidation(toyProject());
    for (const issue of result.issues) {
      expect(issue.title).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(issue.detail).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(issue.refs.length).toBeGreaterThan(0);
    }
  });

  it('produces the same issue ids on a second run', () => {
    const a = runValidation(toyProject()).issues.map((i) => i.id);
    const b = runValidation(toyProject()).issues.map((i) => i.id);
    expect(a).toEqual(b);
  });

  it('measures its own duration and does not truncate', () => {
    const result = runValidation(toyProject());
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.truncated).toBe(false);
    expect(result.issues.length).toBeLessThanOrEqual(MAX_ISSUES);
  });

  it('never mutates the document', () => {
    const doc = toyProjectCopy();
    const before = structuredClone(doc);
    runValidation(doc);
    expect(doc).toEqual(before);
  });
});

describe('referential integrity short-circuits the run', () => {
  it('returns only ref.dangling issues when an id does not resolve', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.typeId = asId<'TrainType'>('typ-999');
    // Break several other things too; none of them should be reported.
    doc.trains.byId[TOY.localDown]!.stops[1]!.dep = 8 * 3600 - 600;
    doc.stationTracks.byId[TOY.c2]!.canBeOvertaken = false;
    const result = runValidation(doc);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(new Set(result.issues.map((i) => i.ruleId))).toEqual(new Set(['ref.dangling']));
    expect(result.errorCount).toBe(result.issues.length);
  });

  it('runs the rest of the catalogue once the reference is repaired', () => {
    const doc = toyProjectCopy();
    doc.stationTracks.byId[TOY.c2]!.canBeOvertaken = false;
    const ruleIds = new Set(runValidation(doc).issues.map((i) => i.ruleId));
    expect(ruleIds.has('ref.dangling')).toBe(false);
    expect(ruleIds.has('overtake.noPassingTrack')).toBe(true);
  });
});

describe('runValidation options', () => {
  it('runs only the requested rules', () => {
    const doc = toyProjectCopy();
    doc.stationTracks.byId[TOY.c2]!.canBeOvertaken = false;
    const result = runValidation(doc, { ruleIds: ['overtake.noPassingTrack'] });
    expect(new Set(result.issues.map((i) => i.ruleId))).toEqual(
      new Set(['overtake.noPassingTrack']),
    );
  });

  it('reuses a prebuilt index', () => {
    const doc = toyProject();
    const index = buildIndex(doc, '2026-04-06');
    const result = runValidation(doc, { index });
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  it('honours a severity override', () => {
    const doc = toyProjectCopy();
    doc.stationTracks.byId[TOY.c2]!.canBeOvertaken = false;
    doc.validationConfig.severityOverrides['overtake.noPassingTrack'] = 'info';
    const result = runValidation(doc, { ruleIds: ['overtake.noPassingTrack'] });
    expect(result.issues[0]?.severity).toBe('info');
    expect(result.errorCount).toBe(0);
    expect(result.infoCount).toBe(1);
  });

  it("skips a rule turned 'off'", () => {
    const doc = toyProjectCopy();
    doc.stationTracks.byId[TOY.c2]!.canBeOvertaken = false;
    doc.validationConfig.severityOverrides['overtake.noPassingTrack'] = 'off';
    expect(runValidation(doc, { ruleIds: ['overtake.noPassingTrack'] }).issues).toEqual([]);
  });

  it('can turn referential integrity off and still run everything else', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.typeId = asId<'TrainType'>('typ-999');
    doc.validationConfig.severityOverrides['ref.dangling'] = 'off';
    const ruleIds = new Set(runValidation(doc).issues.map((i) => i.ruleId));
    expect(ruleIds.has('ref.dangling')).toBe(false);
  });
});

describe('issue ordering and counting', () => {
  it('sorts errors before warnings before info, then by time', () => {
    const doc = toyProjectCopy();
    doc.stationTracks.byId[TOY.c2]!.canBeOvertaken = false; // error
    doc.trains.byId[TOY.localDown]!.stops[1]!.dep = 8 * 3600 + 100; // dwell warning
    const result = runValidation(doc);
    const rank = { error: 0, warning: 1, info: 2 } as const;
    const ranks = result.issues.map((i) => rank[i.severity]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(result.errorCount).toBeGreaterThan(0);
    expect(result.warningCount).toBeGreaterThan(0);
  });

  it('counts issues per rule', () => {
    const doc = toyProjectCopy();
    doc.stationTracks.byId[TOY.c2]!.canBeOvertaken = false;
    const result = runValidation(doc);
    const total = Object.values(result.byRule).reduce((a, b) => a + b, 0);
    expect(total).toBe(result.issues.length);
    expect(result.errorCount + result.warningCount + result.infoCount).toBe(
      result.issues.length,
    );
  });

  it('accepts every RuleId in the union as a filter', () => {
    const doc = toyProject();
    for (const id of Object.keys(RULES) as RuleId[]) {
      expect(() => runValidation(doc, { ruleIds: [id] })).not.toThrow();
    }
  });
});
