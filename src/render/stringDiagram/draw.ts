/**
 * String diagram drawing.
 *
 * The whole reason this stream uses layered canvases lives here: **all ~500
 * train polylines go on the STATIC layer**. Their shape is a function of the
 * timetable and the camera, not of the clock, so advancing time must not
 * redraw them. Only the now-line and the active-train dots are per-frame work.
 */

import type { StationId, TrainId } from '@/domain/ids';
import { formatTime } from '@/domain/time';
import type { Sec } from '@/domain/units';
import type { SimSnapshot } from '@/engine/types';
import type { Camera2D, Viewport } from '../canvas/camera';
import { crisp, worldToScreenX, worldToScreenY } from '../canvas/camera';
import type { DrawContext } from '../canvas/recordingContext';
import { roundRectPath } from '../canvas/recordingContext';
import { drawLabel } from '../canvas/textCache';
import type { RenderTheme } from '../canvas/theme';
import { desaturate, withAlpha } from '../canvas/theme';
import {
  chooseDistanceGrid,
  chooseTimeGrid,
  diagramYOfKm,
  type DiagramLayout,
  type DiagramTrain,
} from './layout';

const AXIS_FONT = '10px ui-monospace, monospace';
const STATION_FONT = '11px system-ui, sans-serif';

/** Width multiplier applied to the highlighted duty's trains. */
export const HIGHLIGHT_WIDTH_FACTOR = 3;
/** Alpha everything else fades to when a duty is highlighted. */
export const DIM_ALPHA = 0.2;

export interface DiagramDrawEnv {
  layout: DiagramLayout;
  camera: Camera2D;
  theme: RenderTheme;
  viewport: Viewport;
  highlightDutyId?: string;
  selected?: ReadonlySet<string>;
}

export interface DiagramDynamicEnv {
  layout: DiagramLayout;
  camera: Camera2D;
  theme: RenderTheme;
  viewport: Viewport;
  t: Sec;
  snapshot: SimSnapshot;
  highlightDutyId?: string;
}

export interface DiagramOverlayEnv extends DiagramDrawEnv {
  hovered?: TrainId;
}

// ---------------------------------------------------------------------------
// Static layer
// ---------------------------------------------------------------------------

export function drawDiagramStatic(ctx: DrawContext, env: DiagramDrawEnv): void {
  drawDiagramGrid(ctx, env);
  drawDiagramTrains(ctx, env);
  drawDiagramEvents(ctx, env);
}

export function drawDiagramGrid(ctx: DrawContext, env: DiagramDrawEnv): void {
  const { layout, camera, theme, viewport } = env;

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  const grid = chooseTimeGrid(camera.scaleX);
  const t0 = camera.x;
  const t1 = camera.x + viewport.width / camera.scaleX;

  ctx.setLineDash([]);
  if (grid.minor > 0) {
    ctx.strokeStyle = withAlpha(theme.grid, 0.4);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = Math.ceil(t0 / grid.minor) * grid.minor; t <= t1; t += grid.minor) {
      if (t % grid.major === 0) continue;
      const x = crisp(worldToScreenX(camera, t));
      ctx.moveTo(x, 0);
      ctx.lineTo(x, viewport.height);
    }
    ctx.stroke();
  }

  ctx.strokeStyle = theme.gridStrong;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let t = Math.ceil(t0 / grid.major) * grid.major; t <= t1; t += grid.major) {
    const x = crisp(worldToScreenX(camera, t));
    ctx.moveTo(x, 0);
    ctx.lineTo(x, viewport.height);
  }
  ctx.stroke();

  // Time labels along the top.
  for (let t = Math.ceil(t0 / grid.major) * grid.major; t <= t1; t += grid.major) {
    const x = worldToScreenX(camera, t);
    drawLabel(ctx, formatTime(t), x + 3, 3, AXIS_FONT, theme.textDim, {
      baseline: 'top',
      themeKey: theme.key,
    });
  }

  // Station rules.
  for (const station of layout.stations) {
    const y = crisp(worldToScreenY(camera, station.y));
    if (y < -20 || y > viewport.height + 20) continue;
    ctx.strokeStyle = station.isConnectionPoint ? withAlpha(theme.accent, 0.55) : theme.gridStrong;
    ctx.lineWidth = station.isConnectionPoint ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(viewport.width, y);
    ctx.stroke();
    drawLabel(ctx, station.name, 4, y - 3, STATION_FONT, theme.text, {
      baseline: 'bottom',
      themeKey: theme.key,
    });
  }

  // Distance gridlines between stations, in km mode only — in index mode the
  // station rules already are the grid.
  if (layout.verticalScale === 'km') {
    const step = chooseDistanceGrid(camera.scaleY);
    const y0 = camera.y;
    const y1 = camera.y + viewport.height / camera.scaleY;
    ctx.strokeStyle = withAlpha(theme.grid, 0.3);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) {
      const y = crisp(worldToScreenY(camera, v));
      ctx.moveTo(0, y);
      ctx.lineTo(viewport.width, y);
    }
    ctx.stroke();
  }
}

