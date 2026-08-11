/**
 * Facts tests: the researched structure, asserted directly on the data.
 *
 * These are deliberately independent of the timetable generator and of the
 * validator. If someone edits the station table or a track flag, this file is
 * what tells them which researched constraint they just broke.
 */

import { describe, expect, it } from 'vitest';
import { metersToKm } from '@/domain/units';
import {
  buildFacts,
  EXPRESS_STOP_KEYS,
  NO_OIMACHI_PLATFORM_KEYS,
  OVERTAKE_STATIONS,
  PENALTY,
  type Facts,
  type StationKey,
} from './facts';
import { routeOf, timeRoute } from '../generator/stopTimes';

const facts = buildFacts();

function station(f: Facts, key: StationKey) {
  return f.stationById.get(f.S[key])!;
}

describe('東急大井町線 — 線路とホーム', () => {
  it('has the 16 numbered stations plus 二子新地・高津, 3 田園都市線 stations and 2 depot nodes', () => {
    expect(facts.stations).toHaveLength(23);
    expect(facts.stations.filter((s) => s.kind === 'depot')).toHaveLength(2);
  });

  it('runs 大井町 0.0 km to 溝の口 12.4 km, strictly increasing throughout', () => {
    expect(metersToKm(station(facts, 'oimachi').kmFromOrigin)).toBe(0);
    expect(metersToKm(station(facts, 'mizonokuchi').kmFromOrigin)).toBe(12.4);
    const axis = facts.axis.map((k) => station(facts, k).kmFromOrigin);
    for (let i = 1; i < axis.length; i++) expect(axis[i]!).toBeGreaterThan(axis[i - 1]!);
  });

  it('makes 大井町 a two-track stub terminal with no tail track', () => {
    const oimachi = station(facts, 'oimachi');
    expect(oimachi.trackIds).toHaveLength(2);
    const tracks = facts.tracksOf.get(oimachi.id)!;
    expect(tracks.every((t) => t.canTurnBack)).toBe(true);
    expect(tracks.some((t) => t.usage === 'stabling')).toBe(false);
  });

  it('allows 待避 at 旗の台 (both ways) and 上野毛 (up only), and NOWHERE else', () => {
    const byStation = new Map<string, string[]>();
    for (const track of facts.tracks) {
      if (!track.canBeOvertaken) continue;
      const key = facts.keyOf.get(track.stationId)!;
      byStation.set(key, [...(byStation.get(key) ?? []), track.name]);
    }
    expect([...byStation.keys()].sort()).toEqual(['hatanodai', 'kaminoge']);
    expect(byStation.get('hatanodai')).toHaveLength(2); // 3番線・6番線
    expect(byStation.get('kaminoge')).toHaveLength(1); // 上り側のみ

    const kaminogeWait = facts
      .tracksOf.get(facts.S.kaminoge)!
      .filter((t) => t.canBeOvertaken);
    expect(kaminogeWait.every((t) => t.directions.join() === 'up')).toBe(true);

    // ...and the declared table agrees with the track flags.
    expect(Object.keys(OVERTAKE_STATIONS).sort()).toEqual(['hatanodai', 'kaminoge']);
  });

  it('gives 大岡山 and 自由が丘 two platform faces — the others belong to other lines', () => {
    expect(station(facts, 'ookayama').trackIds).toHaveLength(2);
    const jiyugaoka = facts.tracksOf.get(facts.S.jiyugaoka)!;
    expect(jiyugaoka.filter((t) => t.hasPlatform)).toHaveLength(2);
  });

  it('hangs the 自由が丘 引上線 off the 溝の口 end, beyond the up platform', () => {
    const tracks = facts.tracksOf.get(facts.S.jiyugaoka)!;
    const tail = tracks.find((t) => t.usage === 'stabling')!;
    expect(tail.name).toBe('引上線');
    expect(tail.canTurnBack).toBe(true);
    // The end is authored, not derived: 自由が丘 is in the 大井町 half of the
    // line, so the km heuristic would put the stub on the other side.
    expect(tail.wiring?.ends).toEqual(['down']);
    const up = tracks.find((t) => t.name === '2番線')!;
    expect(tail.wiring?.ladder).toBeGreaterThan(tracks.indexOf(up));
  });

  it('marks only 旗の台 and 上野毛 as 緩急接続 points', () => {
    const points = facts.stations.filter((s) => s.isConnectionPoint).map((s) => s.name);
    expect(points).toEqual(['旗の台', '上野毛']);
  });

  it('gives 二子新地 and 高津 no 大井町線 platform but a 田園都市線 one', () => {
    for (const key of NO_OIMACHI_PLATFORM_KEYS) {
      const tracks = facts.tracksOf.get(facts.S[key])!;
      const om = tracks.filter((t) => facts.trackRole.get(t.id) === 'om');
      const dt = tracks.filter((t) => facts.trackRole.get(t.id) === 'dt');
      expect(om).toHaveLength(2);
      expect(om.every((t) => !t.hasPlatform)).toBe(true);
      expect(dt).toHaveLength(2);
      expect(dt.every((t) => t.hasPlatform)).toBe(true);
    }
  });

  it('gives 溝の口 four platform roads plus two 引上線', () => {
    const tracks = facts.tracksOf.get(facts.S.mizonokuchi)!;
    expect(tracks.filter((t) => t.hasPlatform)).toHaveLength(4);
    const stabling = tracks.filter((t) => t.usage === 'stabling');
    expect(stabling).toHaveLength(2);
    expect(stabling.every((t) => t.canTurnBack)).toBe(true);
  });

  it('has one link per adjacent pair, and every link has both run-time rows', () => {
    // 20 chain links + 2 depot stubs.
    expect(facts.links).toHaveLength(22);
    for (const link of facts.links) {
      expect(link.distance).toBeGreaterThan(0);
      for (const profileId of [facts.profile.car7, facts.profile.car5]) {
        const rt = facts.runTime(link.fromStationId, link.toStationId, profileId);
        expect(rt.baseRunSec).toBeGreaterThan(0);
        // Everything must land on the 5-second grain so no time needs rounding.
        expect(rt.baseRunSec % 5).toBe(0);
        expect(rt.startPenaltySec % 5).toBe(0);
        expect(rt.stopPenaltySec % 5).toBe(0);
      }
    }
    expect(PENALTY.car7.startPenaltySec).toBeGreaterThanOrEqual(8);
    expect(PENALTY.car5.stopPenaltySec).toBeLessThanOrEqual(12);
  });
});

