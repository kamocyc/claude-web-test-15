/**
 * Three stacked canvases, sized to their container and to the device pixel
 * ratio, with a dirty flag each.
 *
 * The split is the central performance decision of this stream:
 *
 * - `static`  — grid, axes, station rules and labels, rails, and in the string
 *               diagram every train polyline. None of that moves as the clock
 *               advances, so it is redrawn only when the camera or the
 *               document changes. Drawing 500 polylines 60 times a second to
 *               produce an identical image is pure waste.
 * - `dynamic` — the things that actually move: train markers, the time cursor,
 *               active-train dots. Redrawn per frame while playing.
 * - `overlay` — hover and selection. Redrawn on pointer events only.
 *
 * `ctx.setTransform` is used here, and only here, for the DPR base transform.
 * Every draw function positions primitives with explicit arithmetic so that
 * text, marker sizes and line widths stay constant under zoom.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { requestFrame } from './rafLoop';

export const LAYERS = ['static', 'dynamic', 'overlay'] as const;
export type LayerName = (typeof LAYERS)[number];

export interface LayerSize {
  /** CSS pixels. */
  width: number;
  height: number;
  dpr: number;
}

export interface CanvasLayers {
  containerRef: RefObject<HTMLDivElement | null>;
  refs: Record<LayerName, RefObject<HTMLCanvasElement | null>>;
  /** Live size — read inside a frame callback; never triggers a render. */
  sizeRef: RefObject<LayerSize>;
  /** Size as of the last React render, for components that must lay out. */
  size: LayerSize;
  markDirty(layer: LayerName): void;
  markAllDirty(): void;
  /** True exactly once per dirty marking. Call at the top of a draw. */
  consumeDirty(layer: LayerName): boolean;
  isDirty(layer: LayerName): boolean;
  /** The 2-D context with the DPR transform already applied, or null. */
  contextOf(layer: LayerName): CanvasRenderingContext2D | null;
  /** Clear a layer's full CSS-pixel area. */
  clear(layer: LayerName): void;
}

const INITIAL_SIZE: LayerSize = { width: 0, height: 0, dpr: 1 };

function currentDpr(): number {
  if (typeof window === 'undefined') return 1;
  const d = window.devicePixelRatio;
  return Number.isFinite(d) && d > 0 ? Math.min(d, 3) : 1;
}

export function useCanvasLayers(): CanvasLayers {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const staticRef = useRef<HTMLCanvasElement | null>(null);
  const dynamicRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  const refs = useMemo(
    () => ({ static: staticRef, dynamic: dynamicRef, overlay: overlayRef }),
    [],
  );

  const sizeRef = useRef<LayerSize>(INITIAL_SIZE);
  const [size, setSize] = useState<LayerSize>(INITIAL_SIZE);
  const dirty = useRef<Record<LayerName, boolean>>({
    static: true,
    dynamic: true,
    overlay: true,
  });

  const markDirty = useCallback((layer: LayerName) => {
    dirty.current[layer] = true;
    requestFrame();
  }, []);

  const markAllDirty = useCallback(() => {
    dirty.current.static = true;
    dirty.current.dynamic = true;
    dirty.current.overlay = true;
    requestFrame();
  }, []);

  const consumeDirty = useCallback((layer: LayerName) => {
    const was = dirty.current[layer];
    dirty.current[layer] = false;
    return was;
  }, []);

  const isDirty = useCallback((layer: LayerName) => dirty.current[layer], []);

  /** Resize backing stores and reapply the DPR transform. */
  const applySize = useCallback(
    (next: LayerSize) => {
      const prev = sizeRef.current;
      const changed =
        prev.width !== next.width || prev.height !== next.height || prev.dpr !== next.dpr;
      sizeRef.current = next;
      for (const name of LAYERS) {
        const canvas = refs[name].current;
        if (!canvas) continue;
        const bw = Math.max(1, Math.round(next.width * next.dpr));
        const bh = Math.max(1, Math.round(next.height * next.dpr));
        if (canvas.width !== bw) canvas.width = bw;
        if (canvas.height !== bh) canvas.height = bh;
        const ctx = canvas.getContext('2d');
        // The ONLY setTransform in the stream.
        ctx?.setTransform(next.dpr, 0, 0, next.dpr, 0, 0);
      }
      if (changed) {
        markAllDirty();
        setSize(next);
      }
    },
    [refs, markAllDirty],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const measure = (): void => {
      const rect = el.getBoundingClientRect();
      applySize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
        dpr: currentDpr(),
      });
    };

    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);

    // devicePixelRatio changes when a window moves between displays or the
    // page is zoomed; ResizeObserver does not fire for that.
    let media: MediaQueryList | undefined;
    const onDpr = (): void => measure();
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      media = window.matchMedia(`(resolution: ${currentDpr()}dppx)`);
      media.addEventListener?.('change', onDpr);
    }

    return () => {
      ro.disconnect();
      media?.removeEventListener?.('change', onDpr);
    };
  }, [applySize]);

  const contextOf = useCallback(
    (layer: LayerName): CanvasRenderingContext2D | null => {
      const canvas = refs[layer].current;
      if (!canvas) return null;
      return canvas.getContext('2d');
    },
    [refs],
  );

  const clear = useCallback(
    (layer: LayerName) => {
      const ctx = contextOf(layer);
      if (!ctx) return;
      const { width, height } = sizeRef.current;
      ctx.clearRect(0, 0, width, height);
    },
    [contextOf],
  );

  return {
    containerRef,
    refs,
    sizeRef,
    size,
    markDirty,
    markAllDirty,
    consumeDirty,
    isDirty,
    contextOf,
    clear,
  };
}

/** Inline styles for the stack — no CSS file, so unit tests import cleanly. */
export const layerStyles = {
  container: {
    position: 'relative',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    touchAction: 'none',
    contain: 'strict',
  } as const,
  canvas: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    display: 'block',
  } as const,
} satisfies Record<string, CSSProperties>;
