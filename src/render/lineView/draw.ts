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
 * The two module-level scratch objects below are the one exception to "no
 * globals". They are reusable solver buffers, fully reset at the top of the
 * draw that uses them, so a draw's output still depends only on its arguments
 * — they exist because the alternative is allocating a few hundred bytes of
 * garbage sixty times a second.
 */

import type { TrainId, TrainTypeId } from '@/domain/ids';
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
  depotBoxLayout,
  DROPPED,
  LABEL_ROW_PITCH,
  laneCenterY,
  MarkerSlots,
  placeTrainInto,
  StationLabelPlacer,
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
 * Rails, station blocks, platforms, 待避線 tinting, the depot stubs and the
 * station name band.
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

  // -- depot stubs ----------------------------------------------------------
  // Only the track. The box itself is on the dynamic layer, because its size
  // depends on how many formations are stabled.
  for (const depot of layout.depots) {
    const sx0 = worldToScreenX(camera, depot.x0);
    const sx1 = worldToScreenX(camera, depot.x1);
    if (!visible(sx0, sx1, viewport)) continue;
    const y = crisp(laneY(env, depot.index));
    const jx = worldToScreenX(camera, depot.junctionX);
    const jy = crisp(laneY(env, depot.junctionLane));
    const outward = depot.x0 < depot.junctionX ? -1 : 1;

    // The stub angles off the main axis — that diagonal is what reads as
    // "this train is leaving the line and going into the depot".
    ctx.strokeStyle = theme.railDim;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(jx, jy);
    ctx.lineTo(jx + outward * 20, y);
    ctx.lineTo(outward < 0 ? sx0 : sx1, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // -- station blocks -------------------------------------------------------
  const bandFloor = laneStackTop(env) - 7;
  const rows = Math.max(
    1,
    Math.min(2, Math.floor((laneStackTop(env) - 2) / LABEL_ROW_PITCH)),
  );
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

      // 待避線 gets its own tint: spotting the passing loop must not require
      // reading the track name.
      if (lane.canBeOvertaken) {
        ctx.fillStyle = withAlpha(theme.overtakeTrack, 0.14);
        ctx.fillRect(sx0, y - camera.scaleY / 2 + 1, sx1 - sx0, camera.scaleY - 2);
      }

      if (lane.hasPlatform) {
        ctx.fillStyle = withAlpha(theme.platform, 0.35);
        ctx.fillRect(sx0 + 2, y - 9, sx1 - sx0 - 4, 4);
      }

      ctx.strokeStyle = lane.canBeOvertaken
        ? theme.overtakeTrack
        : lane.hasPlatform
          ? theme.rail
          : theme.railDim;
      ctx.lineWidth = lane.hasPlatform ? 4 : 2;
      ctx.beginPath();
      ctx.moveTo(sx0, y);
      ctx.lineTo(sx1, y);
      ctx.stroke();

      if (sx1 - sx0 > 40) {
        drawLabel(ctx, lane.label, sx0 + 3, y + 9, TRACK_FONT, theme.textFaint, {
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

/** Should this train be drawn at all, at this instant, with these filters? */
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
  if (phase.phase === 'dwelling' || phase.phase === 'passing') {
    placeArgs.stationId = phase.stationId;
    placeArgs.trackId = phase.trackId;
    placeArgs.km = phase.km;
  } else if (phase.phase === 'running') {
    placeArgs.fromStationId = phase.fromStationId;
    placeArgs.toStationId = phase.toStationId;
    placeArgs.km = phase.km;
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

  if (waiting && !dimmed) {
    drawWaitBadge(ctx, theme, x - 4, y - 4);
  }
}

/** The 待避 badge. Making 緩急接続 obvious is the entire point of this view. */
function drawWaitBadge(ctx: DrawContext, theme: RenderTheme, x: number, y: number): void {
  const w = 26;
  const h = 12;
  ctx.fillStyle = theme.waitRing;
  roundRectPath(ctx, x, y - h - 1, w, h, 3);
  ctx.fill();
  drawLabel(ctx, '待避', x + w / 2, y - h / 2 - 1, '9px system-ui, sans-serif', '#1f1300', {
    align: 'center',
    baseline: 'middle',
    themeKey: theme.key,
  });
}

/**
 * The depot boxes: name, how many formations are stabled, and — only once the
 * box is wide enough to hold them — which ones.
 *
 * A depot is drawn whether or not anything is in it. "鷺沼車庫 留置 0本" is a
 * fact worth showing; a box that vanishes when the last train leaves just
 * looks like a rendering bug.
 */
function drawDepots(ctx: DrawContext, env: LineDynamicEnv): void {
  const { layout, camera, theme, snapshot, viewport } = env;
  for (const depot of layout.depots) {
    const sx0 = worldToScreenX(camera, depot.x0);
    const sx1 = worldToScreenX(camera, depot.x1);
    if (!visible(sx0, sx1, viewport, 140)) continue;

    const junctionX = worldToScreenX(camera, depot.junctionX);
    const outward = depot.x0 < depot.junctionX ? -1 : 1;
    const box = depotBoxLayout({
      junctionX,
      stubEndX: outward < 0 ? sx0 : sx1,
      centerY: laneY(env, depot.index),
      laneHeight: camera.scaleY,
      viewportWidth: viewport.width,
    });

    ctx.fillStyle = theme.depot;
    ctx.strokeStyle = theme.borderStrong;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    roundRectPath(ctx, box.x, box.y, box.w, box.h, 4);
    ctx.fill();
    ctx.stroke();

    const ids = snapshot.depotOccupancy.get(depot.depotId) ?? [];
    const nameY = box.y + 3;
    const detailY = nameY + 12;
    drawLabel(ctx, depot.label, box.x + 6, nameY, DEPOT_FONT, theme.text, {
      baseline: 'top',
      themeKey: theme.key,
    });

    if (ids.length === 0) {
      drawLabel(ctx, '留置なし', box.x + 6, detailY, SUB_FONT, theme.textFaint, {
        baseline: 'top',
        themeKey: theme.key,
      });
      continue;
    }
    if (!box.showCodes) {
      // Too narrow for the codes, so spend the whole line on the count.
      drawLabel(ctx, `留置 ${ids.length}本`, box.x + 6, detailY, SUB_FONT, theme.textDim, {
        baseline: 'top',
        themeKey: theme.key,
      });
      continue;
    }
    drawLabel(ctx, `${ids.length}本`, box.x + box.w - 6, nameY, SUB_FONT, theme.accent, {
      align: 'right',
      baseline: 'top',
      themeKey: theme.key,
    });
    drawLabel(
      ctx,
      fitCodes(ids, env.formations, box.w - 12),
      box.x + 6,
      detailY,
      SUB_FONT,
      theme.textDim,
      { baseline: 'top', themeKey: theme.key },
    );
  }
}

/**
 * As many formation codes as fit in `widthPx`, with `+N` for the remainder.
 *
 * Builds at most one string per depot per frame, which is the price of showing
 * live occupancy at all; the widths themselves come from the memoized
 * measurement cache.
 */
function fitCodes(
  ids: readonly string[],
  formations: Map<string, Formation>,
  widthPx: number,
): string {
  let text = '';
  let shown = 0;
  for (const id of ids) {
    const code = formations.get(id)?.code ?? id;
    const next = shown === 0 ? code : `${text} ${code}`;
    const remaining = ids.length - shown - 1;
    const suffix = remaining > 0 ? ` +${remaining}` : '';
    if (measuredTextWidth(next + suffix, SUB_FONT) > widthPx) break;
    text = next;
    shown++;
  }
  if (shown === 0) return `+${ids.length}`;
  return shown === ids.length ? text : `${text} +${ids.length - shown}`;
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
