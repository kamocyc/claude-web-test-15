/**
 * The render stream's read-only window onto application state.
 *
 * `ui → render` is a one-way dependency, so the views cannot import a store
 * module from `src/ui`, and they must not subscribe to a React store at 60 Hz
 * either — re-rendering a component tree per frame is exactly the cost the
 * layered-canvas design exists to avoid.
 *
 * So the shell (or a test) registers a *source*: a plain
 * `{ get(), subscribe() }` pair, which is the shape every Zustand store
 * already has (`store.getState` / `store.subscribe`). Inside a frame callback
 * the views call `getRenderScene()` imperatively — no hooks, no React, no
 * allocation. React only ever sees the throttled shadow scene.
 *
 * Wiring from the shell is one line:
 *
 *     setRenderSceneSource({ get: () => buildScene(useAppStore.getState()),
 *                            subscribe: (fn) => useAppStore.subscribe(fn) });
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ProjectDocument } from '@/domain/model';
import type { Sec } from '@/domain/units';
import type { SimSnapshot, TimetableIndex } from '@/engine/types';
import { IS_E2E } from '@/testMode';
import type { ViewSelection } from './types';

export interface RenderScene {
  doc: ProjectDocument;
  index: TimetableIndex;
  /** Current clock position. */
  t: Sec;
  snapshot: SimSnapshot;
  selection?: ViewSelection;
  /**
   * Bumped whenever `doc` or `index` changes identity. Static layers and
   * layouts key off this; the clock moving must NOT change it.
   */
  generation: number;
  /** True while the clock is running — lets a view keep the rAF loop awake. */
  playing?: boolean;
}

export interface RenderSceneSource {
  get(): RenderScene | undefined;
  subscribe(onChange: () => void): () => void;
}

let source: RenderSceneSource | undefined;
let defaultSource: RenderSceneSource | undefined;
const listeners = new Set<() => void>();
let unsubscribeSource: (() => void) | undefined;
let unsubscribeDefault: (() => void) | undefined;

function notify(): void {
  for (const fn of listeners) fn();
}

/** Install (or clear, with `undefined`) the scene source. */
export function setRenderSceneSource(next: RenderSceneSource | undefined): void {
  unsubscribeSource?.();
  unsubscribeSource = undefined;
  source = next;
  if (next) unsubscribeSource = next.subscribe(notify);
  notify();
}

/**
 * The source used when nothing has been registered explicitly.
 *
 * `storeScene.ts` installs the app's Zustand stores here at import time, so a
 * consumer that imports `@/render` gets working views with no wiring, while a
 * test that calls `setRenderSceneSource` still takes precedence.
 */
export function setDefaultRenderSceneSource(next: RenderSceneSource | undefined): void {
  unsubscribeDefault?.();
  unsubscribeDefault = undefined;
  defaultSource = next;
  if (next) unsubscribeDefault = next.subscribe(notify);
  notify();
}

/** Imperative read. Safe to call inside a rAF callback. */
export function getRenderScene(): RenderScene | undefined {
  return (source ?? defaultSource)?.get();
}

export function hasRenderScene(): boolean {
  return source !== undefined || defaultSource !== undefined;
}

/** Subscribe to *any* scene change, including clock ticks. */
export function subscribeRenderScene(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ---------------------------------------------------------------------------
// React bindings
// ---------------------------------------------------------------------------

/**
 * Re-render only when the document/index generation changes.
 *
 * This is what layouts depend on. A clock tick does not change `generation`,
 * so playing the timetable causes zero React renders.
 */
export function useSceneGeneration(): number {
  return useSyncExternalStore(
    subscribeRenderScene,
    () => getRenderScene()?.generation ?? -1,
    () => -1,
  );
}

/** The default shadow refresh rate: 4 Hz. */
export const SHADOW_HZ = 4;
const SHADOW_INTERVAL_MS = 1000 / SHADOW_HZ;

/**
 * The scene as the hidden DOM shadow should see it.
 *
 * Throttled to `SHADOW_HZ` so the 60 Hz canvas path never touches the DOM —
 * and synchronous under `?e2e=1`, so Playwright reads a shadow that matches
 * the frame it just asked for, with no waiting.
 */
export function useShadowScene(): RenderScene | undefined {
  const [scene, setScene] = useState<RenderScene | undefined>(() => getRenderScene());
  const lastAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = useCallback(() => {
    lastAt.current = Date.now();
    timer.current = undefined;
    setScene(getRenderScene());
  }, []);

  useEffect(() => {
    const onChange = (): void => {
      if (IS_E2E) {
        flush();
        return;
      }
      if (timer.current !== undefined) return;
      const wait = Math.max(0, SHADOW_INTERVAL_MS - (Date.now() - lastAt.current));
      timer.current = setTimeout(flush, wait);
    };
    const unsubscribe = subscribeRenderScene(onChange);
    onChange();
    return () => {
      unsubscribe();
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [flush]);

  return scene;
}

// ---------------------------------------------------------------------------
// Static source helper
// ---------------------------------------------------------------------------

/**
 * Wrap a fixed scene as a source. Used by the fixture, by component tests and
 * by `?renderFixture=1` in dev.
 */
export function staticSceneSource(scene: RenderScene): RenderSceneSource {
  return {
    get: () => scene,
    subscribe: () => () => {},
  };
}
