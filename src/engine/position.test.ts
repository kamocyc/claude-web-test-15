import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { PerfProfile } from '@/domain/model';
import { asId } from '@/domain/ids';
import { kmToMeters } from '@/domain/units';
import { TOY, toyProject } from '@/testing/toyProject';
import { buildIndex } from './buildIndex';
import { interpolateKm, segmentSpeedKmh, trainRuntimeAt } from './position';
import { NO_DELAY, type TimeOverlay } from './types';

const PROFILE: PerfProfile = {
  id: asId<'PerfProfile'>('prf-test'),
  name: 'テスト性能',
  accelKmhps: 3.0,
  decelKmhps: 3.5,
  maxSpeedKmh: 110,
};

const FLAG_CASES: Array<[boolean, boolean]> = [
  [true, true],
  [true, false],
  [false, true],
  [false, false],
];

describe('interpolateKm', () => {
  it('is exact at both endpoints for every ramp combination', () => {
    for (const [s, e] of FLAG_CASES) {
      expect(interpolateKm(1000, 90, 0, PROFILE, s, e)).toBe(0);
      expect(interpolateKm(1000, 90, 90, PROFILE, s, e)).toBe(1000);
    }
  });

  it('clamps outside the segment', () => {
    expect(interpolateKm(1000, 90, -10, PROFILE, true, true)).toBe(0);
    expect(interpolateKm(1000, 90, 200, PROFILE, true, true)).toBe(1000);
  });

  it('accelerates away from a stand and brakes into one', () => {
    const d = 1000;
    const T = 90;
    // Just after departure the train has barely moved; linear would already
    // be 1/9 of the way there.
    const early = interpolateKm(d, T, 10, PROFILE, true, true);
    expect(early).toBeLessThan((d * 10) / T);
    // Just before arrival it is closing slowly, so it is ahead of linear.
    const late = interpolateKm(d, T, T - 10, PROFILE, true, true);
    expect(late).toBeGreaterThan((d * (T - 10)) / T);
    // Symmetric-ish: the mid point is close to half way.
    expect(interpolateKm(d, T, T / 2, PROFILE, true, true)).toBeGreaterThan(d * 0.4);
    expect(interpolateKm(d, T, T / 2, PROFILE, true, true)).toBeLessThan(d * 0.6);
  });

  it('does not ramp at an end it does not stop at', () => {
    const d = 1000;
    const T = 90;
    // No decel ramp: still at cruise speed as it passes.
    expect(segmentSpeedKmh(d, T, T, PROFILE, true, false)).toBeGreaterThan(0);
    expect(segmentSpeedKmh(d, T, T, PROFILE, true, true)).toBeCloseTo(0, 6);
    // No accel ramp: already at cruise speed on entry.
    expect(segmentSpeedKmh(d, T, 0, PROFILE, false, true)).toBeGreaterThan(0);
    expect(segmentSpeedKmh(d, T, 0, PROFILE, true, true)).toBeCloseTo(0, 6);
  });

  it('has a flat cruise phase in the middle', () => {
    const d = 2000;
    const T = 120;
    const a = segmentSpeedKmh(d, T, T * 0.45, PROFILE, true, true);
    const b = segmentSpeedKmh(d, T, T * 0.55, PROFILE, true, true);
    expect(a).toBeCloseTo(b, 6);
    expect(a).toBeLessThanOrEqual(PROFILE.maxSpeedKmh + 1e-9);
  });

  it('falls back to linear when the booked time is physically impossible', () => {
    // 5 km in 30 s needs 600 km/h.
    const d = 5000;
    const T = 30;
    for (let tau = 0; tau <= T; tau += 5) {
      expect(interpolateKm(d, T, tau, PROFILE, true, true)).toBeCloseTo((d * tau) / T, 6);
    }
  });

  it('is monotonic non-decreasing and stays inside [0, d]', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 8000, noNaN: true }),
        fc.double({ min: 1, max: 900, noNaN: true }),
        fc.boolean(),
        fc.boolean(),
        (d, T, s, e) => {
          let prev = -1;
          const steps = 40;
          for (let i = 0; i <= steps; i++) {
            const tau = (T * i) / steps;
            const x = interpolateKm(d, T, tau, PROFILE, s, e);
            expect(x).toBeGreaterThanOrEqual(0);
            expect(x).toBeLessThanOrEqual(d);
            expect(x).toBeGreaterThanOrEqual(prev - 1e-6);
            prev = x;
          }
          expect(interpolateKm(d, T, 0, PROFILE, s, e)).toBe(0);
          expect(interpolateKm(d, T, T, PROFILE, s, e)).toBe(d);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('trainRuntimeAt', () => {
  const doc = toyProject();
  const idx = buildIndex(doc);
  const local = idx.timelines.get(TOY.localDown)!;
  const express = idx.timelines.get(TOY.expressDown)!;
  const H = 3600;
  const M = 60;

  it('is pending before the origin departure', () => {
    const rt = trainRuntimeAt(local, 8 * H - 1, NO_DELAY, doc);
    expect(rt.phase.phase).toBe('pending');
    expect(rt.km).toBe(0);
    expect(rt.nextStationId).toBe(TOY.stationB);
    expect(rt.destinationStationId).toBe(TOY.stationD);
  });

  it('is finished once the stock has left as the next train', () => {
    // 各101 berths at D 08:10:30 and 回8002 takes the same stock out at 08:20.
    expect(trainRuntimeAt(local, 8 * H + 10 * M + 31, NO_DELAY, doc).phase.phase).toBe(
      'layover',
    );
    expect(trainRuntimeAt(local, 8 * H + 20 * M - 1, NO_DELAY, doc).phase.phase).toBe('layover');
    expect(trainRuntimeAt(local, 8 * H + 20 * M, NO_DELAY, doc).phase.phase).toBe('finished');
  });

  it('holds the terminated train on its arrival road until the successor leaves', () => {
    const rt = trainRuntimeAt(local, 8 * H + 15 * M, NO_DELAY, doc);
    if (rt.phase.phase !== 'layover') throw new Error('unreachable');
    expect(rt.phase.stationId).toBe(TOY.stationD);
    expect(rt.phase.trackId).toBe(TOY.d1);
    expect(rt.phase.since).toBe(8 * H + 10 * M + 30);
    expect(rt.phase.until).toBe(8 * H + 20 * M);
    expect(rt.phase.nextTrainId).toBe(TOY.depotIn);
    expect(rt.km).toBe(kmToMeters(3));
    // Standing still, so nothing to interpolate across.
    expect(rt.phase.shunt).toBeUndefined();
  });

  it('leaves the last train of a duty finished — there is nothing to form', () => {
    const depotIn = idx.timelines.get(TOY.depotIn)!;
    expect(depotIn.layover).toBeUndefined();
    expect(trainRuntimeAt(depotIn, 8 * H + 31 * M, NO_DELAY, doc).phase.phase).toBe('finished');
  });

  it('hands over with no gap and no overlap', () => {
    // Exactly one of the two trains is drawn at every instant across the turn.
    const drawn = (t: number): string[] =>
      [TOY.localDown, TOY.depotIn]
        .map((id) => trainRuntimeAt(idx.timelines.get(id)!, t, NO_DELAY, doc))
        .filter((rt) => rt.phase.phase !== 'pending' && rt.phase.phase !== 'finished')
        .map((rt) => rt.number);
    for (let t = 8 * H + 10 * M; t <= 8 * H + 21 * M; t += 5) {
      expect(drawn(t), `at ${t}`).toHaveLength(1);
    }
  });

  it('walks the stock across when the duty shunts it to another road', () => {
    // Rewrite the D layover so the formation is berthed on 2番線 in between.
    const shunted = toyProject();
    const duty = shunted.duties.byId[TOY.dutyLocal]!;
    duty.legs = duty.legs.map((leg) =>
      leg.kind === 'stable' ? { ...leg, trackId: TOY.d2 } : leg,
    );
    const tl = buildIndex(shunted).timelines.get(TOY.localDown)!;
    expect(tl.layover?.berths.map((b) => b.trackId)).toEqual([TOY.d1, TOY.d2, TOY.d1]);

    const at = (t: number) => trainRuntimeAt(tl, t, NO_DELAY, shunted).phase;
    const start = at(8 * H + 10 * M + 31);
    if (start.phase !== 'layover') throw new Error('unreachable');
    expect(start.trackId).toBe(TOY.d2);
    expect(start.fromTrackId).toBe(TOY.d1);
    expect(start.shunt).toBeGreaterThan(0);
    expect(start.shunt).toBeLessThan(1);

    // A minute and a half later the move is over and it is simply standing.
    const settled = at(8 * H + 13 * M);
    if (settled.phase !== 'layover') throw new Error('unreachable');
    expect(settled.trackId).toBe(TOY.d2);
    expect(settled.shunt).toBeUndefined();

    // …and it is back on the departure road before 回8002 leaves.
    const before = at(8 * H + 20 * M - 1);
    if (before.phase !== 'layover') throw new Error('unreachable');
    expect(before.trackId).toBe(TOY.d1);
  });

  it('dwells exactly at the booked arrival, not runs', () => {
    const rt = trainRuntimeAt(local, 8 * H + 4 * M, NO_DELAY, doc);
    expect(rt.phase.phase).toBe('dwelling');
    if (rt.phase.phase !== 'dwelling') throw new Error('unreachable');
    expect(rt.phase.stationId).toBe(TOY.stationC);
    expect(rt.phase.since).toBe(8 * H + 4 * M);
    expect(rt.phase.until).toBe(8 * H + 8 * M + 30);
    expect(rt.phase.reason).toBe('overtakeWait');
  });

  it('still dwells exactly at the booked departure', () => {
    const rt = trainRuntimeAt(local, 8 * H + 8 * M + 30, NO_DELAY, doc);
    expect(rt.phase.phase).toBe('dwelling');
  });

  it('is running one second after the departure', () => {
    const rt = trainRuntimeAt(local, 8 * H + 8 * M + 31, NO_DELAY, doc);
    expect(rt.phase.phase).toBe('running');
    if (rt.phase.phase !== 'running') throw new Error('unreachable');
    expect(rt.phase.fromStationId).toBe(TOY.stationC);
    expect(rt.phase.toStationId).toBe(TOY.stationD);
    expect(rt.phase.km).toBeGreaterThan(2000);
    expect(rt.phase.km).toBeLessThan(2050);
    expect(rt.phase.progress).toBeGreaterThan(0);
    expect(rt.phase.speedKmh).toBeGreaterThan(0);
  });

  it('reports the depot dwell reason at a depot station', () => {
    const depotOut = idx.timelines.get(TOY.depotOut)!;
    const rt = trainRuntimeAt(depotOut, 7 * H + 50 * M, NO_DELAY, doc);
    expect(rt.phase.phase).toBe('dwelling');
    if (rt.phase.phase !== 'dwelling') throw new Error('unreachable');
    expect(rt.phase.reason).toBe('depot');
  });

  it('reports 通過 within the pass window', () => {
    // The express now CALLS at C, so B is the pass event to look at.
    const rt = trainRuntimeAt(express, 8 * H + 4 * M + 23, NO_DELAY, doc);
    expect(rt.phase.phase).toBe('passing');
    if (rt.phase.phase !== 'passing') throw new Error('unreachable');
    expect(rt.phase.stationId).toBe(TOY.stationB);
    // …and it names the leg it is on, so the view places it exactly as it
    // places a running train.
    expect(rt.phase.fromStationId).toBe(TOY.stationB);
    expect(rt.phase.toStationId).toBe(TOY.stationC);
  });

  it('keeps moving through a 通過 instead of snapping onto the station', () => {
    // 通過 is a label on a leg. Reporting the station's km for the six seconds
    // either side of it made the marker jump forward, stand still and jump
    // again — twelve seconds of a train visibly not obeying its own timetable.
    const passAt = 8 * H + 4 * M + 20;
    let prev = -Infinity;
    for (let t = passAt - 12; t <= passAt + 12; t += 1) {
      const rt = trainRuntimeAt(express, t, NO_DELAY, doc);
      expect(rt.km, `at ${t}`).toBeGreaterThan(prev);
      prev = rt.km;
    }
    // It is genuinely somewhere else five seconds before and after.
    expect(trainRuntimeAt(express, passAt - 5, NO_DELAY, doc).km).toBeLessThan(
      kmToMeters(1) - 20,
    );
    expect(trainRuntimeAt(express, passAt + 5, NO_DELAY, doc).km).toBeGreaterThan(
      kmToMeters(1) + 20,
    );
  });

  it('names the roads a running leg leaves from and arrives at', () => {
    const rt = trainRuntimeAt(local, 8 * H + 60, NO_DELAY, doc);
    if (rt.phase.phase !== 'running') throw new Error('unreachable');
    expect(rt.phase.fromTrackId).toBe(TOY.a1);
    expect(rt.phase.toTrackId).toBe(TOY.b1);
  });

  it('carries the formation through from the assignment', () => {
    const rt = trainRuntimeAt(local, 8 * H + 5 * M, NO_DELAY, doc);
    expect(rt.dutyId).toBe(TOY.dutyLocal);
    expect(rt.formationId).toBe(TOY.formation1);
    expect(rt.formationCode).toBe('T01F');
    expect(rt.cars).toBe(6);
  });

  it('shifts every event by a delay overlay', () => {
    const overlay: TimeOverlay = { delaySec: () => 120, isEmpty: false };
    // 08:05 is a minute after the booked arrival at C; two minutes late the
    // train is still out on the line.
    expect(trainRuntimeAt(local, 8 * H + 5 * M, NO_DELAY, doc).phase.phase).toBe('dwelling');
    const rt = trainRuntimeAt(local, 8 * H + 5 * M, overlay, doc);
    expect(rt.phase.phase).toBe('running');
    expect(rt.delaySec).toBe(120);
    // …and it reaches C exactly two minutes late.
    expect(trainRuntimeAt(local, 8 * H + 6 * M, overlay, doc).phase.phase).toBe('dwelling');
  });

  it('degrades gracefully without a document', () => {
    const rt = trainRuntimeAt(local, 8 * H + 5 * M);
    expect(rt.phase.phase).toBe('dwelling');
    expect(rt.formationCode).toBeUndefined();
  });
});
