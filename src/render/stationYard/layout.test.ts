import { describe, expect, it } from 'vitest';
import type { OccupancyInterval } from '@/engine/types';
import { TOY } from '@/testing/toyProject';
import { sampleIndex, sampleSceneWithYardConflict } from '../__fixtures__/sampleScene';
import { computeYardLayout, laneAtY } from './layout';

const H = 3600;
const M = 60;

describe('computeYardLayout', () => {
  const index = sampleIndex();
  const layout = computeYardLayout(index.doc, index, TOY.stationC);

  it('creates one lane per 番線, in authored order', () => {
    expect(layout.lanes.map((l) => l.name)).toEqual(['1番線', '2番線', '3番線']);
    expect(layout.lanes.map((l) => l.trackId)).toEqual([TOY.c1, TOY.c2, TOY.c3]);
  });

  it('flags the 待避線', () => {
    expect(layout.lanes.map((l) => l.canBeOvertaken)).toEqual([false, true, false]);
  });

  it('places the 各停 bar on the 待避線 with its 4.5-minute dwell', () => {
    const bar = layout.bars.find((b) => b.trainId === TOY.localDown);
    expect(bar).toBeDefined();
    expect(bar!.trackId).toBe(TOY.c2);
    expect(bar!.bookedFrom).toBe(8 * H + 4 * M);
    expect(bar!.bookedTo).toBe(8 * H + 8 * M + 30);
    expect(bar!.overtakeWait).toBe(true);
  });

  it('widens the bar by the approach and clear margins', () => {
    const bar = layout.bars.find((b) => b.trainId === TOY.localDown)!;
    // C 2番線 uses the default 45 s approach / 30 s clear.
    expect(bar.bookedFrom - bar.from).toBe(45);
    expect(bar.to - bar.bookedTo).toBe(30);
  });

  it('resolves the stop index so a reassignment can name the right stop', () => {
    const bar = layout.bars.find((b) => b.trainId === TOY.localDown)!;
    expect(bar.stopIndex).toBe(2); // A, B, C
  });

  it('finds no conflict in the valid toy timetable', () => {
    expect(layout.conflictCount).toBe(0);
    expect(layout.bars.every((b) => !b.conflict)).toBe(true);
  });

  it('pads the time window around the bars', () => {
    const earliest = Math.min(...layout.bars.map((b) => b.from));
    expect(layout.from).toBe(earliest - 300);
  });

  it('returns an empty but valid layout for a station with no traffic', () => {
    const empty = computeYardLayout(index.doc, index, TOY.stationDepot);
    expect(empty.lanes).toHaveLength(1);
    expect(empty.from).toBeLessThan(empty.to);
  });
});

describe('conflict detection', () => {
  it('marks both sides of an overlap', () => {
    const scene = sampleSceneWithYardConflict();
    const layout = computeYardLayout(scene.doc, scene.index, TOY.stationC);
    const conflicting = layout.bars.filter((b) => b.conflict);
    expect(layout.conflictCount).toBeGreaterThan(0);
    expect(conflicting.length).toBeGreaterThanOrEqual(2);
    // Both are on the same lane.
    expect(new Set(conflicting.map((b) => b.laneIndex)).size).toBe(1);
  });

  it('never flags two bars of the same duty — one formation cannot foul itself', () => {
    // A turnback always produces two overlapping bars on one road: the arrival
    // held until the hand-over, and the departure's own booking opening an
    // approach margin earlier. Counting those as conflicts painted every
    // terminal solid red while the validator correctly reported none, so the
    // chart applies the same duty-identity exclusion as track.doubleOccupancy.
    const index = sampleIndex();
    const doc = index.doc;
    const overlapping: OccupancyInterval[] = [
      {
        trackId: TOY.c1,
        stationId: TOY.stationC,
        trainId: TOY.localDown,
        from: 8 * 3600,
        to: 8 * 3600 + 600,
        bookedFrom: 8 * 3600 + 45,
        bookedTo: 8 * 3600 + 570,
      },
      {
        trackId: TOY.c1,
        stationId: TOY.stationC,
        trainId: TOY.depotIn,
        from: 8 * 3600 + 300,
        to: 8 * 3600 + 900,
        bookedFrom: 8 * 3600 + 345,
        bookedTo: 8 * 3600 + 870,
      },
    ];

    // Both trains belong to 運用 01 in the fixture, so this must be quiet…
    const sameDuty = computeYardLayout(
      doc,
      { ...index, trackIntervals: new Map([[TOY.c1, overlapping]]) },
      TOY.stationC,
    );
    expect(sameDuty.conflictCount).toBe(0);
    expect(sameDuty.bars.every((b) => !b.conflict)).toBe(true);

    // …while the identical overlap between two different duties is a conflict.
    const split = new Map(index.dutyOfTrain);
    split.set(TOY.depotIn, TOY.dutyExpress);
    const crossDuty = computeYardLayout(
      doc,
      { ...index, trackIntervals: new Map([[TOY.c1, overlapping]]), dutyOfTrain: split },
      TOY.stationC,
    );
    expect(crossDuty.conflictCount).toBeGreaterThan(0);
  });

  it('does not flag bars that merely touch', () => {
    const index = sampleIndex();
    const doc = index.doc;
    const patched = {
      ...index,
      trackIntervals: new Map(index.trackIntervals),
    };
    const back: OccupancyInterval[] = [
      {
        trackId: TOY.b1,
        stationId: TOY.stationB,
        trainId: TOY.localDown,
        from: 1000,
        to: 2000,
        bookedFrom: 1045,
        bookedTo: 1970,
      },
      {
        trackId: TOY.b1,
        stationId: TOY.stationB,
        trainId: TOY.expressDown,
        from: 2000,
        to: 3000,
        bookedFrom: 2045,
        bookedTo: 2970,
      },
    ];
    patched.trackIntervals.set(TOY.b1, back);
    const layout = computeYardLayout(doc, patched, TOY.stationB);
    expect(layout.conflictCount).toBe(0);
  });

  it('flags every member of a three-way overlap', () => {
    const index = sampleIndex();
    const patched = { ...index, trackIntervals: new Map(index.trackIntervals) };
    patched.trackIntervals.set(TOY.b1, [
      { trackId: TOY.b1, stationId: TOY.stationB, trainId: TOY.localDown, from: 0, to: 900, bookedFrom: 45, bookedTo: 870 },
      { trackId: TOY.b1, stationId: TOY.stationB, trainId: TOY.expressDown, from: 300, to: 1200, bookedFrom: 345, bookedTo: 1170 },
      { trackId: TOY.b1, stationId: TOY.stationB, trainId: TOY.depotIn, from: 600, to: 1500, bookedFrom: 645, bookedTo: 1470 },
    ]);
    const layout = computeYardLayout(index.doc, patched, TOY.stationB);
    expect(layout.bars.filter((b) => b.conflict)).toHaveLength(3);
  });
});

describe('laneAtY', () => {
  it('maps a drag position to a lane and clamps at the edges', () => {
    expect(laneAtY(0, 28, 3)).toBe(0);
    expect(laneAtY(29, 28, 3)).toBe(1);
    expect(laneAtY(-40, 28, 3)).toBe(0);
    expect(laneAtY(9999, 28, 3)).toBe(2);
  });
});
