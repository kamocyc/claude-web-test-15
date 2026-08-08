import { describe, expect, it } from 'vitest';
import { produce } from 'immer';

import { asId } from '@/domain/ids';
import type { ProjectDocument, Station, StationTrack, Train } from '@/domain/model';
import { createEmptyProject, orderedStations, tracksOfStation } from '@/domain/project';
import { entityList, kmToMeters } from '@/domain/units';
import { TOY, toyProject } from '@/testing/toyProject';

import type { Command } from './commands';
import { reduce } from './reducer';

function apply(doc: ProjectDocument, ...cmds: Command[]): ProjectDocument {
  return cmds.reduce(
    (acc, cmd) =>
      produce(acc, (draft) => {
        reduce(draft, cmd);
      }),
    doc,
  );
}

function station(id: string, name: string, km: number, trackIds: string[] = []): Station {
  return {
    id: asId<'Station'>(id),
    name,
    kind: 'passenger',
    kmFromOrigin: kmToMeters(km),
    trackIds: trackIds.map((t) => asId<'StationTrack'>(t)),
    minDwellSec: 20,
    minTurnbackSec: 180,
    defaultTrackId: {},
    isConnectionPoint: false,
  };
}

function track(id: string, stationId: string, name: string): StationTrack {
  return {
    id: asId<'StationTrack'>(id),
    stationId: asId<'Station'>(stationId),
    name,
    usage: 'main',
    hasPlatform: true,
    directions: ['down', 'up'],
    canTurnBack: true,
    canBeOvertaken: false,
    maxCars: 10,
    approachSec: 45,
    clearSec: 30,
  };
}

