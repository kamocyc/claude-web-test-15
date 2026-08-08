/**
 * Canvas colours, resolved from the CSS custom properties in
 * `src/ui/styles/global.css`.
 *
 * The canvas cannot inherit CSS, so it has to read the tokens once and cache
 * them. Every token has a hardcoded fallback identical to the value in
 * `global.css`, which is what makes the draw functions runnable in a node test
 * with no document at all.
 */

export interface RenderTheme {
  /** Identity string — part of the text cache key. */
  key: string;

  bg: string;
  panel: string;
  panelAlt: string;
  border: string;
  borderStrong: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  error: string;
  warning: string;
  info: string;
  ok: string;

  /** Derived, view-specific roles. */
  grid: string;
  gridStrong: string;
  rail: string;
  railDim: string;
  platform: string;
  /** 待避線 — visually distinct so a passing loop is obvious at a glance. */
  overtakeTrack: string;
  depot: string;
  nowLine: string;
  selection: string;
  hover: string;
  conflict: string;
  /** 待避中 ring. */
  waitRing: string;
  markerText: string;
  hatch: string;

  fontUi: string;
  fontMono: string;
}

interface ThemeTokens {
  bg: string;
  panel: string;
  panelAlt: string;
  border: string;
  borderStrong: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  error: string;
  warning: string;
  info: string;
  ok: string;
}

const FALLBACK_TOKENS: ThemeTokens = {
  bg: '#0f172a',
  panel: '#1e293b',
  panelAlt: '#273449',
  border: '#334155',
  borderStrong: '#475569',
  text: '#e2e8f0',
  textDim: '#94a3b8',
  textFaint: '#64748b',
  accent: '#38bdf8',
  error: '#f87171',
  warning: '#fbbf24',
  info: '#60a5fa',
  ok: '#4ade80',
};

const FONT_UI =
  "12px system-ui, -apple-system, 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', Meiryo, sans-serif";
const FONT_MONO = "11px ui-monospace, 'SFMono-Regular', 'Roboto Mono', Menlo, monospace";

function themeFrom(tokens: ThemeTokens): RenderTheme {
  return {
    key: `${tokens.bg}/${tokens.text}/${tokens.accent}`,
    ...tokens,
    grid: tokens.border,
    gridStrong: tokens.borderStrong,
    rail: tokens.borderStrong,
    railDim: tokens.border,
    platform: tokens.textFaint,
    overtakeTrack: tokens.warning,
    depot: tokens.panelAlt,
    nowLine: tokens.accent,
    selection: tokens.accent,
    hover: tokens.info,
    conflict: tokens.error,
    waitRing: tokens.warning,
    markerText: '#ffffff',
    hatch: tokens.textFaint,
    fontUi: FONT_UI,
    fontMono: FONT_MONO,
  };
}

/** Used by every unit test, and by the browser until the first read succeeds. */
export const FALLBACK_THEME: RenderTheme = themeFrom(FALLBACK_TOKENS);

let cached: RenderTheme | undefined;

function readVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = style.getPropertyValue(name).trim();
  return v.length > 0 ? v : fallback;
}

/**
 * The current theme. Resolved once and memoized; call `resetThemeCache()` if a
 * theme switch is ever added.
 */
export function getTheme(): RenderTheme {
  if (cached) return cached;
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    cached = FALLBACK_THEME;
    return cached;
  }
  let style: CSSStyleDeclaration;
  try {
    style = getComputedStyle(document.documentElement);
  } catch {
    cached = FALLBACK_THEME;
    return cached;
  }
  cached = themeFrom({
    bg: readVar(style, '--bg', FALLBACK_TOKENS.bg),
    panel: readVar(style, '--bg-panel', FALLBACK_TOKENS.panel),
    panelAlt: readVar(style, '--bg-panel-2', FALLBACK_TOKENS.panelAlt),
    border: readVar(style, '--border', FALLBACK_TOKENS.border),
    borderStrong: readVar(style, '--border-strong', FALLBACK_TOKENS.borderStrong),
    text: readVar(style, '--text', FALLBACK_TOKENS.text),
    textDim: readVar(style, '--text-dim', FALLBACK_TOKENS.textDim),
    textFaint: readVar(style, '--text-faint', FALLBACK_TOKENS.textFaint),
    accent: readVar(style, '--accent', FALLBACK_TOKENS.accent),
    error: readVar(style, '--error', FALLBACK_TOKENS.error),
    warning: readVar(style, '--warning', FALLBACK_TOKENS.warning),
    info: readVar(style, '--info', FALLBACK_TOKENS.info),
    ok: readVar(style, '--ok', FALLBACK_TOKENS.ok),
  });
  return cached;
}

export function resetThemeCache(): void {
  cached = undefined;
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

/**
 * `#rgb` / `#rrggbb` / `rgb(...)` to `rgba(...)`. Unrecognised input is
 * returned unchanged, so a document that stores `red` or an `oklch()` colour
 * still draws — just without the alpha fade.
 */
export function withAlpha(color: string, alpha: number): string {
  const rgb = parseColor(color);
  if (!rgb) return color;
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}

/** Blend towards grey — used to push non-highlighted duties into the back. */
export function desaturate(color: string, amount: number): string {
  const rgb = parseColor(color);
  if (!rgb) return color;
  const k = Math.max(0, Math.min(1, amount));
  const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  const mix = (c: number): number => Math.round(c * (1 - k) + lum * k);
  return `rgb(${mix(rgb[0])}, ${mix(rgb[1])}, ${mix(rgb[2])})`;
}

/** Pick black or white text for a background, by relative luminance. */
export function contrastText(background: string): string {
  const rgb = parseColor(background);
  if (!rgb) return '#ffffff';
  const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  return lum > 0.62 ? '#111827' : '#ffffff';
}

/**
 * Parse a colour to RGB components.
 *
 * `rgb(...)` is accepted as well as hex because these helpers compose:
 * `withAlpha(desaturate(c, 0.7), 0.2)` feeds the output of one into the other,
 * and a hex-only parser would silently drop the alpha.
 */
function parseColor(color: string): [number, number, number] | undefined {
  const s = color.trim();
  const fn = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s);
  if (fn) {
    return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  }
  if (s[0] !== '#') return undefined;
  if (s.length === 4) {
    const r = s[1];
    const g = s[2];
    const b = s[3];
    if (r === undefined || g === undefined || b === undefined) return undefined;
    return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)];
  }
  if (s.length === 7) {
    const r = parseInt(s.slice(1, 3), 16);
    const g = parseInt(s.slice(3, 5), 16);
    const b = parseInt(s.slice(5, 7), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return undefined;
    return [r, g, b];
  }
  return undefined;
}
