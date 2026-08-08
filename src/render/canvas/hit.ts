/**
 * Hit testing for the two canvas views.
 *
 * The two views have genuinely different shapes of problem, so they get two
 * structures rather than one compromise:
 *
 * **Line view — a rect list.** At most a few hundred train markers exist at
 * any instant and they are already being iterated to draw. Pushing each
 * marker's screen rect into a preallocated flat array during the draw costs
 * nothing, and a reverse linear scan gives correct topmost-wins semantics for
 * free (the draw order *is* the z order).
 *
 * **String diagram — a uniform grid.** ~500 polylines of ~20 segments is
 * ~10 000 segments; scanning them per pointer move is wasteful, and they do
 * not change between layout rebuilds. A uniform grid over world space is built
 * once with the layout and answers a hover in a handful of cells.
 *
 * The diagram's distance test runs in **screen** space. Under a non-uniform
 * zoom (time zoomed in, distance not) a world-space radius is an ellipse, so a
 * world-space threshold would pick lines the user is nowhere near.
 */

import type { Camera2D } from './camera';
import { worldToScreenX, worldToScreenY } from './camera';

// ---------------------------------------------------------------------------
// Rect list (line view)
// ---------------------------------------------------------------------------

/**
 * A preallocated, reusable list of screen-space rectangles.
 *
 * Reset and refilled every frame with zero garbage: the backing arrays are
 * only ever grown, never reallocated per frame.
 */
export class HitRects<T> {
  private xs: Float64Array;
  private ys: Float64Array;
  private ws: Float64Array;
  private hs: Float64Array;
  private refs: Array<T | undefined>;
  private n = 0;

  constructor(capacity = 512) {
    this.xs = new Float64Array(capacity);
    this.ys = new Float64Array(capacity);
    this.ws = new Float64Array(capacity);
    this.hs = new Float64Array(capacity);
    this.refs = new Array<T | undefined>(capacity);
  }

  get count(): number {
    return this.n;
  }

  reset(): void {
    this.n = 0;
  }

  push(ref: T, x: number, y: number, w: number, h: number): void {
    if (this.n === this.xs.length) this.grow();
    const i = this.n++;
    this.xs[i] = x;
    this.ys[i] = y;
    this.ws[i] = w;
    this.hs[i] = h;
    this.refs[i] = ref;
  }

  /** Topmost hit — scanned in reverse, because later draws sit on top. */
  pick(x: number, y: number, slopPx = 0): T | undefined {
    for (let i = this.n - 1; i >= 0; i--) {
      const rx = this.xs[i]!;
      const ry = this.ys[i]!;
      if (
        x >= rx - slopPx &&
        x <= rx + this.ws[i]! + slopPx &&
        y >= ry - slopPx &&
        y <= ry + this.hs[i]! + slopPx
      ) {
        return this.refs[i];
      }
    }
    return undefined;
  }

  rectOf(ref: T): { x: number; y: number; w: number; h: number } | undefined {
    for (let i = 0; i < this.n; i++) {
      if (this.refs[i] === ref) {
        return { x: this.xs[i]!, y: this.ys[i]!, w: this.ws[i]!, h: this.hs[i]! };
      }
    }
    return undefined;
  }

  private grow(): void {
    const cap = this.xs.length * 2;
    const xs = new Float64Array(cap);
    xs.set(this.xs);
    const ys = new Float64Array(cap);
    ys.set(this.ys);
    const ws = new Float64Array(cap);
    ws.set(this.ws);
    const hs = new Float64Array(cap);
    hs.set(this.hs);
    this.xs = xs;
    this.ys = ys;
    this.ws = ws;
    this.hs = hs;
    this.refs.length = cap;
  }
}

// ---------------------------------------------------------------------------
// Point-to-segment distance
// ---------------------------------------------------------------------------

