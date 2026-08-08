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
    expect(terminusOnly.bookedFrom).toBe(8 * H + 10 * M);
    expect(terminusOnly.bookedTo).toBe(8 * H + 10 * M);
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
    const local = doc.trains.byId[TOY.localDown]!;
    local.stops[3]!.operation = 'turnback';
    // Drop the stabling leg so the 入庫 is the next train leg of duty 01.
    doc.duties.byId[TOY.dutyLocal]!.legs.splice(2, 1);
    const list = intervals(doc).get(TOY.d1)!;
    const held = list.find((i) => i.trainId === TOY.localDown)!;
    expect(held.bookedTo).toBe(8 * H + 20 * M); // 回8002 departure
    expect(held.to).toBe(8 * H + 20 * M + 30);
  });

  it('does not extend a terminus that is not marked as a turnback', () => {
    const list = intervals().get(TOY.d1)!;
    const plain = list.find((i) => i.trainId === TOY.localDown)!;
    expect(plain.bookedTo).toBe(8 * H + 10 * M);
  });

  it('skips stops with no road assigned', () => {
    const doc = toyProjectCopy();
    delete doc.trains.byId[TOY.localDown]!.stops[1]!.trackId;
    expect(intervals(doc).get(TOY.b1)?.map((i) => i.trainId)).not.toContain(TOY.localDown);
  });
});
