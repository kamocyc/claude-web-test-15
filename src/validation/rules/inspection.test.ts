import { describe, expect, it } from 'vitest';

import { TOY, toyProject, toyProjectCopy } from '@/testing/toyProject';
import { expectIssue, idsFor, issuesFor } from '../testkit';

describe('inspection.overdue', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'inspection.overdue')).toEqual([]);
  });

  it('fires once the 10-day 列車検査 cycle has run out', () => {
    const doc = toyProjectCopy();
    doc.inspectionRecords.byId['irc-1']!.from = '2026-03-20';
    doc.inspectionRecords.byId['irc-1']!.to = '2026-03-20'; // due 2026-03-30
    const issue = expectIssue(
      doc,
      'inspection.overdue',
      'inspection.overdue#frm-1|irl-1|2026-04-06',
      'error',
    );
    expect(issue.detail).toContain('T01F');
    expect(issue.detail).toContain('2026-03-30');
    expect(issue.refs[0]).toEqual({
      kind: 'inspection',
      formationId: TOY.formation1,
      ruleId: TOY.ruleTrain,
    });
  });

  it('fires on distance as well as on days', () => {
    const doc = toyProjectCopy();
    doc.inspectionRules.byId[TOY.ruleTrain]!.intervalKm = 100;
    expect(idsFor(doc, 'inspection.overdue')).toContain(
      'inspection.overdue#frm-1|irl-1|2026-04-06',
    );
  });
});

describe('inspection.dueSoon', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'inspection.dueSoon')).toEqual([]);
  });

  it('fires inside warnBeforeDays', () => {
    const doc = toyProjectCopy();
    doc.inspectionRecords.byId['irc-1']!.from = '2026-03-28';
    doc.inspectionRecords.byId['irc-1']!.to = '2026-03-28'; // due 2026-04-07
    const issue = expectIssue(
      doc,
      'inspection.dueSoon',
      'inspection.dueSoon#frm-1|irl-1|2026-04-06',
      'warning',
    );
    expect(issue.detail).toContain('残り 1日');
  });

  it('says nothing for a formation with no record — that is unknown, not due', () => {
    // Neither set has ever had a 月検査 in the fixture.
    expect(idsFor(toyProject(), 'inspection.dueSoon')).toEqual([]);
  });
});

describe('inspection.depotNotCapable', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'inspection.depotNotCapable')).toEqual([]);
  });

  it('fires when a rule names a depot that cannot do that inspection', () => {
    const doc = toyProjectCopy();
    doc.depots.byId[TOY.depot]!.inspectionKinds = ['monthly'];
    const issue = expectIssue(
      doc,
      'inspection.depotNotCapable',
      'inspection.depotNotCapable#irl-1|dep-1',
      'warning',
    );
    expect(issue.detail).toContain('列車検査');
    expect(issue.detail).toContain('A車庫');
    // The completed records at that depot are flagged too.
    expect(idsFor(doc, 'inspection.depotNotCapable')).toContain(
      'inspection.depotNotCapable#irc-1|dep-1',
    );
  });

  it('fires for an inspection leg booked at an incapable depot', () => {
    const doc = toyProjectCopy();
    doc.depots.byId[TOY.depot]!.inspectionKinds = ['train', 'monthly'];
    doc.duties.byId[TOY.dutyExpress]!.legs.push({
      kind: 'inspection',
      depotId: TOY.depot,
      inspectionKind: 'general',
      from: 10 * 3600,
      to: 12 * 3600,
    });
    expect(idsFor(doc, 'inspection.depotNotCapable')).toContain(
      'inspection.depotNotCapable#dut-2|1',
    );
  });
});

describe('inspection.conflictsWithDuty', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'inspection.conflictsWithDuty')).toEqual([]);
  });

  it('fires when a formation is rostered while it is in the works', () => {
    const doc = toyProjectCopy();
    doc.inspectionRecords.byId['irc-1']!.from = '2026-04-05';
    doc.inspectionRecords.byId['irc-1']!.to = '2026-04-07';
    const issue = expectIssue(
      doc,
      'inspection.conflictsWithDuty',
      'inspection.conflictsWithDuty#irc-1|asg-1',
      'error',
    );
    expect(issue.detail).toContain('T01F');
    expect(issue.detail).toContain('運用 01');
    expect(issue.date).toBe('2026-04-06');
  });

  it('says nothing when the inspection window clears the roster date', () => {
    const doc = toyProjectCopy();
    doc.inspectionRecords.byId['irc-1']!.from = '2026-04-04';
    doc.inspectionRecords.byId['irc-1']!.to = '2026-04-05';
    expect(issuesFor(doc, 'inspection.conflictsWithDuty')).toEqual([]);
  });
});
