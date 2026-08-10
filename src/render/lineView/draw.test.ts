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
import { createRecordingContext, type RecordingContext } from '../canvas/recordingContext';
import { approxTextWidth } from '../canvas/textCache';
import { FALLBACK_THEME } from '../canvas/theme';
import {
  drawLineDynamic,
  drawLineOverlay,
  drawLineStatic,
  lineStationPositions,
  lineTrainPositions,
  TRAIN_DOT_R,
  TRAIN_LABEL_DRIFT,
  TRAIN_LABEL_H,
  TRAIN_LABEL_PITCH,
  placementOf,
  type LineDynamicEnv,
} from './draw';
import { computeLineLayout, laneCenterY, LANE_HEIGHT } from './layout';

const VIEWPORT = { width: 900, height: 200 };

/**
 * Every rounded rect of exactly `h` px in the call log, as a rectangle.
 *
 * `roundRectPath` emits a fixed nine-op sequence, so the geometry can be read
 * straight back out of the recording — which is how the label plates (and only
 * the label plates, by their height) are recovered for the overlap checks.
 */
function platesOf(
  ctx: RecordingContext,
  h = TRAIN_LABEL_H,
): Array<{ x: number; y: number; w: number; h: number }> {
  const out: Array<{ x: number; y: number; w: number; h: number }> = [];
  const calls = ctx.calls;
  for (let i = 0; i + 8 < calls.length; i++) {
    if (calls[i]!.op !== 'moveTo' || calls[i + 8]!.op !== 'quadraticCurveTo') continue;
    if (calls[i + 9]?.op !== 'closePath') continue;
    const top = Number(calls[i]!.args[1]);
    const right = Number(calls[i + 2]!.args[0]);
    const bottom = Number(calls[i + 4]!.args[1]);
    const left = Number(calls[i + 6]!.args[0]);
    if (Math.abs(bottom - top - h) > 1e-6) continue;
    out.push({ x: left, y: top, w: right - left, h: bottom - top });
  }
  return out;
}

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

  it('draws the yard throat but leaves the name plate to the dynamic layer', () => {
    const { layout, camera } = makeEnv();
    const ctx = createRecordingContext();
    drawLineStatic(ctx, { layout, camera, theme: FALLBACK_THEME, viewport: VIEWPORT });
    // The plate carries the live count, which the static layer cannot see.
    expect(ctx.ops('fillText').map((c) => c.args[0])).not.toContain('A車庫');
    expect(ctx.ops('setLineDash').some((c) => String(c.args[0]) === '6,4')).toBe(true);
  });

  it('leads the throat off both running lines', () => {
    const { layout, camera } = makeEnv();
    const ctx = createRecordingContext();
    drawLineStatic(ctx, { layout, camera, theme: FALLBACK_THEME, viewport: VIEWPORT });
    const yard = layout.depots[0]!;
    const junction = worldToScreenX(camera, yard.junctionX);
    const starts = ctx.ops('moveTo').map((c) => Number(c.args[0]));
    // Two throat legs leave the junction: 出庫 and 入庫 use both directions.
    expect(starts.filter((x) => Math.abs(x - junction) < 0.6).length).toBeGreaterThanOrEqual(2);
  });

  it('draws every road of the yard, and names them once they are long enough', () => {
    const { layout } = makeEnv();
    const yard = layout.depots[0]!;
    expect(yard.tracks).toHaveLength(1);

    const zoomed = createCamera({ x: yard.endX - 200, y: 0, scaleX: 2, scaleY: LANE_HEIGHT });
    const ctx = createRecordingContext();
    drawLineStatic(ctx, {
      layout,
      camera: zoomed,
      theme: FALLBACK_THEME,
      viewport: { width: 1400, height: 600 },
    });
    const texts = ctx.ops('fillText').map((c) => String(c.args[0]));
    expect(texts).toContain('留置1番');
  });

  it('joins a 待避線 to the running line at both ends', () => {
    const { layout, camera } = makeEnv();
    const ctx = createRecordingContext();
    drawLineStatic(ctx, { layout, camera, theme: FALLBACK_THEME, viewport: VIEWPORT });

    const loop = layout.stations
      .find((s) => s.stationId === TOY.stationC)!
      .trackLanes.find((l) => l.trackId === TOY.c2)!;
    const runY = crisp(laneCenterY(layout.laneDown, camera.y, camera.scaleY));
    const loopY = crisp(laneCenterY(loop.index, camera.y, camera.scaleY));
    const entry = worldToScreenX(camera, loop.x0);
    const bodyStart = worldToScreenX(camera, loop.bodyX0);
    expect(entry).toBeLessThan(bodyStart);

    // The entry lead runs from the running lane at the block edge down onto
    // the loop — without it the 待避線 would be a segment with no way in.
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.6;
    const drawn = ctx.calls.some(
      (call, i) =>
        call.op === 'moveTo' &&
        near(Number(call.args[0]), entry) &&
        near(Number(call.args[1]), runY) &&
        ctx.calls[i + 1]?.op === 'lineTo' &&
        near(Number(ctx.calls[i + 1]!.args[0]), bodyStart) &&
        near(Number(ctx.calls[i + 1]!.args[1]), loopY),
    );
    expect(drawn).toBe(true);
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

  it('marks the 待避 train with an amber ring and says 待避 in its label', () => {
    const ctx = createRecordingContext();
    drawLineDynamic(ctx, dynamicEnv());
    const strokes = ctx.ops('set strokeStyle').map((c) => c.args[0]);
    expect(strokes).toContain(FALLBACK_THEME.waitRing);
    expect(ctx.ops('fillText').map((c) => String(c.args[0])).join(' ')).toContain('待避');
  });

  it('puts a dot exactly where the train is, and never anywhere else', () => {
    const env = dynamicEnv();
    const ctx = createRecordingContext();
    drawLineDynamic(ctx, env);
    const dots = ctx.ops('arc').map((c) => ({ x: Number(c.args[0]), y: Number(c.args[1]) }));
    for (const train of env.snapshot.trains) {
      if (train.phase.phase === 'pending' || train.phase.phase === 'finished') continue;
      const p = placementOf(env.layout, train);
      const sx = worldToScreenX(env.camera, p.x);
      const sy = laneCenterY(p.lane, env.camera.y, env.camera.scaleY);
      expect(
        dots.some((d) => Math.abs(d.x - sx) < 1e-6 && Math.abs(d.y - sy) < 1e-6),
        `no dot at ${train.number}'s position`,
      ).toBe(true);
    }
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
    const texts = ctx.ops('fillText').map((c) => String(c.args[0]));
    expect(texts).toContain('▶各 101');
    expect(texts.some((t) => t.startsWith('T01F(6)'))).toBe(true);
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

  it('draws a non-service move as a hollow dot', () => {
    const scene = sampleScene(7 * 3600 + 51 * 60); // 回8001 is running
    const ctx = createRecordingContext();
    drawLineDynamic(ctx, dynamicEnv({ snapshot: scene.snapshot }));
    // Filled with the background and stroked in the type colour — the exact
    // inverse of a service train, which is filled with the type colour.
    const i = ctx.calls.findIndex((c) => c.op === 'arc');
    const after = ctx.calls.slice(i);
    expect(after.find((c) => c.op === 'set fillStyle')?.args[0]).toBe(FALLBACK_THEME.bg);
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

  it('registers a hit rect centred on the train, covering its label', () => {
    const env = dynamicEnv();
    const hits = new HitRects<TrainId>();
    drawLineDynamic(createRecordingContext(), { ...env, hits });
    const local = env.snapshot.trains.find((t) => t.number === '101')!;
    const rect = hits.rectOf(local.trainId)!;
    const p = placementOf(env.layout, local);
    const sx = worldToScreenX(env.camera, p.x);
    const sy = laneCenterY(p.lane, env.camera.y, env.camera.scaleY);
    expect(rect.x + rect.w / 2).toBeCloseTo(sx);
    expect(rect.h).toBeGreaterThanOrEqual(TRAIN_DOT_R * 2);
    // The dot is inside it, and so is the label row it was given.
    expect(rect.y).toBeLessThanOrEqual(sy);
    expect(rect.y + rect.h).toBeGreaterThanOrEqual(sy);
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

  it('stands each stabled formation on the road the plan berths it on', () => {
    const { layout, trainTypes, formations } = makeEnv();
    const scene = sampleScene(3 * 3600);
    const yard = layout.depots[0]!;
    const roadLane = layout.laneOfTrack.get(TOY.x1)!;
    // Zoomed into the yard, so there is room for the codes themselves.
    const camera = createCamera({ x: yard.endX - 100, y: 0, scaleX: 2, scaleY: LANE_HEIGHT });
    const ctx = createRecordingContext();
    drawLineDynamic(ctx, {
      layout,
      camera,
      theme: FALLBACK_THEME,
      viewport: { width: 1400, height: 700 },
      snapshot: scene.snapshot,
      trainTypes,
      formations,
      showDeadhead: true,
    });

    const codes = ctx.ops('fillText').filter((c) => String(c.args[0]).endsWith('F'));
    expect(codes.length).toBeGreaterThan(0);
    // T01F's duty leaves the yard from 留置1番, so it is drawn on that road…
    const onRoad = codes.find((c) => c.args[0] === 'T01F')!;
    expect(Number(onRoad.args[2])).toBeCloseTo(
      laneCenterY(roadLane, camera.y, camera.scaleY),
      3,
    );
    // …and T02F, whose duty never touches the yard, sits on the yard lead.
    const onLead = codes.find((c) => c.args[0] === 'T02F')!;
    expect(Number(onLead.args[2])).toBeCloseTo(
      laneCenterY(yard.leadLane, camera.y, camera.scaleY),
      3,
    );
  });

  it('keeps the terminated train on screen, badged 折返, until its stock leaves', () => {
    // 各101 arrives D at 08:10:30; 回8002 takes the same stock out at 08:20.
    const scene = sampleScene(8 * 3600 + 15 * 60);
    const env = dynamicEnv({ snapshot: scene.snapshot });
    const hits = new HitRects<TrainId>();
    const ctx = createRecordingContext();
    drawLineDynamic(ctx, { ...env, hits });

    const texts = ctx.ops('fillText').map((c) => String(c.args[0]));
    expect(texts).toContain('▶各 101');
    expect(texts.join(' ')).toContain('折返');
    expect(hits.rectOf(TOY.localDown)).toBeDefined();
    // The successor has not started, so exactly one marker is on the platform.
    expect(hits.rectOf(TOY.depotIn)).toBeUndefined();
  });

  it('never moves a bunched train — every dot stays on its own position', () => {
    // Six trains 30 m apart is 6 px at the fixture camera and the labels are
    // an order of magnitude wider. The old marker slid along the lane to make
    // room; the dot must not.
    const env = dynamicEnv({ snapshot: bunched(6) });
    const ctx = createRecordingContext();
    drawLineDynamic(ctx, env);

    const dots = ctx.ops('arc').map((c) => Number(c.args[0]));
    for (const train of env.snapshot.trains) {
      const sx = worldToScreenX(env.camera, placementOf(env.layout, train).x);
      expect(dots.some((x) => Math.abs(x - sx) < 1e-6), `${train.number} moved`).toBe(true);
    }
    // …and they are genuinely six distinct, tightly packed positions.
    expect(new Set(dots.map((x) => Math.round(x * 1000))).size).toBe(6);
  });

  it('never overlaps two labels, and drops the ones it cannot place', () => {
    const env = dynamicEnv({ snapshot: bunched(6) });
    const ctx = createRecordingContext();
    drawLineDynamic(ctx, env);

    // Every label is drawn on its own background plate, so the plates are the
    // label boxes. No two of them may intersect.
    const plates = platesOf(ctx);
    expect(plates.length).toBeGreaterThan(0);
    expect(plates.length).toBeLessThanOrEqual(6);
    for (let i = 0; i < plates.length; i++) {
      for (let j = i + 1; j < plates.length; j++) {
        const a = plates[i]!;
        const b = plates[j]!;
        const clear =
          a.x + a.w <= b.x + 1e-9 ||
          b.x + b.w <= a.x + 1e-9 ||
          a.y + a.h <= b.y + 1e-9 ||
          b.y + b.h <= a.y + 1e-9;
        expect(clear, `labels ${i} and ${j} overlap`).toBe(true);
      }
    }
  });

  it('keeps every label within a few rows of its own train', () => {
    const env = dynamicEnv({ snapshot: bunched(6) });
    const ctx = createRecordingContext();
    drawLineDynamic(ctx, env);
    const lane = placementOf(env.layout, env.snapshot.trains[0]!).lane;
    const sy = laneCenterY(lane, env.camera.y, env.camera.scaleY);
    for (const plate of platesOf(ctx)) {
      // A label further away than the drift limit would look like it belonged
      // to a different train, which is worse than no label.
      expect(Math.abs(plate.y + plate.h / 2 - sy)).toBeLessThan(
        (TRAIN_LABEL_DRIFT + 2) * TRAIN_LABEL_PITCH,
      );
    }
  });

  it('reports the true position in the digest, whatever the labels did', () => {
    const env = dynamicEnv({ snapshot: bunched(6) });
    const digest = lineTrainPositions(env.layout, env.camera, env.snapshot);
    for (const train of env.snapshot.trains) {
      const truth = digest.find((d) => d.id === train.trainId)!;
      const expected = worldToScreenX(env.camera, placementOf(env.layout, train).x);
      expect(truth.sx).toBe(Math.round(expected));
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

  it('never teleports a train, in x or across the lanes', () => {
    // The complaint this exists for: a train that jumps a lane the instant it
    // departs, snaps onto a station it is passing, or slides along the bottom
    // of the picture for the whole of a depot run.
    const layout = computeLineLayout(sampleScene().doc);
    const STEP = 1;
    // Half a lane per second still reads as movement; the jumps this test is
    // about were a whole lane — or three, into the yard — in a single frame.
    const MAX_LANE_STEP = 0.5;
    // 110 km/h is 31 m/s, so a second is at most ~31 m of line.
    const MAX_X_STEP = 40;

    for (const id of [TOY.localDown, TOY.expressDown, TOY.depotOut, TOY.depotIn]) {
      let prev: { x: number; lane: number } | undefined;
      let seen = 0;
      for (let t = 7 * 3600; t <= 8 * 3600 + 35 * 60; t += STEP) {
        const train = sampleScene(t).snapshot.trains.find((r) => r.trainId === id);
        const drawn =
          train !== undefined &&
          train.phase.phase !== 'pending' &&
          train.phase.phase !== 'finished';
        if (!drawn) {
          prev = undefined;
          continue;
        }
        seen++;
        const p = placementOf(layout, train);
        if (prev !== undefined) {
          expect(Math.abs(p.lane - prev.lane), `${id} lane at ${t}`).toBeLessThan(
            MAX_LANE_STEP,
          );
          expect(Math.abs(p.x - prev.x), `${id} x at ${t}`).toBeLessThan(MAX_X_STEP);
        }
        prev = { x: p.x, lane: p.lane };
      }
      expect(seen, `${id} was never drawn`).toBeGreaterThan(0);
    }
  });

  it('hands a turnback over without a gap and without a jump', () => {
    const layout = computeLineLayout(sampleScene().doc);
    const at = (t: number): Array<{ id: string; x: number; lane: number }> =>
      sampleScene(t)
        .snapshot.trains.filter(
          (r) =>
            r.formationId === TOY.formation1 &&
            r.phase.phase !== 'pending' &&
            r.phase.phase !== 'finished',
        )
        .map((r) => ({ id: r.trainId, ...placementOf(layout, r) }));

    // Across 各101 → 回8002 at D, the formation is drawn exactly once and the
    // marker does not move when the identity changes.
    let prev: { id: string; x: number; lane: number } | undefined;
    for (let t = 8 * 3600 + 10 * 60; t <= 8 * 3600 + 21 * 60; t += 2) {
      const drawn = at(t);
      expect(drawn, `at ${t}`).toHaveLength(1);
      const now = drawn[0]!;
      if (prev !== undefined && prev.id !== now.id) {
        expect(now.x).toBeCloseTo(prev.x, 6);
        expect(now.lane).toBeCloseTo(prev.lane, 6);
      }
      prev = now;
    }
    // …and the handover really did happen inside the window.
    expect(at(8 * 3600 + 15 * 60)[0]!.id).toBe(TOY.localDown);
    expect(at(8 * 3600 + 21 * 60)[0]!.id).toBe(TOY.depotIn);
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
