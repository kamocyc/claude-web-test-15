import { describe, expect, it } from 'vitest';

import { isSingleTrackLine } from '@/domain/project';
import { buildKodomonokuniFacts, CARS, LINE_KEYS, PASSING_STATIONS } from './facts';

const facts = buildKodomonokuniFacts();

const station = (key: keyof typeof facts.S) => facts.stationById.get(facts.S[key])!;
const tracks = (key: keyof typeof facts.S) => facts.tracksOf.get(facts.S[key]) ?? [];

describe('こどもの国線 — infrastructure', () => {
  it('is three passenger stations in km order, plus two depot nodes', () => {
    expect(LINE_KEYS).toEqual(['nagatsuta', 'onda', 'kodomonokuni']);
    expect(facts.axisStations.map((s) => s.name)).toEqual(['長津田', '恩田', 'こどもの国']);
    let last = Number.NEGATIVE_INFINITY;
    for (const s of facts.axisStations) {
      expect(s.kmFromOrigin).toBeGreaterThan(last);
      last = s.kmFromOrigin;
    }
    expect(facts.depots.map((d) => d.name)).toEqual(['長津田検車区', '長津田工場']);
  });

  it('is single track everywhere — that is the point of the line', () => {
    expect(facts.links.every((l) => l.trackCount === 1)).toBe(true);
    for (let i = 1; i < facts.axisStations.length; i++) {
      const a = facts.axisStations[i - 1]!;
      const b = facts.axisStations[i]!;
      expect(facts.isSingleTrack(a.id, b.id)).toBe(true);
      // Symmetric: a section has no direction.
      expect(facts.isSingleTrack(b.id, a.id)).toBe(true);
    }
  });

  it('has exactly one passing place, and it is 恩田', () => {
    expect(Object.keys(PASSING_STATIONS)).toEqual(['onda']);
    expect(tracks('onda')).toHaveLength(2);
    expect(tracks('nagatsuta')).toHaveLength(1);
    expect(tracks('kodomonokuni')).toHaveLength(1);

    const [through, loop] = tracks('onda');
    expect(through!.canBeOvertaken).toBe(false);
    expect(loop!.canBeOvertaken).toBe(true);
    // Both roads are signalled both ways: on a single line there is no such
    // thing as a down platform.
    for (const t of tracks('onda')) expect(t.directions).toEqual(['down', 'up']);
    // Both take passengers — a meet between two service trains must not push
    // one of them onto a road with no platform.
    for (const t of tracks('onda')) expect(t.hasPlatform).toBe(true);
    // Only the through road has the running line going straight into it, which
    // is what makes the line view draw a 交換 as a dip and not a lane swap.
    expect(through!.wiring?.line).toEqual(['down', 'up']);
    expect(loop!.wiring?.line).toBeUndefined();
  });

  it('defaults both directions to the through road at 恩田', () => {
    // 「ラッシュ時のみ交換」 has to come out of the timetable. If the up
    // direction defaulted to the loop, every up train would use it all day and
    // the peak would look no different from the middle of the afternoon.
    const onda = station('onda');
    const through = tracks('onda')[0]!;
    expect(onda.defaultTrackId.down).toBe(through.id);
    expect(onda.defaultTrackId.up).toBe(through.id);
  });

  it('lets both terminals reverse, and only こどもの国 is against the buffers', () => {
    expect(tracks('nagatsuta')[0]!.canTurnBack).toBe(true);
    expect(tracks('kodomonokuni')[0]!.canTurnBack).toBe(true);
    // 長津田 is open at both ends: the yard is beyond it at negative km, and
    // that throat is how a 出庫 gets in.
    expect(tracks('nagatsuta')[0]!.wiring?.ends).toEqual(['down', 'up']);
    expect(tracks('kodomonokuni')[0]!.wiring?.ends).toEqual(['up']);
  });

  it('hangs the yard off the 下り方 throat — the mirror of 鷺沼車庫', () => {
    // The yard is behind the origin, so its lead faces the higher-km end. The
    // km heuristic guesses the other one, which is why the end is authored.
    for (const t of tracks('nagatsutaDepot')) {
      expect(t.wiring?.ends).toEqual(['down']);
    }
    expect(station('nagatsutaDepot').crossovers?.every((c) => c.end === 'down')).toBe(true);
    expect(facts.depots[0]!.stubOffsetMeters).toBeLessThan(0);
  });

  it('puts the depot at the front of the deadhead chain, not the back', () => {
    expect(facts.deadheadAxis.map((s) => s.name)).toEqual([
      '長津田検車区',
      '長津田',
      '恩田',
      'こどもの国',
    ]);
  });

  it('splits the examinations between the shed and the works', () => {
    expect(facts.depots[0]!.inspectionKinds).toEqual(['train', 'monthly']);
    expect(facts.depots[1]!.inspectionKinds).toEqual(['bogie', 'general']);
  });

  it('runs ワンマン — no train type asks for a conductor', () => {
    for (const t of facts.trainTypes) expect(t.crewRoles).toBeUndefined();
  });

  it('gives a clear run of 300 s each way', () => {
    // The round numbers are load-bearing: see the header of service.ts.
    const [nagatsuta, onda, kodomonokuni] = facts.axisStations;
    const hop = (a: string, b: string): number => {
      const rt = facts.runTime(a as never, b as never, facts.profileId);
      return rt.baseRunSec + rt.startPenaltySec + rt.stopPenaltySec;
    };
    expect(hop(nagatsuta!.id, onda!.id)).toBe(150);
    expect(hop(onda!.id, kodomonokuni!.id)).toBe(130);
    expect(150 + onda!.minDwellSec + 130).toBe(300);
  });

  it('carries two-car sets', () => {
    expect(CARS).toBe(2);
    expect(facts.formationSeries[0]!.allowedCarCounts).toEqual([2]);
  });

  it('demands a deadhead headway at least the line minimum', () => {
    const min = Math.min(...facts.links.map((l) => l.minHeadwaySec));
    expect(facts.deadheadHeadwaySec).toBeGreaterThanOrEqual(min);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(buildKodomonokuniFacts().stations)).toBe(
      JSON.stringify(buildKodomonokuniFacts().stations),
    );
  });

  it('reads as a single-track line to the drawing code', () => {
    // `isSingleTrackLine` discounts the depot stubs, so this is really asking
    // about 長津田〜恩田〜こどもの国.
    expect(
      isSingleTrackLine({
        links: { byId: Object.fromEntries(facts.links.map((l) => [l.id, l])), allIds: facts.links.map((l) => l.id) },
        stations: {
          byId: Object.fromEntries(facts.stations.map((s) => [s.id, s])),
          allIds: facts.stations.map((s) => s.id),
        },
      } as never),
    ).toBe(true);
  });
});
