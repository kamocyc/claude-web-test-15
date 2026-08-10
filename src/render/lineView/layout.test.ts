import { describe, expect, it } from 'vitest';
import type { StationTrack } from '@/domain/model';
import { kmToMeters } from '@/domain/units';
import { TOY, toyProjectCopy } from '@/testing/toyProject';
import {
  assignStationLanes,
  BOTTOM_PAD_LANES,
  computeLineLayout,
  computeStationHalfWidth,
  depotLanePitch,
  depotPlateLayout,
  DEPOT_PLATE_H,
  depotStubCap,
  depotStubReach,
  DROPPED,
  isMajorStop,
  LABEL_BAND_LANES,
  laneCenterY,
  LANE_HEIGHT,
  placeTrain,
  resolveMarkerSlots,
  resolveStationLabels,
  runningLane,
  stationLabelPriority,
  type LabelCandidate,
} from './layout';

function track(
  id: string,
  directions: StationTrack['directions'],
  canBeOvertaken = false,
): StationTrack {
  return {
    id: id as StationTrack['id'],
    stationId: 'stn-x' as StationTrack['stationId'],
    name: id,
    usage: 'main',
    hasPlatform: true,
    directions,
    canTurnBack: false,
    canBeOvertaken,
    maxCars: 10,
    approachSec: 45,
    clearSec: 30,
  };
}

describe('assignStationLanes', () => {
  it('puts down-only tracks at the top and up-only tracks at the bottom', () => {
    const lanes = assignStationLanes([track('d1', ['down']), track('u1', ['up'])], 3);
    expect(lanes.get('d1' as never)).toBe(0);
    expect(lanes.get('u1' as never)).toBe(2);
  });

  it('keeps authored order among same-direction tracks', () => {
    const lanes = assignStationLanes(
      [track('d1', ['down']), track('d2', ['down']), track('u1', ['up']), track('u2', ['up'])],
      4,
    );
    expect(lanes.get('d1' as never)).toBe(0);
    expect(lanes.get('d2' as never)).toBe(1);
    expect(lanes.get('u1' as never)).toBe(2);
    expect(lanes.get('u2' as never)).toBe(3);
  });

  it('centres bidirectional tracks', () => {
    const lanes = assignStationLanes([track('b1', ['down', 'up'])], 3);
    expect(lanes.get('b1' as never)).toBe(1);
  });

  it('never assigns two tracks to the same lane', () => {
    const tracks = [
      track('d1', ['down']),
      track('d2', ['down']),
      track('b1', ['down', 'up']),
      track('u1', ['up']),
    ];
    const lanes = assignStationLanes(tracks, 4);
    expect(new Set(lanes.values()).size).toBe(tracks.length);
  });

  it('still fits when the lane count is smaller than the track count', () => {
    const tracks = [track('a', ['down']), track('b', ['down']), track('c', ['up'])];
    const lanes = assignStationLanes(tracks, 2);
    expect(new Set(lanes.values()).size).toBe(3);
  });

  it('handles a station with no tracks', () => {
    expect(assignStationLanes([], 3).size).toBe(0);
  });

  it('keeps the 待避線 off the running lane even when authored first', () => {
    // 旗の台 authors 3番線 (待避) before 4番線 (through) on the down side, and
    // 5番線 (through) before 6番線 (待避) on the up side.
    const lanes = assignStationLanes(
      [
        track('3', ['down'], true),
        track('4', ['down']),
        track('5', ['up']),
        track('6', ['up'], true),
      ],
      6,
    );
    // Through roads hold the two running lanes...
    expect(lanes.get('4' as never)).toBe(0);
    expect(lanes.get('5' as never)).toBe(5);
    // ...and each 待避線 sits one lane inside it, so a 待避 reads as a dip.
    expect(lanes.get('3' as never)).toBe(1);
    expect(lanes.get('6' as never)).toBe(4);
  });
});

