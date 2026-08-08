import { describe, expect, it } from 'vitest';

import { TOY, toyProject, toyProjectCopy } from '@/testing/toyProject';
import { expectIssue, idsFor, issuesFor } from '../testkit';

const H = 3600;
const M = 60;

describe('track.doubleOccupancy', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'track.doubleOccupancy')).toEqual([]);
  });

  it('fires when two trains are booked onto one road at once', () => {
    const doc = toyProjectCopy();
    // Put the express through C on the same road the local is waiting on.
    doc.trains.byId[TOY.expressDown]!.stops[2]!.trackId = TOY.c2;
    const issue = expectIssue(
      doc,
      'track.doubleOccupancy',
      'track.doubleOccupancy#trk-5|trn-1|trn-2|28995',
      'error',
    );
    expect(issue.detail).toContain('C駅 2番線');
    expect(issue.detail).toContain('列車 101');
    expect(issue.detail).toContain('列車 201');
    expect(issue.detail).toMatch(/\d+秒 重複/);
  });

  it('ignores the same duty handing over to itself', () => {
    const doc = toyProjectCopy();
    // 各停 arrives at D 1番線 and 回8002 leaves from it; both are duty 01.
    doc.trains.byId[TOY.depotIn]!.stops[0]!.dep = 8 * H + 10 * M + 10;
    doc.duties.byId[TOY.dutyLocal]!.legs.splice(2, 1);
    expect(issuesFor(doc, 'track.doubleOccupancy')).toEqual([]);
  });
});

describe('track.unassigned', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'track.unassigned')).toEqual([]);
  });

  it('fires for a stop with no road at a station that has some', () => {
    const doc = toyProjectCopy();
    delete doc.trains.byId[TOY.localDown]!.stops[1]!.trackId;
    expectIssue(doc, 'track.unassigned', 'track.unassigned#trn-1|1', 'warning');
  });

  it('stays quiet at a station with no roads at all', () => {
    const doc = toyProjectCopy();
    delete doc.trains.byId[TOY.localDown]!.stops[1]!.trackId;
    doc.stations.byId[TOY.stationB]!.trackIds = [];
    expect(issuesFor(doc, 'track.unassigned')).toEqual([]);
  });
});

describe('track.directionNotAllowed', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'track.directionNotAllowed')).toEqual([]);
  });

  it('fires when a down train is put on an up-only road', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.stops[2]!.trackId = TOY.c3;
    const issue = expectIssue(
      doc,
      'track.directionNotAllowed',
      'track.directionNotAllowed#trn-1|2',
      'error',
    );
    expect(issue.detail).toContain('C駅 3番線');
    expect(issue.detail).toContain('上り');
  });
});

describe('track.noPlatform', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'track.noPlatform')).toEqual([]);
  });

  it('fires for a passenger stop on a road with no platform', () => {
    const doc = toyProjectCopy();
    doc.stationTracks.byId[TOY.b1]!.hasPlatform = false;
    const issue = expectIssue(doc, 'track.noPlatform', 'track.noPlatform#trn-1|1', 'error');
    expect(issue.detail).toContain('B駅 1番線');
  });

  it('leaves 回送 on the depot road alone', () => {
    // 回8001/回8002 already stand on a platformless stabling road.
    expect(idsFor(toyProject(), 'track.noPlatform')).toEqual([]);
  });

  it('leaves 運転停車 alone', () => {
    const doc = toyProjectCopy();
    doc.stationTracks.byId[TOY.b1]!.hasPlatform = false;
    doc.trains.byId[TOY.localDown]!.stops[1]!.operational = true;
    expect(issuesFor(doc, 'track.noPlatform')).toEqual([]);
  });
});

describe('track.lengthExceeded', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'track.lengthExceeded')).toEqual([]);
  });

  it('fires when the assigned formation is longer than the road', () => {
    const doc = toyProjectCopy();
    doc.stationTracks.byId[TOY.d1]!.maxCars = 4;
    const issue = expectIssue(
      doc,
      'track.lengthExceeded',
      'track.lengthExceeded#trn-1|3|frm-1',
      'error',
    );
    expect(issue.detail).toContain('6両');
    expect(issue.detail).toContain('4両');
  });

  it('says nothing when no formation is assigned', () => {
    const doc = toyProjectCopy();
    doc.stationTracks.byId[TOY.d1]!.maxCars = 4;
    doc.assignments = { byId: {}, allIds: [] };
    expect(issuesFor(doc, 'track.lengthExceeded')).toEqual([]);
  });
});
