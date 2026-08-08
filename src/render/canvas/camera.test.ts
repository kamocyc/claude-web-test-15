import { describe, expect, it } from 'vitest';
import {
  camerasEqual,
  centerOn,
  clampCamera,
  createCamera,
  crisp,
  fitToBounds,
  fitXToBounds,
  panByScreen,
  screenToWorld,
  screenToWorldX,
  setScaleAbout,
  visibleWorldBounds,
  worldToScreen,
  worldToScreenX,
  worldToScreenY,
  zoomAbout,
  type Camera2D,
  type ScaleLimits,
  type WorldBounds,
} from './camera';

const VIEWPORT = { width: 800, height: 400 };
const BOUNDS: WorldBounds = { minX: 0, maxX: 12_000, minY: 0, maxY: 6 };

function cam(over: Partial<Camera2D> = {}): Camera2D {
  return createCamera({ x: 1000, y: 1.5, scaleX: 0.05, scaleY: 26, ...over });
}

describe('projection', () => {
  it('round-trips screen <-> world on both axes', () => {
    const c = cam();
    for (const [wx, wy] of [
      [0, 0],
      [1234.5, 3.25],
      [-500, -2],
      [98_765, 41.5],
    ] as const) {
      const s = worldToScreen(c, wx, wy);
      const back = screenToWorld(c, s.x, s.y);
      expect(back.x).toBeCloseTo(wx, 9);
      expect(back.y).toBeCloseTo(wy, 9);
    }
  });

  it('keeps the axis scales independent', () => {
    const c = cam({ scaleX: 0.05, scaleY: 26 });
    // 1000 world-x units is 50 px; 1 world-y unit is 26 px.
    expect(worldToScreenX(c, 1000 + 1000) - worldToScreenX(c, 1000)).toBeCloseTo(50);
    expect(worldToScreenY(c, 1.5 + 1) - worldToScreenY(c, 1.5)).toBeCloseTo(26);
  });

  it('puts the camera origin at screen (0, 0)', () => {
    const c = cam();
    expect(worldToScreenX(c, c.x)).toBeCloseTo(0);
    expect(worldToScreenY(c, c.y)).toBeCloseTo(0);
  });

  it('reports the visible world rectangle', () => {
    const c = cam();
    const v = visibleWorldBounds(c, VIEWPORT);
    expect(v.minX).toBeCloseTo(1000);
    expect(v.maxX).toBeCloseTo(1000 + 800 / 0.05);
    expect(v.maxY).toBeCloseTo(1.5 + 400 / 26);
  });
});