describe('depotStubCap / depotStubReach', () => {
  it('is generous enough not to shorten a toy line stub', () => {
    expect(depotStubCap(3300, 150)).toBeGreaterThanOrEqual(500);
  });

  it('caps a works node parked far off the axis', () => {
    // 長津田車両工場 is 13 km off a 17 km line. Drawn to scale it would be
    // most of the picture; the cap keeps it a stub off the end.
    expect(depotStubReach(13_000, 17_000, 75)).toBeLessThan(17_000 * 0.2);
    expect(depotStubReach(13_000, 17_000, 75)).toBe(depotStubCap(17_000, 75));
  });

  it('draws a short yard long enough for its roads to be roads', () => {
    // 鷺沼車庫 is 500 m off a 17 km line — 3% of the width, which no ladder
    // of ten roads survives being drawn inside.
    const drawn = depotStubReach(500, 17_000, 75);
    expect(drawn).toBeGreaterThan(500);
    expect(drawn).toBeLessThanOrEqual(depotStubCap(17_000, 75));
  });

  it('leaves a yard that is already long enough at its true length', () => {
    expect(depotStubReach(500, 3300, 150)).toBe(500);
  });
});

describe('stationLabelPriority / isMajorStop', () => {
  const base = { isTerminal: false, isConnectionPoint: false };

  it('ranks a terminus above a junction above a busy stop', () => {
    const terminus = stationLabelPriority({ ...base, isTerminal: true, stopCount: 1 });
    const junction = stationLabelPriority({ ...base, isConnectionPoint: true, stopCount: 1 });
    const busy = stationLabelPriority({ ...base, stopCount: 10 });
    const quiet = stationLabelPriority({ ...base, stopCount: 4 });
    expect(terminus).toBeGreaterThan(junction);
    expect(junction).toBeGreaterThan(busy);
    expect(busy).toBeGreaterThan(quiet);
  });

  it('calls a 急行 stop major and an intermediate stop minor', () => {
    // 大井町線 numbers: 急行 stops are served by 10 patterns, locals by 6.
    expect(isMajorStop({ ...base, stopCount: 10, maxStopCount: 10 })).toBe(true);
    expect(isMajorStop({ ...base, stopCount: 6, maxStopCount: 10 })).toBe(false);
    expect(isMajorStop({ ...base, isTerminal: true, stopCount: 4, maxStopCount: 10 })).toBe(true);
    expect(
      isMajorStop({ ...base, isConnectionPoint: true, stopCount: 6, maxStopCount: 10 }),
    ).toBe(true);
  });

  it('does not divide by zero on a document with no stop patterns', () => {
    expect(isMajorStop({ ...base, stopCount: 0, maxStopCount: 0 })).toBe(false);
  });
});

describe('computeStationHalfWidth', () => {
  it('scales with the tightest section and stays inside sane limits', () => {
    // Tightest gap is 400 m -> 60 m.
    expect(
      computeStationHalfWidth([
        { kmFromOrigin: 0 },
        { kmFromOrigin: 1000 },
        { kmFromOrigin: 1400 },
      ]),
    ).toBe(60);
  });

  it('clamps a very long line', () => {
    expect(computeStationHalfWidth([{ kmFromOrigin: 0 }, { kmFromOrigin: 40_000 }])).toBe(250);
  });

  it('falls back for a single station', () => {
    expect(computeStationHalfWidth([{ kmFromOrigin: 0 }])).toBe(150);
  });
});

