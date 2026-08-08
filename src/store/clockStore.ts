/**
 * The clock lives in its own store.
 *
 * At 60 Hz this slice changes 60 times a second. If it shared a store with the
 * editors, every keystroke-sized component in the app would re-render on every
 * animation frame. Keeping it separate means only the transport readout and the
 * canvases subscribe to it.
 */

import { create } from 'zustand';

import {
  DEFAULT_SERVICE_DAY_END,
  DEFAULT_SERVICE_DAY_START,
  clampTime,
} from '@/domain/time';
import type { Sec } from '@/domain/units';
import { createClockDriver, type ClockDriver } from '@/engine';
import { CLOCK_MODE, INITIAL_T } from '@/testMode';

const DEFAULT_INITIAL: Sec = 8 * 3600;

export const clockDriver: ClockDriver = createClockDriver({
  initialT: clampTime(
    INITIAL_T ?? DEFAULT_INITIAL,
    DEFAULT_SERVICE_DAY_START,
    DEFAULT_SERVICE_DAY_END,
  ),
  from: DEFAULT_SERVICE_DAY_START,
  to: DEFAULT_SERVICE_DAY_END,
  speed: 60,
});

export interface ClockStoreState {
  tSec: Sec;
  playing: boolean;
  speed: number;
  from: Sec;
  to: Sec;
  seek(t: Sec): void;
  nudge(delta: number): void;
  play(): void;
  pause(): void;
  toggle(): void;
  setSpeed(n: number): void;
  setRange(from: Sec, to: Sec): void;
}

const initial = clockDriver.getState();

export const useClockStore = create<ClockStoreState>((set) => ({
  tSec: initial.tSec,
  playing: initial.playing,
  speed: initial.speed,
  from: DEFAULT_SERVICE_DAY_START,
  to: DEFAULT_SERVICE_DAY_END,
  seek: (t) => clockDriver.seek(t),
  nudge: (delta) => clockDriver.nudge(delta),
  play: () => clockDriver.play(),
  pause: () => clockDriver.pause(),
  toggle: () => clockDriver.toggle(),
  setSpeed: (n) => clockDriver.setSpeed(n),
  setRange: (from, to) => {
    clockDriver.setRange(from, to);
    set({ from, to });
  },
}));

clockDriver.subscribe((s) => {
  const prev = useClockStore.getState();
  if (prev.tSec === s.tSec && prev.playing === s.playing && prev.speed === s.speed) return;
  useClockStore.setState({ tSec: s.tSec, playing: s.playing, speed: s.speed });
});

// ---------------------------------------------------------------------------
// The shared animation frame
// ---------------------------------------------------------------------------

let rafHandle: number | undefined;
let lastFrameMs: number | undefined;

/**
 * One rAF loop for the whole app. Installed only when the clock is in `auto`
 * mode — under `?e2e=1` Playwright drives time through `window.__sim` instead,
 * so there is nothing running in the background to make an assertion flake.
 */
export function installClockLoop(): () => void {
  if (CLOCK_MODE !== 'auto') return () => {};
  if (typeof requestAnimationFrame === 'undefined') return () => {};
  if (rafHandle !== undefined) return () => {};

  const frame = (nowMs: number): void => {
    const dt = lastFrameMs === undefined ? 0 : nowMs - lastFrameMs;
    lastFrameMs = nowMs;
    if (dt > 0) clockDriver.tick(Math.min(dt, 250));
    rafHandle = requestAnimationFrame(frame);
  };
  rafHandle = requestAnimationFrame(frame);

  return () => {
    if (rafHandle !== undefined) cancelAnimationFrame(rafHandle);
    rafHandle = undefined;
    lastFrameMs = undefined;
  };
}
