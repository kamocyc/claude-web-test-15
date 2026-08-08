/**
 * `window.__render` — the E2E geometry probe.
 *
 * A digest of integer screen coordinates for every drawn train and station
 * tests the whole transform chain end to end (layout → camera → DPR) and fails
 * with a readable diff: "train trn-1 moved from sx 412 to sx 118". A pixel
 * comparison would catch the same regression and tell you nothing about it,
 * while also breaking whenever a font renders half a pixel differently.
 *
 * Both views register here; the shared object is installed once. `digest`
 * forces a synchronous frame first, so Playwright never has to wait for a rAF
 * that, under `?e2e=1`, is never going to come.
 */

import { installRenderHooks, type RenderTestHooks } from '@/testMode';
import { renderOnce } from './canvas/rafLoop';
import type { RenderDigest } from './types';

export type DigestView = 'line' | 'diagram';

const providers = new Map<DigestView, () => RenderDigest>();
let installed = false;

const EMPTY: RenderDigest = { view: '', width: 0, height: 0, trains: [], stations: [] };

const hooks: RenderTestHooks = {
  digest(view) {
    renderOnce();
    const provider = providers.get(view);
    if (!provider) return { ...EMPTY, view };
    return provider();
  },
};

/** Register a view's digest provider; returns an unregister function. */
export function registerDigest(view: DigestView, provider: () => RenderDigest): () => void {
  providers.set(view, provider);
  if (!installed) {
    installRenderHooks(hooks);
    installed = true;
  }
  return () => {
    if (providers.get(view) === provider) providers.delete(view);
  };
}

/** Direct access for component tests that do not go through `window`. */
export function digestOf(view: DigestView): RenderDigest {
  return hooks.digest(view);
}
