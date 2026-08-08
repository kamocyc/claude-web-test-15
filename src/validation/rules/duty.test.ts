import { describe, expect, it } from 'vitest';

import { asId } from '@/domain/ids';
import { TOY, toyProject, toyProjectCopy } from '@/testing/toyProject';
import { expectIssue, idsFor, issuesFor } from '../testkit';

const H = 3600;
const M = 60;

describe('duty.continuityBreak', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'duty.continuityBreak')).toEqual([]);
  });

  it('fires when one leg ends somewhere the next does not start', () => {
    const doc = toyProjectCopy();
    const stable = doc.duties.byId[TOY.dutyLocal]!.legs[2]!;
    if (stable.kind !== 'stable') throw new Error('fixture changed');
    stable.stationId = TOY.stationC;
    delete stable.trackId;
    const issue = expectIssue(
      doc,
      'duty.continuityBreak',
      'duty.continuityBreak#dut-1|2|place',
      'error',
    );
    expect(issue.detail).toContain('D駅');
    expect(issue.detail).toContain('C駅');
  });

  it('fires when the next leg starts before the previous one ends', () => {
    const doc = toyProjectCopy();
    const stable = doc.duties.byId[TOY.dutyLocal]!.legs[2]!;
    if (stable.kind !== 'stable') throw new Error('fixture changed');
    stable.from = 8 * H + 5 * M; // the 各停 does not arrive until 08:10
    expectIssue(doc, 'duty.continuityBreak', 'duty.continuityBreak#dut-1|2|time', 'error');
  });
});

describe('duty.emptyOrUnassigned', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'duty.emptyOrUnassigned')).toEqual([]);
  });

  it('fires for a duty with no legs', () => {
    const doc = toyProjectCopy();
    doc.duties.byId[TOY.dutyExpress]!.legs = [];
    expectIssue(
      doc,
      'duty.emptyOrUnassigned',
      'duty.emptyOrUnassigned#dut-2|empty',
      'warning',
    );
  });

  it('fires for a duty with no formation on the date', () => {
    const doc = toyProjectCopy();
    doc.assignments.allIds = ['asg-1'];
    const issue = expectIssue(
      doc,
      'duty.emptyOrUnassigned',
      'duty.emptyOrUnassigned#dut-2|unassigned',
      'warning',
    );
    expect(issue.date).toBe('2026-04-06');
  });
});

describe('duty.notStartingFromDepot', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'duty.notStartingFromDepot')).toEqual([]);
  });

  it('fires when a duty leaves the depot and never returns', () => {
    const doc = toyProjectCopy();
    doc.duties.byId[TOY.dutyLocal]!.legs.pop(); // drop the 入庫
    const issue = expectIssue(
      doc,
      'duty.notStartingFromDepot',
      'duty.notStartingFromDepot#dut-1|noIn',
      'warning',
    );
    expect(issue.detail).toContain('A車庫');
  });

  it('fires when a duty returns to the depot without ever leaving it', () => {
    const doc = toyProjectCopy();
    doc.duties.byId[TOY.dutyLocal]!.legs.shift(); // drop the 出庫
    expect(idsFor(doc, 'duty.notStartingFromDepot')).toContain(
      'duty.notStartingFromDepot#dut-1|noOut',
    );
  });
});

describe('duty.carCountMismatch', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'duty.carCountMismatch')).toEqual([]);
  });

  it('fires when the formation is shorter than the duty requires', () => {
    const doc = toyProjectCopy();
    doc.formations.byId[TOY.formation1]!.cars = 4;
    const issue = expectIssue(
      doc,
      'duty.carCountMismatch',
      'duty.carCountMismatch#dut-1|frm-1|dutyCars',
      'error',
    );
    expect(issue.detail).toContain('6両');
    expect(issue.detail).toContain('4両');
  });

  it('fires when the formation is shorter than a train requires', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.minCars = 8;
    expect(idsFor(doc, 'duty.carCountMismatch')).toContain(
      'duty.carCountMismatch#dut-1|frm-1|trainCars|trn-1',
    );
  });

  it('fires when the series is not allowed', () => {
    const doc = toyProjectCopy();
    doc.formationSeries.byId['ser-2'] = {
      id: asId<'FormationSeries'>('ser-2'),
      name: 'U形',
      perfProfileId: TOY.profile,
      allowedCarCounts: [6],
    };
    doc.formationSeries.allIds.push('ser-2');
    doc.trains.byId[TOY.localDown]!.allowedSeriesIds = [asId<'FormationSeries'>('ser-2')];
    expect(idsFor(doc, 'duty.carCountMismatch')).toContain(
      'duty.carCountMismatch#dut-1|frm-1|trainSeries|trn-1',
    );
  });
});

describe('train.notCovered', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'train.notCovered')).toEqual([]);
  });

  it('fires for a service train in no duty', () => {
    const doc = toyProjectCopy();
    doc.duties.allIds = ['dut-1'];
    const issue = expectIssue(doc, 'train.notCovered', 'train.notCovered#trn-2|day-1', 'warning');
    expect(issue.detail).toContain('列車 201');
  });

  it('does not chase 回送 — they are not category service', () => {
    const doc = toyProjectCopy();
    doc.duties.allIds = [];
    expect(idsFor(doc, 'train.notCovered').sort()).toEqual([
      'train.notCovered#trn-1|day-1',
      'train.notCovered#trn-2|day-1',
    ]);
  });
});

describe('train.duplicateNumber', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'train.duplicateNumber')).toEqual([]);
  });

  it('fires for two trains sharing a number on one day type', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.expressDown]!.number = '101';
    const issue = expectIssue(
      doc,
      'train.duplicateNumber',
      'train.duplicateNumber#day-1|101',
      'error',
    );
    expect(issue.detail).toContain('2本');
    expect(issue.refs).toHaveLength(2);
  });

  it('allows the same number on different day types', () => {
    const doc = toyProjectCopy();
    doc.dayTypes.byId['day-2'] = {
      id: asId<'DayType'>('day-2'),
      name: '休日',
      kind: 'holiday',
      color: '#000',
    };
    doc.dayTypes.allIds.push('day-2');
    doc.trains.byId[TOY.expressDown]!.number = '101';
    doc.trains.byId[TOY.expressDown]!.dayTypeIds = [asId<'DayType'>('day-2')];
    expect(issuesFor(doc, 'train.duplicateNumber')).toEqual([]);
  });
});
