import { describe, expect, it } from 'vitest';
import { kmToMeters } from '@/domain/units';
import { TOY } from '@/testing/toyProject';
import { sampleIndex } from '../__fixtures__/sampleScene';
import {
  chooseDistanceGrid,
  chooseTimeGrid,
  computeDiagramLayout,
  diagramYOfKm,
} from './layout';

const H = 3600;
const M = 60;

describe('computeDiagramLayout — vertical axis', () => {
  it('km mode puts world y in kilometres', () => {
    const layout = computeDiagramLayout(sampleIndex(), { verticalScale: 'km' });
    expect(layout.stations.map((s) => s.y)).toEqual([0, 1, 2, 3]);
  });

  it('index mode spaces stations evenly', () => {
    const layout = computeDiagramLayout(sampleIndex(), { verticalScale: 'index' });
    expect(layout.stations.map((s) => s.y)).toEqual([0, 1, 2, 3]);
  });

  it('index mode interpolates a mid-section position', () => {
    const layout = computeDiagramLayout(sampleIndex(), { verticalScale: 'index' });
    // Halfway between B (km 1) and C (km 2) is halfway between index 1 and 2.
    expect(diagramYOfKm(layout, kmToMeters(1.5))).toBeCloseTo(1.5);
  });

  it('km mode is linear in distance regardless of station spacing', () => {
    const layout = computeDiagramLayout(sampleIndex(), { verticalScale: 'km' });
    expect(diagramYOfKm(layout, kmToMeters(1.25))).toBeCloseTo(1.25);
  });

  it('clamps beyond the ends', () => {
    const layout = computeDiagramLayout(sampleIndex(), { verticalScale: 'index' });
    expect(diagramYOfKm(layout, kmToMeters(-5))).toBe(0);
    expect(diagramYOfKm(layout, kmToMeters(99))).toBe(3);
  });
});

describe('computeDiagramLayout — polylines', () => {
  const layout = computeDiagramLayout(sampleIndex());

  it('emits one polyline per train', () => {
    expect(layout.trains).toHaveLength(4);
    expect(layout.trainById.get(TOY.localDown)).toBeDefined();
  });

  it('inserts a HORIZONTAL segment across every dwell — the 待避 stub', () => {
    const local = layout.trainById.get(TOY.localDown)!;
    // A(dep) B(arr,dep) C(arr,dep) D(arr) = 1 + 2 + 2 + 1 vertices.
    expect(local.points).toHaveLength(6);

    const atC = local.points.filter((p) => p.stationId === TOY.stationC);
    expect(atC).toHaveLength(2);
    expect(atC[0]!.y).toBe(atC[1]!.y); // horizontal
    expect(atC[0]!.x).toBe(8 * H + 4 * M);
    expect(atC[1]!.x).toBe(8 * H + 8 * M + 30); // the 4.5-minute 待避
    expect(atC[1]!.isDwellEnd).toBe(true);
  });

  it('draws the overtaking express calling at C as its own dwell stub', () => {
    // The fixture's express *calls* at C on the through road while the local
    // stands aside on the loop — that cross-platform call is what makes C a
    // 緩急接続 rather than a bare spacing 待避.
    const express = layout.trainById.get(TOY.expressDown)!;
    const atC = express.points.filter((p) => p.stationId === TOY.stationC);
    expect(atC).toHaveLength(2);
    expect(atC[0]!.x).toBe(8 * H + 6 * M);
    expect(atC[1]!.x).toBe(8 * H + 6 * M + 30);
    expect(atC[0]!.y).toBe(atC[1]!.y);
  });

  it('emits a single vertex where a train passes without stopping', () => {
    // B is the station the express genuinely runs through.
    const express = layout.trainById.get(TOY.expressDown)!;
    const atB = express.points.filter((p) => p.stationId === TOY.stationB);
    expect(atB).toHaveLength(1);
    expect(atB[0]!.x).toBe(8 * H + 4 * M + 20);
  });

  it('carries the type styling onto the line', () => {
    const express = layout.trainById.get(TOY.expressDown)!;
    expect(express.color).toBe('#dc2626');
    expect(express.lineWidth).toBe(2.5);
    expect(express.dash).toEqual([]);
    const deadhead = layout.trainById.get(TOY.depotOut)!;
    expect(deadhead.dash).toEqual([7, 4]); // 回送 is dashed
  });

  it('can hide 回送', () => {
    const only = computeDiagramLayout(sampleIndex(), { showDeadhead: false });
    expect(only.trains.map((t) => t.trainId)).toEqual([TOY.localDown, TOY.expressDown]);
  });

  it('builds a spatial index covering every segment', () => {
    const segmentCount = layout.trains.reduce((n, t) => n + t.points.length - 1, 0);
    expect(layout.segments.size).toBe(segmentCount);
  });

  it('reports a point count matching the polylines', () => {
    expect(layout.pointCount).toBe(layout.trains.reduce((n, t) => n + t.points.length, 0));
  });

  it('bounds cover every drawn vertex', () => {
    for (const train of layout.trains) {
      for (const p of train.points) {
        expect(p.x).toBeGreaterThanOrEqual(layout.bounds.minX);
        expect(p.x).toBeLessThanOrEqual(layout.bounds.maxX);
        expect(p.y).toBeGreaterThanOrEqual(layout.bounds.minY);
        expect(p.y).toBeLessThanOrEqual(layout.bounds.maxY);
      }
    }
  });
});

