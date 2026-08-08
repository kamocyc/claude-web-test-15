import { describe, expect, it } from 'vitest';
import { TOY } from '@/testing/toyProject';
import { FIXTURE_T, sampleScene } from '../__fixtures__/sampleScene';
import { createCamera } from '../canvas/camera';
import { createRecordingContext } from '../canvas/recordingContext';
import { FALLBACK_THEME } from '../canvas/theme';
import {
  diagramStationPositions,
  diagramTrainPositions,
  drawDiagramDynamic,
  drawDiagramEvents,
  drawDiagramGrid,
  drawDiagramOverlay,
  drawDiagramStatic,
  drawDiagramTrains,
  DIM_ALPHA,
} from './draw';
import { computeDiagramLayout } from './layout';

const VIEWPORT = { width: 800, height: 320 };

function env(overrides: Partial<Parameters<typeof drawDiagramStatic>[1]> = {}) {
  const scene = sampleScene(FIXTURE_T);
  const layout = computeDiagramLayout(scene.index, { verticalScale: 'km' });
  // 07:45 at the left edge, 0.2 px/s, 90 px per km.
  const camera = createCamera({ x: 7 * 3600 + 45 * 60, y: -0.2, scaleX: 0.2, scaleY: 90 });
  return { scene, layout, camera, theme: FALLBACK_THEME, viewport: VIEWPORT, ...overrides };
}

describe('drawDiagramGrid', () => {
  it('produces a stable call log', () => {
    const ctx = createRecordingContext();
    drawDiagramGrid(ctx, env());
    expect(ctx.lines()).toMatchSnapshot();
  });

  it('labels the stations down the left edge', () => {
    const ctx = createRecordingContext();
    drawDiagramGrid(ctx, env());
    const texts = ctx.ops('fillText').map((c) => c.args[0]);
    for (const name of ['A駅', 'B駅', 'C駅', 'D駅']) expect(texts).toContain(name);
  });

  it('writes hour/minute labels along the top', () => {
    const ctx = createRecordingContext();
    drawDiagramGrid(ctx, env());
    const texts = ctx.ops('fillText').map((c) => String(c.args[0]));
    expect(texts.some((t) => /^\d{1,2}:\d{2}$/.test(t))).toBe(true);
  });
});

describe('drawDiagramTrains', () => {
  it('produces a stable call log', () => {
    const ctx = createRecordingContext();
    drawDiagramTrains(ctx, env());
    expect(ctx.lines()).toMatchSnapshot();
  });

  it('emits one path per visible train', () => {
    const ctx = createRecordingContext();
    const e = env();
    drawDiagramTrains(ctx, e);
    expect(ctx.ops('moveTo')).toHaveLength(e.layout.trains.length);
  });

  it('draws the dwell as a HORIZONTAL screen segment', () => {
    const ctx = createRecordingContext();
    const e = env();
    drawDiagramTrains(ctx, e);
    // Consecutive vertices at equal y are the dwell stubs; the 待避 at C is
    // four minutes long, which at 0.2 px/s is 48 px wide.
    const pts = [...ctx.ops('moveTo'), ...ctx.ops('lineTo')].map((c) => ({
      x: c.args[0] as number,
      y: c.args[1] as number,
    }));
    const horizontalRuns = ctx
      .lines()
      .join('\n')
      .match(/lineTo\((-?[\d.]+), (-?[\d.]+)\)/g);
    expect(horizontalRuns).toBeTruthy();
    expect(pts.length).toBeGreaterThan(0);

    const local = e.layout.trainById.get(TOY.localDown)!;
    const dwell = local.points.filter((p) => p.stationId === TOY.stationC);
    expect(dwell[0]!.y).toBe(dwell[1]!.y);
    expect((dwell[1]!.x - dwell[0]!.x) * e.camera.scaleX).toBeCloseTo(48);
  });

  it('applies the type dash pattern', () => {
    const ctx = createRecordingContext();
    drawDiagramTrains(ctx, env());
    const dashes = ctx.ops('setLineDash').map((c) => JSON.stringify(c.args[0]));
    expect(dashes).toContain('[7,4]'); // 回送
    expect(dashes).toContain('[]');
  });

  it('highlighting a duty widens it 3x and fades everything else', () => {
    const ctx = createRecordingContext();
    const e = env();
    drawDiagramTrains(ctx, { ...e, highlightDutyId: TOY.dutyExpress });
    const widths = ctx.ops('set lineWidth').map((c) => c.args[0] as number);
    const express = e.layout.trainById.get(TOY.expressDown)!;
    expect(widths).toContain(express.lineWidth * 3);

    const dimmed = ctx
      .ops('set strokeStyle')
      .map((c) => String(c.args[0]))
      .filter((s) => s.includes(`, ${DIM_ALPHA})`));
    expect(dimmed.length).toBeGreaterThan(0);
  });

  it('culls trains outside the visible time window', () => {
    const e = env();
    const late = createCamera({ x: 20 * 3600, y: -0.2, scaleX: 0.2, scaleY: 90 });
    const ctx = createRecordingContext();
    drawDiagramTrains(ctx, { ...e, camera: late });
    expect(ctx.ops('moveTo')).toHaveLength(0);
  });
});