describe('computeLineLayout', () => {
  const layout = computeLineLayout(toyProjectCopy());

  it('uses a fixed lane height — only x zooms', () => {
    expect(layout.laneHeight).toBe(LANE_HEIGHT);
  });

  it('sizes the main stack to the widest station', () => {
    // C has three 番線, which is the maximum on the toy line.
    expect(layout.mainLaneCount).toBe(3);
    expect(layout.laneDown).toBe(0);
    expect(layout.laneUp).toBe(2);
  });

  it('excludes depot stations from the line but keeps them in bounds', () => {
    expect(layout.stations.map((s) => s.name)).toEqual(['A駅', 'B駅', 'C駅', 'D駅']);
    // The depot sits at km -0.5, so the world extends left of the origin.
    expect(layout.bounds.minX).toBeLessThan(kmToMeters(-0.4));
  });

  it('aligns a down platform with the down running lane', () => {
    // A駅 1番線 is down-only, so it sits on lane 0 with the open-line down lane.
    expect(layout.laneOfTrack.get(TOY.a1)).toBe(layout.laneDown);
    expect(layout.laneOfTrack.get(TOY.a2)).toBe(layout.laneUp);
  });

  it('drops the 待避線 onto its own lane — this is what makes 待避 visible', () => {
    const main = layout.laneOfTrack.get(TOY.c1);
    const loop = layout.laneOfTrack.get(TOY.c2);
    expect(main).toBe(layout.laneDown);
    expect(loop).not.toBe(main);
    expect(loop).toBe(1);
    const loopLane = layout.stations
      .find((s) => s.stationId === TOY.stationC)
      ?.trackLanes.find((l) => l.trackId === TOY.c2);
    expect(loopLane?.canBeOvertaken).toBe(true);
  });

  it('builds one section lane per direction between adjacent stations', () => {
    const sections = layout.lanes.filter((l) => l.kind === 'section');
    // Three sections (A-B, B-C, C-D) x two directions.
    expect(sections).toHaveLength(6);
    const ab = sections.filter((s) => s.kind === 'section' && s.sectionIndex === 0);
    expect(ab.map((s) => (s.kind === 'section' ? s.direction : ''))).toEqual(['down', 'up']);
  });

  it('leaves a gap between a station block and the next section', () => {
    const a = layout.stations[0]!;
    const b = layout.stations[1]!;
    const section = layout.lanes.find((l) => l.kind === 'section' && l.sectionIndex === 0)!;
    expect(section.x0).toBe(a.x1);
    expect(section.x1).toBe(b.x0);
    expect(section.x0).toBeLessThan(section.x1);
  });

  it('gives every yard road its own lane below the main stack', () => {
    expect(layout.depots).toHaveLength(1);
    const yard = layout.depots[0]!;
    expect(yard.laneFrom).toBeGreaterThan(layout.laneUp);
    expect(yard.tracks.map((r) => r.trackId)).toEqual([TOY.x1]);
    // Each road is a lane, and the road is what a train is placed on.
    expect(layout.laneOfTrack.get(TOY.x1)).toBe(yard.tracks[0]!.index);
    expect(layout.totalLaneCount).toBe(yard.laneTo + 1);
    // The yard runs from its km in to the edge of the attached station block.
    expect(yard.endX).toBe(kmToMeters(-0.5));
    expect(yard.junctionX).toBe(-layout.stationHalfWidth);
    // …and the throat is between the two, so a train has somewhere to turn in.
    expect(yard.rootX).toBeLessThan(yard.junctionX);
    expect(yard.throatX).toBeLessThan(yard.rootX);
    expect(yard.endX).toBeLessThan(yard.throatX);
  });

  it('keeps a yard clear of the running lines and of the next yard', () => {
    const yard = layout.depots[0]!;
    expect(yard.laneFrom - layout.laneUp).toBeGreaterThan(1);
    // The throat fans out above the first road.
    expect(yard.rootLane).toBeLessThan(yard.laneFrom);
    expect(yard.rootLane).toBeGreaterThan(layout.laneUp);
  });

  it('joins a road that is not the running lane to the ones it serves', () => {
    const c = layout.stations.find((s) => s.stationId === TOY.stationC)!;
    const loop = c.trackLanes.find((l) => l.trackId === TOY.c2)!;
    const through = c.trackLanes.find((l) => l.trackId === TOY.c1)!;
    // The 待避線 is switched off the down running lane at both ends…
    expect(loop.leadLanes).toEqual([layout.laneDown]);
    expect(loop.bodyX0).toBeGreaterThan(loop.x0);
    expect(loop.bodyX1).toBeLessThan(loop.x1);
    // …and the through road needs no lead, because it *is* the running lane.
    expect(through.leadLanes).toEqual([]);
    expect(through.bodyX0).toBe(through.x0);
    expect(through.bodyX1).toBe(through.x1);
  });

  it('reserves world space above lane 0 for the station-name band', () => {
    expect(layout.bounds.minY).toBe(-LABEL_BAND_LANES);
    expect(layout.bounds.maxY).toBe(layout.totalLaneCount + BOTTOM_PAD_LANES);
    // Fitting y to these bounds therefore leaves room for the names.
    expect(layout.bounds.maxY - layout.bounds.minY).toBeGreaterThan(layout.totalLaneCount);
  });

  it('scores stations from the stop patterns', () => {
    const a = layout.stations.find((s) => s.stationId === TOY.stationA)!;
    const b = layout.stations.find((s) => s.stationId === TOY.stationB)!;
    expect(a.stopCount).toBeGreaterThan(0);
    // A駅 is a terminus, so it outranks the intermediate B駅 whatever the counts.
    expect(a.labelPriority).toBeGreaterThan(b.labelPriority);
    expect(a.isMajorStop).toBe(true);
  });

  it('does not let a far-off works node dominate the world width', () => {
    // Park the depot 40 km off a 3 km line, as 長津田車両工場 is on 大井町線.
    const doc = toyProjectCopy();
    const depotStation = doc.stations.byId[TOY.stationDepot]!;
    doc.stations.byId[TOY.stationDepot] = {
      ...depotStation,
      kmFromOrigin: kmToMeters(-40),
    };
    const far = computeLineLayout(doc);
    const lineSpan = kmToMeters(3);
    // Without the cap the world would be fourteen times the length of the line.
    expect(far.bounds.maxX - far.bounds.minX).toBeLessThan(lineSpan * 1.6);
    // …and the stub still points the right way.
    expect(far.depots[0]!.x0).toBeLessThan(far.depots[0]!.junctionX);
    // The yard's km stays the routing fact it is; only the drawing is capped.
    expect(far.depots[0]!.km).toBe(kmToMeters(-40));
    expect(far.depots[0]!.endX).toBeGreaterThan(kmToMeters(-40));
  });

  it('is deterministic', () => {
    const again = computeLineLayout(toyProjectCopy());
    expect(again.lanes.map((l) => `${l.kind}:${l.index}:${l.x0}:${l.x1}`)).toEqual(
      layout.lanes.map((l) => `${l.kind}:${l.index}:${l.x0}:${l.x1}`),
    );
  });
});

