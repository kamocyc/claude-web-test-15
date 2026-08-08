import { describe, expect, it } from 'vitest';

import { TOY, toyProject, toyProjectCopy } from '@/testing/toyProject';
import { buildIndex } from './buildIndex';
import { detectConnections, detectOvertakes } from './overtake';

const H = 3600;
const M = 60;

function analyse(doc = toyProject()): ReturnType<typeof buildIndex> {
  return buildIndex(doc);
}

describe('detectOvertakes', () => {
  it('finds the local being overtaken by the express at C', () => {
    const idx = analyse();
    expect(idx.overtakes).toHaveLength(1);
    expect(idx.overtakes[0]).toEqual({
      stationId: TOY.stationC,
      direction: 'down',
      waitingTrainId: TOY.localDown,
      passingTrainId: TOY.expressDown,
      waitArr: 8 * H + 4 * M,
      passAt: 8 * H + 6 * M,
      waitDep: 8 * H + 8 * M,
      declared: true,
      legal: true,
    });
  });

  it('does not fire when the order does not actually flip', () => {
    // Send the express through C before the local gets there.
    const doc = toyProjectCopy();
    const express = doc.trains.byId[TOY.expressDown]!;
    express.stops[0]!.dep = 7 * H + 55 * M;
    express.stops[1]!.arr = 7 * H + 56 * M;
    express.stops[1]!.dep = 7 * H + 56 * M;
    express.stops[2]!.arr = 7 * H + 57 * M;
    express.stops[2]!.dep = 7 * H + 57 * M;
    express.stops[3]!.arr = 7 * H + 58 * M;
    expect(analyse(doc).overtakes).toHaveLength(0);
  });

  it('does not pair trains running in opposite directions', () => {
    const doc = toyProjectCopy();
    // Drag the up-direction 回送 through C while the local is standing there.
    const depotIn = doc.trains.byId[TOY.depotIn]!;
    depotIn.stops[0]!.dep = 8 * H + 4 * M;
    depotIn.stops[1]!.arr = 8 * H + 6 * M;
    depotIn.stops[1]!.dep = 8 * H + 6 * M;
    const idx = analyse(doc);
    expect(idx.overtakes.map((o) => o.passingTrainId)).not.toContain(TOY.depotIn);
  });

  it('marks the overtake illegal when no track at the station can be passed', () => {
    const doc = toyProjectCopy();
    doc.stationTracks.byId[TOY.c2]!.canBeOvertaken = false;
    const [ot] = analyse(doc).overtakes;
    expect(ot?.legal).toBe(false);
    expect(ot?.reason).toBe('noPassingTrack');
  });

  it('marks the overtake illegal when the waiting train is on the wrong road', () => {
    const doc = toyProjectCopy();
    // 1番線 exists and cannot be passed; the passing loop is still there.
    doc.stationTracks.byId[TOY.c1]!.canBeOvertaken = false;
    doc.trains.byId[TOY.localDown]!.stops[2]!.trackId = TOY.c1;
    const [ot] = analyse(doc).overtakes;
    expect(ot?.legal).toBe(false);
    expect(ot?.reason).toBe('trackNotOvertakeCapable');
  });

  it('reports undeclared overtakes as undeclared', () => {
    const doc = toyProjectCopy();
    delete doc.trains.byId[TOY.localDown]!.stops[2]!.overtakenBy;
    expect(analyse(doc).overtakes[0]?.declared).toBe(false);
  });
});

describe('detectConnections', () => {
  it('finds the viable 緩急接続 at C', () => {
    const idx = analyse();
    expect(idx.connections).toHaveLength(1);
    expect(idx.connections[0]).toEqual({
      stationId: TOY.stationC,
      direction: 'down',
      fromTrainId: TOY.localDown,
      toTrainId: TOY.expressDown,
      transferSec: 2 * M,
      declared: false,
      viable: true,
    });
  });

  it('only looks at stations flagged as connection points', () => {
    const doc = toyProjectCopy();
    doc.stations.byId[TOY.stationC]!.isConnectionPoint = false;
    expect(analyse(doc).connections).toHaveLength(0);
  });

  it('marks a transfer outside the window as not viable', () => {
    const doc = toyProjectCopy();
    // Express through C only 30 s after the local arrives.
    const express = doc.trains.byId[TOY.expressDown]!;
    express.stops[2]!.arr = 8 * H + 4 * M + 30;
    express.stops[2]!.dep = 8 * H + 4 * M + 30;
    const [connection] = analyse(doc).connections;
    expect(connection?.transferSec).toBe(30);
    expect(connection?.viable).toBe(false);
  });

  it('picks up a declaration from the stop', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.stops[2]!.connectsTo = [TOY.expressDown];
    expect(analyse(doc).connections[0]?.declared).toBe(true);
  });

  it('is callable directly and is deduplicated', () => {
    const doc = toyProject();
    const idx = buildIndex(doc);
    const overtakes = detectOvertakes(doc, idx.timelines);
    const connections = detectConnections(doc, idx.timelines, overtakes);
    const keys = connections.map((c) => `${c.stationId}|${c.fromTrainId}|${c.toTrainId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
