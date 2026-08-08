/**
 * A fake 2-D context that records every call.
 *
 * Every draw function in this stream takes a `DrawContext` rather than
 * reaching for a canvas of its own. That single parameter buys the whole
 * geometry test strategy: `draw.test.ts` runs the real drawing code in a plain
 * node process with no canvas implementation at all, and snapshots the ordered
 * call log. When a transform breaks, the diff names the primitive and the
 * numbers, instead of reporting that two PNGs differ by 0.3%.
 */

/**
 * The subset of `CanvasRenderingContext2D` the render stream uses.
 *
 * A real `CanvasRenderingContext2D` is structurally assignable to this, so
 * production code passes the browser context straight through.
 */
export interface DrawContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;

  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  setLineDash(segments: number[]): void;
  translate(x: number, y: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number): void;
}

export interface RecordedCall {
  op: string;
  args: unknown[];
}

export interface RecordingContext extends DrawContext {
  readonly calls: RecordedCall[];
  /** One readable line per call — the snapshot payload. */
  lines(): string[];
  /** Calls of a single op, e.g. every `fillText`. */
  ops(op: string): RecordedCall[];
  reset(): void;
}

const ROUND = 1e3;

function fmt(v: unknown): string {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);
    const r = Math.round(v * ROUND) / ROUND;
    return Object.is(r, -0) ? '0' : String(r);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(fmt).join(',')}]`;
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') return '<object>';
  return String(v);
}

/**
 * Create a recording context.
 *
 * Property writes are recorded too (as `set fillStyle`), because "which colour
 * was this stroked in" is exactly the sort of regression a call-log snapshot
 * should catch.
 */
export function createRecordingContext(): RecordingContext {
  const calls: RecordedCall[] = [];
  const push = (op: string, ...args: unknown[]): void => {
    calls.push({ op, args });
  };

  const state = {
    fillStyle: '#000000' as string | CanvasGradient | CanvasPattern,
    strokeStyle: '#000000' as string | CanvasGradient | CanvasPattern,
    lineWidth: 1,
    lineCap: 'butt' as CanvasLineCap,
    lineJoin: 'miter' as CanvasLineJoin,
    globalAlpha: 1,
    font: '10px sans-serif',
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
  };

  function prop<K extends keyof typeof state>(name: K) {
    return {
      get(): (typeof state)[K] {
        return state[name];
      },
      set(v: (typeof state)[K]) {
        if (state[name] === v) return;
        state[name] = v;
        push(`set ${String(name)}`, v);
      },
      enumerable: true,
      configurable: true,
    };
  }

  const ctx: RecordingContext = {
    calls,
    lines: () => calls.map((c) => `${c.op}(${c.args.map(fmt).join(', ')})`),
    ops: (op: string) => calls.filter((c) => c.op === op),
    reset: () => {
      calls.length = 0;
    },

    save: () => push('save'),
    restore: () => push('restore'),
    beginPath: () => push('beginPath'),
    closePath: () => push('closePath'),
    moveTo: (x, y) => push('moveTo', x, y),
    lineTo: (x, y) => push('lineTo', x, y),
    quadraticCurveTo: (cpx, cpy, x, y) => push('quadraticCurveTo', cpx, cpy, x, y),
    arc: (x, y, r, s, e) => push('arc', x, y, r, s, e),
    rect: (x, y, w, h) => push('rect', x, y, w, h),
    fill: () => push('fill'),
    stroke: () => push('stroke'),
    clip: () => push('clip'),
    fillRect: (x, y, w, h) => push('fillRect', x, y, w, h),
    strokeRect: (x, y, w, h) => push('strokeRect', x, y, w, h),
    clearRect: (x, y, w, h) => push('clearRect', x, y, w, h),
    fillText: (t, x, y) => push('fillText', t, x, y),
    // Deterministic and canvas-free: 6 px per character is close enough for
    // layout decisions and never varies by platform font.
    measureText: (t: string) => ({ width: t.length * 6 }),
    setLineDash: (s) => push('setLineDash', s),
    translate: (x, y) => push('translate', x, y),
    setTransform: (a, b, c, d, e, f) => push('setTransform', a, b, c, d, e, f),
    drawImage: (_image, dx, dy) => push('drawImage', '<image>', dx, dy),
  } as RecordingContext;

  Object.defineProperties(ctx, {
    fillStyle: prop('fillStyle'),
    strokeStyle: prop('strokeStyle'),
    lineWidth: prop('lineWidth'),
    lineCap: prop('lineCap'),
    lineJoin: prop('lineJoin'),
    globalAlpha: prop('globalAlpha'),
    font: prop('font'),
    textAlign: prop('textAlign'),
    textBaseline: prop('textBaseline'),
  });

  return ctx;
}

// ---------------------------------------------------------------------------
// Small path helpers shared by the draw modules
// ---------------------------------------------------------------------------

/**
 * Rounded-rectangle path built from primitives.
 *
 * `ctx.roundRect` exists in modern browsers but not in every headless target,
 * and adding it to `DrawContext` would force the recording context to model a
 * primitive we can express in four `quadraticCurveTo`s.
 */
export function roundRectPath(
  ctx: DrawContext,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

export function linePath(ctx: DrawContext, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}