/** Shortest distance from a point to a finite segment. Pure; unit tested. */
export function pointSegmentDistance(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x0, py - y0);
  let t = ((px - x0) * dx + (py - y0) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

// ---------------------------------------------------------------------------
// Uniform grid (string diagram)
// ---------------------------------------------------------------------------

/** A world-space polyline segment, with a back reference to its owner. */
export interface WorldSegment<T> {
  ref: T;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Roughly five minutes of time. */
export const DEFAULT_CELL_W = 300;
/** Roughly half a kilometre, in the diagram's world-y units. */
export const DEFAULT_CELL_H = 0.5;

/**
 * A uniform grid spatial index over world space.
 *
 * Built once per layout rebuild. Segments are inserted into every cell their
 * bounding box touches, which over-selects slightly for steep lines and is
 * exactly the right trade: the candidate set stays tiny and the precise test
 * happens afterwards in screen space.
 */
export class SegmentGrid<T> {
  readonly cellW: number;
  readonly cellH: number;
  private minX = 0;
  private minY = 0;
  private cols = 0;
  private rows = 0;
  private cells: Array<Array<WorldSegment<T>>> = [];
  private segments: Array<WorldSegment<T>> = [];

  constructor(cellW = DEFAULT_CELL_W, cellH = DEFAULT_CELL_H) {
    this.cellW = cellW > 0 ? cellW : DEFAULT_CELL_W;
    this.cellH = cellH > 0 ? cellH : DEFAULT_CELL_H;
  }

  get size(): number {
    return this.segments.length;
  }

  build(segments: Array<WorldSegment<T>>): void {
    this.segments = segments;
    this.cells = [];
    this.cols = 0;
    this.rows = 0;
    if (segments.length === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of segments) {
      minX = Math.min(minX, s.x0, s.x1);
      maxX = Math.max(maxX, s.x0, s.x1);
      minY = Math.min(minY, s.y0, s.y1);
      maxY = Math.max(maxY, s.y0, s.y1);
    }
    this.minX = minX;
    this.minY = minY;
    this.cols = Math.max(1, Math.ceil((maxX - minX) / this.cellW) + 1);
    this.rows = Math.max(1, Math.ceil((maxY - minY) / this.cellH) + 1);
    this.cells = new Array<Array<WorldSegment<T>>>(this.cols * this.rows);

    for (const s of segments) {
      const c0 = this.colOf(Math.min(s.x0, s.x1));
      const c1 = this.colOf(Math.max(s.x0, s.x1));
      const r0 = this.rowOf(Math.min(s.y0, s.y1));
      const r1 = this.rowOf(Math.max(s.y0, s.y1));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const i = r * this.cols + c;
          const bucket = this.cells[i];
          if (bucket) bucket.push(s);
          else this.cells[i] = [s];
        }
      }
    }
  }

  /** Every segment in the cells overlapping the given world rectangle. */
  query(minX: number, minY: number, maxX: number, maxY: number): Array<WorldSegment<T>> {
    if (this.cols === 0) return [];
    const out: Array<WorldSegment<T>> = [];
    const seen = new Set<WorldSegment<T>>();
    const c0 = this.colOf(minX);
    const c1 = this.colOf(maxX);
    const r0 = this.rowOf(minY);
    const r1 = this.rowOf(maxY);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const bucket = this.cells[r * this.cols + c];
        if (!bucket) continue;
        for (const s of bucket) {
          if (seen.has(s)) continue;
          seen.add(s);
          out.push(s);
        }
      }
    }
    return out;
  }

  private colOf(x: number): number {
    const c = Math.floor((x - this.minX) / this.cellW);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  private rowOf(y: number): number {
    const r = Math.floor((y - this.minY) / this.cellH);
    return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
  }
}

export interface SegmentHit<T> {
  segment: WorldSegment<T>;
  /** Screen-space distance from the pointer to the segment. */
  distance: number;
}

/**
 * Find the segment nearest a screen point, within `thresholdPx`.
 *
 * The grid query is done in world space (cheap, index-friendly); the actual
 * distance comparison is done in screen space (correct under non-uniform zoom).
 */
export function pickSegment<T>(
  grid: SegmentGrid<T>,
  cam: Camera2D,
  screenX: number,
  screenY: number,
  thresholdPx = 6,
): SegmentHit<T> | undefined {
  if (grid.size === 0) return undefined;
  const worldRx = thresholdPx / Math.max(cam.scaleX, 1e-9);
  const worldRy = thresholdPx / Math.max(cam.scaleY, 1e-9);
  const wx = cam.x + screenX / cam.scaleX;
  const wy = cam.y + screenY / cam.scaleY;

  const candidates = grid.query(wx - worldRx, wy - worldRy, wx + worldRx, wy + worldRy);
  let best: SegmentHit<T> | undefined;
  for (const s of candidates) {
    const d = pointSegmentDistance(
      screenX,
      screenY,
      worldToScreenX(cam, s.x0),
      worldToScreenY(cam, s.y0),
      worldToScreenX(cam, s.x1),
      worldToScreenY(cam, s.y1),
    );
    if (d <= thresholdPx && (best === undefined || d < best.distance)) {
      best = { segment: s, distance: d };
    }
  }
  return best;
}