/**
 * Every train polyline.
 *
 * With `highlightDutyId` set this becomes a 車両運用 view: the chosen duty is
 * drawn at 3x width in full colour and everything else drops to 20% alpha, so
 * one vehicle's whole day is traceable across a sheet of 500 lines.
 */
export function drawDiagramTrains(ctx: DrawContext, env: DiagramDrawEnv): void {
  const { layout, camera, viewport, highlightDutyId } = env;
  const t0 = camera.x - 60;
  const t1 = camera.x + viewport.width / camera.scaleX + 60;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Two passes so the highlighted duty is never buried under dimmed lines.
  if (highlightDutyId !== undefined) {
    for (const train of layout.trains) {
      if (train.dutyId === highlightDutyId) continue;
      strokeTrain(ctx, env, train, t0, t1, true);
    }
    for (const train of layout.trains) {
      if (train.dutyId !== highlightDutyId) continue;
      strokeTrain(ctx, env, train, t0, t1, false);
    }
    return;
  }

  for (const train of layout.trains) strokeTrain(ctx, env, train, t0, t1, false);
}

function strokeTrain(
  ctx: DrawContext,
  env: DiagramDrawEnv,
  train: DiagramTrain,
  t0: Sec,
  t1: Sec,
  dimmed: boolean,
): void {
  if (train.endSec < t0 || train.startSec > t1) return;
  const { camera } = env;
  const highlighted = env.highlightDutyId !== undefined && !dimmed;
  const selected = env.selected?.has(train.trainId) ?? false;

  ctx.strokeStyle = dimmed
    ? withAlpha(desaturate(train.color, 0.7), DIM_ALPHA)
    : train.color;
  ctx.lineWidth =
    train.lineWidth * (highlighted ? HIGHLIGHT_WIDTH_FACTOR : 1) + (selected ? 2 : 0);
  ctx.setLineDash(dimmed ? [] : train.dash);

  ctx.beginPath();
  const pts = train.points;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const x = worldToScreenX(camera, p.x);
    const y = worldToScreenY(camera, p.y);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Train number at the head of the line, where there is room.
  if (!dimmed) {
    const head = pts[0]!;
    drawLabel(
      ctx,
      train.label,
      worldToScreenX(camera, head.x) + 3,
      worldToScreenY(camera, head.y) - 3,
      AXIS_FONT,
      train.color,
      { baseline: 'bottom', themeKey: env.theme.key },
    );
  }
}

