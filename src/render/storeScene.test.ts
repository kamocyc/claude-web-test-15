/**
 * The store-backed scene source is what actually runs in the app, so it gets
 * the same scrutiny as the pure geometry: it must never throw on an empty
 * project, must pool its snapshot, and must not change `generation` when only
 * the clock moves.
 */

import { describe, expect, it } from 'vitest';
import { useClockStore } from '@/store/clockStore';
import { useProjectStore } from '@/store/projectStore';
import { toyProject } from '@/testing/toyProject';
import { getRenderScene, hasRenderScene } from './scene';
import { storeSceneSource } from './storeScene';

describe('storeSceneSource', () => {
  it('is installed as the default, so the views need no wiring', () => {
    expect(hasRenderScene()).toBe(true);
    expect(getRenderScene()).toBeDefined();
  });

  it('produces a usable scene from a brand-new empty project', () => {
    const scene = storeSceneSource.get()!;
    expect(scene.doc).toBeDefined();
    expect(scene.index.doc).toBe(scene.doc);
    expect(scene.snapshot.trains).toEqual([]);
    expect(scene.selection?.selected).toEqual([]);
  });

  it('reuses one pooled snapshot — the frame path must not allocate', () => {
    const a = storeSceneSource.get()!;
    const b = storeSceneSource.get()!;
    expect(a.snapshot).toBe(b.snapshot);
  });

  it('follows the clock without bumping the layout generation', () => {
    const before = storeSceneSource.get()!;
    const generation = before.generation;
    useClockStore.getState().seek(8 * 3600 + 5 * 60);
    const after = storeSceneSource.get()!;
    expect(after.t).toBe(8 * 3600 + 5 * 60);
    // A clock tick must not invalidate any layout or static canvas.
    expect(after.generation).toBe(generation);
  });

  it('bumps the generation when the document is replaced', () => {
    const before = storeSceneSource.get()!.generation;
    useProjectStore.getState().hydrate(toyProject());
    const after = storeSceneSource.get()!;
    expect(after.generation).toBeGreaterThan(before);
    expect(after.doc.trains.allIds.length).toBeGreaterThan(0);
  });

  it('notifies subscribers when the clock moves', () => {
    let calls = 0;
    const off = storeSceneSource.subscribe(() => {
      calls++;
    });
    useClockStore.getState().seek(9 * 3600);
    off();
    expect(calls).toBeGreaterThan(0);
  });
});
