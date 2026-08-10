/**
 * Line view drawing. Pure functions of `(ctx, env)` — no DOM lookups, no
 * globals, no canvas of their own, so `draw.test.ts` can run every one of them
 * against a recording context in a node process.
 *
 * Every coordinate is converted with explicit `worldToScreenX/Y` arithmetic.
 * The context transform is only ever the DPR base transform set by
 * `useCanvasLayers`, which is what keeps text, marker sizes and stroke widths
 * constant as the line zooms.
 *
 * The module-level scratch objects below are the one exception to "no
 * globals". They are reusable solver buffers, fully reset at the top of the
 * draw that uses them, so a draw's output still depends only on its arguments
 * — they exist because the alternative is allocating a few hundred bytes of
 * garbage sixty times a second.
 */

import type { FormationId, TrainId, TrainTypeId } from '@/domain/ids';
import type { Formation, TrainType } from '@/domain/model';
import type { SimSnapshot, TrainRuntime } from '@/engine/types';
import type { Camera2D, Viewport } from '../canvas/camera';
import { crisp, worldToScreenX } from '../canvas/camera';
import type { HitRects } from '../canvas/hit';
import type { DrawContext } from '../canvas/recordingContext';
import { roundRectPath } from '../canvas/recordingContext';
import { drawLabel, measuredTextWidth } from '../canvas/textCache';
import type { RenderTheme } from '../canvas/theme';
import { contrastText, desaturate, withAlpha } from '../canvas/theme';
import {
  depotPlateLayout,
  DEPOT_PLATE_PAD,
  DROPPED,
  LABEL_ROW_PITCH,
  laneCenterY,
  MarkerSlots,
  placeTrainInto,
  StationLabelPlacer,
  type DepotLane,
  type LineLayout,
  type PlaceTrainArgs,
  type TrainPlacement,
} from './layout';

/**
 * Train marker box, CSS pixels. Constant under zoom by design.
 *
 * Two text rows: the train label, and the 編成 underneath it. Keeping the
 * formation code *inside* the box rather than floating below it means a
 * cluster of markers cannot interleave its labels with its neighbours', and
 * frees the strip under the box for the true-position tick.
 */
export const MARKER_W = 92;
export const MARKER_H = 26;
const MARKER_R = 6;
/** Minimum clear space between two marker boxes on the same lane. */
export const MARKER_GAP = 5;
/** A box displaced by less than this is treated as sitting on its train. */
const SHIFT_EPSILON = 1.5;

const LABEL_FONT = 'bold 11px system-ui, sans-serif';
const SUB_FONT = '9px ui-monospace, monospace';
const STATION_FONT = 'bold 11px system-ui, sans-serif';
const STATION_FONT_MINOR = '11px system-ui, sans-serif';
const TRACK_FONT = '9px system-ui, sans-serif';
const DEPOT_FONT = 'bold 10px system-ui, sans-serif';

/** Reusable solver buffers — see the file header. */
const labelPlacer = new StationLabelPlacer();
const markerSlots = new MarkerSlots();
const placeArgs: PlaceTrainArgs = { km: 0, direction: 'down' };
const placement: TrainPlacement = { x: 0, lane: 0 };
const NO_FORMATIONS: readonly FormationId[] = [];

export interface LineDrawEnv {
  layout: LineLayout;
  camera: Camera2D;
  theme: RenderTheme;
  viewport: Viewport;
}

export interface LineDynamicEnv extends LineDrawEnv {
  snapshot: SimSnapshot;
  trainTypes: Map<TrainTypeId, TrainType>;
  formations: Map<string, Formation>;
  /** Filled during the draw and used for hit testing; reset by the caller. */
  hits?: HitRects<TrainId>;
  /** Everything not on this duty is desaturated. */
  highlightDutyId?: string;
  showDeadhead: boolean;
  selected?: ReadonlySet<string>;
}

export interface LineOverlayEnv extends LineDrawEnv {
  hits: HitRects<TrainId>;
  hovered?: TrainId;
  selected?: ReadonlySet<string>;
}

function laneY(env: LineDrawEnv, lane: number): number {
  return laneCenterY(lane, env.camera.y, env.camera.scaleY);
}

/** Screen y of the top edge of lane 0 — the floor of the station-name band. */
function laneStackTop(env: LineDrawEnv): number {
  return (0 - env.camera.y) * env.camera.scaleY;
}

