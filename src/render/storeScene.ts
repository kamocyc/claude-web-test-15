/**
 * The default scene source: the app's Zustand stores, read imperatively.
 *
 * The views need application state 60 times a second, and subscribing a React
 * component to a store at that rate would defeat the entire layered-canvas
 * design. So this module never uses a hook: it reads `getState()` inside the
 * frame callback and publishes change notifications through the scene
 * registry, which the shadow throttles to 4 Hz.
 *
 * Two things keep the per-frame path allocation-free:
 *
 *   - `getIndex()` memoizes on the document revision, so calling it every
 *     frame is a comparison, not a rebuild;
 *   - `snapshotInto` reuses one pooled `SimSnapshot` — the engine exposes it
 *     precisely for this caller.
 *
 * Registering explicitly with `setRenderSceneSource` always wins over this
 * default, which is how tests and the fixture take control.
 */

import { snapshotInto } from '@/engine';
import { createEmptySnapshot } from '@/engine/snapshot';
import type { SimSnapshot } from '@/engine/types';
import { useClockStore } from '@/store/clockStore';
import { getIndex, getIndexGeneration, useProjectStore } from '@/store/projectStore';
import { useUiStore } from '@/store/uiStore';
import { requestFrame } from './canvas/rafLoop';
import { setDefaultRenderSceneSource, type RenderScene, type RenderSceneSource } from './scene';
import type { ViewSelection } from './types';

/** One pooled snapshot for the whole app. Refilled, never reallocated. */
const pooled: SimSnapshot = createEmptySnapshot();

/** Rebuilt only when the selection actually changes, not every frame. */
let selectionCache: ViewSelection | undefined;
let selectionKey = '';

let scene: RenderScene | undefined;

function buildScene(): RenderScene {
  const { tSec, playing } = useClockStore.getState();
  const index = getIndex();
  const ui = useUiStore.getState();

  const key = `${ui.selected.map((r) => JSON.stringify(r)).join('|')}#${
    ui.hovered ? JSON.stringify(ui.hovered) : ''
  }`;
  if (key !== selectionKey || selectionCache === undefined) {
    selectionKey = key;
    selectionCache = ui.hovered
      ? { selected: ui.selected, hovered: ui.hovered }
      : { selected: ui.selected };
  }

  snapshotInto(index, tSec, pooled);

  // The object identity churns once per frame but its contents are pooled;
  // nothing downstream keeps it past the frame.
  scene = {
    doc: index.doc,
    index,
    t: tSec,
    snapshot: pooled,
    selection: selectionCache,
    generation: getIndexGeneration(),
    playing,
  };
  return scene;
}

export const storeSceneSource: RenderSceneSource = {
  get: () => buildScene(),
  subscribe(onChange) {
    const unsubscribers = [
      useProjectStore.subscribe(onChange),
      useClockStore.subscribe(onChange),
      useUiStore.subscribe(onChange),
    ];
    return () => {
      for (const off of unsubscribers) off();
    };
  },
};

/**
 * Install the stores as the fallback scene source and keep the frame loop
 * awake while the clock is playing.
 *
 * Called for its side effect from `src/render/index.ts`, so any consumer that
 * imports `@/render` gets working views without wiring anything.
 */
export function connectRenderToStores(): void {
  setDefaultRenderSceneSource(storeSceneSource);
  useClockStore.subscribe(() => requestFrame());
}

connectRenderToStores();
