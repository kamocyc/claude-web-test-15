/**
 * The clock is the only stateful object in the simulation.
 *
 * `tick` is driven by the shared rAF loop in normal use and called directly by
 * tests, so the driver itself has no timer inside it. Under `?e2e=1` the rAF
 * loop is never installed and Playwright calls `seek` through `window.__sim`.
 */

import type { Sec } from '@/domain/units';
import type { ClockState } from './types';

export interface ClockDriver {
  getState(): ClockState;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(t: Sec): void;
  nudge(deltaSec: number): void;
  setSpeed(n: number): void;
  setRange(from: Sec, to: Sec): void;
  setLoop(range: { from: Sec; to: Sec } | undefined): void;
  /** Advance by wall-clock milliseconds. */
  tick(wallDtMs: number): void;
  subscribe(fn: (s: ClockState) => void): () => void;
}

export interface CreateClockOptions {
  initialT: Sec;
  from: Sec;
  to: Sec;
  speed?: number;
}

export function createClockDriver(opts: CreateClockOptions): ClockDriver {
  let state: ClockState = {
    tSec: opts.initialT,
    playing: false,
    speed: opts.speed ?? 60,
  };
  let from = opts.from;
  let to = opts.to;
  const listeners = new Set<(s: ClockState) => void>();

  const emit = (): void => {
    for (const fn of listeners) fn(state);
  };

  const set = (patch: Partial<ClockState>): void => {
    state = { ...state, ...patch };
    emit();
  };

  const clamp = (t: Sec): Sec => (t < from ? from : t > to ? to : t);

  return {
    getState: () => state,
    play: () => set({ playing: true }),
    pause: () => set({ playing: false }),
    toggle: () => set({ playing: !state.playing }),
    seek: (t) => set({ tSec: clamp(t) }),
    nudge: (d) => set({ tSec: clamp(state.tSec + d) }),
    setSpeed: (n) => set({ speed: n }),
    setRange: (a, b) => {
      from = a;
      to = b;
      set({ tSec: clamp(state.tSec) });
    },
    setLoop: (range) => {
      const next: ClockState = { ...state };
      if (range === undefined) delete next.loopRange;
      else next.loopRange = range;
      state = next;
      emit();
    },
    tick: (wallDtMs) => {
      if (!state.playing) return;
      const next = state.tSec + (wallDtMs / 1000) * state.speed;
      const loop = state.loopRange;
      if (loop && next > loop.to) {
        set({ tSec: loop.from });
        return;
      }
      if (next >= to) {
        set({ tSec: to, playing: false });
        return;
      }
      set({ tSec: next });
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
