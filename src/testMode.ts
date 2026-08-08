/**
 * Test-mode switches, read once at module load.
 *
 * Under `?e2e=1` the app becomes deterministic: no rAF clock driver, no
 * autosave restore, counter-based ids, no CSS transitions. Playwright drives
 * the clock through `window.__sim` and reads geometry through
 * `window.__render`, so nothing in the suite ever needs a timeout.
 */

import type { Sec } from '@/domain/units';

function readParams(): URLSearchParams {
  if (typeof window === 'undefined') return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

const params = readParams();

export const IS_E2E = params.get('e2e') === '1';

/** Under e2e, autosave restore is off unless `persist=1` is also given. */
export const RESTORE_AUTOSAVE = !IS_E2E || params.get('persist') === '1';

/** Initial clock position, seconds. */
export const INITIAL_T: Sec | undefined = (() => {
  const raw = params.get('t');
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
})();

/** 'manual' disables the rAF driver even outside e2e mode. */
export const CLOCK_MODE: 'auto' | 'manual' = IS_E2E || params.get('clock') === 'manual' ? 'manual' : 'auto';

export const ANIMATIONS_ENABLED = !IS_E2E;

export interface SimTestHooks {
  setTime(sec: Sec): void;
  step(sec: number): void;
  setSpeed(n: number): void;
  play(): void;
  pause(): void;
  getTime(): Sec;
  isReady(): boolean;
  snapshotDigest(): {
    t: Sec;
    active: number;
    trains: Array<{ id: string; number: string; phase: string; km: number }>;
  };
}

export interface RenderTestHooks {
  digest(view: 'line' | 'diagram'): {
    view: string;
    width: number;
    height: number;
    trains: Array<{ id: string; sx: number; sy: number }>;
    stations: Array<{ id: string; sx: number; sy: number }>;
  };
}

declare global {
  interface Window {
    __sim?: SimTestHooks;
    __render?: RenderTestHooks;
  }
}

export function installSimHooks(hooks: SimTestHooks): void {
  if (typeof window === 'undefined') return;
  window.__sim = hooks;
}

export function installRenderHooks(hooks: RenderTestHooks): void {
  if (typeof window === 'undefined') return;
  window.__render = hooks;
}
