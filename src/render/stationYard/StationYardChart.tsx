/**
 * 構内ダイヤ — station yard occupancy.
 *
 * **SVG, not canvas**, and deliberately so. The chart is small (one station's
 * 番線 for one day), it needs drag-and-drop, and every bar wants to be a
 * focusable, labelled element. All three of those are free in SVG and would be
 * hand-built in canvas — the layered-canvas machinery earns its keep on 500
 * polylines, not on 20 bars.
 *
 * Each bar shows two nested rectangles: the outer one is the margin-inclusive
 * occupancy (`approachSec` before arrival to `clearSec` after departure) and
 * the inner one is the timetabled dwell. Seeing the margins is the difference
 * between "these two trains overlap" and "these two trains overlap *because of
 * the clearing margin*", which is a different fix.
 *
 * **The bars are flat.** No outline, no rounded corners: a 構内ダイヤ is read by
 * comparing edges — where one booking ends and the next begins — and a 1 px
 * stroke plus a 3 px radius moves every edge by two pixels in a direction that
 * depends on the bar's colour. Everything a border used to carry (conflict,
 * 待避, the selected train) is now a solid band inside the bar, which reads at
 * a glance and costs the edges nothing.
 *
 * **入換 are lines.** Two bars of one duty on two roads mean the stock was
 * moved between them, and the line joining them is the only mark on the chart
 * that says so. In v1 the move is instantaneous, so it is usually vertical.
 *
 * The time axis zooms and pans — wheel, drag, or the buttons above the chart —
 * because a whole service day on one sheet is 40 seconds per pixel, and the
 * margins this chart exists to show are 45.
 *
 * Dragging a bar to another lane reports `onReassignTrack`; the chart never
 * mutates the document. Arrow keys do the same thing without a mouse.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TID } from '@e2e/testids';
import type { TrainId } from '@/domain/ids';
import { formatTime, formatTimeCompact } from '@/domain/time';
import { getTheme } from '../canvas/theme';
import { withAlpha } from '../canvas/theme';
import { getRenderScene, useSceneGeneration } from '../scene';
import type { StationYardProps } from '../types';
import { computeYardLayout, laneAtY, type YardBar, type YardLayout } from './layout';

const LANE_H = 28;
const AXIS_H = 22;
const LABEL_W = 74;
const BAR_INSET = 4;
const MIN_PLOT_W = 320;
/** Thickness of the solid bands that replaced the bar outlines. */
const BAND_H = 3;
/**
 * Closest the time axis may be zoomed, in seconds across the plot.
 *
 * Ten minutes over ~900 px is about a second per pixel: past that there is
 * nothing left to resolve, since no timetable here is finer than 5 s.
 */
const MIN_SPAN_SEC = 600;
const ZOOM_STEP = 1.6;
/**
 * Zoom at which 入換 lines start being drawn, in px per second.
 *
 * 溝の口 shunts 184 times a day. Drawn across a whole day on one sheet they
 * are a picket fence that hides the bars underneath — so, exactly like the
 * station names on the line view, they are dropped where they cannot be read
 * and come back as the axis opens up. 0.08 px/s puts about four minutes
 * between neighbours on a 900 px plot.
 */
const SHUNT_MIN_PX_PER_SEC = 0.08;

interface DragState {
  trainId: TrainId;
  stopIndex: number;
  fromLane: number;
  toLane: number;
}

/** The visible time window, or `undefined` while it is the whole day. */
interface TimeView {
  from: number;
  to: number;
}

