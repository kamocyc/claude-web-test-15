/**
 * The shared time axis. Pure arithmetic, so these are arithmetic tests — the
 * two charts that use it are checked separately for what they draw.
 */

import { describe, expect, it } from 'vitest';
import {
  TIME_TICK_MIN_PX,
  TIME_TICK_STEPS,
  clampTimeWindow,
  niceTimeTicks,
  panTimeWindow,
  timeScale,
  zoomTimeWindow,
} from './timeAxis';

const FULL = { from: 4 * 3600, to: 26 * 3600 };
const MIN = 600;

describe('timeScale', () => {
  it('maps the window onto the plot, past the label gutter', () => {
    const s = timeScale({ from: 0, to: 3600, plotW: 360, labelW: 100 });
    expect(s.xOf(0)).toBe(100);
    expect(s.xOf(3600)).toBe(460);
    expect(s.xOf(1800)).toBe(280);
    expect(s.timeAt(280)).toBe(1800);
    expect(s.pxPerSec).toBeCloseTo(0.1);
  });

  it('never divides by zero on an empty window', () => {
    const s = timeScale({ from: 100, to: 100, plotW: 100, labelW: 0 });
    expect(Number.isFinite(s.xOf(100))).toBe(true);
  });
});

describe('niceTimeTicks', () => {
  it('keeps ticks at least 70 px apart while a coarser step is available', () => {
    const coarsest = TIME_TICK_STEPS[TIME_TICK_STEPS.length - 1]!;
    for (const plotW of [200, 400, 900, 1600]) {
      const ticks = niceTimeTicks(FULL.from, FULL.to, plotW);
      const scale = timeScale({ from: FULL.from, to: FULL.to, plotW, labelW: 0 });
      const step = ticks.length > 1 ? ticks[1]! - ticks[0]! : coarsest;
      for (let i = 1; i < ticks.length; i++) {
        const gap = scale.xOf(ticks[i]!) - scale.xOf(ticks[i - 1]!);
        // A day on 200 px cannot satisfy the minimum at any step; there the
        // coarsest is the best on offer and the axis takes it.
        if (step === coarsest) expect(gap).toBeGreaterThan(0);
        else expect(gap).toBeGreaterThanOrEqual(TIME_TICK_MIN_PX);
      }
    }
  });

  it('lands every tick on a round multiple of its own step', () => {
    const ticks = niceTimeTicks(4 * 3600 + 137, 8 * 3600, 900);
    expect(ticks.length).toBeGreaterThan(1);
    const step = ticks[1]! - ticks[0]!;
    for (const t of ticks) expect(t % step).toBe(0);
  });

  it('gets finer as the window narrows', () => {
    const wide = niceTimeTicks(FULL.from, FULL.to, 900);
    const narrow = niceTimeTicks(8 * 3600, 9 * 3600, 900);
    expect(narrow[1]! - narrow[0]!).toBeLessThan(wide[1]! - wide[0]!);
  });
});

describe('clampTimeWindow', () => {
  it('returns undefined once the window covers the whole day', () => {
    expect(clampTimeWindow({ from: 0, to: 30 * 3600 }, FULL, MIN)).toBeUndefined();
  });

  it('slides a window that would run off the end back inside', () => {
    const w = clampTimeWindow({ from: 25 * 3600, to: 27 * 3600 }, FULL, MIN)!;
    expect(w.to).toBe(FULL.to);
    expect(w.to - w.from).toBe(2 * 3600);
  });

  it('will not go narrower than the minimum span', () => {
    const w = clampTimeWindow({ from: 8 * 3600, to: 8 * 3600 + 10 }, FULL, MIN)!;
    expect(w.to - w.from).toBe(MIN);
  });
});

describe('zoomTimeWindow', () => {
  it('keeps the anchor time where it was', () => {
    const anchor = 12 * 3600;
    const w = zoomTimeWindow(undefined, FULL, 2, anchor, MIN)!;
    const before = (anchor - FULL.from) / (FULL.to - FULL.from);
    const after = (anchor - w.from) / (w.to - w.from);
    expect(after).toBeCloseTo(before, 6);
    expect(w.to - w.from).toBeCloseTo((FULL.to - FULL.from) / 2, 6);
  });

  it('zooming back out past the day drops the window entirely', () => {
    const inward = zoomTimeWindow(undefined, FULL, 2, 12 * 3600, MIN)!;
    expect(zoomTimeWindow(inward, FULL, 1 / 4, 12 * 3600, MIN)).toBeUndefined();
  });
});

describe('panTimeWindow', () => {
  it('moves the window against the drag, by the dragged fraction', () => {
    const base = { from: 8 * 3600, to: 10 * 3600 };
    const w = panTimeWindow(base, 100, 400, FULL, MIN)!;
    // A quarter of the plot dragged right shows a quarter-window earlier.
    expect(w.from).toBe(base.from - 0.25 * 2 * 3600);
    expect(w.to - w.from).toBe(2 * 3600);
  });

  it('stops at the edge of the day rather than scrolling into nothing', () => {
    const base = { from: FULL.from, to: FULL.from + 3600 };
    const w = panTimeWindow(base, 5000, 400, FULL, MIN)!;
    expect(w.from).toBe(FULL.from);
  });
});