describe('placeTrain', () => {
  const layout = computeLineLayout(toyProjectCopy());

  it('uses the assigned 番線 lane when the train is standing', () => {
    const p = placeTrain(layout, {
      km: kmToMeters(2),
      direction: 'down',
      stationId: TOY.stationC,
      trackId: TOY.c2,
    });
    expect(p.lane).toBe(layout.laneOfTrack.get(TOY.c2));
    expect(p.x).toBe(kmToMeters(2));
  });

  it('uses the running lane for its direction while in the open', () => {
    expect(
      placeTrain(layout, {
        km: kmToMeters(1.5),
        direction: 'down',
        fromStationId: TOY.stationB,
        toStationId: TOY.stationC,
      }).lane,
    ).toBe(runningLane(layout, 'down'));

    expect(
      placeTrain(layout, {
        km: kmToMeters(1.5),
        direction: 'up',
        fromStationId: TOY.stationC,
        toStationId: TOY.stationB,
      }).lane,
    ).toBe(runningLane(layout, 'up'));
  });

  it('swings out of the 待避線 along the lead instead of changing lane at once', () => {
    const loop = layout.laneOfTrack.get(TOY.c2)!;
    const down = runningLane(layout, 'down');
    const at = (km: number): number =>
      placeTrain(layout, {
        km,
        direction: 'down',
        fromStationId: TOY.stationC,
        toStationId: TOY.stationD,
        fromTrackId: TOY.c2,
        toTrackId: TOY.d1,
      }).lane;

    const c = layout.stationOf.get(TOY.stationC)!;
    // On the road at the platform, on the running lane once clear of the
    // block, and strictly in between all the way along the lead.
    expect(at(c.x)).toBe(loop);
    expect(at(c.x1)).toBe(down);
    const mid = at(c.x1 - layout.stationLeadWidth / 2);
    expect(mid).toBeGreaterThan(down);
    expect(mid).toBeLessThan(loop);

    // Monotone: no step back, and no jump bigger than the sampling step.
    let prev = loop;
    for (let km = c.x; km <= c.x1; km += 1) {
      const lane = at(km);
      expect(lane).toBeLessThanOrEqual(prev + 1e-9);
      expect(prev - lane).toBeLessThan(0.2);
      prev = lane;
    }
  });

  it('runs a depot leg down the throat onto its own road', () => {
    const yard = layout.depots[0]!;
    const road = layout.laneOfTrack.get(TOY.x1)!;
    const at = (km: number) =>
      placeTrain(layout, {
        km,
        direction: 'up',
        fromStationId: TOY.stationA,
        toStationId: TOY.stationDepot,
        fromTrackId: TOY.a2,
        toTrackId: TOY.x1,
      });

    // Ends on the road, having come off the running lane through the throat.
    expect(at(kmToMeters(-0.5)).lane).toBe(road);
    expect(at(kmToMeters(-0.5)).x).toBe(yard.berthX);
    expect(at(0).lane).toBe(layout.laneOfTrack.get(TOY.a2));

    let prev = -Infinity;
    let lastLane = layout.laneOfTrack.get(TOY.a2)!;
    for (let km = 0; km >= kmToMeters(-0.5); km -= 5) {
      const p = at(km);
      // x runs monotonically outwards along the *drawn* stub…
      expect(p.x).toBeLessThan(prev === -Infinity ? Infinity : prev);
      prev = p.x;
      // …and the lane never jumps.
      expect(Math.abs(p.lane - lastLane)).toBeLessThan(0.5);
      lastLane = p.lane;
    }
  });

  it('compresses a leg to a works node onto the drawn stub', () => {
    // 長津田車両工場 sits far off the km axis; a 回送 to it must not fly off
    // the end of the line while the yard stays where it was drawn.
    const doc = toyProjectCopy();
    const depotStation = doc.stations.byId[TOY.stationDepot]!;
    doc.stations.byId[TOY.stationDepot] = {
      ...depotStation,
      kmFromOrigin: kmToMeters(-40),
    };
    const far = computeLineLayout(doc);
    const yard = far.depots[0]!;
    for (let km = 0; km >= kmToMeters(-40); km -= 500) {
      const p = placeTrain(far, {
        km,
        direction: 'up',
        fromStationId: TOY.stationA,
        toStationId: TOY.stationDepot,
        toTrackId: TOY.x1,
      });
      expect(p.x).toBeGreaterThanOrEqual(yard.endX);
      expect(p.x).toBeLessThanOrEqual(0);
    }
  });

  it('walks a shunting formation across the roads it moves between', () => {
    const from = layout.laneOfTrack.get(TOY.c1)!;
    const to = layout.laneOfTrack.get(TOY.c2)!;
    const at = (trackBlend: number): number =>
      placeTrain(layout, {
        km: kmToMeters(2),
        direction: 'down',
        stationId: TOY.stationC,
        trackId: TOY.c2,
        fromTrackId: TOY.c1,
        trackBlend,
      }).lane;
    expect(at(0)).toBe(from);
    expect(at(1)).toBe(to);
    expect(at(0.5)).toBeCloseTo((from + to) / 2);
    // Out-of-range blends clamp rather than fling the marker off the stack.
    expect(at(-1)).toBe(from);
    expect(at(4)).toBe(to);
  });

  it('falls back to the running lane for an unknown track', () => {
    expect(
      placeTrain(layout, {
        km: 0,
        direction: 'up',
        trackId: 'trk-does-not-exist' as never,
      }).lane,
    ).toBe(layout.laneUp);
  });
});

