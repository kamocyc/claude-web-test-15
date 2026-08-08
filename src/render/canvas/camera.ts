/**
 * A 2-D camera with **independent axis scales**.
 *
 * Both canvas views need to zoom one axis without touching the other: the line
 * view zooms metres-along-the-line while lane height stays a fixed number of
 * CSS pixels, and the string diagram zooms time and distance separately. A
 * single uniform `scale` cannot express that, so `scaleX` and `scaleY` are
 * separate throughout.
 *
 * `x`/`y` are the world coordinates that land on the top-left corner of the
 * viewport, so the mapping is
 *
 *     screen = (world - camera.origin) * scale
 *
 * Nothing here touches a canvas: no `ctx`, no DOM, no globals. The renderer
 * uses `ctx.setTransform` ONLY for the device-pixel-ratio base transform and
 * converts every primitive through these functions, because text size, marker
 * size and line widths must not scale with zoom.
 */

export interface Camera2D {
  /** World x at screen x = 0. */
  x: number;
  /** World y at screen y = 0. */
  y: number;
  /** Screen pixels per world x unit. */
  scaleX: number;
  /** Screen pixels per world y unit. */
  scaleY: number;
}

export interface WorldBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface ScaleLimits {
  minScaleX: number;
  maxScaleX: number;
  minScaleY: number;
  maxScaleY: number;
}

export const DEFAULT_SCALE_LIMITS: ScaleLimits = {
  minScaleX: 1e-6,
  maxScaleX: 1e4,
  minScaleY: 1e-6,
  maxScaleY: 1e4,
};

export function createCamera(partial: Partial<Camera2D> = {}): Camera2D {
  return {
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    scaleX: partial.scaleX ?? 1,
    scaleY: partial.scaleY ?? 1,
  };
}

export function cloneCamera(cam: Camera2D): Camera2D {
  return { x: cam.x, y: cam.y, scaleX: cam.scaleX, scaleY: cam.scaleY };
}