describe('computeDiagramLayout — events', () => {
  const layout = computeDiagramLayout(sampleIndex());

  it('anchors the 待避 marker at the moment of passing', () => {
    expect(layout.overtakes).toHaveLength(1);
    const o = layout.overtakes[0]!;
    expect(o.stationId).toBe(TOY.stationC);
    expect(o.waitingTrainId).toBe(TOY.localDown);
    expect(o.passingTrainId).toBe(TOY.expressDown);
    expect(o.x).toBe(8 * H + 6 * M);
    expect(o.y).toBe(2);
  });

  it('spans the connection bracket over the transfer window', () => {
    expect(layout.connections).toHaveLength(1);
    const c = layout.connections[0]!;
    // Arrival of the 各停 to *departure* of the 急行: 08:04:00 → 08:06:30 is
    // the time a passenger actually has to change trains.
    expect(c.x).toBe(8 * H + 4 * M);
    expect(c.x2).toBe(8 * H + 6 * M + 30);
    expect(c.transferSec).toBe(150);
  });
});

describe('chooseTimeGrid', () => {
  it('uses minute lines only when they are legible', () => {
    // 1 px per second: a minute is 60 px apart.
    expect(chooseTimeGrid(1).major).toBe(60);
  });

  it('steps up to 10 minutes, then to hours, as the view zooms out', () => {
    expect(chooseTimeGrid(0.1).major).toBe(600);
    expect(chooseTimeGrid(0.02).major).toBe(1800);
    expect(chooseTimeGrid(0.005).major).toBe(7200);
  });

  it('offers a minor step only when it would not become a smear', () => {
    expect(chooseTimeGrid(0.1).minor).toBe(300);
    expect(chooseTimeGrid(1).minor).toBe(0); // nothing finer than a minute exists
    // Zoomed all the way out, even hour lines would be 3.6 px apart.
    expect(chooseTimeGrid(0.001).minor).toBe(0);
  });

  it('never returns a minor step coarser than the major one', () => {
    for (const scale of [0.001, 0.005, 0.02, 0.1, 0.5, 1, 4]) {
      const g = chooseTimeGrid(scale);
      if (g.minor > 0) expect(g.minor).toBeLessThan(g.major);
    }
  });
});

describe('chooseDistanceGrid', () => {
  it('grows the step as the vertical zoom shrinks', () => {
    expect(chooseDistanceGrid(100)).toBe(0.5);
    expect(chooseDistanceGrid(20)).toBe(2);
    expect(chooseDistanceGrid(0.1)).toBe(50);
  });
});
