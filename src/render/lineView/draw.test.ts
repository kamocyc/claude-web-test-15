/**
 * Draw tests: run the real draw functions against a recording context and
 * assert on the ordered call log.
 *
 * No canvas, no jsdom, no pixels — so these run in the node project, never
 * flake on font rendering, and produce a diff a human can read when the
 * geometry changes.
 */

import { describe, expect, it } from 'vitest';
import type { TrainId, TrainTypeId } from '@/domain/ids';
import type { Formation, TrainType } from '@/domain/model';
import { entityList } from '@/domain/units';
import type { SimSnapshot, TrainRuntime } from '@/engine/types';
import { TOY } from '@/testing/toyProject';
import { FIXTURE_T, sampleScene } from '../__fixtures__/sampleScene';
import { createCamera, crisp, worldToScreenX } from '../canvas/camera';
import { HitRects } from '../canvas/hit';
import { createRecordingContext } from '../canvas/recordingContext';
import { approxTextWidth } from '../canvas/textCache';
import { FALLBACK_THEME } from '../canvas/theme';
import {
  drawLineDynamic,
  drawLineOverlay,
  drawLineStatic,
  lineStationPositions,
  lineTrainPositions,
  MARKER_H,
  MARKER_W,
  placementOf,
  type LineDynamicEnv,
} from './draw';
import { computeLineLayout, LANE_HEIGHT } from './layout';

const VIEWPORT = { width: 900, height: 200 };

function makeEnv() {
  const scene = sampleScene(FIXTURE_T);
  const layout = computeLineLayout(scene.doc);
  const camera = createCamera({ x: -700, y: 0, scaleX: 0.2, scaleY: LANE_HEIGHT });
  const trainTypes = new Map<TrainTypeId, TrainType>();
  for (const t of entityList(scene.doc.trainTypes)) trainTypes.set(t.id, t);
  const formations = new Map<string, Formation>();
  for (const f of entityList(scene.doc.formations)) formations.set(f.id, f);
  return { scene, layout, camera, trainTypes, formations };
}

/**
 * `count` copies of the running 急行, 30 m apart on the same lane.
 *
 * At the fixture camera that is 6 px between trains and a 92 px marker, which
 * is the situation the de-overlap exists for and which the four-train toy
 * timetable cannot produce on its own.
 */
function bunched(count: number): SimSnapshot {
  const snapshot = sampleScene(FIXTURE_T).snapshot;
  const express = snapshot.trains.find((t) => t.number === '201')!;
  const phase = express.phase as Extract<TrainRuntime['phase'], { phase: 'running' }>;
  const trains = Array.from({ length: count }, (_, i) => ({
    ...express,
    trainId: `${express.trainId}-${i}` as TrainId,
    number: String(300 + i),
    km: express.km + i * 30,
    phase: { ...phase, km: phase.km + i * 30 },
  }));
  return { ...snapshot, trains };
}

function dynamicEnv(over: Partial<LineDynamicEnv> = {}): LineDynamicEnv {
  const { scene, layout, camera, trainTypes, formations } = makeEnv();
  return {
    layout,
    camera,
    theme: FALLBACK_THEME,
    viewport: VIEWPORT,
    snapshot: scene.snapshot,
    trainTypes,
    formations,
    showDeadhead: true,
    ...over,
  };
}