function visible(x0: number, x1: number, viewport: Viewport, slop = 60): boolean {
  return x1 >= -slop && x0 <= viewport.width + slop;
}

// ---------------------------------------------------------------------------
// Static layer
// ---------------------------------------------------------------------------

/**
 * Rails, station blocks, platforms and their turnout leads, 待避線 tinting,
 * the yards, and the station name band.
 *
 * Redrawn only when the camera or the document changes — never on a clock
 * tick. Nothing here depends on `t`.
 */
export function drawLineStatic(ctx: DrawContext, env: LineDrawEnv): void {
  const { layout, camera, theme, viewport } = env;

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  // -- open-line rails ------------------------------------------------------
  ctx.lineCap = 'butt';
  for (const lane of layout.lanes) {
    if (lane.kind !== 'section') continue;
    const sx0 = worldToScreenX(camera, lane.x0);
    const sx1 = worldToScreenX(camera, lane.x1);
    if (!visible(sx0, sx1, viewport)) continue;
    const y = crisp(laneY(env, lane.index));
    ctx.strokeStyle = theme.rail;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(sx0, y);
    ctx.lineTo(sx1, y);
    ctx.stroke();
    drawDirectionTicks(ctx, sx0, sx1, y, lane.direction, theme);
  }

  // -- yards ----------------------------------------------------------------
  // Every road of every depot, fanned out of a throat off the main line. The
  // name plate is on the dynamic layer, because it carries the live count.
  for (const yard of layout.depots) drawYard(ctx, env, yard);

  // -- station blocks -------------------------------------------------------
  // Names hang off the top of the lane stack. How many rows they get depends
  // on how much band is actually on screen, so a short canvas degrades to one
  // row and drops more names rather than writing over the rails.
  const stackTop = laneStackTop(env);
  const bandFloor = stackTop - 7;
  const rows = Math.max(1, Math.min(2, Math.floor((stackTop - 2) / LABEL_ROW_PITCH)));
  planStationLabels(env, rows);

  for (let i = 0; i < layout.stations.length; i++) {
    const station = layout.stations[i]!;
    const sx0 = worldToScreenX(camera, station.x0);
    const sx1 = worldToScreenX(camera, station.x1);
    if (!visible(sx0, sx1, viewport)) continue;

    const topY = laneY(env, station.laneFrom) - camera.scaleY / 2;
    const botY = laneY(env, station.laneTo) + camera.scaleY / 2;
    const row = labelPlacer.rowAt(i);
    const labelBaseY = bandFloor - (rows - 1 - row) * LABEL_ROW_PITCH;

    // Vertical station rule. It runs all the way up to the label when there is
    // one, so a name on the upper row is unambiguously tied to its station.
    const cx = crisp(worldToScreenX(camera, station.x));
    const ruleTop = row === DROPPED ? topY - 8 : labelBaseY + 2;
    ctx.strokeStyle = station.isConnectionPoint ? theme.accent : theme.gridStrong;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, Math.min(ruleTop, topY - 8));
    ctx.lineTo(cx, botY);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const lane of station.trackLanes) {
      const y = crisp(laneY(env, lane.index));
      const bx0 = worldToScreenX(camera, lane.bodyX0);
      const bx1 = worldToScreenX(camera, lane.bodyX1);

      // 待避線 gets its own tint: spotting the passing loop must not require
      // reading the track name.
      if (lane.canBeOvertaken) {
        ctx.fillStyle = withAlpha(theme.overtakeTrack, 0.14);
        ctx.fillRect(sx0, y - camera.scaleY / 2 + 1, sx1 - sx0, camera.scaleY - 2);
      }

      if (lane.hasPlatform && bx1 - bx0 > 6) {
        ctx.fillStyle = withAlpha(theme.platform, 0.35);
        ctx.fillRect(bx0 + 2, y - 9, bx1 - bx0 - 4, 4);
      }

      // The leads into the running lanes this road serves. Without them a
      // 待避線 is a segment floating beside the railway with no way on or off,
      // and the train that swings into it has nothing to swing along.
      if (lane.leadLanes.length > 0) {
        ctx.strokeStyle = theme.railDim;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (const running of lane.leadLanes) {
          const ry = crisp(laneY(env, running));
          ctx.moveTo(sx0, ry);
          ctx.lineTo(bx0, y);
          ctx.moveTo(bx1, y);
          ctx.lineTo(sx1, ry);
        }
        ctx.stroke();
      }

      ctx.strokeStyle = lane.canBeOvertaken
        ? theme.overtakeTrack
        : lane.hasPlatform
          ? theme.rail
          : theme.railDim;
      ctx.lineWidth = lane.hasPlatform ? 4 : 2;
      ctx.beginPath();
      ctx.moveTo(bx0, y);
      ctx.lineTo(bx1, y);
      ctx.stroke();

      if (bx1 - bx0 > 40) {
        drawLabel(ctx, lane.label, bx0 + 3, y + 9, TRACK_FONT, theme.textFaint, {
          themeKey: theme.key,
        });
      }
    }

    if (row === DROPPED) continue;
    drawLabel(
      ctx,
      station.name,
      cx,
      labelBaseY,
      station.isMajorStop ? STATION_FONT : STATION_FONT_MINOR,
      station.isMajorStop ? theme.text : theme.textDim,
      { align: 'center', baseline: 'bottom', themeKey: theme.key },
    );
  }
}

