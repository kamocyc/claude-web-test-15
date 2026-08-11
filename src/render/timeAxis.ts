/**
 * A horizontal time axis, as pure arithmetic.
 *
 * Both SVG charts — 構内ダイヤ and 行路表 — draw seconds across and rows down,
 * and both let the reader zoom and pan the axis because a whole service day on
 * one sheet is about 40 seconds per pixel while the things worth looking at
 * are 45 seconds long. This is the part of that they genuinely share: the
 * window arithmetic and the tick chooser, with no React, no DOM and no state.
 *
 * `undefined` means "the whole day, no window" throughout. That is not a
 * failure value: it is how both charts spell their reset state, and returning
 * it from a clamp is how a zoom-out past the full span stops being a window at
 * all.
 */

import type { Sec } from '@/domain/units';

export interface TimeWindow {
  from: Sec;
  to: Sec;
}

export interface TimeScale {
  from: Sec;
  to: Sec;
  span: number;
  pxPerSec: number;
  xOf(t: Sec): number;
  timeAt(x: number): Sec;
}

/** Candidate tick spacings, coarsest last. */
export const TIME_TICK_STEPS: readonly number[] = [60, 300, 600, 900, 1800, 3600, 7200, 14400];

/** Ticks closer together than this are unreadable at any font size. */
export const TIME_TICK_MIN_PX = 70;

export function timeScale(opts: {
  from: Sec;
  to: Sec;
  plotW: number;
  /** Left gutter holding the row labels; x = 0 is the sheet, not the plot. */
  labelW: number;
}): TimeScale {
  const span = Math.max(1, opts.to - opts.from);
  return {
    from: opts.from,
    to: opts.to,
    span,
    pxPerSec: opts.plotW / span,
    xOf: (t) => opts.labelW + ((t - opts.from) / span) * opts.plotW,
    timeAt: (x) => opts.from + ((x - opts.labelW) / opts.plotW) * span,
  };
}

/** The coarsest step that still fills the plot, then every multiple of it. */
export function niceTimeTicks(from: Sec, to: Sec, plotW: number): Sec[] {
  const span = Math.max(1, to - from);
  const pxPerSec = plotW / span;
  let step = TIME_TICK_STEPS[TIME_TICK_STEPS.length - 1]!;
  for (const s of TIME_TICK_STEPS) {
    if (s * pxPerSec >= TIME_TICK_MIN_PX) {
      step = s;
      break;
    }
  }
  const out: Sec[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push(t);
  return out;
}

/** Keep a window inside the day, at a legible width. */
export function clampTimeWindow(
  next: TimeWindow,
  full: TimeWindow,
  minSpanSec: number,
): TimeWindow | undefined {
  const fullSpan = Math.max(1, full.to - full.from);
  const wanted = Math.min(Math.max(next.to - next.from, minSpanSec), fullSpan);
  if (wanted >= fullSpan) return undefined;
  let start = next.from;
  if (start < full.from) start = full.from;
  if (start + wanted > full.to) start = full.to - wanted;
  return { from: start, to: start + wanted };
}

/** Zoom by `factor` about a time that must stay where it is on screen. */
export function zoomTimeWindow(
  current: TimeWindow | undefined,
  full: TimeWindow,
  factor: number,
  anchorSec: Sec,
  minSpanSec: number,
): TimeWindow | undefined {
  const from = current?.from ?? full.from;
  const to = current?.to ?? full.to;
  const nextSpan = (to - from) / factor;
  const share = (anchorSec - from) / Math.max(1, to - from);
  return clampTimeWindow(
    { from: anchorSec - nextSpan * share, to: anchorSec + nextSpan * (1 - share) },
    full,
    minSpanSec,
  );
}

/** Slide a window by a pixel distance dragged across the plot. */
export function panTimeWindow(
  base: TimeWindow,
  dxPx: number,
  plotW: number,
  full: TimeWindow,
  minSpanSec: number,
): TimeWindow | undefined {
  const dt = (dxPx / Math.max(1, plotW)) * (base.to - base.from);
  return clampTimeWindow({ from: base.from - dt, to: base.to - dt }, full, minSpanSec);
}
