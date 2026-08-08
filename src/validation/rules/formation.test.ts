import { describe, expect, it } from 'vitest';

import { asId } from '@/domain/ids';
import { TOY, toyProject, toyProjectCopy } from '@/testing/toyProject';
import { expectIssue, idsFor, issuesFor } from '../testkit';

describe('formation.doubleBooked', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'formation.doubleBooked')).toEqual([]);
  });

  it('fires when one formation works two overlapping duties on a date', () => {
    const doc = toyProjectCopy();
    doc.assignments.byId['asg-2']!.formationId = TOY.formation1;
    const issue = expectIssue(
      doc,
      'formation.doubleBooked',
      'formation.doubleBooked#2026-04-06|frm-1|dut-1|dut-2',
      'error',
    );
    expect(issue.detail).toContain('T01F');
    expect(issue.detail).toContain('運用 01');
    expect(issue.detail).toContain('運用 02');
    expect(issue.date).toBe('2026-04-06');
  });

  it('allows the same formation on two duties that do not overlap in time', () => {
    const doc = toyProjectCopy();
    doc.assignments.byId['asg-2']!.formationId = TOY.formation1;
    // Push the express well clear of duty 01 (which ends 08:30).
    const express = doc.trains.byId[TOY.expressDown]!;
    express.stops[0]!.dep = 12 * 3600;
    express.stops[1]!.arr = 12 * 3600 + 70;
    express.stops[1]!.dep = 12 * 3600 + 70;
    express.stops[2]!.arr = 12 * 3600 + 180;
    express.stops[2]!.dep = 12 * 3600 + 180;
    express.stops[3]!.arr = 12 * 3600 + 270;
    expect(issuesFor(doc, 'formation.doubleBooked')).toEqual([]);
  });

  it('allows the same formation on the same duty on different dates', () => {
    const doc = toyProjectCopy();
    doc.assignments.byId['asg-3'] = {
      id: asId<'Assignment'>('asg-3'),
      date: '2026-04-07',
      dutyId: TOY.dutyExpress,
      formationId: TOY.formation1,
    };
    doc.assignments.allIds.push('asg-3');
    expect(issuesFor(doc, 'formation.doubleBooked')).toEqual([]);
  });
});

describe('formation.insufficientFleet', () => {
  it('does not fire on the clean fixture (2 duties, 2 active sets)', () => {
    expect(issuesFor(toyProject(), 'formation.insufficientFleet')).toEqual([]);
  });

  it('fires when the peak needs more sets than are in service', () => {
    const doc = toyProjectCopy();
    doc.formations.byId[TOY.formation2]!.status = 'stored';
    const issue = expectIssue(
      doc,
      'formation.insufficientFleet',
      'formation.insufficientFleet#6',
      'warning',
    );
    expect(issue.detail).toContain('2運用');
    expect(issue.detail).toContain('1本');
  });

  it('does not count sets that are too short', () => {
    const doc = toyProjectCopy();
    doc.formations.byId[TOY.formation2]!.cars = 4;
    expect(idsFor(doc, 'formation.insufficientFleet')).toEqual([
      'formation.insufficientFleet#6',
    ]);
  });
});
