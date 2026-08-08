/**
 * Line view drawing. Pure functions of `(ctx, env)` — no DOM lookups, no
 * globals, no canvas of their own, so `draw.test.ts` can run every one of them
 * against a recording context in a node process.
 *
 * Every coordinate is converted with explicit `worldToScreenX/Y` arithmetic.
 * The context transform is only ever the DPR base transform set by
 * `useCanvasLayers`, which is what keeps text, marker sizes and stroke widths
 * constant as the line zooms.
 */

import type { TrainId, TrainTypeId } from '@/domain/ids';
import type { Formation, TrainType } from '@/domain/model';
import type { SimSnapshot, TrainRuntime } from '@/engine/types';
import type { Camera2D, Viewport } from '../canvas/camera';
import { crisp, worldToScreenX } from '../canvas/camera';
import type { HitRects } from '../canvas/hit';
import type { DrawContext } from '../canvas/recordingContext';
import { roundRectPath } from '../canvas/recordingContext';
import { drawLabel } from '../canvas/textCache';
import type { RenderTheme } from '../canvas/theme';
import { contrastText, desaturate, withAlpha } from '../canvas/theme';
import { laneCenterY, placeTrain, type LineLayout } from './layout';

/** Train marker box, CSS pixels. Constant under zoom by design. */
export const MARKER_W = 92;
export const MARKER_H = 20;
const MARKER_R = 6;

const LABEL_FONT = 'bold 11px system-ui, sans-serif';
const SUB_FONT = '9px ui-monospace, monospace';
const STATION_FONT = 'bold 11px system-ui, sans-serif';
const TRACK_FONT = '9px system-ui, sans-serif';

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

function visible(x0: number, x1: number, viewport: Viewport, slop = 60): boolean {
  return x1 >= -slop && x0 <= viewport.width + slop;
}

// ---------------------------------------------------------------------------
// Static layer
// ---------------------------------------------------------------------------

/**
 * Rails, station blocks, platforms, 待避線 tinting and the depot stubs.
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
  for (const depot of layout.depots) {
    const sx0 = worldToScreenX(camera, depot.x0);
    const sx1 = worldToScreenX(camera, depot.x1);
    if (!visible(sx0, sx1, viewport)) continue;
    const y = crisp(laneY(env, depot.index));
    const jx = worldToScreenX(camera, depot.junctionX);
    const jy = crisp(laneY(env, depot.junctionLane));

    // The stub angles off the main axis — that diagonal is what reads as
    // "this train is leaving the line and going into the depot".
    ctx.strokeStyle = theme.railDim;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(jx, jy);
    ctx.lineTo(jx + (depot.x0 < depot.junctionX ? -24 : 24), y);
    ctx.lineTo(depot.x0 < depot.junctionX ? sx0 : sx1, y);
    ctx.stroke();
    ctx.setLineDash([]);

    const boxW = Math.max(64, Math.abs(sx1 - sx0) * 0.55);
    const boxX = depot.x0 < depot.junctionX ? sx0 : sx1 - boxW;
    ctx.fillStyle = theme.depot;
    ctx.strokeStyle = theme.borderStrong;
    ctx.lineWidth = 1;
    roundRectPath(ctx, boxX, y - MARKER_H / 2 - 2, boxW, MARKER_H + 4, 4);
    ctx.fill();
    ctx.stroke();
    drawLabel(ctx, depot.label, boxX + 6, y - 2, TRACK_FONT, theme.textDim, {
      baseline: 'middle',
      themeKey: theme.key,
    });
  }

  // -- station blocks -------------------------------------------------------
  for (const station of layout.stations) {
    const sx0 = worldToScreenX(camera, station.x0);
    const sx1 = worldToScreenX(camera, station.x1);
    if (!visible(sx0, sx1, viewport)) continue;

    const topY = laneY(env, station.laneFrom) - camera.scaleY / 2;
    const botY = laneY(env, station.laneTo) + camera.scaleY / 2;

    // Vertical station rule.
    const cx = crisp(worldToScreenX(camera, station.x));
    ctx.strokeStyle = station.isConnectionPoint ? theme.accent : theme.gridStrong;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, topY - 14);
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

    drawLabel(ctx, station.name, cx, topY - 18, STATION_FONT, theme.text, {
      align: 'center',
      baseline: 'top',
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
 * Train markers and depot contents. Redrawn every frame while the clock runs.
 *
 * Pending trains are not drawn at all — a 未出庫 train has no position, and
 * parking them all at the origin would be a lie.
 */