describe('depotLanePitch', () => {
  it('gives a small yard full-height roads', () => {
    expect(depotLanePitch(1)).toBe(1);
    expect(depotLanePitch(4)).toBe(1);
  });

  it('keeps a yard of any size about four lanes deep', () => {
    // 鷺沼車庫 has ten roads. At the full pitch they would take more vertical
    // space than the whole running line.
    for (const n of [5, 10, 24, 60]) {
      const depth = (n - 1) * depotLanePitch(n);
      expect(depotLanePitch(n), `${n} roads`).toBeLessThanOrEqual(1);
      expect(depth, `${n} roads`).toBeLessThanOrEqual(n <= 12 ? 4 : 18);
    }
    expect(depotLanePitch(10)).toBeLessThan(depotLanePitch(5));
  });
});

// ---------------------------------------------------------------------------
// Label collision resolution
// ---------------------------------------------------------------------------

/** Intervals of everything placed on `row`, in x order. */
function rowSpans(
  candidates: readonly LabelCandidate[],
  rows: readonly number[],
  row: number,
): Array<[number, number]> {
  return candidates
    .map((c, i) => ({ c, row: rows[i]! }))
    .filter((e) => e.row === row)
    .map((e): [number, number] => [e.c.x - e.c.width / 2, e.c.x + e.c.width / 2])
    .sort((a, b) => a[0] - b[0]);
}

