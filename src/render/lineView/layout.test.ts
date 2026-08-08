import { describe, expect, it } from 'vitest';
import type { StationTrack } from '@/domain/model';
import { kmToMeters } from '@/domain/units';
import { TOY, toyProjectCopy } from '@/testing/toyProject';
import {
  assignStationLanes,
  computeLineLayout,
  computeStationHalfWidth,
  laneCenterY,
  LANE_HEIGHT,
  placeTrain,
  runningLane,
} from './layout';

function track(id: string, directions: StationTrack['directions']): StationTrack {
  return {
    id: id as StationTrack['id'],
    stationId: 'stn-x' as StationTrack['stationId'],
    name: id,
    usage: 'main',
    hasPlatform: true,
    directions,
    canTurnBack: false,
    canBeOvertaken: false,
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

  it('gives the depot a stub lane below the main stack', () => {
    expect(layout.depots).toHaveLength(1);
    const depot = layout.depots[0]!;
    expect(depot.index).toBe(layout.mainLaneCount);
    expect(layout.totalLaneCount).toBe(layout.mainLaneCount + 1);
    // The stub runs from the depot's km back to the attached station.
    expect(depot.x0).toBe(kmToMeters(-0.5));
    expect(depot.x1).toBe(0);
    expect(depot.junctionX).toBe(0);
    // Depot stabling tracks resolve to the stub lane.
    expect(layout.laneOfTrack.get(TOY.x1)).toBe(depot.index);
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

  it('sends anything touching a depot station onto the stub lane', () => {
    const depotLane = layout.depots[0]!.index;
    expect(
      placeTrain(layout, {
        km: kmToMeters(-0.2),
        direction: 'down',
        fromStationId: TOY.stationDepot,
        toStationId: TOY.stationA,
      }).lane,
    ).toBe(depotLane);
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

describe('laneCenterY', () => {
  it('centres the marker in its lane', () => {
    expect(laneCenterY(0, 0, 26)).toBe(13);
    expect(laneCenterY(2, 0, 26)).toBe(65);
    // Scrolling the camera down by one lane lifts everything by a lane height.
    expect(laneCenterY(2, 1, 26)).toBe(39);
  });
});
