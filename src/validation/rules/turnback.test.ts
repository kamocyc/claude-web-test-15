import { describe, expect, it } from 'vitest';

import { asId } from '@/domain/ids';
import { TOY, toyProject, toyProjectCopy } from '@/testing/toyProject';
import { expectIssue, idsFor, issuesFor } from '../testkit';

const H = 3600;
const M = 60;

/** 各停 arrives at D 08:10:30; 回8002 leaves D at `dep`. */
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
    const doc = withTurnbackAt(8 * H + 11 * M + 30); // 60 s, minimum is 180
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
    expect(idsFor(withTurnbackAt(8 * H + 13 * M + 30), 'turnback.insufficient')).toEqual([]);
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

describe('turnback.trackChanged', () => {
  it('does not fire on the clean fixture (101 and 回8002 both use D 1番線)', () => {
    expect(issuesFor(toyProject(), 'turnback.trackChanged')).toEqual([]);
  });

  it('also catches a hand-over between two legs running the SAME way', () => {
    // Not a reversal, so the 折り返し timing rules rightly ignore it — but the
    // formation still has to be standing on the road it departs from. This
    // used to be skipped entirely, which let a 回送 arriving from beyond a
    // terminus and continuing onward change road with nothing to catch it.
    const doc = toyProjectCopy();
    const inbound = doc.trains.byId[TOY.depotIn]!;
    // Make 回8002 terminate at A rather than running through to the depot, and
    // have a second down train continue from A on a different road.
    inbound.stops = inbound.stops.slice(0, -1);
    const onward = structuredClone(doc.trains.byId[TOY.localDown]!);
    onward.id = asId<'Train'>('trn-90');
    onward.number = '190';
    onward.direction = 'up';
    onward.stops = [
      { stationId: TOY.stationA, trackId: TOY.a1, dep: 8 * 3600 + 40 * 60, kind: 'stop' },
      { stationId: TOY.stationB, trackId: TOY.b1, arr: 8 * 3600 + 42 * 60, kind: 'stop' },
    ];
    doc.trains.byId[onward.id] = onward;
    doc.trains.allIds.push(onward.id);
    doc.duties.byId[TOY.dutyLocal]!.legs.push({ kind: 'train', trainId: onward.id });

    const issues = issuesFor(doc, 'turnback.trackChanged');
    // 回8002 arrives A on 2番線; 190 departs A on 1番線, same direction.
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toContain('A駅');
  });

  it('errors where the station has no siding to shunt through', () => {
    const doc = toyProjectCopy();
    // 101 arrives on D 1番線, 回8002 now leaves from D 2番線, and the berth in
    // between still claims 1番線: the stock is asserted to have teleported.
    doc.trains.byId[TOY.depotIn]!.stops[0]!.trackId = TOY.d2;
    const issue = expectIssue(
      doc,
      'turnback.trackChanged',
      'turnback.trackChanged#dut-1|trn-1|trn-4',
      'error',
    );
    expect(issue.detail).toContain('D駅 1番線');
    expect(issue.detail).toContain('D駅 2番線');
    expect(issue.detail).toContain('引上線も留置線もなく');
  });

  it('downgrades to a warning where a stabling road exists', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.depotIn]!.stops[0]!.trackId = TOY.d2;
    doc.stationTracks.byId[TOY.d2]!.usage = 'stabling';
    const issue = expectIssue(
      doc,
      'turnback.trackChanged',
      'turnback.trackChanged#dut-1|trn-1|trn-4',
      'warning',
    );
    expect(issue.detail).toContain('移動自体は可能');
  });

  it('accepts the change when a stabling leg models the move', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.depotIn]!.stops[0]!.trackId = TOY.d2;
    const leg = doc.duties.byId[TOY.dutyLocal]!.legs[2]!;
    if (leg.kind === 'stable') leg.trackId = TOY.d2;
    expect(issuesFor(doc, 'turnback.trackChanged')).toEqual([]);
  });

  it('says nothing when a road is simply unassigned', () => {
    const doc = toyProjectCopy();
    delete doc.trains.byId[TOY.depotIn]!.stops[0]!.trackId;
    expect(issuesFor(doc, 'turnback.trackChanged')).toEqual([]);
  });
});