/**
 * Feed every station name into the shared placer and solve.
 *
 * Widths come from `measuredTextWidth`, which memoizes by font and string —
 * the station names are a fixed set, so after the first draw this is a map
 * lookup rather than a text-shaping call.
 */
function planStationLabels(env: LineDrawEnv, rows: number): void {
  const { layout, camera } = env;
  labelPlacer.reset(rows);
  for (const station of layout.stations) {
    const font = station.isMajorStop ? STATION_FONT : STATION_FONT_MINOR;
    labelPlacer.push(
      worldToScreenX(camera, station.x),
      measuredTextWidth(station.name, font),
      station.labelPriority,
    );
  }
  labelPlacer.solve();
}

/**
 * One yard: the throat off both running lines, the ladder, and every road.
 *
 * The roads are the point. A depot used to be a single lane with a box on it,
 * which meant the ten stabling roads at 鷺沼車庫 — and which formation was on
 * which — were simply not in the picture, and a 回送 disappeared into a caption
 * the moment it arrived.
 */
function drawYard(ctx: DrawContext, env: LineDrawEnv, yard: DepotLane): void {
  const { layout, camera, theme, viewport } = env;
  const sx0 = worldToScreenX(camera, yard.x0);
  const sx1 = worldToScreenX(camera, yard.x1);
  if (!visible(sx0, sx1, viewport)) return;

  const jx = worldToScreenX(camera, yard.junctionX);
  const rx = worldToScreenX(camera, yard.rootX);
  const tx = worldToScreenX(camera, yard.throatX);
  const ex = worldToScreenX(camera, yard.endX);
  const ry = crisp(laneY(env, yard.rootLane));

  // Both running lines lead into the yard: 出庫 and 入庫 happen in both
  // directions, and the dashes say "this is not running line".
  ctx.strokeStyle = theme.railDim;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(jx, crisp(laneY(env, layout.laneDown)));
  ctx.lineTo(rx, ry);
  ctx.moveTo(jx, crisp(laneY(env, layout.laneUp)));
  ctx.lineTo(rx, ry);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.lineWidth = 1.5;
  for (const road of yard.tracks) {
    const y = crisp(laneY(env, road.index));
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.lineTo(tx, y);
    ctx.lineTo(ex, y);
    ctx.stroke();
  }

  // Road names only once the road is long enough to hold one — a yard is a
  // few hundred metres of a line tens of kilometres long, so at the fitted
  // zoom the names appear as the reader zooms into the depot.
  const room = Math.abs(ex - tx);
  for (const road of yard.tracks) {
    if (measuredTextWidth(road.label, TRACK_FONT) + 8 > room) continue;
    const y = crisp(laneY(env, road.index));
    drawLabel(ctx, road.label, Math.min(tx, ex) + 4, y - 2, TRACK_FONT, theme.textFaint, {
      baseline: 'bottom',
      themeKey: theme.key,
    });
  }
}