describe('zoomAbout', () => {
  it('keeps the world point under the cursor fixed', () => {
    const c = cam();
    const px = 517;
    const py = 233;
    const before = screenToWorld(c, px, py);
    const next = zoomAbout(c, px, py, 2.5, 1.4);
    const after = screenToWorld(next, px, py);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('keeps the point fixed over a long chain of zooms', () => {
    let c = cam();
    const px = 120;
    const py = 88;
    const anchor = screenToWorld(c, px, py);
    for (let i = 0; i < 40; i++) {
      c = zoomAbout(c, px, py, i % 2 === 0 ? 1.1 : 0.93, 1);
    }
    const after = screenToWorld(c, px, py);
    expect(after.x).toBeCloseTo(anchor.x, 4);
  });

  it('zooming one axis leaves the other untouched', () => {
    const c = cam();
    const next = zoomAbout(c, 400, 200, 3, 1);
    expect(next.scaleY).toBe(c.scaleY);
    expect(next.y).toBe(c.y);
    expect(next.scaleX).toBeCloseTo(c.scaleX * 3);
  });

  it('respects scale limits', () => {
    const limits: ScaleLimits = { minScaleX: 0.01, maxScaleX: 0.1, minScaleY: 20, maxScaleY: 30 };
    const zoomedIn = zoomAbout(cam(), 0, 0, 1000, 1000, limits);
    expect(zoomedIn.scaleX).toBe(0.1);
    expect(zoomedIn.scaleY).toBe(30);
    const zoomedOut = zoomAbout(cam(), 0, 0, 0.0001, 0.0001, limits);
    expect(zoomedOut.scaleX).toBe(0.01);
    expect(zoomedOut.scaleY).toBe(20);
  });

  it('setScaleAbout reaches the requested scale and holds the anchor', () => {
    const c = cam();
    const anchor = screenToWorldX(c, 300);
    const next = setScaleAbout(c, 300, 0, 0.2, c.scaleY);
    expect(next.scaleX).toBeCloseTo(0.2);
    expect(screenToWorldX(next, 300)).toBeCloseTo(anchor, 6);
  });
});

describe('panByScreen', () => {
  it('moves the world under the pointer by exactly the drag delta', () => {
    const c = cam();
    const before = screenToWorld(c, 100, 100);
    const next = panByScreen(c, 40, -13);
    const after = screenToWorld(next, 140, 87);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });
});

describe('clampCamera', () => {
  it('keeps the viewport inside the bounds when content overflows', () => {
    const c = cam({ x: -9999, scaleX: 0.5 });
    const clamped = clampCamera(c, BOUNDS, VIEWPORT);
    expect(clamped.x).toBeGreaterThanOrEqual(BOUNDS.minX - 1e-9);

    const far = clampCamera(cam({ x: 999_999, scaleX: 0.5 }), BOUNDS, VIEWPORT);
    expect(far.x + VIEWPORT.width / 0.5).toBeLessThanOrEqual(BOUNDS.maxX + 1e-9);
  });

  it('centres content narrower than the viewport instead of pinning it left', () => {
    // 12 000 world units at 0.01 px/unit is 120 px in an 800 px viewport.
    const clamped = clampCamera(cam({ x: 0, scaleX: 0.01 }), BOUNDS, VIEWPORT);
    const leftGap = worldToScreenX(clamped, BOUNDS.minX);
    const rightGap = VIEWPORT.width - worldToScreenX(clamped, BOUNDS.maxX);
    expect(leftGap).toBeCloseTo(rightGap, 6);
    expect(leftGap).toBeGreaterThan(0);
  });

  it('is idempotent', () => {
    const once = clampCamera(cam({ x: -5000 }), BOUNDS, VIEWPORT);
    const twice = clampCamera(once, BOUNDS, VIEWPORT);
    expect(camerasEqual(once, twice)).toBe(true);
  });
});

describe('fitToBounds', () => {
  it('frames the bounds with padding on both axes', () => {
    const c = fitToBounds(BOUNDS, VIEWPORT, 20);
    expect(worldToScreenX(c, BOUNDS.minX)).toBeCloseTo(20);
    expect(worldToScreenX(c, BOUNDS.maxX)).toBeCloseTo(VIEWPORT.width - 20);
    expect(worldToScreenY(c, BOUNDS.minY)).toBeCloseTo(20);
    expect(worldToScreenY(c, BOUNDS.maxY)).toBeCloseTo(VIEWPORT.height - 20);
  });

  it('fitXToBounds leaves the y axis exactly as it was', () => {
    const c = cam();
    const next = fitXToBounds(c, BOUNDS, VIEWPORT, 10);
    expect(next.scaleY).toBe(c.scaleY);
    expect(next.y).toBe(c.y);
    expect(worldToScreenX(next, BOUNDS.minX)).toBeCloseTo(10);
  });
});

describe('centerOn', () => {
  it('puts the requested world point at the viewport centre', () => {
    const next = centerOn(cam(), 4321, 2.5, VIEWPORT);
    expect(worldToScreenX(next, 4321)).toBeCloseTo(VIEWPORT.width / 2);
    expect(worldToScreenY(next, 2.5)).toBeCloseTo(VIEWPORT.height / 2);
  });
});

describe('crisp', () => {
  it('lands 1 px strokes on the half-pixel grid', () => {
    expect(crisp(10)).toBe(10.5);
    expect(crisp(10.4)).toBe(10.5);
    expect(crisp(-3.2)).toBe(-2.5);
  });
});
