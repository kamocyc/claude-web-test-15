import { describe, expect, it } from 'vitest';

import { TOY, toyProject, toyProjectCopy } from '@/testing/toyProject';
import { buildIndex } from './buildIndex';
import { buildTrackIntervals } from './occupancy';

const H = 3600;
const M = 60;

function intervals(doc = toyProject()): ReturnType<typeof buildTrackIntervals> {
  return buildTrackIntervals(doc, buildIndex(doc).timelines);
}

describe('buildTrackIntervals', () => {
  it('wraps the booked window in the track approach and clear margins', () => {
    const b1 = intervals().get(TOY.b1)!;
    const local = b1.find((i) => i.trainId === TOY.localDown)!;
    expect(local).toMatchObject({
      stationId: TOY.stationB,
      bookedFrom: 8 * H + 90,
      bookedTo: 8 * H + 120,
      from: 8 * H + 90 - 45,
      to: 8 * H + 120 + 30,
    });
  });

  it('uses the departure at the origin and the arrival at the terminus', () => {
    const map = intervals();
    const originOnly = map.get(TOY.x1)!.find((i) => i.trainId === TOY.depotOut)!;
    expect(originOnly.bookedFrom).toBe(originOnly.bookedTo);
    const terminusOnly = map.get(TOY.d1)!.find((i) => i.trainId === TOY.localDown)!;
    expect(terminusOnly.bookedFrom).toBe(8 * H + 10 * M + 30);
    // The stabling leg names D1, so the arrival road is released at once.
    expect(terminusOnly.bookedTo).toBe(8 * H + 10 * M + 30);
  });

  it('lists every known track, even the empty ones', () => {
    const map = intervals();
    expect(map.has(TOY.c3)).toBe(true);
    expect(map.get(TOY.a2)?.map((i) => i.trainId)).toEqual([TOY.depotIn]);
  });

  it('sorts each track by start time', () => {
    for (const list of intervals().values()) {
      const froms = list.map((i) => i.from);
      expect([...froms].sort((a, b) => a - b)).toEqual(froms);
    }
  });

  it('holds the road until the next train of the duty leaves on a turnback', () => {
    const doc = toyProjectCopy();
    // No `operation: 'turnback'` flag anywhere: the hold is derived from the
    // duty, so a document that never sets the flag still books the road.
    // Drop the stabling leg so the 入庫 is the next train leg of duty 01.
    doc.duties.byId[TOY.dutyLocal]!.legs.splice(2, 1);
    const list = intervals(doc).get(TOY.d1)!;
    const held = list.find((i) => i.trainId === TOY.localDown)!;
    expect(held.bookedTo).toBe(8 * H + 20 * M); // 回8002 departure
    expect(held.to).toBe(8 * H + 20 * M + 30);
  });

  it('books a stabling leg on the road it names, not on the arrival road', () => {
    const list = intervals().get(TOY.d1)!;
    // 101 arrives 08:10:30 and the berth runs to the 入庫 at 08:20.
    const arrival = list.find(
      (i) => i.trainId === TOY.localDown && i.bookedFrom === 8 * H + 10 * M + 30,
    )!;
    expect(arrival.bookedTo).toBe(8 * H + 10 * M + 30);
    const stabled = list.find((i) => i.bookedTo === 8 * H + 20 * M)!;
    expect(stabled.trainId).toBe(TOY.localDown);
    expect(stabled.bookedFrom).toBe(8 * H + 10 * M + 30);
  });

  it('holds the arrival road when a stabling leg names no berth', () => {
    const doc = toyProjectCopy();
    const leg = doc.duties.byId[TOY.dutyLocal]!.legs[2]!;
    if (leg.kind === 'stable') delete leg.trackId;
    const list = intervals(doc).get(TOY.d1)!;
    const held = list.find((i) => i.trainId === TOY.localDown)!;
    expect(held.bookedTo).toBe(8 * H + 20 * M);
  });

  it('skips stops with no road assigned', () => {
    const doc = toyProjectCopy();
    delete doc.trains.byId[TOY.localDown]!.stops[1]!.trackId;
    expect(intervals(doc).get(TOY.b1)?.map((i) => i.trainId)).not.toContain(TOY.localDown);
  });
});