/** 待避 markers and 緩急接続 brackets. */
export function drawDiagramEvents(ctx: DrawContext, env: DiagramDrawEnv): void {
  const { layout, camera, theme } = env;

  for (const o of layout.overtakes) {
    const x = worldToScreenX(camera, o.x);
    const y = worldToScreenY(camera, o.y);
    // A diamond: distinct from any line crossing, readable at 1:1 zoom.
    ctx.fillStyle = o.ok ? theme.warning : theme.error;
    ctx.beginPath();
    ctx.moveTo(x, y - 6);
    ctx.lineTo(x + 5, y);
    ctx.lineTo(x, y + 6);
    ctx.lineTo(x - 5, y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = theme.bg;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  for (const c of layout.connections) {
    const x0 = worldToScreenX(camera, c.x);
    const x1 = worldToScreenX(camera, c.x2 ?? c.x);
    const y = worldToScreenY(camera, c.y);
    // A square bracket under the station rule spanning the transfer window.
    ctx.strokeStyle = c.ok ? theme.ok : theme.textFaint;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x0, y + 4);
    ctx.lineTo(x0, y + 10);
    ctx.lineTo(x1, y + 10);
    ctx.lineTo(x1, y + 4);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Dynamic layer
// ---------------------------------------------------------------------------

/** The now-line and a dot per active train. This is the only per-frame work. */
export function drawDiagramDynamic(ctx: DrawContext, env: DiagramDynamicEnv): void {
  const { layout, camera, theme, viewport, t, snapshot } = env;
  ctx.clearRect(0, 0, viewport.width, viewport.height);

  const x = crisp(worldToScreenX(camera, t));
  if (x >= -1 && x <= viewport.width + 1) {
    ctx.strokeStyle = theme.nowLine;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, viewport.height);
    ctx.stroke();

    // A grab handle at the top — the drag target for `onSeek`.
    ctx.fillStyle = theme.nowLine;
    roundRectPath(ctx, x - 22, 0, 44, 14, 3);
    ctx.fill();
    drawLabel(ctx, formatTime(t), x, 7, AXIS_FONT, '#08121c', {
      align: 'center',
      baseline: 'middle',
      themeKey: theme.key,
    });
  }

  for (const train of snapshot.trains) {
    if (train.phase.phase === 'pending' || train.phase.phase === 'finished') continue;
    const dt = layout.trainById.get(train.trainId);
    if (!dt) continue;
    const cx = worldToScreenX(camera, t);
    const cy = worldToScreenY(camera, diagramYOfKm(layout, train.km));
    if (cy < -10 || cy > viewport.height + 10) continue;
    const dimmed = env.highlightDutyId !== undefined && dt.dutyId !== env.highlightDutyId;

    ctx.fillStyle = dimmed ? withAlpha(dt.color, 0.3) : dt.color;
    ctx.beginPath();
    ctx.arc(cx, cy, dimmed ? 2.5 : 4, 0, Math.PI * 2);
    ctx.fill();
    if (!dimmed) {
      ctx.strokeStyle = theme.bg;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------------------
// Overlay layer
// ---------------------------------------------------------------------------

export function drawDiagramOverlay(ctx: DrawContext, env: DiagramOverlayEnv): void {
  const { layout, camera, theme, viewport, hovered } = env;
  ctx.clearRect(0, 0, viewport.width, viewport.height);
  if (hovered === undefined) return;
  const train = layout.trainById.get(hovered);
  if (!train) return;

  ctx.strokeStyle = theme.hover;
  ctx.lineWidth = train.lineWidth + 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = 0.45;
  ctx.setLineDash([]);
  ctx.beginPath();
  train.points.forEach((p, i) => {
    const x = worldToScreenX(camera, p.x);
    const y = worldToScreenY(camera, p.y);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.globalAlpha = 1;

  const head = train.points[0];
  if (head) {
    const x = Math.min(worldToScreenX(camera, head.x) + 6, viewport.width - 120);
    const y = Math.max(worldToScreenY(camera, head.y) - 22, 2);
    ctx.fillStyle = withAlpha(theme.panel, 0.95);
    ctx.strokeStyle = theme.borderStrong;
    ctx.lineWidth = 1;
    roundRectPath(ctx, x, y, 116, 18, 4);
    ctx.fill();
    ctx.stroke();
    drawLabel(ctx, `${train.label} ${train.typeName}`, x + 6, y + 9, AXIS_FONT, theme.text, {
      baseline: 'middle',
      themeKey: theme.key,
    });
  }
}

// ---------------------------------------------------------------------------
// Digest support
// ---------------------------------------------------------------------------

export function diagramTrainPositions(
  layout: DiagramLayout,
  camera: Camera2D,
  snapshot: SimSnapshot,
  t: Sec,
): Array<{ id: string; sx: number; sy: number }> {
  const out: Array<{ id: string; sx: number; sy: number }> = [];
  for (const train of snapshot.trains) {
    if (train.phase.phase === 'pending' || train.phase.phase === 'finished') continue;
    if (!layout.trainById.has(train.trainId)) continue;
    out.push({
      id: train.trainId,
      sx: Math.round(worldToScreenX(camera, t)),
      sy: Math.round(worldToScreenY(camera, diagramYOfKm(layout, train.km))),
    });
  }
  return out;
}

export function diagramStationPositions(
  layout: DiagramLayout,
  camera: Camera2D,
): Array<{ id: StationId; sx: number; sy: number }> {
  return layout.stations.map((s) => ({
    id: s.stationId,
    sx: 0,
    sy: Math.round(worldToScreenY(camera, s.y)),
  }));
}
