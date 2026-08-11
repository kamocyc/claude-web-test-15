/**
 * 行路表 — one row per 乗務員行路, time across.
 *
 * SVG for the same reasons as the 構内ダイヤ: seventy rows of a few bars each
 * is not a job for a layered canvas, and every bar wants to be a labelled,
 * clickable element. It shares that chart's time axis outright (`../timeAxis`)
 * so the two zoom and tick identically.
 *
 * The 点呼 at each end is a paler shoulder rather than a bar. It is derived
 * from `crewSignOnSec` / `crewSignOffSec` and is the same at both ends of
 * every duty, so it is not something to select or edit — but it is most of
 * what separates 拘束時間 from the legs you can see, and leaving it off the
 * picture would make the 拘束 column look wrong.
 *
 * No drag-and-drop. Moving a leg from one person to another is a two-sided
 * edit, and the leg table below the chart does it without ambiguity.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TID } from '@e2e/testids';
import type { CrewLeg } from '@/domain/model';
import { formatDuration, formatTime, formatTimeCompact } from '@/domain/time';
import { getTheme, withAlpha } from '../canvas/theme';
import { getRenderScene, useSceneGeneration } from '../scene';
import type { CrewDutyChartProps } from '../types';
import {
  niceTimeTicks,
  panTimeWindow,
  zoomTimeWindow,
  timeScale,
  type TimeWindow,
} from '../timeAxis';
import { CREW_LANE_H, computeCrewChartLayout, type CrewChartLayout } from './layout';

const AXIS_H = 22;
const LABEL_W = 128;
const BAR_INSET = 4;
const MIN_PLOT_W = 320;
const MIN_SPAN_SEC = 600;
const ZOOM_STEP = 1.6;
/** Below this the bars are narrower than their own labels. */
const LABEL_MIN_PX = 34;