describe('drawLineStatic', () => {
  it('produces a stable call log', () => {
    const { layout, camera } = makeEnv();
    const ctx = createRecordingContext();
    drawLineStatic(ctx, { layout, camera, theme: FALLBACK_THEME, viewport: VIEWPORT });
    expect(ctx.lines()).toMatchSnapshot();
  });

  it('labels every station', () => {
    const { layout, camera } = makeEnv();
    const ctx = createRecordingContext();
    drawLineStatic(ctx, { layout, camera, theme: FALLBACK_THEME, viewport: VIEWPORT });
    const texts = ctx.ops('fillText').map((c) => c.args[0]);
    for (const name of ['A駅', 'B駅', 'C駅', 'D駅']) expect(texts).toContain(name);
  });

  it('tints the 待避線 with the warning colour', () => {
    const { layout, camera } = makeEnv();
    const ctx = createRecordingContext();
    drawLineStatic(ctx, { layout, camera, theme: FALLBACK_THEME, viewport: VIEWPORT });
    const styles = ctx.ops('set fillStyle').map((c) => String(c.args[0]));
    expect(styles.some((s) => s.startsWith('rgba(251, 191, 36'))).toBe(true);
  });

  it('draws the depot stub but leaves the box to the dynamic layer', () => {
    const { layout, camera } = makeEnv();
    const ctx = createRecordingContext();
    drawLineStatic(ctx, { layout, camera, theme: FALLBACK_THEME, viewport: VIEWPORT });
    // The box is sized from the occupancy, which the static layer cannot see.
    expect(ctx.ops('fillText').map((c) => c.args[0])).not.toContain('A車庫');
    expect(ctx.ops('setLineDash').some((c) => String(c.args[0]) === '6,4')).toBe(true);
  });

  it('places every station name on a row with no two overlapping', () => {
    const { layout, camera } = makeEnv();
    const ctx = createRecordingContext();
    drawLineStatic(ctx, { layout, camera, theme: FALLBACK_THEME, viewport: VIEWPORT });
    const names = new Set(layout.stations.map((s) => s.name));
    const drawn = ctx
      .ops('fillText')
      .filter((c) => names.has(String(c.args[0])))
      .map((c) => ({ text: String(c.args[0]), x: Number(c.args[1]), y: Number(c.args[2]) }));
    expect(drawn).toHaveLength(layout.stations.length);
    // Same row => the centres must be at least half the two widths apart.
    for (let i = 0; i < drawn.length; i++) {
      for (let j = i + 1; j < drawn.length; j++) {
        const a = drawn[i]!;
        const b = drawn[j]!;
        if (a.y !== b.y) continue;
        const need = (approxTextWidth(a.text, 11) + approxTextWidth(b.text, 11)) / 2;
        expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual(need);
      }
    }
  });

  it('drops the least important names when the line is squeezed', () => {
    const { layout } = makeEnv();
    const squeezed = createCamera({ x: -700, y: -1.5, scaleX: 0.006, scaleY: LANE_HEIGHT });
    const ctx = createRecordingContext();
    drawLineStatic(ctx, { layout, camera: squeezed, theme: FALLBACK_THEME, viewport: VIEWPORT });
    const texts = ctx.ops('fillText').map((c) => String(c.args[0]));
    // The two ends of the line always survive; something in the middle does not.
    expect(texts).toContain('A駅');
    expect(texts).toContain('D駅');
    expect(texts.filter((t) => t.endsWith('駅')).length).toBeLessThan(layout.stations.length);
  });

  it('culls everything when the camera is somewhere else entirely', () => {
    const { layout } = makeEnv();
    const far = createCamera({ x: 9_000_000, y: 0, scaleX: 0.2, scaleY: LANE_HEIGHT });
    const ctx = createRecordingContext();
    drawLineStatic(ctx, { layout, camera: far, theme: FALLBACK_THEME, viewport: VIEWPORT });
    // Only the background fill survives.
    expect(ctx.ops('stroke')).toHaveLength(0);
    expect(ctx.ops('fillRect')).toHaveLength(1);
  });
});