describe('種別と停車パターン', () => {
  it('stops 急行 at exactly 大井町・旗の台・大岡山・自由が丘・二子玉川・溝の口', () => {
    const pattern = facts.stopPatterns.find((p) => p.id === facts.pattern.expressDown)!;
    const stops = Object.entries(pattern.entries)
      .filter(([, kind]) => kind === 'stop')
      .map(([id]) => facts.keyOf.get(id as never));
    expect(stops.sort()).toEqual([...EXPRESS_STOP_KEYS].sort());
  });

  it('makes 緑各停 pass 二子新地・高津 where 青各停 stops', () => {
    const green = facts.stopPatterns.find((p) => p.id === facts.pattern.greenDown)!;
    const blue = facts.stopPatterns.find((p) => p.id === facts.pattern.blueDown)!;
    for (const key of NO_OIMACHI_PLATFORM_KEYS) {
      expect(green.entries[facts.S[key]]).toBe('pass');
      expect(blue.entries[facts.S[key]]).toBe('stop');
    }
    // ...and are otherwise identical.
    for (const id of Object.keys(green.entries)) {
      const key = facts.keyOf.get(id as never)!;
      if (NO_OIMACHI_PLATFORM_KEYS.includes(key)) continue;
      expect(blue.entries[id]).toBe(green.entries[id]);
    }
  });

  it('has a 回送 type that is not a passenger service', () => {
    const deadhead = facts.trainTypes.find((t) => t.id === facts.type.deadhead)!;
    expect(deadhead.isPassengerService).toBe(false);
  });
});

describe('所要時分のサニティターゲット', () => {
  const clearRun = (patternKey: 'expressDown' | 'greenDown' | 'blueDown'): number => {
    const pattern = facts.stopPatterns.find((p) => p.id === facts.pattern[patternKey])!;
    const route = routeOf(facts, pattern);
    const profileId =
      patternKey === 'expressDown' ? facts.profile.car7 : facts.profile.car5;
    const timed = timeRoute(facts, route, profileId, 0);
    return timed.arr[route.length - 1]!;
  };

  it('runs 急行 大井町→溝の口 in 18–20 minutes', () => {
    const sec = clearRun('expressDown');
    expect(sec).toBeGreaterThanOrEqual(18 * 60);
    expect(sec).toBeLessThanOrEqual(20 * 60);
  });

  it('runs 各停 大井町→溝の口 in 24–27 minutes, 青 slower than 緑', () => {
    const green = clearRun('greenDown');
    const blue = clearRun('blueDown');
    expect(green).toBeGreaterThanOrEqual(24 * 60);
    expect(blue).toBeLessThanOrEqual(27 * 60);
    expect(blue).toBeGreaterThan(green);
  });

  it('is deterministic: two builds produce identical facts', () => {
    expect(JSON.stringify(buildFacts().stations)).toBe(JSON.stringify(buildFacts().stations));
    expect(JSON.stringify(buildFacts().linkRunTimes)).toBe(
      JSON.stringify(buildFacts().linkRunTimes),
    );
  });
});