/** Small chevrons along a running lane, so the direction is never ambiguous. */
function drawDirectionTicks(
  ctx: DrawContext,
  sx0: number,
  sx1: number,
  y: number,
  direction: 'down' | 'up',
  theme: RenderTheme,
): void {
  const mid = (sx0 + sx1) / 2;
  if (sx1 - sx0 < 30) return;
  const dir = direction === 'down' ? 1 : -1;
  ctx.strokeStyle = theme.textFaint;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(mid - 4 * dir, y - 4);
  ctx.lineTo(mid + 4 * dir, y);
  ctx.lineTo(mid - 4 * dir, y + 4);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Dynamic layer
// ---------------------------------------------------------------------------

/**
 * Should this train be drawn at all, at this instant, with these filters?
 *
 * `layover` counts: the train has arrived but its stock is standing at the
 * platform waiting to form the next one, and dropping the marker for those
 * minutes is what used to make a formation vanish at every 折り返し.
 */
function isDrawn(train: TrainRuntime, showDeadhead: boolean): boolean {
  if (train.phase.phase === 'pending' || train.phase.phase === 'finished') return false;
  return showDeadhead || train.category === 'service';
}

/**
 * Train markers and depot boxes. Redrawn every frame while the clock runs.
 *
 * Two passes over the snapshot: the first places every visible train and hands
 * the positions to `MarkerSlots`, the second draws using the de-overlapped
 * result. The passes use the same predicate and the same order, so slot `k` in
 * the second pass is slot `k` from the first without an index array.
 *
 * Pending trains are not drawn at all — a 未出庫 train has no position, and
 * parking them all at the origin would be a lie.
 */
export function drawLineDynamic(ctx: DrawContext, env: LineDynamicEnv): void {
  const { layout, camera, viewport, snapshot, hits } = env;

  ctx.clearRect(0, 0, viewport.width, viewport.height);
  drawDepots(ctx, env);

  markerSlots.reset();
  for (const train of snapshot.trains) {
    if (!isDrawn(train, env.showDeadhead)) continue;
    placementInto(layout, train, placement);
    const sx = worldToScreenX(camera, placement.x);
    if (sx < -MARKER_W || sx > viewport.width + MARKER_W) continue;
    markerSlots.push(placement.lane, sx);
  }
  markerSlots.solve(MARKER_W, MARKER_GAP);

  let slot = 0;
  for (const train of snapshot.trains) {
    if (!isDrawn(train, env.showDeadhead)) continue;
    placementInto(layout, train, placement);
    const sx = worldToScreenX(camera, placement.x);
    if (sx < -MARKER_W || sx > viewport.width + MARKER_W) continue;

    const i = slot++;
    const boxX = markerSlots.xAt(i);
    const sy = laneY(env, placement.lane);
    const dimmed =
      env.highlightDutyId !== undefined && train.dutyId !== env.highlightDutyId;
    drawTrainMarker(ctx, env, train, boxX, sx, sy, dimmed);
    hits?.push(train.trainId, boxX - MARKER_W / 2, sy - MARKER_H / 2, MARKER_W, MARKER_H);
  }
}

/** Where a runtime train sits in world space, written into `out`. */
function placementInto(
  layout: LineLayout,
  train: TrainRuntime,
  out: TrainPlacement,
): TrainPlacement {
  const phase = train.phase;
  placeArgs.km = train.km;
  placeArgs.direction = train.direction;
  placeArgs.stationId = undefined;
  placeArgs.trackId = undefined;
  placeArgs.fromStationId = undefined;
  placeArgs.toStationId = undefined;
  placeArgs.fromTrackId = undefined;
  placeArgs.toTrackId = undefined;
  placeArgs.trackBlend = undefined;

  if (phase.phase === 'dwelling') {
    placeArgs.stationId = phase.stationId;
    placeArgs.trackId = phase.trackId;
    placeArgs.km = phase.km;
  } else if (phase.phase === 'layover') {
    placeArgs.stationId = phase.stationId;
    placeArgs.trackId = phase.trackId;
    placeArgs.km = phase.km;
    placeArgs.fromTrackId = phase.fromTrackId;
    placeArgs.trackBlend = phase.shunt;
  } else if (phase.phase === 'running') {
    placeArgs.fromStationId = phase.fromStationId;
    placeArgs.toStationId = phase.toStationId;
    placeArgs.fromTrackId = phase.fromTrackId;
    placeArgs.toTrackId = phase.toTrackId;
    placeArgs.km = phase.km;
  } else if (phase.phase === 'passing') {
    placeArgs.km = phase.km;
    // 通過 is an annotation on a leg, so it is placed as a leg — falling back
    // to the station itself only for a pass with no leg after it.
    if (phase.fromStationId !== undefined && phase.toStationId !== undefined) {
      placeArgs.fromStationId = phase.fromStationId;
      placeArgs.toStationId = phase.toStationId;
      placeArgs.fromTrackId = phase.fromTrackId;
      placeArgs.toTrackId = phase.toTrackId;
    } else {
      placeArgs.stationId = phase.stationId;
      placeArgs.trackId = phase.trackId;
    }
  }
  return placeTrainInto(layout, placeArgs, out);
}

/** Where a runtime train sits in world space. */
export function placementOf(
  layout: LineLayout,
  train: TrainRuntime,
): { x: number; lane: number } {
  return placementInto(layout, train, { x: 0, lane: 0 });
}

function drawTrainMarker(
  ctx: DrawContext,
  env: LineDynamicEnv,
  train: TrainRuntime,
  cx: number,
  anchorX: number,
  cy: number,
  dimmed: boolean,
): void {
  const { theme } = env;
  const type = env.trainTypes.get(train.typeId);
  const baseColor = type?.color ?? theme.accent;
  const color = dimmed ? withAlpha(desaturate(baseColor, 0.8), 0.35) : baseColor;
  const x = cx - MARKER_W / 2;
  const y = cy - MARKER_H / 2;

  const phase = train.phase;
  const waiting = phase.phase === 'dwelling' && phase.reason === 'overtakeWait';
  // 折返 is the other state worth calling out: this train has arrived, and
  // what the reader is looking at is its stock waiting to become the next one.
  const badge = waiting ? '待避' : phase.phase === 'layover' ? '折返' : undefined;

  // The box has slid along the lane to avoid its neighbours, so say where the
  // train actually is: a tick at the true km plus a leader back to the box.
  if (Math.abs(cx - anchorX) > SHIFT_EPSILON) {
    const tickY = cy + MARKER_H / 2;
    ctx.strokeStyle = dimmed ? withAlpha(theme.textFaint, 0.5) : withAlpha(baseColor, 0.95);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(crisp(anchorX), tickY - 3);
    ctx.lineTo(crisp(anchorX), tickY + 6);
    ctx.lineTo(crisp(cx), tickY + 6);
    ctx.stroke();
  }

  // 待避中 ring FIRST, so the marker sits inside it.
  if (waiting && !dimmed) {
    ctx.strokeStyle = theme.waitRing;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([]);
    roundRectPath(ctx, x - 4, y - 4, MARKER_W + 8, MARKER_H + 8, MARKER_R + 3);
    ctx.stroke();
  }

  ctx.fillStyle = color;
  roundRectPath(ctx, x, y, MARKER_W, MARKER_H, MARKER_R);
  ctx.fill();

  // 回送 / 試運転 get a hatched (dashed) border — a non-revenue move should
  // never be mistaken for a service train.
  if (train.category !== 'service') {
    ctx.strokeStyle = dimmed ? withAlpha(theme.hatch, 0.4) : theme.hatch;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    roundRectPath(ctx, x + 1, y + 1, MARKER_W - 2, MARKER_H - 2, MARKER_R - 1);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Direction chevron at the leading edge.
  const dir = train.direction === 'down' ? 1 : -1;
  const tipX = cx + dir * (MARKER_W / 2 - 6);
  ctx.fillStyle = withAlpha('#ffffff', dimmed ? 0.35 : 0.85);
  ctx.beginPath();
  ctx.moveTo(tipX, cy);
  ctx.lineTo(tipX - dir * 6, cy - 5);
  ctx.lineTo(tipX - dir * 6, cy + 5);
  ctx.closePath();
  ctx.fill();

  const textColor = dimmed ? withAlpha(theme.text, 0.4) : contrastText(baseColor);
  const textX = cx - dir * 6;
  const sub =
    train.formationCode !== undefined
      ? train.cars !== undefined
        ? `${train.formationCode}(${train.cars})`
        : train.formationCode
      : undefined;

  if (sub === undefined) {
    drawLabel(ctx, train.label, textX, cy + 0.5, LABEL_FONT, textColor, {
      align: 'center',
      baseline: 'middle',
      themeKey: theme.key,
    });
  } else {
    drawLabel(ctx, train.label, textX, cy - 1, LABEL_FONT, textColor, {
      align: 'center',
      baseline: 'bottom',
      themeKey: theme.key,
    });
    drawLabel(ctx, sub, textX, cy - 1, SUB_FONT, withAlpha(textColor, 0.85), {
      align: 'center',
      baseline: 'top',
      themeKey: theme.key,
    });
  }

  if (badge !== undefined && !dimmed) {
    drawStateBadge(ctx, theme, x - 4, y - 4, badge, waiting);
  }
}

/**
 * The 待避 / 折返 badge. Making 緩急接続 obvious is the entire point of this
 * view; making it obvious that a marker is stock rather than a running train
 * is what stops the layover from reading as a train that forgot to leave.
 */
function drawStateBadge(
  ctx: DrawContext,
  theme: RenderTheme,
  x: number,
  y: number,
  text: string,
  urgent: boolean,
): void {
  const w = 26;
  const h = 12;
  ctx.fillStyle = urgent ? theme.waitRing : theme.borderStrong;
  ctx.setLineDash([]);
  roundRectPath(ctx, x, y - h - 1, w, h, 3);
  ctx.fill();
  drawLabel(
    ctx,
    text,
    x + w / 2,
    y - h / 2 - 1,
    '9px system-ui, sans-serif',
    urgent ? '#1f1300' : contrastText(theme.borderStrong),
    { align: 'center', baseline: 'middle', themeKey: theme.key },
  );
}

/**
 * Each yard's name plate and the formations standing in it, on the roads they
 * are actually berthed on.
 *
 * A depot is drawn whether or not anything is in it. "鷺沼車庫 留置なし" is a
 * fact worth showing; a yard that vanishes when the last train leaves just
 * looks like a rendering bug.
 */
function drawDepots(ctx: DrawContext, env: LineDynamicEnv): void {
  const { layout, camera, theme, snapshot, viewport } = env;
  for (const yard of layout.depots) {
    const sx0 = worldToScreenX(camera, yard.x0);
    const sx1 = worldToScreenX(camera, yard.x1);
    if (!visible(sx0, sx1, viewport, 140)) continue;

    const ids = snapshot.depotOccupancy.get(yard.depotId) ?? NO_FORMATIONS;
    const count = ids.length === 0 ? '留置なし' : `留置 ${ids.length}本`;
    const nameW = measuredTextWidth(yard.label, DEPOT_FONT);
    const countW = measuredTextWidth(count, SUB_FONT);
    const endX = worldToScreenX(camera, yard.endX);
    const plate = depotPlateLayout({
      junctionX: worldToScreenX(camera, yard.junctionX),
      stubEndX: endX,
      centerY: laneY(env, yard.laneFrom) - camera.scaleY / 2 - 2,
      contentWidth: nameW + 8 + countW,
      viewportWidth: viewport.width,
    });

    ctx.fillStyle = theme.depot;
    ctx.strokeStyle = theme.borderStrong;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    roundRectPath(ctx, plate.x, plate.y, plate.w, plate.h, 3);
    ctx.fill();
    ctx.stroke();

    const textY = plate.y + plate.h / 2;
    drawLabel(ctx, yard.label, plate.x + DEPOT_PLATE_PAD, textY, DEPOT_FONT, theme.text, {
      baseline: 'middle',
      themeKey: theme.key,
    });
    drawLabel(
      ctx,
      count,
      plate.x + plate.w - DEPOT_PLATE_PAD,
      textY,
      SUB_FONT,
      ids.length === 0 ? theme.textFaint : theme.accent,
      { align: 'right', baseline: 'middle', themeKey: theme.key },
    );

    drawStabled(ctx, env, yard, ids);
  }
}

/** Roads → the formations standing on them. Reused across frames. */
const stabledByLane = new Map<number, FormationId[]>();

/**
 * The stabled formations, drawn as chips on their own road.
 *
 * Which road matters: "6121F is on 留置3番線" is the difference between a
 * depot that is modelled and a depot that is a number in a caption. Stock the
 * plan does not berth anywhere in particular goes on the yard lead, which is
 * the honest place for "in there, somewhere".
 */
function drawStabled(
  ctx: DrawContext,
  env: LineDynamicEnv,
  yard: DepotLane,
  ids: readonly FormationId[],
): void {
  const { layout, camera, theme, snapshot } = env;
  if (ids.length === 0) return;

  const outerX = worldToScreenX(camera, yard.endX);
  const innerX = worldToScreenX(camera, yard.throatX);
  const room = Math.abs(innerX - outerX);
  if (room < 24) return; // the plate's count is all that fits

  stabledByLane.clear();
  for (const id of ids) {
    const trackId = snapshot.formations.get(id)?.trackId;
    const lane = trackId === undefined ? undefined : layout.laneOfTrack.get(trackId);
    const key = lane === undefined ? yard.leadLane : lane;
    const list = stabledByLane.get(key);
    if (list) list.push(id);
    else stabledByLane.set(key, [id]);
  }

  const dir = innerX < outerX ? -1 : 1;
  const h = Math.max(8, Math.min(14, camera.scaleY * yard.lanePitch - 3));
  for (const [lane, list] of stabledByLane) {
    const cy = laneY(env, lane);
    let cursor = outerX + dir * 3;
    for (let i = 0; i < list.length; i++) {
      const code = env.formations.get(list[i]!)?.code ?? list[i]!;
      const remaining = list.length - i;
      const w = measuredTextWidth(code, SUB_FONT) + 8;
      if (Math.abs(cursor + dir * w - outerX) > room) {
        drawLabel(ctx, `+${remaining}`, cursor, cy, SUB_FONT, theme.textFaint, {
          align: dir < 0 ? 'right' : 'left',
          baseline: 'middle',
          themeKey: theme.key,
        });
        break;
      }
      const x = dir < 0 ? cursor - w : cursor;
      ctx.fillStyle = theme.depot;
      ctx.strokeStyle = theme.borderStrong;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      roundRectPath(ctx, x, cy - h / 2, w, h, 3);
      ctx.fill();
      ctx.stroke();
      drawLabel(ctx, code, x + w / 2, cy, SUB_FONT, theme.textDim, {
        align: 'center',
        baseline: 'middle',
        themeKey: theme.key,
      });
      cursor += dir * (w + 3);
    }
  }
}

// ---------------------------------------------------------------------------
// Overlay layer
// ---------------------------------------------------------------------------

/** Hover highlight and selection halo. Redrawn on pointer events only. */
export function drawLineOverlay(ctx: DrawContext, env: LineOverlayEnv): void {
  const { theme, viewport, hits } = env;
  ctx.clearRect(0, 0, viewport.width, viewport.height);

  if (env.selected) {
    for (const id of env.selected) {
      const rect = hits.rectOf(id as TrainId);
      if (!rect) continue;
      ctx.strokeStyle = theme.selection;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([]);
      roundRectPath(ctx, rect.x - 3, rect.y - 3, rect.w + 6, rect.h + 6, MARKER_R + 2);
      ctx.stroke();
    }
  }

  if (env.hovered !== undefined) {
    const rect = hits.rectOf(env.hovered);
    if (rect) {
      ctx.strokeStyle = theme.hover;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 2]);
      roundRectPath(ctx, rect.x - 2, rect.y - 2, rect.w + 4, rect.h + 4, MARKER_R + 1);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

// ---------------------------------------------------------------------------
// Digest support
// ---------------------------------------------------------------------------

/**
 * Integer screen positions of every drawn train — the E2E digest payload.
 *
 * These are **true** positions. The marker box may have slid a few pixels
 * along its lane to stay readable, but nothing outside the draw is ever told
 * about that: the digest and the DOM shadow report where the train is.
 */
export function lineTrainPositions(
  layout: LineLayout,
  camera: Camera2D,
  snapshot: SimSnapshot,
): Array<{ id: string; sx: number; sy: number }> {
  const out: Array<{ id: string; sx: number; sy: number }> = [];
  for (const train of snapshot.trains) {
    if (train.phase.phase === 'pending' || train.phase.phase === 'finished') continue;
    const p = placementOf(layout, train);
    out.push({
      id: train.trainId,
      sx: Math.round(worldToScreenX(camera, p.x)),
      sy: Math.round(laneCenterY(p.lane, camera.y, camera.scaleY)),
    });
  }
  return out;
}

export function lineStationPositions(
  layout: LineLayout,
  camera: Camera2D,
): Array<{ id: string; sx: number; sy: number }> {
  return layout.stations.map((s) => ({
    id: s.stationId,
    sx: Math.round(worldToScreenX(camera, s.x)),
    sy: Math.round(laneCenterY(s.laneFrom, camera.y, camera.scaleY)),
  }));
}