describe('reduce', () => {
  it('station/add inserts tracks and rebuilds the link chain', () => {
    let doc = createEmptyProject();
    doc = apply(
      doc,
      { type: 'station/add', station: station('s-a', 'A', 0), tracks: [track('t-a', 's-a', '1')] },
      { type: 'station/add', station: station('s-c', 'C', 2), tracks: [track('t-c', 's-c', '1')] },
    );
    expect(entityList(doc.links)).toHaveLength(1);
    expect(tracksOfStation(doc, asId<'Station'>('s-a'))).toHaveLength(1);

    doc = apply(doc, {
      type: 'station/add',
      station: station('s-b', 'B', 1),
      tracks: [track('t-b', 's-b', '1')],
    });
    // A—C is replaced by A—B and B—C.
    const links = entityList(doc.links);
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.distance)).toEqual([kmToMeters(1), kmToMeters(1)]);
    expect(orderedStations(doc).map((s) => s.name)).toEqual(['A', 'B', 'C']);
  });

  it('station/remove drops its tracks, its stops and its links', () => {
    const doc = apply(toyProject(), { type: 'station/remove', id: TOY.stationB });
    expect(doc.stations.byId[TOY.stationB]).toBeUndefined();
    expect(doc.stationTracks.byId[TOY.b1]).toBeUndefined();
    for (const train of entityList(doc.trains)) {
      expect(train.stops.some((s) => s.stationId === TOY.stationB)).toBe(false);
    }
    for (const link of entityList(doc.links)) {
      expect(link.fromStationId).not.toBe(TOY.stationB);
      expect(link.toStationId).not.toBe(TOY.stationB);
    }
    // A—C now exists directly.
    expect(
      entityList(doc.links).some(
        (l) => l.fromStationId === TOY.stationA && l.toStationId === TOY.stationC,
      ),
    ).toBe(true);
  });

  it("stopPattern/setEntry with 'none' deletes the entry", () => {
    let doc = apply(toyProject(), {
      type: 'stopPattern/setEntry',
      patternId: TOY.patLocalDown,
      stationId: TOY.stationB,
      kind: 'pass',
    });
    expect(doc.stopPatterns.byId[TOY.patLocalDown]?.entries[TOY.stationB]).toBe('pass');

    doc = apply(doc, {
      type: 'stopPattern/setEntry',
      patternId: TOY.patLocalDown,
      stationId: TOY.stationB,
      kind: 'none',
    });
    expect(TOY.stationB in (doc.stopPatterns.byId[TOY.patLocalDown]?.entries ?? {})).toBe(false);
  });

  it('train/shift moves every arr and dep', () => {
    const before = toyProject().trains.byId[TOY.localDown] as Train;
    const doc = apply(toyProject(), {
      type: 'train/shift',
      trainIds: [TOY.localDown],
      deltaSec: 600,
    });
    const after = doc.trains.byId[TOY.localDown] as Train;
    after.stops.forEach((stop, i) => {
      const source = before.stops[i]!;
      if (source.arr === undefined) expect(stop.arr).toBeUndefined();
      else expect(stop.arr).toBe(source.arr + 600);
      if (source.dep === undefined) expect(stop.dep).toBeUndefined();
      else expect(stop.dep).toBe(source.dep + 600);
    });
  });

  it('train/recomputeTimes derives forward from the origin departure', () => {
    const doc = apply(toyProject(), { type: 'train/recomputeTimes', trainId: TOY.expressDown });
    const train = doc.trains.byId[TOY.expressDown] as Train;
    // A dep 08:03, B and C are passes (base 70, no penalties), D is a stop.
    expect(train.stops[0]?.dep).toBe(8 * 3600 + 3 * 60);
    expect(train.stops[0]?.arr).toBeUndefined();
    expect(train.stops[1]?.arr).toBe(8 * 3600 + 3 * 60 + 80); // 70 + start penalty
    expect(train.stops[2]?.arr).toBe(8 * 3600 + 3 * 60 + 150);
    expect(train.stops[3]?.arr).toBe(8 * 3600 + 3 * 60 + 230); // + stop penalty
    expect(train.stops[3]?.dep).toBeUndefined();
  });

  it('train/autoAssignTracks prefers the default track and honours direction', () => {
    let doc = toyProject();
    // Clear every platform first.
    doc = produce(doc, (draft) => {
      for (const train of entityList(draft.trains)) {
        for (const stop of train.stops) delete stop.trackId;
      }
    });
    doc = apply(doc, { type: 'train/autoAssignTracks' });

    const local = doc.trains.byId[TOY.localDown] as Train;
    // Station A default for `down` is track a1.
    expect(local.stops[0]?.trackId).toBe(TOY.a1);
    // The wait at C is declared as an overtake, so it needs the 待避可 track.
    expect(local.stops[2]?.trackId).toBe(TOY.c2);

    const depotIn = doc.trains.byId[TOY.depotIn] as Train;
    // An `up` train at A can only use a2.
    const stopAtA = depotIn.stops.find((s) => s.stationId === TOY.stationA);
    expect(stopAtA?.trackId).toBe(TOY.a2);
  });

  it('duty/autoAssign chains trains that meet at a station', () => {
    let doc = apply(toyProject(), { type: 'duty/remove', dutyIds: [TOY.dutyLocal, TOY.dutyExpress] });
    expect(entityList(doc.duties)).toHaveLength(0);

    doc = apply(doc, { type: 'duty/autoAssign', dayTypeId: TOY.dayType });
    const duties = entityList(doc.duties);
    expect(duties.length).toBeGreaterThan(0);
    const covered = duties.flatMap((d) => d.legs).filter((l) => l.kind === 'train');
    expect(covered).toHaveLength(4);
    // 出庫 (depot -> A) then the local (A -> D) belong to one duty.
    const chained = duties.find((d) =>
      d.legs.some((l) => l.kind === 'train' && l.trainId === TOY.depotOut),
    );
    expect(chained?.legs.map((l) => (l.kind === 'train' ? l.trainId : ''))).toContain(
      TOY.localDown,
    );
  });

  it('assignment/autoFill covers unassigned duties with free formations', () => {
    let doc = apply(toyProject(), { type: 'assignment/clear', date: '2026-04-06', dutyId: TOY.dutyLocal });
    expect(entityList(doc.assignments)).toHaveLength(1);

    doc = apply(doc, { type: 'assignment/autoFill', date: '2026-04-06' });
    const onDate = entityList(doc.assignments).filter((a) => a.date === '2026-04-06');
    expect(onDate).toHaveLength(2);
    expect(new Set(onDate.map((a) => a.formationId)).size).toBe(2);
  });

  it('track/remove clears every reference to the track', () => {
    const doc = apply(toyProject(), { type: 'track/remove', id: TOY.c2 });
    expect(doc.stationTracks.byId[TOY.c2]).toBeUndefined();
    expect(doc.stations.byId[TOY.stationC]?.trackIds).not.toContain(TOY.c2);
    const local = doc.trains.byId[TOY.localDown] as Train;
    expect(local.stops[2]?.trackId).toBeUndefined();
  });

  it('project/replace swaps every top-level field', () => {
    const doc = apply(createEmptyProject(), {
      type: 'project/replace',
      doc: toyProject(),
      label: 'テスト',
    });
    expect(entityList(doc.stations)).toHaveLength(5);
    expect(doc.meta.name).toBe('テスト線プロジェクト');
  });
});
