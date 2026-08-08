import { describe, expect, it } from 'vitest';
import { createCamera, type Camera2D } from './camera';
import { HitRects, pickSegment, pointSegmentDistance, SegmentGrid, type WorldSegment } from './hit';

describe('HitRects', () => {
  it('picks the topmost rect — draw order is z order', () => {
    const hits = new HitRects<string>(4);
    hits.push('under', 0, 0, 100, 20);
    hits.push('over', 50, 5, 100, 20);
    expect(hits.pick(60, 10)).toBe('over');
    expect(hits.pick(10, 10)).toBe('under');
    expect(hits.pick(400, 400)).toBeUndefined();
  });

  it('honours the slop radius', () => {
    const hits = new HitRects<string>();
    hits.push('a', 10, 10, 10, 10);
    expect(hits.pick(8, 10)).toBeUndefined();
    expect(hits.pick(8, 10, 3)).toBe('a');
  });

  it('reset makes previous entries unfindable without reallocating', () => {
    const hits = new HitRects<string>(2);
    hits.push('a', 0, 0, 10, 10);
    hits.reset();
    expect(hits.count).toBe(0);
    expect(hits.pick(5, 5)).toBeUndefined();
  });

  it('grows past its initial capacity', () => {
    const hits = new HitRects<number>(2);
    for (let i = 0; i < 100; i++) hits.push(i, i * 10, 0, 8, 8);
    expect(hits.count).toBe(100);
    expect(hits.pick(994, 4)).toBe(99);
    expect(hits.pick(4, 4)).toBe(0);
  });

  it('reports the rect of a known ref, for the selection halo', () => {
    const hits = new HitRects<string>();
    hits.push('a', 3, 4, 5, 6);
    expect(hits.rectOf('a')).toEqual({ x: 3, y: 4, w: 5, h: 6 });
    expect(hits.rectOf('zzz')).toBeUndefined();
  });
});

describe('pointSegmentDistance', () => {
  it('measures perpendicular distance inside the segment', () => {
    expect(pointSegmentDistance(5, 3, 0, 0, 10, 0)).toBeCloseTo(3);
  });

  it('clamps to the endpoints outside the segment', () => {
    expect(pointSegmentDistance(-4, 0, 0, 0, 10, 0)).toBeCloseTo(4);
    expect(pointSegmentDistance(13, 4, 0, 0, 10, 0)).toBeCloseTo(5);
  });

  it('handles a degenerate zero-length segment', () => {
    expect(pointSegmentDistance(3, 4, 0, 0, 0, 0)).toBeCloseTo(5);
  });
});

describe('SegmentGrid', () => {
  const segments: Array<WorldSegment<string>> = [
    // A horizontal dwell stub at y = 2 from t = 0 to t = 600.
    { ref: 'local', x0: 0, y0: 2, x1: 600, y1: 2 },
    // A steep run crossing it.
    { ref: 'express', x0: 300, y0: 0, x1: 900, y1: 5 },
    // Something far away.
    { ref: 'other', x0: 20_000, y0: 40, x1: 21_000, y1: 41 },
  ];

  function grid(): SegmentGrid<string> {
    const g = new SegmentGrid<string>(300, 0.5);
    g.build(segments);
    return g;
  }

  it('indexes every segment', () => {
    expect(grid().size).toBe(3);
  });

  it('returns candidates near a query box and excludes distant ones', () => {
    const refs = grid()
      .query(250, 1.5, 350, 2.5)
      .map((s) => s.ref);
    expect(refs).toContain('local');
    expect(refs).not.toContain('other');
  });

  it('an empty grid answers nothing rather than throwing', () => {
    const g = new SegmentGrid<string>();
    g.build([]);
    expect(g.query(0, 0, 10, 10)).toEqual([]);
  });
});

describe('pickSegment', () => {
  /** 1 px per second horizontally, 100 px per world-y unit vertically. */
  const cam: Camera2D = createCamera({ x: 0, y: 0, scaleX: 1, scaleY: 100 });

  function grid(): SegmentGrid<string> {
    const g = new SegmentGrid<string>(300, 0.5);
    g.build([
      { ref: 'local', x0: 0, y0: 2, x1: 600, y1: 2 },
      { ref: 'express', x0: 300, y0: 0, x1: 900, y1: 5 },
    ]);
    return g;
  }

  it('hits a line within the screen-space threshold', () => {
    // World (100, 2) -> screen (100, 200).
    const hit = pickSegment(grid(), cam, 100, 203, 6);
    expect(hit?.segment.ref).toBe('local');
    expect(hit?.distance).toBeCloseTo(3);
  });

  it('misses beyond the threshold', () => {
    expect(pickSegment(grid(), cam, 100, 215, 6)).toBeUndefined();
  });

  it('measures in SCREEN space, so a stretched axis does not over-select', () => {
    // The pointer is 0.05 world-y from the local's line. Under this camera
    // that is 5 px — a hit. Squash y by 100x and the same world offset is
    // 0.05 px, so a *different* nearby line becomes the better answer.
    const near = pickSegment(grid(), cam, 100, 205, 6);
    expect(near?.segment.ref).toBe('local');

    const squashed = createCamera({ x: 0, y: 0, scaleX: 1, scaleY: 1 });
    // World (100, 2) -> screen (100, 2). A pointer at screen y = 60 is 58 px
    // away: far in screen space even though it is only 0.58 world units away.
    expect(pickSegment(grid(), squashed, 100, 60, 6)).toBeUndefined();
  });

  it('returns the nearest of several candidates', () => {
    // Near the crossing at world x = 540 both lines are close; the express is
    // exactly on the pointer.
    const g = grid();
    const hit = pickSegment(g, cam, 660, 300, 8);
    expect(hit?.segment.ref).toBe('express');
  });
});
