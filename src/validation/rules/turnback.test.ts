import { describe, expect, it } from 'vitest';

import { TOY, toyProject, toyProjectCopy } from '@/testing/toyProject';
import { expectIssue, idsFor, issuesFor } from '../testkit';

const H = 3600;
const M = 60;

/** 各停 arrives at D 08:10; 回8002 leaves D at `dep`. */
function withTurnbackAt(dep: number): ReturnType<typeof toyProjectCopy> {
  const doc = toyProjectCopy();
  doc.trains.byId[TOY.depotIn]!.stops[0]!.dep = dep;
  const stable = doc.duties.byId[TOY.dutyLocal]!.legs[2]!;
  if (stable.kind === 'stable') stable.to = dep;
  return doc;
}

describe('turnback.insufficient', () => {
  it('does not fire on the clean fixture (10 minutes at D)', () => {
    expect(issuesFor(toyProject(), 'turnback.insufficient')).toEqual([]);
  });

  it('fires below the station minimum turnback time', () => {
    const doc = withTurnbackAt(8 * H + 11 * M); // 60 s, minimum is 180
    const issue = expectIssue(
      doc,
      'turnback.insufficient',
      'turnback.insufficient#dut-1|trn-1|trn-4',
      'error',
    );
    expect(issue.detail).toContain('1分');
    expect(issue.detail).toContain('3分');
  });

  it('is silent exactly at the minimum', () => {
    expect(idsFor(withTurnbackAt(8 * H + 13 * M), 'turnback.insufficient')).toEqual([]);
  });
});

describe('turnback.tight', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'turnback.tight')).toEqual([]);
  });

  it('fires between the minimum and the preferred turnback time', () => {
    const doc = withTurnbackAt(8 * H + 14 * M); // 240 s: >= 180, < 300
    expectIssue(doc, 'turnback.tight', 'turnback.tight#dut-1|trn-1|trn-4', 'warning');
  });

  it('defers to turnback.insufficient below the minimum', () => {
    const doc = withTurnbackAt(8 * H + 11 * M);
    expect(issuesFor(doc, 'turnback.tight')).toEqual([]);
  });
});

describe('turnback.trackNotCapable', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'turnback.trackNotCapable')).toEqual([]);
  });

  it('fires when the road at the turnback point cannot reverse', () => {
    const doc = toyProjectCopy();
    doc.stationTracks.byId[TOY.d1]!.canTurnBack = false;
    const issue = expectIssue(
      doc,
      'turnback.trackNotCapable',
      'turnback.trackNotCapable#dut-1|trn-1|trk-7',
      'error',
    );
    expect(issue.detail).toContain('D駅 1番線');
    // Both the arriving and the departing train sit on that road.
    expect(idsFor(doc, 'turnback.trackNotCapable')).toContain(
      'turnback.trackNotCapable#dut-1|trn-4|trk-7',
    );
  });

  it('says nothing when the two legs do not reverse direction', () => {
    const doc = toyProjectCopy();
    doc.stationTracks.byId[TOY.a1]!.canTurnBack = false;
    // 回8001 (down) into A then 各停 (down) out of A is not a turnback.
    expect(issuesFor(doc, 'turnback.trackNotCapable')).toEqual([]);
  });
});
