/**
 * ONE requestAnimationFrame loop for the whole app.
 *
 * Every view registering its own rAF means N callbacks per frame with no
 * defined ordering, N chances to leak a loop on unmount, and N loops still
 * burning battery in a background tab. A single registry fixes all three:
 * tasks run in a declared order, unregistering is a returned function, and the
 * loop parks itself on `document.hidden`.
 *
 * The loop is demand-driven. `requestFrame()` wakes it; a task that returns
 * `true` (still animating) keeps it awake for another frame. An idle app with
 * a paused clock costs nothing.
 *
 * Under `?e2e=1` the loop is never started. Playwright calls `renderOnce()`
 * through the render test hooks, so every assertion runs against a frame that
 * has demonstrably finished drawing — no waiting, no flake.
 */

import { IS_E2E } from '@/testMode';

/** Return `true` to request another frame. */
export type FrameTask = (nowMs: number) => boolean | void;

interface Entry {
  id: string;
  order: number;
  task: FrameTask;
}

const entries: Entry[] = [];
let rafId: number | null = null;
let wanted = false;
let running = false;
let visibilityHooked = false;

function byOrder(a: Entry, b: Entry): number {
  return a.order - b.order || a.id.localeCompare(b.id);
}

/**
 * Register a per-frame draw callback.
 *
 * `order` sets the run order within a frame — lower runs first. Views use
 * 0 (static), 10 (dynamic), 20 (overlay) so a rebuilt static layer is always
 * beneath the dynamic content drawn in the same frame.
 */
export function registerFrameTask(id: string, order: number, task: FrameTask): () => void {
  const entry: Entry = { id, order, task };
  entries.push(entry);
  entries.sort(byOrder);
  hookVisibility();
  requestFrame();
  return () => {
    const i = entries.indexOf(entry);
    if (i >= 0) entries.splice(i, 1);
    if (entries.length === 0) stopLoop();
  };
}

/** Ask for one more frame. Cheap and idempotent — call it freely. */
export function requestFrame(): void {
  wanted = true;
  if (IS_E2E) return;
  schedule();
}

function schedule(): void {
  if (rafId !== null) return;
  if (typeof requestAnimationFrame !== 'function') return;
  if (typeof document !== 'undefined' && document.hidden) return;
  rafId = requestAnimationFrame(frame);
}

function frame(nowMs: number): void {
  rafId = null;
  wanted = false;
  const again = runTasks(nowMs);
  if (again || wanted) schedule();
}

function runTasks(nowMs: number): boolean {
  if (running) return false;
  running = true;
  let again = false;
  // Snapshot: a task may unregister itself mid-frame.
  const snapshot = entries.slice();
  try {
    for (const e of snapshot) {
      try {
        if (e.task(nowMs) === true) again = true;
      } catch (err) {
        // One broken view must not take down every other view's rendering.
        console.error(`[render] frame task "${e.id}" threw`, err);
      }
    }
  } finally {
    running = false;
  }
  return again;
}

/**
 * Run every registered task once, synchronously.
 *
 * This is the E2E entry point and the only way a frame happens under
 * `?e2e=1`. It is also handy in a jsdom component test.
 */
export function renderOnce(nowMs?: number): void {
  const t =
    nowMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
  wanted = false;
  runTasks(t);
}

export function stopLoop(): void {
  if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
  rafId = null;
}

export function frameTaskCount(): number {
  return entries.length;
}

function hookVisibility(): void {
  if (visibilityHooked) return;
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  visibilityHooked = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopLoop();
    else requestFrame();
  });
}

/** Test-only: forget every registration. */
export function resetFrameTasks(): void {
  entries.length = 0;
  stopLoop();
}