export function camerasEqual(a: Camera2D, b: Camera2D): boolean {
  return a.x === b.x && a.y === b.y && a.scaleX === b.scaleX && a.scaleY === b.scaleY;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export function worldToScreenX(cam: Camera2D, worldX: number): number {
  return (worldX - cam.x) * cam.scaleX;
}

export function worldToScreenY(cam: Camera2D, worldY: number): number {
  return (worldY - cam.y) * cam.scaleY;
}

export function screenToWorldX(cam: Camera2D, screenX: number): number {
  return cam.x + screenX / cam.scaleX;
}

export function screenToWorldY(cam: Camera2D, screenY: number): number {
  return cam.y + screenY / cam.scaleY;
}

export function worldToScreen(
  cam: Camera2D,
  worldX: number,
  worldY: number,
): { x: number; y: number } {
  return { x: worldToScreenX(cam, worldX), y: worldToScreenY(cam, worldY) };
}

export function screenToWorld(
  cam: Camera2D,
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  return { x: screenToWorldX(cam, screenX), y: screenToWorldY(cam, screenY) };
}

/** The world rectangle currently visible, useful for culling. */
export function visibleWorldBounds(cam: Camera2D, viewport: Viewport): WorldBounds {
  return {
    minX: screenToWorldX(cam, 0),
    maxX: screenToWorldX(cam, viewport.width),
    minY: screenToWorldY(cam, 0),
    maxY: screenToWorldY(cam, viewport.height),
  };
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

/** Pan by a screen-space delta (what a pointer drag produces). */
export function panByScreen(cam: Camera2D, dxScreen: number, dyScreen: number): Camera2D {
  return {
    x: cam.x - dxScreen / cam.scaleX,
    y: cam.y - dyScreen / cam.scaleY,
    scaleX: cam.scaleX,
    scaleY: cam.scaleY,
  };
}

function clampNumber(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Zoom about a fixed screen point. The world point currently under
 * `(screenX, screenY)` stays under it afterwards — the single property that
 * makes wheel-zoom feel right, and the one `camera.test.ts` pins down.
 */
export function zoomAbout(
  cam: Camera2D,
  screenX: number,
  screenY: number,
  factorX: number,
  factorY: number,
  limits: ScaleLimits = DEFAULT_SCALE_LIMITS,
): Camera2D {
  const worldX = screenToWorldX(cam, screenX);
  const worldY = screenToWorldY(cam, screenY);
  const scaleX = clampNumber(cam.scaleX * factorX, limits.minScaleX, limits.maxScaleX);
  const scaleY = clampNumber(cam.scaleY * factorY, limits.minScaleY, limits.maxScaleY);
  // An axis whose scale did not move keeps its origin bit-for-bit. Without
  // this, zooming x fifty times walks y by a few ULPs each round trip and the
  // view slowly drifts.
  return {
    scaleX,
    scaleY,
    x: scaleX === cam.scaleX ? cam.x : worldX - screenX / scaleX,
    y: scaleY === cam.scaleY ? cam.y : worldY - screenY / scaleY,
  };
}

/** Set an absolute scale while keeping a screen point fixed. */
export function setScaleAbout(
  cam: Camera2D,
  screenX: number,
  screenY: number,
  scaleX: number,
  scaleY: number,
  limits: ScaleLimits = DEFAULT_SCALE_LIMITS,
): Camera2D {
  const fx = scaleX / cam.scaleX;
  const fy = scaleY / cam.scaleY;
  return zoomAbout(cam, screenX, screenY, fx, fy, limits);
}

/**
 * Keep the camera over the content.
 *
 * When the content is narrower than the viewport on an axis it is centred on
 * that axis rather than pinned to the origin — a two-station line pinned to
 * the left edge of a wide window looks broken.
 */
export function clampCamera(
  cam: Camera2D,
  bounds: WorldBounds,
  viewport: Viewport,
  paddingPx = 0,
): Camera2D {
  const out = cloneCamera(cam);
  out.x = clampAxis(cam.x, bounds.minX, bounds.maxX, cam.scaleX, viewport.width, paddingPx);
  out.y = clampAxis(cam.y, bounds.minY, bounds.maxY, cam.scaleY, viewport.height, paddingPx);
  return out;
}

function clampAxis(
  origin: number,
  min: number,
  max: number,
  scale: number,
  viewportSize: number,
  paddingPx: number,
): number {
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(viewportSize)) return origin;
  const worldSpan = Math.max(0, max - min);
  const screenSpan = worldSpan * scale + paddingPx * 2;
  if (screenSpan <= viewportSize) {
    // Centre the content.
    return min - (viewportSize / scale - worldSpan) / 2;
  }
  const lo = min - paddingPx / scale;
  const hi = max + paddingPx / scale - viewportSize / scale;
  return clampNumber(origin, lo, hi);
}

/** A camera showing all of `bounds` with `paddingPx` breathing room. */
export function fitToBounds(
  bounds: WorldBounds,
  viewport: Viewport,
  paddingPx = 16,
  limits: ScaleLimits = DEFAULT_SCALE_LIMITS,
): Camera2D {
  const spanX = Math.max(bounds.maxX - bounds.minX, Number.EPSILON);
  const spanY = Math.max(bounds.maxY - bounds.minY, Number.EPSILON);
  const usableW = Math.max(viewport.width - paddingPx * 2, 1);
  const usableH = Math.max(viewport.height - paddingPx * 2, 1);
  const scaleX = clampNumber(usableW / spanX, limits.minScaleX, limits.maxScaleX);
  const scaleY = clampNumber(usableH / spanY, limits.minScaleY, limits.maxScaleY);
  return {
    scaleX,
    scaleY,
    x: bounds.minX - paddingPx / scaleX,
    y: bounds.minY - paddingPx / scaleY,
  };
}

/**
 * Like `fitToBounds` but only for the x axis; y scale and origin are kept.
 * The line view uses this because lane height is fixed in CSS pixels.
 */
export function fitXToBounds(
  cam: Camera2D,
  bounds: WorldBounds,
  viewport: Viewport,
  paddingPx = 16,
  limits: ScaleLimits = DEFAULT_SCALE_LIMITS,
): Camera2D {
  const spanX = Math.max(bounds.maxX - bounds.minX, Number.EPSILON);
  const usableW = Math.max(viewport.width - paddingPx * 2, 1);
  const scaleX = clampNumber(usableW / spanX, limits.minScaleX, limits.maxScaleX);
  return {
    scaleX,
    scaleY: cam.scaleY,
    x: bounds.minX - paddingPx / scaleX,
    y: cam.y,
  };
}

/**
 * Like `fitToBounds` but only for the y axis; x scale and origin are kept.
 *
 * The line view fits the two axes with different padding and different scale
 * limits — x is a free zoom over metres, y is a lane pitch that must stay in a
 * legible band — so it composes `fitXToBounds` and this rather than using the
 * uniform `fitToBounds`.
 */
export function fitYToBounds(
  cam: Camera2D,
  bounds: WorldBounds,
  viewport: Viewport,
  paddingPx = 16,
  limits: ScaleLimits = DEFAULT_SCALE_LIMITS,
): Camera2D {
  const spanY = Math.max(bounds.maxY - bounds.minY, Number.EPSILON);
  const usableH = Math.max(viewport.height - paddingPx * 2, 1);
  const scaleY = clampNumber(usableH / spanY, limits.minScaleY, limits.maxScaleY);
  return {
    scaleX: cam.scaleX,
    scaleY,
    x: cam.x,
    y: bounds.minY - paddingPx / scaleY,
  };
}

/** Centre a world point in the viewport without changing scale. */
export function centerOn(
  cam: Camera2D,
  worldX: number,
  worldY: number,
  viewport: Viewport,
): Camera2D {
  return {
    scaleX: cam.scaleX,
    scaleY: cam.scaleY,
    x: worldX - viewport.width / 2 / cam.scaleX,
    y: worldY - viewport.height / 2 / cam.scaleY,
  };
}

/**
 * Snap a screen coordinate onto the device pixel grid used for 1 px strokes.
 * A vertical rule drawn at an integer x with lineWidth 1 straddles two device
 * pixels and renders as a 2 px blur; the half-pixel offset fixes it.
 */
export function crisp(screenValue: number): number {
  return Math.round(screenValue) + 0.5;
}