export function StationYardChart(props: StationYardProps) {
  const { stationId, onSelect, onReassignTrack, highlightTrainId, className } = props;

  // Occupancy is a property of the timetable, not of the clock: this chart
  // re-renders on document changes only.
  const generation = useSceneGeneration();
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** Zoomed in, a booking runs off both ends; the plot is clipped so that it
   *  never spills over the 番線 names. */
  const clipId = `yard-plot-${useId()}`;
  const [width, setWidth] = useState(720);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [view, setView] = useState<TimeView | undefined>(undefined);

  const layout: YardLayout | undefined = useMemo(() => {
    const scene = getRenderScene();
    if (!scene) return undefined;
    return computeYardLayout(scene.doc, scene.index, stationId);
  }, [generation, stationId]);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = (): void =>
      setWidth(Math.max(MIN_PLOT_W + LABEL_W, Math.round(el.getBoundingClientRect().width) || 720));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const theme = getTheme();
  const lanes = layout?.lanes ?? [];
  const bars = layout?.bars ?? [];
  const shunts = layout?.shunts ?? [];
  const height = Math.max(LANE_H, lanes.length * LANE_H) + AXIS_H;
  const plotW = Math.max(MIN_PLOT_W, width - LABEL_W - 8);
  const fullFrom = layout?.from ?? 0;
  const fullTo = layout?.to ?? 3600;
  const from = view?.from ?? fullFrom;
  const to = view?.to ?? fullTo;
  const span = Math.max(1, to - from);

  const xOf = useCallback(
    (t: number): number => LABEL_W + ((t - from) / span) * plotW,
    [from, span, plotW],
  );
  const timeAt = useCallback(
    (x: number): number => from + ((x - LABEL_W) / plotW) * span,
    [from, span, plotW],
  );
  /** Centre of a lane, in svg y. Shunt lines are drawn between these. */
  const laneY = useCallback((laneIndex: number): number => AXIS_H + laneIndex * LANE_H + LANE_H / 2, []);

  const ticks = useMemo(() => niceTimeTicks(from, to, plotW), [from, to, plotW]);
  const showShunts = shunts.length > 0 && plotW / span >= SHUNT_MIN_PX_PER_SEC;

  // -- zoom and pan ---------------------------------------------------------
  /** Keep a window inside the day, at a legible width. */
  const clampView = useCallback(
    (next: TimeView): TimeView | undefined => {
      const full = Math.max(1, fullTo - fullFrom);
      const wanted = Math.min(Math.max(next.to - next.from, MIN_SPAN_SEC), full);
      if (wanted >= full) return undefined;
      let start = next.from;
      if (start < fullFrom) start = fullFrom;
      if (start + wanted > fullTo) start = fullTo - wanted;
      return { from: start, to: start + wanted };
    },
    [fullFrom, fullTo],
  );

  /** Zoom by `factor` about a time that must stay put. */
  const zoomAbout = useCallback(
    (factor: number, anchorSec: number) => {
      setView((current) => {
        const f = current?.from ?? fullFrom;
        const t = current?.to ?? fullTo;
        const nextSpan = (t - f) / factor;
        const share = (anchorSec - f) / Math.max(1, t - f);
        return clampView({ from: anchorSec - nextSpan * share, to: anchorSec + nextSpan * (1 - share) });
      });
    },
    [clampView, fullFrom, fullTo],
  );

  // -- drag -----------------------------------------------------------------
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  const laneFromEvent = useCallback(
    (clientY: number): number => {
      const svg = svgRef.current;
      if (!svg) return 0;
      const rect = svg.getBoundingClientRect();
      return laneAtY(clientY - rect.top - AXIS_H, LANE_H, Math.max(1, lanes.length));
    },
    [lanes.length],
  );

  const beginDrag = useCallback(
    (bar: YardBar, e: React.PointerEvent<SVGGElement>) => {
      e.stopPropagation();
      (e.currentTarget as SVGGElement).setPointerCapture?.(e.pointerId);
      setDrag({
        trainId: bar.trainId,
        stopIndex: bar.stopIndex,
        fromLane: bar.laneIndex,
        toLane: bar.laneIndex,
      });
    },
    [],
  );

  const moveDrag = useCallback(
    (e: React.PointerEvent<SVGGElement>) => {
      const d = dragRef.current;
      if (!d) return;
      const lane = laneFromEvent(e.clientY);
      if (lane === d.toLane) return;
      setDrag({ ...d, toLane: lane });
    },
    [laneFromEvent],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent<SVGGElement>) => {
      const d = dragRef.current;
      setDrag(null);
      (e.currentTarget as SVGGElement).releasePointerCapture?.(e.pointerId);
      if (!d) return;
      if (d.toLane === d.fromLane) return;
      const target = lanes[d.toLane];
      if (!target) return;
      onReassignTrack?.(d.trainId, d.stopIndex, target.trackId);
    },
    [lanes, onReassignTrack],
  );

  const nudge = useCallback(
    (bar: YardBar, delta: number) => {
      const next = bar.laneIndex + delta;
      const target = lanes[next];
      if (!target) return;
      onReassignTrack?.(bar.trainId, bar.stopIndex, target.trackId);
    },
    [lanes, onReassignTrack],
  );

  useEffect(() => {
    // A document change invalidates any in-flight drag.
    setDrag(null);
  }, [generation, stationId]);

  useEffect(() => {
    // Another station is another day's worth of bars; keep no window from it.
    setView(undefined);
  }, [stationId]);

  // The wheel has to be a non-passive listener to be allowed to stop the page
  // scrolling under it, which React's onWheel cannot promise.
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY === 0) return;
      const rect = svg.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < LABEL_W) return;
      e.preventDefault();
      zoomAbout(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, timeAt(x));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [zoomAbout, timeAt]);

  /** Dragging the background pans; dragging a bar reassigns it. */
  const panRef = useRef<{ x: number; from: number; to: number } | null>(null);
  const beginPan = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (e.button !== 0) return;
      panRef.current = { x: e.clientX, from, to };
    },
    [from, to],
  );
  const movePan = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const p = panRef.current;
      if (p === null) return;
      const dt = ((e.clientX - p.x) / plotW) * (p.to - p.from);
      setView(clampView({ from: p.from - dt, to: p.to - dt }));
    },
    [clampView, plotW],
  );
  const endPan = useCallback(() => {
    panRef.current = null;
  }, []);

  return (
    <div
      ref={hostRef}
      data-testid={TID.yardChart}
      data-station-id={stationId}
      data-conflict-count={layout?.conflictCount ?? 0}
      className={className}
      style={{ width: '100%', overflowX: 'auto' }}
      data-zoomed={view === undefined ? '0' : '1'}
    >
      <div
        style={{
          display: 'flex',
          gap: 4,
          alignItems: 'center',
          padding: '2px 0',
          fontSize: 11,
          color: theme.textDim,
        }}
      >
        <button
          type="button"
          data-testid={TID.yardZoomOut}
          aria-label="構内ダイヤを縮小"
          onClick={() => zoomAbout(1 / ZOOM_STEP, (from + to) / 2)}
        >
          −
        </button>
        <button
          type="button"
          data-testid={TID.yardZoomIn}
          aria-label="構内ダイヤを拡大"
          onClick={() => zoomAbout(ZOOM_STEP, (from + to) / 2)}
        >
          ＋
        </button>
        <button
          type="button"
          data-testid={TID.yardZoomReset}
          aria-label="構内ダイヤを全体表示"
          disabled={view === undefined}
          onClick={() => setView(undefined)}
        >
          全体
        </button>
        <span data-testid={TID.yardWindow}>
          {formatTime(Math.round(from))}–{formatTime(Math.round(to))}
        </span>
        {shunts.length > 0 && !showShunts ? (
          <span data-testid={TID.yardShuntHint}>入換 {shunts.length} 件 — 拡大すると表示</span>
        ) : null}
      </div>
      <svg
        ref={svgRef}
        width={Math.max(width, LABEL_W + plotW + 8)}
        height={height}
        role="img"
        aria-label={`${layout?.stationName ?? ''} 構内ダイヤ`}
        style={{
          display: 'block',
          background: theme.panel,
          touchAction: 'none',
          cursor: view === undefined ? 'default' : 'grab',
        }}
        onPointerDown={beginPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerLeave={endPan}
      >
        {/* time axis */}
        <g>
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={xOf(t)}
                y1={AXIS_H - 4}
                x2={xOf(t)}
                y2={height}
                stroke={theme.grid}
                strokeWidth={1}
              />
              <text
                x={xOf(t) + 3}
                y={AXIS_H - 7}
                fill={theme.textDim}
                fontSize={10}
                fontFamily="ui-monospace, monospace"
              >
                {formatTimeCompact(t)}
              </text>
            </g>
          ))}
        </g>

        {/* lanes */}
        {lanes.map((lane) => {
          const y = AXIS_H + lane.index * LANE_H;
          const isDropTarget = drag !== null && drag.toLane === lane.index;
          return (
            <g key={lane.trackId} data-testid={TID.yardLane(lane.trackId)} data-track-id={lane.trackId}>
              <rect
                x={0}
                y={y}
                width={LABEL_W + plotW}
                height={LANE_H}
                fill={
                  isDropTarget
                    ? withAlpha(theme.accent, 0.16)
                    : lane.canBeOvertaken
                      ? withAlpha(theme.overtakeTrack, 0.08)
                      : lane.index % 2 === 0
                        ? withAlpha(theme.panelAlt, 0.5)
                        : 'transparent'
                }
                stroke={theme.grid}
                strokeWidth={0.5}
              />
              <text x={6} y={y + LANE_H / 2 + 4} fill={theme.text} fontSize={11}>
                {lane.name}
              </text>
              {lane.canBeOvertaken ? (
                <text
                  x={LABEL_W - 8}
                  y={y + LANE_H / 2 + 4}
                  fill={theme.overtakeTrack}
                  fontSize={9}
                  textAnchor="end"
                >
                  待避
                </text>
              ) : null}
            </g>
          );
        })}

        <defs>
          <clipPath id={clipId}>
            <rect x={LABEL_W} y={0} width={plotW} height={height} />
          </clipPath>
        </defs>

        <g clipPath={`url(#${clipId})`}>
        {/* bars */}
        {bars.map((bar) => {
          const dragging =
            drag !== null && drag.trainId === bar.trainId && drag.stopIndex === bar.stopIndex;
          const laneIndex = dragging ? drag.toLane : bar.laneIndex;
          const y = AXIS_H + laneIndex * LANE_H + BAR_INSET;
          const h = LANE_H - BAR_INSET * 2;
          const x = xOf(bar.from);
          const w = Math.max(3, xOf(bar.to) - x);
          const bx = xOf(bar.bookedFrom);
          const bw = Math.max(2, xOf(bar.bookedTo) - bx);
          const highlighted = highlightTrainId === bar.trainId;

          return (
            <g
              // A train can hold two roads at one station — the platform it
              // arrived on and the 引上線 it was shunted to — so the key needs
              // the road and the hour as well as the stop.
              key={`${bar.trainId}-${bar.stopIndex}-${bar.trackId}-${bar.from}`}
              data-testid={TID.yardBar(bar.trainId)}
              data-train-id={bar.trainId}
              data-stop-index={bar.stopIndex}
              data-track-id={bar.trackId}
              data-lane={laneIndex}
              data-conflict={bar.conflict ? '1' : '0'}
              data-from={bar.from}
              data-to={bar.to}
              tabIndex={0}
              role="button"
              aria-label={`${bar.label} ${formatTimeCompact(bar.bookedFrom)}–${formatTimeCompact(bar.bookedTo)}`}
              style={{ cursor: onReassignTrack ? 'grab' : 'pointer', opacity: dragging ? 0.75 : 1 }}
              onPointerDown={(e) => {
                // Never let a bar press fall through to the pan handler.
                e.stopPropagation();
                if (onReassignTrack) beginDrag(bar, e);
                onSelect?.({ kind: 'train', trainId: bar.trainId, stopIndex: bar.stopIndex }, false);
              }}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  nudge(bar, -1);
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  nudge(bar, 1);
                } else if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect?.({ kind: 'train', trainId: bar.trainId, stopIndex: bar.stopIndex }, false);
                }
              }}
            >
              {/* margin-inclusive occupancy */}
              <rect
                x={x}
                y={y}
                width={w}
                height={h}
                fill={bar.conflict ? withAlpha(theme.conflict, 0.3) : withAlpha(bar.color, 0.22)}
              />
              {/* timetabled dwell */}
              <rect
                x={bx}
                y={y + 3}
                width={bw}
                height={h - 6}
                fill={bar.conflict ? theme.conflict : bar.color}
              />
              {/* 待避: a band along the foot of the dwell. */}
              {bar.overtakeWait ? (
                <rect
                  x={bx}
                  y={y + h - 3 - BAND_H}
                  width={bw}
                  height={BAND_H}
                  fill={theme.waitRing}
                />
              ) : null}
              {/* The selected train, marked without moving any edge. */}
              {highlighted ? (
                <rect x={bx} y={y + 3} width={bw} height={BAND_H} fill={theme.selection} />
              ) : null}
              <text
                x={bx + 4}
                y={y + h / 2 + 3}
                fill="#ffffff"
                fontSize={10}
                style={{ pointerEvents: 'none' }}
              >
                {bw > 34 ? bar.label : ''}
              </text>
              {bar.conflict ? (
                <rect
                  data-testid={TID.yardConflict}
                  data-train-id={bar.trainId}
                  data-track-id={bar.trackId}
                  x={x}
                  y={y}
                  width={w}
                  height={BAND_H}
                  fill={theme.conflict}
                />
              ) : null}
              <title>
                {`${bar.label} ${formatTimeCompact(bar.bookedFrom)}–${formatTimeCompact(bar.bookedTo)}` +
                  (bar.conflict ? ' 【番線二重使用】' : '')}
              </title>
            </g>
          );
        })}

        {/* 入換 — the move between two roads, drawn over the bars it joins. */}
        <g style={{ pointerEvents: 'none' }}>
          {(showShunts ? shunts : []).map((s) => {
            const x1 = xOf(s.from);
            const x2 = xOf(s.to);
            const y1 = laneY(s.fromLane);
            const y2 = laneY(s.toLane);
            const down = y2 > y1;
            return (
              <g
                key={`${s.dutyId}-${s.fromTrackId}-${s.from}`}
                data-testid={TID.yardShunt}
                data-duty-id={s.dutyId}
                data-from-track={s.fromTrackId}
                data-to-track={s.toTrackId}
                data-from={s.from}
                data-to={s.to}
              >
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={theme.textDim}
                  strokeWidth={1.25}
                  strokeDasharray="3 2"
                />
                {/* Which way the stock went: a chevron at the arriving end. */}
                <path
                  d={`M ${x2 - 3} ${y2 + (down ? -4 : 4)} L ${x2} ${y2} L ${x2 + 3} ${y2 + (down ? -4 : 4)}`}
                  fill="none"
                  stroke={theme.textDim}
                  strokeWidth={1.25}
                />
                <title>{`入換 ${s.label} ${formatTimeCompact(s.from)}`}</title>
              </g>
            );
          })}
        </g>
        </g>
      </svg>
    </div>
  );
}

/** Round time ticks that stay at least ~70 px apart. */
function niceTimeTicks(from: number, to: number, plotW: number): number[] {
  const steps = [60, 300, 600, 900, 1800, 3600, 7200, 14400];
  const span = Math.max(1, to - from);
  const pxPerSec = plotW / span;
  let step = steps[steps.length - 1]!;
  for (const s of steps) {
    if (s * pxPerSec >= 70) {
      step = s;
      break;
    }
  }
  const out: number[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push(t);
  return out;
}
