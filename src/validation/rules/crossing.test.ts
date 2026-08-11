import { describe, expect, it } from 'vitest';

import { ID_PREFIX, asId } from '@/domain/ids';
import { TOY, toyProject, toyProjectCopy } from '@/testing/toyProject';
import { expectIssue, issuesFor } from '../testkit';

const H = 3600;
const M = 60;

/**
 * Put C駅's 待避線 on the far side of the up road, which is what turns a move
 * into it from the down line into a move across the 上り本線. Everything else
 * about the fixture stays as it is.
 */
function loopBeyondTheUpRoad(doc: ReturnType<typeof toyProjectCopy>): void {
  doc.stationTracks.byId[TOY.c2]!.wiring = { ends: ['down', 'up'], ladder: 3 };
}

/** Bring 急201 through C駅 at the same moment 回8002 leaves it. */
function collideAtC(doc: ReturnType<typeof toyProjectCopy>): void {
  const express = doc.trains.byId[TOY.expressDown]!;
  express.stops[2]!.arr = 8 * H + 22 * M + 50;
  express.stops[2]!.dep = 8 * H + 23 * M + 20;
  express.stops[3]!.arr = 8 * H + 25 * M;
}

describe('track.crossingConflict', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'track.crossingConflict')).toEqual([]);
  });

  it('lets two moves through one throat run in parallel', () => {
    // 各101 into the loop and 回8002 out of the up road at the same instant.
    // Both use the throat, neither crosses the other: the loop is on the down
    // side of the layout, where it belongs.
    const doc = toyProjectCopy();
    collideAtC(doc);
    doc.trains.byId[TOY.expressDown]!.stops[2]!.trackId = TOY.c2;
    expect(issuesFor(doc, 'track.crossingConflict')).toEqual([]);
  });

  it('fires when a move across the throat meets one along it', () => {
    const doc = toyProjectCopy();
    loopBeyondTheUpRoad(doc);
    collideAtC(doc);
    doc.trains.byId[TOY.expressDown]!.stops[2]!.trackId = TOY.c2;
    const issue = expectIssue(
      doc,
      'track.crossingConflict',
      'track.crossingConflict#stn-3|up|trn-2|trn-4|30170',
      'warning',
    );
    expect(issue.detail).toContain('C駅 上り方');
    expect(issue.detail).toContain('列車 201');
    expect(issue.detail).toContain('列車 回8002');
    expect(issue.detail).toMatch(/\d+秒 重なって/);
    expect(issue.refs[0]).toEqual({ kind: 'station', stationId: TOY.stationC });
  });

  it('stays quiet once the two moves are far enough apart', () => {
    const doc = toyProjectCopy();
    loopBeyondTheUpRoad(doc);
    collideAtC(doc);
    doc.trains.byId[TOY.expressDown]!.stops[2]!.trackId = TOY.c2;
    doc.trains.byId[TOY.expressDown]!.stops[2]!.arr = 8 * H + 24 * M;
    doc.trains.byId[TOY.expressDown]!.stops[2]!.dep = 8 * H + 24 * M + 30;
    expect(issuesFor(doc, 'track.crossingConflict')).toEqual([]);
  });

  it('never reports one formation against itself', () => {
    // 各101 and 回8002 are the same duty, so nothing they do at C can conflict.
    const doc = toyProjectCopy();
    loopBeyondTheUpRoad(doc);
    const deadhead = doc.trains.byId[TOY.depotIn]!;
    deadhead.stops[0]!.dep = 8 * H + 2 * M;
    deadhead.stops[1]!.arr = 8 * H + 4 * M;
    deadhead.stops[1]!.dep = 8 * H + 4 * M + 10;
    expect(issuesFor(doc, 'track.crossingConflict')).toEqual([]);
  });

  it('reports the 入換 a duty makes between two roads', () => {
    // 運用 01 arrives at D駅 1番線 and is shunted into a tail track wired
    // beyond a third road — so the shunt crosses that road, and the express
    // standing on it at the time is fouled.
    const doc = toyProjectCopy();
    const d3 = asId<'StationTrack'>(`${ID_PREFIX.stationTrack}-30`);
    doc.stationTracks.byId[d3] = {
      ...doc.stationTracks.byId[TOY.d1]!,
      id: d3,
      name: '3番線',
    };
    doc.stationTracks.allIds = [...doc.stationTracks.allIds, d3];
    doc.stations.byId[TOY.stationD]!.trackIds = [TOY.d1, d3, TOY.d2];
    doc.stationTracks.byId[TOY.d2]!.wiring = { ends: ['up'], ladder: 5 };
    doc.duties.byId[TOY.dutyLocal]!.legs[2] = {
      kind: 'stable',
      stationId: TOY.stationD,
      trackId: TOY.d2,
      from: 8 * H + 12 * M,
      to: 8 * H + 20 * M,
    };
    const express = doc.trains.byId[TOY.expressDown]!;
    express.stops[3]!.trackId = d3;
    express.stops[3]!.arr = 8 * H + 12 * M + 30;

    const issues = issuesFor(doc, 'track.crossingConflict');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toContain('入換');
    expect(issues[0]!.detail).toContain('D駅');
    expect(issues[0]!.detail).toContain('3番線');
  });
});

describe('track.routeMissing', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'track.routeMissing')).toEqual([]);
  });

  it('fires when a road meets no 本線 at the end the train uses', () => {
    // C駅's 待避線 is switched onto the 上り方 throat but onto a lead of its
    // own there, the way 溝の口's 大井町線 faces are: reachable from the other
    // roads, and from no running line.
    const doc = toyProjectCopy();
    doc.stationTracks.byId[TOY.c2]!.wiring = {
      ends: ['down', 'up'],
      connects: { up: ['側線'] },
    };
    doc.trains.byId[TOY.expressDown]!.stops[2]!.trackId = TOY.c2;
    const issues = issuesFor(doc, 'track.routeMissing');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.detail).toContain('C駅');
    expect(issues[0]!.detail).toContain('上り方');
    expect(issues[0]!.detail).toContain('つながっていません');
  });

  it('stays quiet once a 渡り線 joins that lead to the line', () => {
    const doc = toyProjectCopy();
    doc.stationTracks.byId[TOY.c2]!.wiring = {
      ends: ['down', 'up'],
      connects: { up: ['側線'] },
    };
    doc.trains.byId[TOY.expressDown]!.stops[2]!.trackId = TOY.c2;
    doc.stations.byId[TOY.stationC]!.crossovers = [
      { end: 'up', from: '側線', to: 'down' },
      { end: 'up', from: '側線', to: 'up' },
    ];
    expect(issuesFor(doc, 'track.routeMissing')).toEqual([]);
  });
});