export function drawLineDynamic(ctx: DrawContext, env: LineDynamicEnv): void {
  const { layout, camera, viewport, snapshot, hits } = env;

  ctx.clearRect(0, 0, viewport.width, viewport.height);
  drawDepotContents(ctx, env);

  for (const train of snapshot.trains) {
    if (train.phase.phase === 'pending') continue;
    if (train.phase.phase === 'finished') continue;
    if (!env.showDeadhead && train.category !== 'service') continue;

    const placement = placementOf(layout, train);
    const sx = worldToScreenX(camera, placement.x);
    const sy = laneY(env, placement.lane);
    if (sx < -MARKER_W || sx > viewport.width + MARKER_W) continue;

    const dimmed =
      env.highlightDutyId !== undefined && train.dutyId !== env.highlightDutyId;
    drawTrainMarker(ctx, env, train, sx, sy, dimmed);
    hits?.push(train.trainId, sx - MARKER_W / 2, sy - MARKER_H / 2, MARKER_W, MARKER_H);
  }
}

/** Where a runtime train sits in world space. */
export function placementOf(
  layout: LineLayout,
  train: TrainRuntime,
): { x: number; lane: number } {
  const phase = train.phase;
  const args: Parameters<typeof placeTrain>[1] = {
    km: train.km,
    direction: train.direction,
  };
  if (phase.phase === 'dwelling' || phase.phase === 'passing') {
    args.stationId = phase.stationId;
    if (phase.trackId !== undefined) args.trackId = phase.trackId;
    args.km = phase.km;
  } else if (phase.phase === 'running') {
    args.fromStationId = phase.fromStationId;
    args.toStationId = phase.toStationId;
    args.km = phase.km;
  }
  return placeTrain(layout, args);
}

function drawTrainMarker(
  ctx: DrawContext,
  env: LineDynamicEnv,
  train: TrainRuntime,
  cx: number,
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
  const tipX = cx + dir * (MARKER_W / 2 - 7);
  ctx.fillStyle = withAlpha('#ffffff', dimmed ? 0.35 : 0.85);
  ctx.beginPath();
  ctx.moveTo(tipX, cy);
  ctx.lineTo(tipX - dir * 6, cy - 5);
  ctx.lineTo(tipX - dir * 6, cy + 5);
  ctx.closePath();
  ctx.fill();

  const textColor = dimmed ? withAlpha(theme.text, 0.4) : contrastText(baseColor);
  drawLabel(ctx, train.label, cx - dir * 5, cy + 0.5, LABEL_FONT, textColor, {
    align: 'center',
    baseline: 'middle',
    themeKey: theme.key,
  });

  const sub =
    train.formationCode !== undefined
      ? train.cars !== undefined
        ? `${train.formationCode}(${train.cars})`
        : train.formationCode
      : undefined;
  if (sub !== undefined) {
    drawLabel(ctx, sub, cx, cy + MARKER_H / 2 + 2, SUB_FONT, dimmed ? theme.textFaint : theme.textDim, {
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

/** Which formations are sitting in each depot right now. */
function drawDepotContents(ctx: DrawContext, env: LineDynamicEnv): void {
  const { layout, camera, theme, snapshot, viewport } = env;
  for (const depot of layout.depots) {
    const ids = snapshot.depotOccupancy.get(depot.depotId) ?? [];
    if (ids.length === 0) continue;
    const sx0 = worldToScreenX(camera, depot.x0);
    const sx1 = worldToScreenX(camera, depot.x1);
    if (!visible(sx0, sx1, viewport)) continue;
    const y = laneY(env, depot.index);
    const codes = ids
      .map((id) => env.formations.get(id)?.code ?? id)
      .slice(0, 6)
      .join(' ');
    const text = ids.length > 6 ? `${codes} +${ids.length - 6}` : codes;
    const anchor = depot.x0 < depot.junctionX ? sx0 : sx1;
    drawLabel(ctx, text, anchor + 6, y + MARKER_H / 2 + 4, SUB_FONT, theme.textDim, {
      baseline: 'top',
      themeKey: theme.key,
    });
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

/** Integer screen positions of every drawn train — the E2E digest payload. */
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