function assertNoOverlaps(candidates: readonly LabelCandidate[], rows: readonly number[]): void {
  const used = new Set(rows.filter((r) => r !== DROPPED));
  for (const row of used) {
    const spans = rowSpans(candidates, rows, row);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1]);
    }
  }
}

describe('resolveStationLabels', () => {
  /** Eight names 45 px apart — the 大井町 end of the line at the fitted zoom. */
  const packed: LabelCandidate[] = [
    { x: 0, width: 40, priority: 1_000_010 }, // 大井町 (terminus)
    { x: 45, width: 40, priority: 6 }, //        下神明
    { x: 97, width: 50, priority: 6 }, //        戸越公園
    { x: 141, width: 30, priority: 6 }, //       中延
    { x: 178, width: 40, priority: 6 }, //       荏原町
    { x: 230, width: 40, priority: 10_010 }, //  旗の台 (junction)
    { x: 297, width: 40, priority: 6 }, //       北千束
    { x: 356, width: 40, priority: 10 }, //      大岡山 (急行 stop)
  ];

  it('never overlaps two names on the same row', () => {
    assertNoOverlaps(packed, resolveStationLabels(packed));
  });

  it('keeps every important stop and drops an intermediate one instead', () => {
    const rows = resolveStationLabels(packed, { rows: 1 });
    expect(rows[0]).not.toBe(DROPPED); // 大井町
    expect(rows[5]).not.toBe(DROPPED); // 旗の台
    expect(rows[7]).not.toBe(DROPPED); // 大岡山
    expect(rows.filter((r) => r === DROPPED).length).toBeGreaterThan(0);
  });

  it('two rows fit strictly more names than one', () => {
    const one = resolveStationLabels(packed, { rows: 1 }).filter((r) => r !== DROPPED).length;
    const two = resolveStationLabels(packed, { rows: 2 }).filter((r) => r !== DROPPED).length;
    expect(two).toBeGreaterThan(one);
    assertNoOverlaps(packed, resolveStationLabels(packed, { rows: 2 }));
  });

  it('reveals more names as the view zooms in', () => {
    const shown = (zoom: number): number => {
      const scaled = packed.map((c) => ({ ...c, x: c.x * zoom }));
      return resolveStationLabels(scaled).filter((r) => r !== DROPPED).length;
    };
    expect(shown(0.5)).toBeLessThan(shown(1));
    expect(shown(1)).toBeLessThanOrEqual(shown(4));
    expect(shown(4)).toBe(packed.length);
  });

  it('prefers the upper row, so a single sparse line stays on one line', () => {
    const sparse = packed.map((c, i) => ({ ...c, x: i * 200 }));
    expect(resolveStationLabels(sparse).every((r) => r === 0)).toBe(true);
  });

  it('is deterministic and independent of input order among equals', () => {
    const a = resolveStationLabels(packed);
    const b = resolveStationLabels(packed);
    expect(b).toEqual(a);
  });

  it('honours the requested gap', () => {
    const pair: LabelCandidate[] = [
      { x: 0, width: 40, priority: 1 },
      { x: 44, width: 40, priority: 1 },
    ];
    // 4 px of clear space between them: fine with a 2 px gap, not with 8.
    expect(resolveStationLabels(pair, { rows: 1, gap: 2 })).toEqual([0, 0]);
    expect(resolveStationLabels(pair, { rows: 1, gap: 8 })).toEqual([0, DROPPED]);
  });

  it('survives an empty line', () => {
    expect(resolveStationLabels([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Marker de-overlap
// ---------------------------------------------------------------------------

describe('resolveMarkerSlots', () => {
  const W = 92;
  const GAP = 4;

  it('leaves well-separated markers exactly where they are', () => {
    const out = resolveMarkerSlots([{ lane: 0, x: 100 }, { lane: 0, x: 400 }], W, GAP);
    expect(out.map((r) => r.x)).toEqual([100, 400]);
  });

  it('separates a bunch to at least a marker width apart', () => {
    const items = [0, 20, 40, 60, 80].map((x) => ({ lane: 0, x }));
    const out = resolveMarkerSlots(items, W, GAP);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.x - out[i - 1]!.x).toBeGreaterThanOrEqual(W + GAP - 1e-9);
    }
  });

  it('centres a cluster on the trains in it rather than pushing it aside', () => {
    // Three trains stacked on one point: the middle one must not move.
    const out = resolveMarkerSlots(
      [{ lane: 0, x: 500 }, { lane: 0, x: 500 }, { lane: 0, x: 500 }],
      W,
      GAP,
    );
    expect(out[1]!.x).toBeCloseTo(500);
    expect(out[0]!.x).toBeCloseTo(500 - (W + GAP));
    expect(out[2]!.x).toBeCloseTo(500 + (W + GAP));
  });

  it('preserves along-the-line order', () => {
    const items = [90, 10, 50, 30].map((x) => ({ lane: 0, x }));
    const out = resolveMarkerSlots(items, W, GAP);
    const byDesired = items
      .map((it, i) => ({ d: it.x, p: out[i]!.x }))
      .sort((a, b) => a.d - b.d);
    for (let i = 1; i < byDesired.length; i++) {
      expect(byDesired[i]!.p).toBeGreaterThan(byDesired[i - 1]!.p);
    }
  });

  it('treats lanes independently — a 待避 train never shifts the express', () => {
    const out = resolveMarkerSlots([{ lane: 0, x: 300 }, { lane: 3, x: 300 }], W, GAP);
    expect(out.map((r) => r.x)).toEqual([300, 300]);
  });

  it('always reports the true position alongside the drawn one', () => {
    const items = [{ lane: 1, x: 10 }, { lane: 1, x: 12 }];
    const out = resolveMarkerSlots(items, W, GAP);
    expect(out.map((r) => r.anchorX)).toEqual([10, 12]);
    expect(out.map((r) => r.lane)).toEqual([1, 1]);
  });

  it('moves no further than it has to', () => {
    // A pair 2 px apart needs (W + GAP - 2) of separation, split evenly.
    const out = resolveMarkerSlots([{ lane: 0, x: 200 }, { lane: 0, x: 202 }], W, GAP);
    const spread = out[1]!.x - out[0]!.x;
    expect(spread).toBeCloseTo(W + GAP);
    expect((out[0]!.x + out[1]!.x) / 2).toBeCloseTo(201);
  });

  it('handles nothing at all', () => {
    expect(resolveMarkerSlots([], W, GAP)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Depot box
// ---------------------------------------------------------------------------

describe('depotPlateLayout', () => {
  const base = { centerY: 100, contentWidth: 90, viewportWidth: 1400 };

  it('is only as wide as its text — the roads are the drawing now', () => {
    const plate = depotPlateLayout({ ...base, junctionX: 200, stubEndX: 500 });
    expect(plate.w).toBeGreaterThan(base.contentWidth);
    expect(plate.w).toBeLessThan(base.contentWidth + 20);
    expect(plate.h).toBe(DEPOT_PLATE_H);
    expect(plate.y).toBeCloseTo(base.centerY - DEPOT_PLATE_H / 2);
  });

  it('hangs off the far end of the yard, on the correct side', () => {
    const right = depotPlateLayout({ ...base, junctionX: 200, stubEndX: 500 });
    expect(right.outward).toBe(1);
    expect(right.x + right.w).toBeCloseTo(500);

    const left = depotPlateLayout({ ...base, junctionX: 500, stubEndX: 200 });
    expect(left.outward).toBe(-1);
    expect(left.x).toBeCloseTo(200);
  });

  it('never hangs off the edge of the viewport', () => {
    const plate = depotPlateLayout({ ...base, junctionX: 1380, stubEndX: 1480 });
    expect(plate.x).toBeGreaterThanOrEqual(0);
    expect(plate.x + plate.w).toBeLessThanOrEqual(base.viewportWidth);
  });

  it('stays legible for a yard with no name to speak of', () => {
    const plate = depotPlateLayout({ ...base, contentWidth: 0, junctionX: 0, stubEndX: 40 });
    expect(plate.w).toBeGreaterThanOrEqual(32);
  });
});

describe('laneCenterY', () => {
  it('centres the marker in its lane', () => {
    expect(laneCenterY(0, 0, 26)).toBe(13);
    expect(laneCenterY(2, 0, 26)).toBe(65);
    // Scrolling the camera down by one lane lifts everything by a lane height.
    expect(laneCenterY(2, 1, 26)).toBe(39);
  });
});
