import { describe, expect, it } from 'vitest';

import { asId } from '@/domain/ids';
import { TOY, toyProject, toyProjectCopy } from '@/testing/toyProject';
import { buildIndex, dayTypeIdFor } from './buildIndex';

const H = 3600;
const M = 60;

describe('dayTypeIdFor', () => {
  it('resolves the day type from the calendar', () => {
    expect(dayTypeIdFor(toyProject(), '2026-04-06')).toBe(TOY.dayType);
  });

  it('falls back to the active day type for an uncalendared date', () => {
    expect(dayTypeIdFor(toyProject(), '2030-01-01')).toBe(TOY.dayType);
  });
});

describe('buildIndex', () => {
  const doc = toyProject();
  const idx = buildIndex(doc);

  it('builds one timeline per train active on the date', () => {
    expect(idx.timelines.size).toBe(4);
    expect([...idx.timelines.keys()].sort()).toEqual(
      [TOY.localDown, TOY.expressDown, TOY.depotOut, TOY.depotIn].sort(),
    );
  });

  it('skips trains that do not run on the resolved day type', () => {
    const other = toyProjectCopy();
    other.trains.byId[TOY.expressDown]!.dayTypeIds = [asId<'DayType'>('day-9')];
    expect(buildIndex(other).timelines.has(TOY.expressDown)).toBe(false);
  });

  it('attaches km, profile, label and distance', () => {
    const local = idx.timelines.get(TOY.localDown)!;
    expect(local.events.map((e) => e.km)).toEqual([0, 1000, 2000, 3000]);
    expect(local.profile.id).toBe(TOY.profile);
    expect(local.label).toBe('各 101');
    expect(local.distance).toBe(3000);
    expect(local.startSec).toBe(8 * H);
    expect(local.endSec).toBe(8 * H + 10 * M + 30);
  });

  it('sets TrainEvent.at to arr ?? dep and keeps events sorted', () => {
    const local = idx.timelines.get(TOY.localDown)!;
    expect(local.events[0]!.at).toBe(8 * H); // origin: dep
    expect(local.events[0]!.arr).toBeUndefined();
    expect(local.events[3]!.at).toBe(8 * H + 10 * M + 30); // terminus: arr
    const ats = local.events.map((e) => e.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
  });

  it('attaches the duty and the formation assigned on the date', () => {
    const local = idx.timelines.get(TOY.localDown)!;
    expect(local.dutyId).toBe(TOY.dutyLocal);
    expect(local.formationId).toBe(TOY.formation1);
    expect(idx.dutyOfTrain.get(TOY.expressDown)).toBe(TOY.dutyExpress);
    expect(idx.formationOfTrain.get(TOY.expressDown)).toBe(TOY.formation2);
  });

  it('orders trains by (startSec, trainId)', () => {
    expect(idx.orderedTrainIds).toEqual([
      TOY.depotOut,
      TOY.localDown,
      TOY.expressDown,
      TOY.depotIn,
    ]);
  });

  it('buckets active trains by minute from the service day start', () => {
    expect(idx.bucketStartSec).toBe(doc.settings.serviceDayStartSec);
    const bucketOf = (t: number): number => Math.floor((t - idx.bucketStartSec) / 60);
    // 08:05 — the local is standing at C, the express is en route.
    const at0805 = idx.activeByMinute[bucketOf(8 * H + 5 * M)]!;
    expect(at0805).toContain(TOY.localDown);
    expect(at0805).toContain(TOY.expressDown);
    expect(at0805).not.toContain(TOY.depotIn);
    // 07:00 — nothing is out yet.
    expect(idx.activeByMinute[bucketOf(7 * H)]).toEqual([]);
    // A train appears in every bucket it overlaps.
    for (let t = 8 * H; t <= 8 * H + 10 * M; t += 60) {
      expect(idx.activeByMinute[bucketOf(t)]).toContain(TOY.localDown);
    }
  });

  it('indexes link run times by link and profile', () => {
    expect(idx.runTimeOf(TOY.linkAB, TOY.profile)?.baseRunSec).toBe(70);
    expect(idx.runTimeOf(TOY.linkDepot, TOY.profile)?.baseRunSec).toBe(60);
    expect(idx.runTimeOf(TOY.linkAB, asId<'PerfProfile'>('prf-9'))).toBeUndefined();
  });

  it('marks the overtake wait on the waiting train event', () => {
    const local = idx.timelines.get(TOY.localDown)!;
    const atC = local.events.find((e) => e.stationId === TOY.stationC)!;
    expect(atC.isOvertakeWait).toBe(true);
    expect(local.events.filter((e) => e.isOvertakeWait)).toHaveLength(1);
  });

  it('stores occupancy intervals with approach and clear margins', () => {
    const c2 = idx.trackIntervals.get(TOY.c2)!;
    expect(c2).toHaveLength(1);
    expect(c2[0]).toMatchObject({
      trainId: TOY.localDown,
      bookedFrom: 8 * H + 4 * M,
      bookedTo: 8 * H + 8 * M + 30,
      from: 8 * H + 4 * M - 45,
      to: 8 * H + 8 * M + 60,
    });
    // The origin has no arrival: its departure stands in for both ends.
    const x1 = idx.trackIntervals.get(TOY.x1)!;
    const out = x1.find((i) => i.trainId === TOY.depotOut)!;
    expect(out.bookedFrom).toBe(7 * H + 50 * M);
    expect(out.bookedTo).toBe(7 * H + 50 * M);
  });

  it('sorts each track list by start time', () => {
    for (const list of idx.trackIntervals.values()) {
      const froms = list.map((i) => i.from);
      expect([...froms].sort((a, b) => a - b)).toEqual(froms);
    }
  });

  it('stores the detected overtakes and connections', () => {
    expect(idx.overtakes).toHaveLength(1);
    expect(idx.connections).toHaveLength(1);
  });
});