export function CrewDutyChart(props: CrewDutyChartProps) {
  const { role, selectedCrewDutyId, onSelect, className } = props;
  const generation = useSceneGeneration();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const clipId = `crew-plot-${useId()}`;
  const [width, setWidth] = useState(720);
  const [view, setView] = useState<TimeWindow | undefined>(undefined);

  const layout: CrewChartLayout | undefined = useMemo(() => {
    const scene = getRenderScene();
    if (!scene) return undefined;
    return computeCrewChartLayout(scene.doc, {
      dayTypeId: scene.doc.settings.activeDayTypeId,
      date: scene.doc.settings.activeDate,
      ...(role === undefined ? {} : { role }),
    });
  }, [generation, role]);

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
  const rows = layout?.rows ?? [];
  const bars = layout?.bars ?? [];
  const height = Math.max(CREW_LANE_H, rows.length * CREW_LANE_H) + AXIS_H;
  const plotW = Math.max(MIN_PLOT_W, width - LABEL_W - 8);
  const full: TimeWindow = { from: layout?.from ?? 0, to: layout?.to ?? 3600 };
  const from = view?.from ?? full.from;
  const to = view?.to ?? full.to;
  const scale = useMemo(
    () => timeScale({ from, to, plotW, labelW: LABEL_W }),
    [from, to, plotW],
  );
  const ticks = useMemo(() => niceTimeTicks(from, to, plotW), [from, to, plotW]);

  const zoomAbout = useCallback(
    (factor: number, anchorSec: number) => {
      setView((current) => zoomTimeWindow(current, full, factor, anchorSec, MIN_SPAN_SEC));
    },
    [full.from, full.to],
  );

  useEffect(() => {
    setView(undefined);
  }, [role]);

  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY === 0) return;
      const rect = svg.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < LABEL_W) return;
      e.preventDefault();
      zoomAbout(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, scale.timeAt(x));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [zoomAbout, scale]);

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
      setView(panTimeWindow(p, e.clientX - p.x, plotW, full, MIN_SPAN_SEC));
    },
    [plotW, full.from, full.to],
  );
  const endPan = useCallback(() => {
    panRef.current = null;
  }, []);

  const rowY = (index: number): number => AXIS_H + index * CREW_LANE_H;

  return (
    <div
      ref={hostRef}
      data-testid={TID.crewChart}
      data-row-count={rows.length}
      data-conflict-count={layout?.conflictCount ?? 0}
      className={className}
      style={{ width: '100%', overflowX: 'auto' }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 0' }}>
        <button
          type="button"
          data-testid={TID.crewZoomOut}
          aria-label="行路表を縮小"
          onClick={() => zoomAbout(1 / ZOOM_STEP, (from + to) / 2)}
        >
          −
        </button>
        <button
          type="button"
          data-testid={TID.crewZoomIn}
          aria-label="行路表を拡大"
          onClick={() => zoomAbout(ZOOM_STEP, (from + to) / 2)}
        >
          ＋
        </button>
        <button
          type="button"
          data-testid={TID.crewZoomReset}
          aria-label="行路表を全体表示"
          disabled={view === undefined}
          onClick={() => setView(undefined)}
        >
          全体
        </button>
        <span data-testid={TID.crewChartWindow}>
          {formatTime(Math.round(from))}–{formatTime(Math.round(to))}
        </span>
      </div>
      <svg
        ref={svgRef}
        width={Math.max(width, LABEL_W + plotW + 8)}
        height={height}
        role="img"
        aria-label="行路表"
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
        <defs>
          <clipPath id={clipId}>
            <rect x={LABEL_W} y={0} width={plotW} height={height} />
          </clipPath>
        </defs>

        <g>
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={scale.xOf(t)}
                y1={AXIS_H - 4}
                x2={scale.xOf(t)}
                y2={height}
                stroke={theme.grid}
                strokeWidth={1}
              />
              <text
                x={scale.xOf(t) + 3}
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

        {rows.map((row) => {
          const y = rowY(row.index);
          const selected = selectedCrewDutyId === row.crewDutyId;
          return (
            <g
              key={row.crewDutyId}
              data-testid={TID.crewChartRow(row.crewDutyId)}
              data-crew-duty-id={row.crewDutyId}
              data-work-sec={row.workSec}
              data-spread-sec={row.spreadSec}
            >
              <rect
                x={0}
                y={y}
                width={LABEL_W + plotW}
                height={CREW_LANE_H}
                fill={
                  selected
                    ? withAlpha(theme.accent, 0.16)
                    : row.index % 2 === 0
                      ? withAlpha(theme.panelAlt, 0.5)
                      : 'transparent'
                }
                onClick={() => onSelect?.(row.crewDutyId)}
              />
              <line
                x1={0}
                y1={y + CREW_LANE_H}
                x2={LABEL_W + plotW}
                y2={y + CREW_LANE_H}
                stroke={theme.grid}
                strokeWidth={1}
              />
              <text x={6} y={y + CREW_LANE_H / 2 + 4} fill={theme.text} fontSize={11}>
                {row.code}
              </text>
              <text
                x={LABEL_W - 6}
                y={y + CREW_LANE_H / 2 + 4}
                fill={theme.textDim}
                fontSize={9}
                textAnchor="end"
              >
                {row.crewLabel ?? row.roleLabel}
              </text>
            </g>
          );
        })}

        <g clipPath={`url(#${clipId})`}>
          {/* 点呼 — derived, so drawn as a shoulder and never selectable. */}
          {rows.map((row) => {
            const y = rowY(row.index);
            const legs = bars.filter((b) => b.crewDutyId === row.crewDutyId);
            const first = legs[0];
            const last = legs[legs.length - 1];
            if (first === undefined || last === undefined) return null;
            return (
              <g key={`duty-${row.crewDutyId}`} opacity={0.5}>
                <rect
                  x={scale.xOf(row.signOn)}
                  y={y + CREW_LANE_H / 2 - 2}
                  width={Math.max(scale.xOf(first.from) - scale.xOf(row.signOn), 1)}
                  height={4}
                  fill={theme.grid}
                />
                <rect
                  x={scale.xOf(last.to)}
                  y={y + CREW_LANE_H / 2 - 2}
                  width={Math.max(scale.xOf(row.signOff) - scale.xOf(last.to), 1)}
                  height={4}
                  fill={theme.grid}
                />
              </g>
            );
          })}

          {bars.map((bar) => {
            const y = rowY(bar.rowIndex);
            const x = scale.xOf(bar.from);
            const w = Math.max(scale.xOf(bar.to) - x, 2);
            const row = rows[bar.rowIndex];
            return (
              <g
                key={`${bar.crewDutyId}-${bar.legIndex}`}
                data-testid={TID.crewChartBar(bar.crewDutyId, bar.legIndex)}
                data-kind={bar.kind}
                data-conflict={bar.conflict ? 'true' : undefined}
                onClick={() => onSelect?.(bar.crewDutyId, bar.legIndex)}
                style={{ cursor: 'pointer' }}
              >
                <rect
                  x={x}
                  y={y + BAR_INSET}
                  width={w}
                  height={CREW_LANE_H - BAR_INSET * 2}
                  fill={fillOf(bar.kind, theme)}
                  {...(bar.kind === 'deadhead'
                    ? { stroke: theme.accent, strokeDasharray: '3 2', strokeWidth: 1 }
                    : {})}
                >
                  <title>
                    {`${row?.code ?? ''} ${bar.label} ${formatTime(bar.from)}–${formatTime(bar.to)} (${formatDuration(bar.to - bar.from)})`}
                  </title>
                </rect>
                {bar.conflict ? (
                  <rect
                    x={x}
                    y={y + BAR_INSET}
                    width={Math.min(w, 3)}
                    height={CREW_LANE_H - BAR_INSET * 2}
                    fill={theme.conflict}
                  />
                ) : null}
                {w >= LABEL_MIN_PX ? (
                  <text
                    x={x + 4}
                    y={y + CREW_LANE_H / 2 + 3}
                    fill={theme.text}
                    fontSize={9}
                    pointerEvents="none"
                  >
                    {bar.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

function fillOf(kind: CrewLeg['kind'], theme: ReturnType<typeof getTheme>): string {
  switch (kind) {
    case 'train':
      return withAlpha(theme.accent, 0.75);
    case 'deadhead':
      return withAlpha(theme.accent, 0.2);
    case 'break':
      return withAlpha(theme.waitRing, 0.5);
    default:
      return withAlpha(theme.textDim, 0.28);
  }
}
