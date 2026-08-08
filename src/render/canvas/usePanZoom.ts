/**
 * Pan and zoom, shared by both canvas views.
 *
 * Pointer Events only (no mouse/touch split) with `touch-action: none` on the
 * container, so a trackpad, a mouse and a touchscreen all take the same code
 * path. Drag pans; wheel zooms x about the cursor; Ctrl+wheel zooms y;
 * Shift+wheel pans x, which is what a horizontal scroll gesture should do on a
 * time axis.
 *
 * The camera lives in a ref, never in React state. Panning must not re-render
 * a component tree — it marks the affected layers dirty and asks the shared
 * rAF loop for a frame.
 *
 * The wheel listener is attached natively because React's synthetic `wheel`
 * handler is registered passively and therefore cannot `preventDefault` the
 * page scroll.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { Camera2D, ScaleLimits, Viewport, WorldBounds } from './camera';
import { clampCamera, cloneCamera, panByScreen, zoomAbout } from './camera';

/** A drag handler returned by an interceptor that wants to own the gesture. */
export type CustomDrag = (screenX: number, screenY: number, done: boolean) => void;

export interface PanZoomOptions {
  cameraRef: RefObject<Camera2D>;
  boundsRef: RefObject<WorldBounds>;
  viewportRef: RefObject<Viewport>;
  limits?: ScaleLimits;
  /** Called after any camera change. */
  onCameraChange(): void;
  /** A click that did not move — the selection gesture. */
  onClick?(screenX: number, screenY: number, additive: boolean): void;
  onHover?(screenX: number, screenY: number): void;
  onLeave?(): void;
  /**
   * First refusal on a pointerdown. Return a drag handler to take over the
   * gesture (the string diagram's now-line uses this), or undefined to pan.
   */
  interceptDown?(screenX: number, screenY: number): CustomDrag | undefined;
  /** false locks the y axis entirely (Ctrl+wheel does nothing). */
  allowZoomY?: boolean;
  padding?: number;
}

export interface PanZoomHandlers {
  onPointerDown(e: React.PointerEvent<HTMLElement>): void;
  onPointerMove(e: React.PointerEvent<HTMLElement>): void;
  onPointerUp(e: React.PointerEvent<HTMLElement>): void;
  onPointerLeave(e: React.PointerEvent<HTMLElement>): void;
}

const CLICK_SLOP_PX = 4;
const WHEEL_ZOOM_PER_LINE = 0.0022;

export function usePanZoom(
  containerRef: RefObject<HTMLElement | null>,
  opts: PanZoomOptions,
): PanZoomHandlers {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const drag = useRef<{
    pointerId: number;
    lastX: number;
    lastY: number;
    startX: number;
    startY: number;
    moved: number;
    custom?: CustomDrag;
  } | null>(null);

  const localPoint = useCallback(
    (e: { clientX: number; clientY: number }): { x: number; y: number } => {
      const el = containerRef.current;
      if (!el) return { x: e.clientX, y: e.clientY };
      const rect = el.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    },
    [containerRef],
  );

  const applyClamp = useCallback((next: Camera2D): Camera2D => {
    const o = optsRef.current;
    return clampCamera(next, o.boundsRef.current, o.viewportRef.current, o.padding ?? 24);
  }, []);

  // -- wheel (native, non-passive) -----------------------------------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const o = optsRef.current;
      const cam = o.cameraRef.current;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;

      // A line-mode wheel reports ~3 lines per notch; normalise to pixels.
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;

      if (e.shiftKey) {
        o.cameraRef.current = applyClamp(panByScreen(cam, -dy, 0));
      } else if (e.ctrlKey || e.metaKey) {
        if (o.allowZoomY === false) return;
        const f = Math.exp(-dy * WHEEL_ZOOM_PER_LINE);
        o.cameraRef.current = applyClamp(zoomAbout(cam, px, py, 1, f, o.limits));
      } else {
        const f = Math.exp(-dy * WHEEL_ZOOM_PER_LINE);
        o.cameraRef.current = applyClamp(zoomAbout(cam, px, py, f, 1, o.limits));
      }
      o.onCameraChange();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [containerRef, applyClamp]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const o = optsRef.current;
      const p = localPoint(e);
      const custom = o.interceptDown?.(p.x, p.y);
      drag.current = {
        pointerId: e.pointerId,
        lastX: p.x,
        lastY: p.y,
        startX: p.x,
        startY: p.y,
        moved: 0,
        ...(custom ? { custom } : {}),
      };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      if (custom) custom(p.x, p.y, false);
    },
    [localPoint],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const o = optsRef.current;
      const p = localPoint(e);
      const d = drag.current;
      if (!d || d.pointerId !== e.pointerId) {
        o.onHover?.(p.x, p.y);
        return;
      }
      const dx = p.x - d.lastX;
      const dy = p.y - d.lastY;
      d.lastX = p.x;
      d.lastY = p.y;
      d.moved += Math.abs(dx) + Math.abs(dy);

      if (d.custom) {
        d.custom(p.x, p.y, false);
        return;
      }
      o.cameraRef.current = applyClamp(panByScreen(cloneCamera(o.cameraRef.current), dx, dy));
      o.onCameraChange();
    },
    [localPoint, applyClamp],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const o = optsRef.current;
      const d = drag.current;
      drag.current = null;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      if (!d) return;
      const p = localPoint(e);
      if (d.custom) {
        d.custom(p.x, p.y, true);
        return;
      }
      if (d.moved <= CLICK_SLOP_PX) {
        o.onClick?.(p.x, p.y, e.shiftKey || e.metaKey || e.ctrlKey);
      }
    },
    [localPoint],
  );

  const onPointerLeave = useCallback(() => {
    optsRef.current.onLeave?.();
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerLeave };
}
