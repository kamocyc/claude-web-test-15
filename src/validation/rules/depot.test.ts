import { describe, expect, it } from 'vitest';

import { asId } from '@/domain/ids';
import { TOY, toyProject, toyProjectCopy } from '@/testing/toyProject';
import { expectIssue, idsFor, issuesFor } from '../testkit';

const H = 3600;
const M = 60;

describe('depot.capacityExceeded', () => {
  it('does not fire on the clean fixture (2 formations, capacity 6)', () => {
    expect(issuesFor(toyProject(), 'depot.capacityExceeded')).toEqual([]);
  });

  it('fires when more formations are stabled than the shed holds', () => {
    const doc = toyProjectCopy();
    doc.depots.byId[TOY.depot]!.capacityFormations = 1;
    const issue = expectIssue(
      doc,
      'depot.capacityExceeded',
      'depot.capacityExceeded#dep-1',
      'error',
    );
    expect(issue.detail).toContain('2編成');
    expect(issue.detail).toContain('1編成');
    expect(issue.at).toBe(doc.settings.serviceDayStartSec);
  });

  it('counts every non-retired formation homed at the depot', () => {
    const doc = toyProjectCopy();
    doc.depots.byId[TOY.depot]!.capacityFormations = 2;
    expect(issuesFor(doc, 'depot.capacityExceeded')).toEqual([]);

    const third = asId<'Formation'>('frm-3');
    doc.formations.byId[third] = {
      ...doc.formations.byId[TOY.formation1]!,
      id: third,
      code: 'T03F',
    };
    doc.formations.allIds.push(third);
    expect(idsFor(doc, 'depot.capacityExceeded')).toEqual(['depot.capacityExceeded#dep-1']);

    // …but a retired set is not in the shed.
    doc.formations.byId[third] = { ...doc.formations.byId[third]!, status: 'retired' };
    expect(issuesFor(doc, 'depot.capacityExceeded')).toEqual([]);
  });
});

describe('depot.accessTimeViolated', () => {
  it('does not fire on the clean fixture (120 s ≥ 90 s)', () => {
    expect(issuesFor(toyProject(), 'depot.accessTimeViolated')).toEqual([]);
  });

  it('fires when 出庫 is booked faster than the depot access time', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.depotOut]!.stops[1]!.arr = 7 * H + 50 * M + 30;
    const issue = expectIssue(
      doc,
      'depot.accessTimeViolated',
      'depot.accessTimeViolated#trn-3|1|dep-1',
      'error',
    );
    expect(issue.detail).toContain('30秒');
    expect(issue.detail).toContain('1分30秒');
  });

  it('fires on the 入庫 leg too', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.depotIn]!.stops[4]!.arr = 8 * H + 28 * M + 30;
    expect(idsFor(doc, 'depot.accessTimeViolated')).toContain(
      'depot.accessTimeViolated#trn-4|4|dep-1',
    );
  });

  it('ignores ordinary sections that do not touch the depot', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.stops[1]!.arr = 8 * H + 5;
    expect(issuesFor(doc, 'depot.accessTimeViolated')).toEqual([]);
  });
});
