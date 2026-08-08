import { describe, expect, it } from 'vitest';

import { TOY, toyProject, toyProjectCopy } from '@/testing/toyProject';
import { expectIssue, idsFor, issuesFor } from '../testkit';

describe('overtake.noPassingTrack', () => {
  it('does not fire on the clean fixture — C has a 待避線', () => {
    expect(issuesFor(toyProject(), 'overtake.noPassingTrack')).toEqual([]);
  });

  it('fires when no road at the station can be passed', () => {
    const doc = toyProjectCopy();
    doc.stationTracks.byId[TOY.c2]!.canBeOvertaken = false;
    const issue = expectIssue(
      doc,
      'overtake.noPassingTrack',
      'overtake.noPassingTrack#stn-3|trn-1|trn-2',
      'error',
    );
    expect(issue.detail).toContain('待避可能な番線がありません');
  });

  it('fires when the waiting train sits on a road that cannot be passed', () => {
    const doc = toyProjectCopy();
    doc.stationTracks.byId[TOY.c1]!.canBeOvertaken = false;
    doc.trains.byId[TOY.localDown]!.stops[2]!.trackId = TOY.c1;
    const issue = expectIssue(
      doc,
      'overtake.noPassingTrack',
      'overtake.noPassingTrack#stn-3|trn-1|trn-2',
      'error',
    );
    expect(issue.detail).toContain('C駅 1番線');
  });
});

describe('overtake.undeclared', () => {
  it('does not fire on the clean fixture — the wait is declared', () => {
    expect(issuesFor(toyProject(), 'overtake.undeclared')).toEqual([]);
  });

  it('fires when a detected overtake was never declared', () => {
    const doc = toyProjectCopy();
    delete doc.trains.byId[TOY.localDown]!.stops[2]!.overtakenBy;
    const issue = expectIssue(
      doc,
      'overtake.undeclared',
      'overtake.undeclared#stn-3|trn-1|trn-2',
      'info',
    );
    expect(issue.detail).toContain('列車 201');
  });
});

describe('overtake.declaredButAbsent', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'overtake.declaredButAbsent')).toEqual([]);
  });

  it('fires when the declared passing train does not actually pass', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.stops[2]!.overtakenBy = [TOY.depotIn];
    const issue = expectIssue(
      doc,
      'overtake.declaredButAbsent',
      'overtake.declaredButAbsent#trn-1|2|trn-4',
      'warning',
    );
    expect(issue.detail).toContain('回8002');
    // The real overtake is still recognised, so no complaint about 201.
    expect(idsFor(doc, 'overtake.declaredButAbsent')).not.toContain(
      'overtake.declaredButAbsent#trn-1|2|trn-2',
    );
  });

  it('fires when the timing no longer works', () => {
    const doc = toyProjectCopy();
    // Send the express through C after the local has already left.
    doc.trains.byId[TOY.expressDown]!.stops[2]!.arr = 8 * 3600 + 9 * 60;
    doc.trains.byId[TOY.expressDown]!.stops[2]!.dep = 8 * 3600 + 9 * 60;
    expect(idsFor(doc, 'overtake.declaredButAbsent')).toContain(
      'overtake.declaredButAbsent#trn-1|2|trn-2',
    );
  });
});
