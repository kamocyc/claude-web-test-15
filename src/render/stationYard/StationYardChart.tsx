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
 * Dragging a bar to another lane reports `onReassignTrack`; the chart never
 * mutates the document. Arrow keys do the same thing without a mouse.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TID } from '@e2e/testids';
import type { TrainId } from '@/domain/ids';
import { formatTimeCompact } from '@/domain/time';
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

interface DragState {
  trainId: TrainId;
  stopIndex: number;
  fromLane: number;
  toLane: number;
}

export function StationYardChart(props: StationYardProps) {
  const { stationId, onSelect, onReassignTrack, highlightTrainId, className } = props;

  // Occupancy is a property of the timetable, not of the clock: this chart
  // re-renders on document changes only.
  const generation = useSceneGeneration();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(720);
  const [drag, setDrag] = useState<DragState | null>(null);

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
  const height = Math.max(LANE_H, lanes.length * LANE_H) + AXIS_H;
  const plotW = Math.max(MIN_PLOT_W, width - LABEL_W - 8);
  const from = layout?.from ?? 0;
  const to = layout?.to ?? 3600;
  const span = Math.max(1, to - from);

  const xOf = useCallback(
    (t: number): number => LABEL_W + ((t - from) / span) * plotW,
    [from, span, plotW],
  );

  const ticks = useMemo(() => niceTimeTicks(from, to, plotW), [from, to, plotW]);

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

  return (
    <div
      ref={hostRef}
      data-testid={TID.yardChart}
      data-station-id={stationId}
      data-conflict-count={layout?.conflictCount ?? 0}
      className={className}
      style={{ width: '100%', overflowX: 'auto' }}
    >
      <svg
        ref={svgRef}
        width={Math.max(width, LABEL_W + plotW + 8)}
        height={height}
        role="img"
        aria-label={`${layout?.stationName ?? ''} 構内ダイヤ`}
        style={{ display: 'block', background: theme.panel, touchAction: 'none' }}
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
              key={`${bar.trainId}-${bar.stopIndex}`}
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
                rx={3}
                fill={bar.conflict ? withAlpha(theme.conflict, 0.3) : withAlpha(bar.color, 0.22)}
                stroke={bar.conflict ? theme.conflict : withAlpha(bar.color, 0.7)}
                strokeWidth={bar.conflict ? 2 : 1}
                strokeDasharray={bar.conflict ? '4 2' : undefined}
              />
              {/* timetabled dwell */}
              <rect
                x={bx}
                y={y + 3}
                width={bw}
                height={h - 6}
                rx={2}
                fill={bar.conflict ? theme.conflict : bar.color}
                stroke={highlighted ? theme.selection : 'none'}
                strokeWidth={highlighted ? 2 : 0}
              />
              {bar.overtakeWait ? (
                <rect
                  x={bx}
                  y={y + 3}
                  width={bw}
                  height={h - 6}
                  rx={2}
                  fill="none"
                  stroke={theme.waitRing}
                  strokeWidth={2}
                />
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
                  height={h}
                  fill="none"
                  stroke={theme.conflict}
                  strokeWidth={1}
                />
              ) : null}
              <title>
                {`${bar.label} ${formatTimeCompact(bar.bookedFrom)}–${formatTimeCompact(bar.bookedTo)}` +
                  (bar.conflict ? ' 【番線二重使用】' : '')}
              </title>
            </g>
          );
        })}
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