describe('drawLineDynamic', () => {
  it('produces a stable call log', () => {
    const ctx = createRecordingContext();
    drawLineDynamic(ctx, dynamicEnv());
    expect(ctx.lines()).toMatchSnapshot();
  });

  it('draws exactly the active trains — never a pending or finished one', () => {
    const env = dynamicEnv();
    const hits = new HitRects<TrainId>();
    const ctx = createRecordingContext();
    drawLineDynamic(ctx, { ...env, hits });

    const active = env.snapshot.trains.filter(
      (t) => t.phase.phase !== 'pending' && t.phase.phase !== 'finished',
    );
    expect(active.map((t) => t.number).sort()).toEqual(['101', '201']);
    expect(hits.count).toBe(active.length);
  });

  it('marks the 待避 train with an amber ring and a 待避 badge', () => {
    const ctx = createRecordingContext();
    drawLineDynamic(ctx, dynamicEnv());
    const strokes = ctx.ops('set strokeStyle').map((c) => c.args[0]);
    expect(strokes).toContain(FALLBACK_THEME.waitRing);
    expect(ctx.ops('fillText').map((c) => c.args[0])).toContain('待避');
  });

  it('puts the waiting train on a different lane from the train passing it', () => {
    const env = dynamicEnv();
    const waiting = env.snapshot.trains.find((t) => t.number === '101')!;
    const passing = env.snapshot.trains.find((t) => t.number === '201')!;
    const wl = placementOf(env.layout, waiting).lane;
    const pl = placementOf(env.layout, passing).lane;
    expect(wl).not.toBe(pl);
    // The 待避線 sits below the through line.
    expect(wl).toBeGreaterThan(pl);
  });

  it('writes the train label and the formation code', () => {
    const ctx = createRecordingContext();
    drawLineDynamic(ctx, dynamicEnv());
    const texts = ctx.ops('fillText').map((c) => c.args[0]);
    expect(texts).toContain('各 101');
    expect(texts).toContain('急 201');
    expect(texts).toContain('T01F(6)');
  });

  it('hides 回送 when showDeadhead is false', () => {
    const scene = sampleScene(7 * 3600 + 51 * 60); // 回8001 is running
    const env = dynamicEnv({ snapshot: scene.snapshot });
    const shown = new HitRects<TrainId>();
    drawLineDynamic(createRecordingContext(), { ...env, hits: shown });
    expect(shown.count).toBe(1);

    const hidden = new HitRects<TrainId>();
    drawLineDynamic(createRecordingContext(), {
      ...env,
      showDeadhead: false,
      hits: hidden,
    });
    expect(hidden.count).toBe(0);
  });

  it('dashes the border of a non-service move', () => {
    const scene = sampleScene(7 * 3600 + 51 * 60);
    const ctx = createRecordingContext();
    drawLineDynamic(ctx, dynamicEnv({ snapshot: scene.snapshot }));
    expect(ctx.ops('setLineDash').some((c) => Array.isArray(c.args[0]) && (c.args[0] as number[]).length > 0)).toBe(true);
  });

  it('desaturates trains outside the highlighted duty', () => {
    const plain = createRecordingContext();
    drawLineDynamic(plain, dynamicEnv());
    const highlighted = createRecordingContext();
    drawLineDynamic(highlighted, dynamicEnv({ highlightDutyId: TOY.dutyExpress }));
    const dimmedFills = highlighted
      .ops('set fillStyle')
      .map((c) => String(c.args[0]))
      .filter((s) => s.startsWith('rgba('));
    expect(dimmedFills.length).toBeGreaterThan(0);
    expect(highlighted.lines()).not.toEqual(plain.lines());
  });

  it('registers hit rects that match the drawn marker size', () => {
    const env = dynamicEnv();
    const hits = new HitRects<TrainId>();
    drawLineDynamic(createRecordingContext(), { ...env, hits });
    const local = env.snapshot.trains.find((t) => t.number === '101')!;
    const rect = hits.rectOf(local.trainId)!;
    expect(rect.w).toBe(MARKER_W);
    expect(rect.h).toBe(MARKER_H);
    const p = placementOf(env.layout, local);
    expect(rect.x + MARKER_W / 2).toBeCloseTo(worldToScreenX(env.camera, p.x));
  });

  it('names each depot and says how many formations are stabled', () => {
    const ctx = createRecordingContext();
    drawLineDynamic(ctx, dynamicEnv());
    const texts = ctx.ops('fillText').map((c) => String(c.args[0]));
    expect(texts).toContain('A車庫');
    // At the fixture time both toy formations are out, so the yard is empty.
    expect(texts).toContain('留置なし');
  });

  it('counts the stabled formations when the depot is occupied', () => {
    const scene = sampleScene(3 * 3600);
    const ctx = createRecordingContext();
    drawLineDynamic(ctx, dynamicEnv({ snapshot: scene.snapshot }));
    const texts = ctx.ops('fillText').map((c) => String(c.args[0]));
    expect(texts).toContain('A車庫');
    expect(texts.some((t) => /^留置 \d+本$/.test(t))).toBe(true);
  });

  it('never lets two marker boxes on the same lane overlap', () => {
    const env = dynamicEnv({ snapshot: bunched(6) });
    const hits = new HitRects<TrainId>();
    drawLineDynamic(createRecordingContext(), { ...env, hits });
    expect(hits.count).toBe(6);

    const rects = env.snapshot.trains.map((t) => hits.rectOf(t.trainId)!);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        if (a.y !== b.y) continue;
        expect(a.x + a.w <= b.x || b.x + b.w <= a.x).toBe(true);
      }
    }
  });

  it('keeps the digest on the true position when a box has slid', () => {
    const env = dynamicEnv({ snapshot: bunched(6) });
    const hits = new HitRects<TrainId>();
    drawLineDynamic(createRecordingContext(), { ...env, hits });

    const digest = lineTrainPositions(env.layout, env.camera, env.snapshot);
    let moved = 0;
    for (const train of env.snapshot.trains) {
      const truth = digest.find((d) => d.id === train.trainId)!;
      const expected = worldToScreenX(env.camera, placementOf(env.layout, train).x);
      expect(truth.sx).toBe(Math.round(expected));
      if (Math.abs(hits.rectOf(train.trainId)!.x + MARKER_W / 2 - expected) > 1) moved++;
    }
    // …and most boxes really did move, so the assertion above is not vacuous.
    expect(moved).toBeGreaterThanOrEqual(4);
  });

  it('draws a leader that starts at the train, not at the box', () => {
    const env = dynamicEnv({ snapshot: bunched(6) });
    const hits = new HitRects<TrainId>();
    const ctx = createRecordingContext();
    drawLineDynamic(ctx, { ...env, hits });

    const starts = new Set(ctx.ops('moveTo').map((c) => Number(c.args[0])));
    for (const train of env.snapshot.trains) {
      const truth = worldToScreenX(env.camera, placementOf(env.layout, train).x);
      const box = hits.rectOf(train.trainId)!.x + MARKER_W / 2;
      if (Math.abs(box - truth) <= 2) continue;
      expect(starts.has(crisp(truth))).toBe(true);
    }
  });
});