describe('drawDiagramEvents', () => {
  it('draws a diamond at the 待避 and a bracket at the 接続', () => {
    const ctx = createRecordingContext();
    drawDiagramEvents(ctx, env());
    expect(ctx.lines()).toMatchSnapshot();
    const fills = ctx.ops('set fillStyle').map((c) => c.args[0]);
    expect(fills).toContain(FALLBACK_THEME.warning);
    const strokes = ctx.ops('set strokeStyle').map((c) => c.args[0]);
    expect(strokes).toContain(FALLBACK_THEME.ok);
  });
});

describe('drawDiagramDynamic', () => {
  it('draws the now-line and one dot per active train', () => {
    const e = env();
    const ctx = createRecordingContext();
    drawDiagramDynamic(ctx, { ...e, t: e.scene.t, snapshot: e.scene.snapshot });
    expect(ctx.ops('arc')).toHaveLength(2); // 各101 dwelling, 急201 running
    expect(ctx.ops('fillText').map((c) => c.args[0])).toContain('08:05');
    expect(ctx.lines()).toMatchSnapshot();
  });

  it('is cheap — no polyline work happens on the dynamic layer', () => {
    const e = env();
    const dynamic = createRecordingContext();
    drawDiagramDynamic(dynamic, { ...e, t: e.scene.t, snapshot: e.scene.snapshot });
    const staticCtx = createRecordingContext();
    drawDiagramStatic(staticCtx, e);
    // The whole point of the split: the per-frame layer is an order of
    // magnitude smaller than the per-camera-change layer.
    expect(dynamic.calls.length * 4).toBeLessThan(staticCtx.calls.length);
  });

  it('moves the now-line right as the clock advances', () => {
    const e = env();
    const xOf = (t: number): number => {
      const ctx = createRecordingContext();
      drawDiagramDynamic(ctx, { ...e, t, snapshot: sampleScene(t).snapshot });
      const move = ctx.ops('moveTo')[0];
      return move?.args[0] as number;
    };
    expect(xOf(8 * 3600)).toBeLessThan(xOf(8 * 3600 + 600));
  });
});

describe('drawDiagramOverlay', () => {
  it('clears and stops when nothing is hovered', () => {
    const ctx = createRecordingContext();
    drawDiagramOverlay(ctx, env());
    expect(ctx.lines()).toEqual(['clearRect(0, 0, 800, 320)']);
  });

  it('traces the hovered train and shows a tooltip', () => {
    const ctx = createRecordingContext();
    drawDiagramOverlay(ctx, { ...env(), hovered: TOY.localDown });
    expect(ctx.ops('set strokeStyle').map((c) => c.args[0])).toContain(FALLBACK_THEME.hover);
    expect(ctx.ops('fillText').map((c) => String(c.args[0]))).toContain('各 101 各駅停車');
  });
});

describe('digest positions', () => {
  it('places active trains on the now-line at their current km', () => {
    const e = env();
    const trains = diagramTrainPositions(e.layout, e.camera, e.scene.snapshot, e.scene.t);
    expect(trains).toHaveLength(2);
    // Both sit on the same vertical: the now-line.
    expect(new Set(trains.map((t) => t.sx)).size).toBe(1);
    expect(trains).toMatchSnapshot();
  });

  it('reports one row per station in km order', () => {
    const e = env();
    const stations = diagramStationPositions(e.layout, e.camera);
    expect(stations.map((s) => s.id)).toEqual([
      TOY.stationA,
      TOY.stationB,
      TOY.stationC,
      TOY.stationD,
    ]);
    const ys = stations.map((s) => s.sy);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });
});
