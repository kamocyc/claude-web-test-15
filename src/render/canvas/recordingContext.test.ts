import { describe, expect, it } from 'vitest';
import { createRecordingContext, linePath, roundRectPath } from './recordingContext';
import { contrastText, desaturate, FALLBACK_THEME, getTheme, withAlpha } from './theme';
import { approxTextWidth, drawLabel, measuredTextWidth, textCacheSize } from './textCache';

describe('recording context', () => {
  it('records calls in order with their arguments', () => {
    const ctx = createRecordingContext();
    ctx.beginPath();
    ctx.moveTo(1, 2);
    ctx.lineTo(3.14159, 4);
    ctx.stroke();
    expect(ctx.lines()).toEqual(['beginPath()', 'moveTo(1, 2)', 'lineTo(3.142, 4)', 'stroke()']);
  });

  it('records style changes but collapses redundant writes', () => {
    const ctx = createRecordingContext();
    ctx.fillStyle = '#fff';
    ctx.fillStyle = '#fff';
    ctx.fillStyle = '#000';
    expect(ctx.ops('set fillStyle').map((c) => c.args[0])).toEqual(['#fff', '#000']);
  });

  it('normalises -0 so a snapshot does not flap', () => {
    const ctx = createRecordingContext();
    ctx.moveTo(-0, 0);
    expect(ctx.lines()).toEqual(['moveTo(0, 0)']);
  });

  it('measureText is deterministic — no platform fonts involved', () => {
    const ctx = createRecordingContext();
    expect(ctx.measureText('abc').width).toBe(18);
  });

  it('reset empties the log', () => {
    const ctx = createRecordingContext();
    ctx.save();
    ctx.reset();
    expect(ctx.calls).toHaveLength(0);
  });
});

describe('roundRectPath', () => {
  it('closes a path with four rounded corners', () => {
    const ctx = createRecordingContext();
    roundRectPath(ctx, 0, 0, 100, 20, 5);
    const ops = ctx.calls.map((c) => c.op);
    expect(ops[0]).toBe('beginPath');
    expect(ops.filter((o) => o === 'quadraticCurveTo')).toHaveLength(4);
    expect(ops[ops.length - 1]).toBe('closePath');
  });

  it('clamps the radius to half the shorter side', () => {
    const ctx = createRecordingContext();
    roundRectPath(ctx, 0, 0, 10, 4, 99);
    // With r clamped to 2, the first move is to x + 2.
    expect(ctx.calls[1]).toEqual({ op: 'moveTo', args: [2, 0] });
  });

  it('linePath strokes a single segment', () => {
    const ctx = createRecordingContext();
    linePath(ctx, 0, 1, 2, 3);
    expect(ctx.lines()).toEqual(['beginPath()', 'moveTo(0, 1)', 'lineTo(2, 3)', 'stroke()']);
  });
});

describe('theme', () => {
  it('falls back to the global.css values with no document', () => {
    expect(getTheme()).toEqual(FALLBACK_THEME);
    expect(FALLBACK_THEME.overtakeTrack).toBe(FALLBACK_THEME.warning);
  });

  it('withAlpha handles both hex forms and rgb()', () => {
    expect(withAlpha('#fff', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
    expect(withAlpha('#2563eb', 0.25)).toBe('rgba(37, 99, 235, 0.25)');
    expect(withAlpha('rgb(1, 2, 3)', 1)).toBe('rgba(1, 2, 3, 1)');
  });

  it('withAlpha composes with desaturate — the dimming path', () => {
    expect(withAlpha(desaturate('#dc2626', 1), 0.2)).toMatch(/^rgba\(\d+, \d+, \d+, 0\.2\)$/);
  });

  it('leaves an unparseable colour alone rather than corrupting it', () => {
    expect(withAlpha('rebeccapurple', 0.5)).toBe('rebeccapurple');
  });

  it('desaturate moves a colour towards its own luminance', () => {
    expect(desaturate('#dc2626', 0)).toBe('rgb(220, 38, 38)');
    const grey = desaturate('#dc2626', 1);
    const [r, g, b] = /rgb\((\d+), (\d+), (\d+)\)/.exec(grey)!.slice(1).map(Number);
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it('contrastText picks readable ink for a marker fill', () => {
    expect(contrastText('#2563eb')).toBe('#ffffff');
    expect(contrastText('#fbbf24')).toBe('#111827');
  });
});

describe('textCache', () => {
  it('falls back to fillText when no canvas exists, and caches nothing', () => {
    const ctx = createRecordingContext();
    drawLabel(ctx, '各 101', 10, 20, '11px sans-serif', '#fff', { align: 'center' });
    expect(ctx.lines()).toContain('fillText("各 101", 10, 20)');
    expect(ctx.ops('drawImage')).toHaveLength(0);
    expect(textCacheSize()).toBeLessThanOrEqual(1);
  });

  it('draws nothing for empty text', () => {
    const ctx = createRecordingContext();
    drawLabel(ctx, '', 0, 0, '11px sans-serif', '#fff');
    expect(ctx.calls).toHaveLength(0);
  });

  it('approxTextWidth treats CJK as full width', () => {
    expect(approxTextWidth('AB', 10)).toBeCloseTo(11);
    expect(approxTextWidth('各停', 10)).toBeCloseTo(20);
  });

  it('measuredTextWidth reads the font size and is stable across calls', () => {
    // No canvas here, so it falls back to the approximation — which is what
    // keeps the label collision geometry deterministic in node tests.
    expect(measuredTextWidth('戸越公園', 'bold 11px system-ui')).toBeCloseTo(44);
    expect(measuredTextWidth('戸越公園', 'bold 11px system-ui')).toBeCloseTo(44);
    expect(measuredTextWidth('', 'bold 11px system-ui')).toBe(0);
  });

  it('measuredTextWidth keys on the font, not just the string', () => {
    const small = measuredTextWidth('大井町', '9px system-ui');
    const large = measuredTextWidth('大井町', 'bold 14px system-ui');
    expect(large).toBeGreaterThan(small);
  });
});