describe('drawLineOverlay', () => {
  it('draws nothing but a clear when there is no hover or selection', () => {
    const { layout, camera } = makeEnv();
    const ctx = createRecordingContext();
    drawLineOverlay(ctx, {
      layout,
      camera,
      theme: FALLBACK_THEME,
      viewport: VIEWPORT,
      hits: new HitRects<TrainId>(),
    });
    expect(ctx.lines()).toEqual(['clearRect(0, 0, 900, 200)']);
  });

  it('rings the hovered and the selected marker', () => {
    const env = dynamicEnv();
    const hits = new HitRects<TrainId>();
    drawLineDynamic(createRecordingContext(), { ...env, hits });
    const ctx = createRecordingContext();
    drawLineOverlay(ctx, {
      layout: env.layout,
      camera: env.camera,
      theme: FALLBACK_THEME,
      viewport: VIEWPORT,
      hits,
      hovered: TOY.localDown,
      selected: new Set([TOY.expressDown]),
    });
    const strokes = ctx.ops('set strokeStyle').map((c) => c.args[0]);
    expect(strokes).toContain(FALLBACK_THEME.hover);
    expect(strokes).toContain(FALLBACK_THEME.selection);
  });
});

describe('digest positions', () => {
  it('are integers and match the camera transform', () => {
    const env = dynamicEnv();
    const trains = lineTrainPositions(env.layout, env.camera, env.snapshot);
    expect(trains).toHaveLength(2);
    for (const t of trains) {
      expect(Number.isInteger(t.sx)).toBe(true);
      expect(Number.isInteger(t.sy)).toBe(true);
    }
    const stations = lineStationPositions(env.layout, env.camera);
    expect(stations.map((s) => s.id)).toEqual([
      TOY.stationA,
      TOY.stationB,
      TOY.stationC,
      TOY.stationD,
    ]);
    expect(stations).toMatchSnapshot();
  });

  it('moves a train to the right as the clock advances', () => {
    const layout = computeLineLayout(sampleScene().doc);
    const camera = createCamera({ x: -700, y: 0, scaleX: 0.2, scaleY: LANE_HEIGHT });
    const at = (t: number): number => {
      const s = sampleScene(t);
      const express = s.snapshot.trains.find((r) => r.number === '201') as TrainRuntime;
      return worldToScreenX(camera, placementOf(layout, express).x);
    };
    expect(at(8 * 3600 + 5 * 60)).toBeLessThan(at(8 * 3600 + 6 * 60 + 30));
  });
});
