/**
 * 構内配線図 — the throats of one station, drawn and edited.
 *
 * The 番線 table says what a road *is*; this says how it is wired, which is a
 * different question and the one a 配線図 exists to answer. Four things are on
 * the sheet and all four came out of a request for them:
 *
 * - **留置線の配置.** A road that dead-ends is drawn where it dead-ends —
 *   out in the throat it hangs off, past the platform ends, at its own 分岐位置.
 * - **どこにつながっているか.** Each throat shows its leads: the running lines,
 *   and any lead that is not one (溝の口's 大井町線 lead, which carries the
 *   platform faces and the two 引上線 and stops there). A road is joined to the
 *   leads it is switched onto and to nothing else.
 * - **分岐器.** A dot wherever a road meets a lead, and a 渡り線 drawn beyond
 *   every one of them, because that is where a crossover is.
 * - **交差支障.** Select a road and the band each of its routes sweeps is
 *   shaded; the roads inside the band are the ones it fouls. It is the same
 *   span `track.crossingConflict` tests, so the picture and the check agree.
 *
 * Editing is direct: drag a road up or down to change its 分岐位置, click a
 * turnout to disconnect it, click a gap on a lead to connect one. The component
 * never mutates the document — it reports through `onChange`, exactly like the
 * 構内ダイヤ chart reports a drag between lanes.
 *
 * SVG for the same reasons the yard chart is SVG: a handful of shapes, all of
 * which want to be focusable, labelled and hit-testable.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { TID } from '@e2e/testids';

import type { StationId, StationTrackId } from '@/domain/ids';
import type { ProjectDocument, StationEnd, ThroatLead } from '@/domain/model';
import { STATION_END_LABEL } from '@/domain/model';
import { shuntMove, trainMove } from '@/domain/wiring';
import { getTheme, withAlpha } from '../canvas/theme';
import {
  computeWiringDiagram,
  routesOfRoad,
  DIAGRAM_DEFAULTS,
  type DiagramRoute,
} from './layout';

export interface StationWiringDiagramProps {
  doc: ProjectDocument;
  stationId: StationId;
  /** Road whose routes are shaded. */
  selectedTrackId?: StationTrackId | undefined;
  onSelect?: (trackId: StationTrackId) => void;
  /** New 分岐位置 for a road, after a drag. */
  onMoveLadder?: (trackId: StationTrackId, ladder: number) => void;
  /** Connect or disconnect a road and a lead in one throat. */
  onToggleLead?: (trackId: StationTrackId, end: StationEnd, lead: ThroatLead) => void;
  width?: number;
}

const DOT_R = 3.5;
const ROAD_W = 2;

export function StationWiringDiagram({
  doc,
  stationId,
  selectedTrackId,
  onSelect,
  onMoveLadder,
  onToggleLead,
  width = DIAGRAM_DEFAULTS.width,
}: StationWiringDiagramProps) {
  const theme = getTheme();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ trackId: StationTrackId; ladder: number } | undefined>();

  const diagram = useMemo(
    () => computeWiringDiagram(doc, stationId, { width }),
    [doc, stationId, width],
  );

  /**
   * The routes of the selected road, as the check sees them: one per throat it
   * is open at, per direction that can reach it, plus the 入換 to every other
   * road it can be worked to.
   */
  const routes: DiagramRoute[] = useMemo(() => {
    if (selectedTrackId === undefined) return [];
    const road = diagram.wiring.byTrack.get(selectedTrackId);
    if (road === undefined) return [];
    const moves: Array<{ end: StationEnd; label: string; from: number; to: number }> = [];
    for (const end of road.ends) {
      for (const direction of ['down', 'up'] as const) {
        const move = trainMove(diagram.wiring, {
          kind: 'arrive',
          trackId: selectedTrackId,
          direction,
          end,
        });
        if (move === undefined || move.routing === 'none') continue;
        moves.push({
          end,
          label: `${direction === 'down' ? '下り' : '上り'}本線から`,
          from: move.from,
          to: move.to,
        });
      }
      for (const other of diagram.wiring.roads) {
        if (other.trackId === selectedTrackId) continue;
        const move = shuntMove(diagram.wiring, selectedTrackId, other.trackId);
        if (move === undefined || move.routing === 'none' || move.end !== end) continue;
        moves.push({ end, label: `${other.name}へ入換`, from: move.from, to: move.to });
      }
    }
    return routesOfRoad(diagram, selectedTrackId, moves);
  }, [diagram, selectedTrackId]);

  const fouled = useMemo(() => new Set(routes.flatMap((r) => r.fouls)), [routes]);

  const ladderAt = useCallback(
    (clientY: number): number => {
      const box = svgRef.current?.getBoundingClientRect();
      if (box === undefined) return 0;
      const scale = box.height === 0 ? 1 : diagram.height / box.height;
      const y = (clientY - box.top) * scale;
      return Math.round((y - DIAGRAM_DEFAULTS.topPad) / DIAGRAM_DEFAULTS.laneH);
    },
    [diagram.height],
  );

  const yOf = (ladder: number): number =>
    DIAGRAM_DEFAULTS.topPad +
    (ladder - Math.min(...diagram.roads.map((r) => r.ladder), 0)) * DIAGRAM_DEFAULTS.laneH;

  return (
    <svg
      ref={svgRef}
      data-testid={TID.wiringDiagram}
      viewBox={`0 0 ${diagram.width} ${diagram.height}`}
      width="100%"
      height={diagram.height}
      role="img"
      aria-label={`${doc.stations.byId[stationId]?.name ?? ''} の構内配線図`}
      style={{ touchAction: 'none', display: 'block', maxWidth: '100%' }}
      onPointerMove={(e) => {
        if (drag === undefined) return;
        const next = ladderAt(e.clientY);
        if (next !== drag.ladder) setDrag({ ...drag, ladder: next });
      }}
      onPointerUp={() => {
        if (drag === undefined) return;
        onMoveLadder?.(drag.trackId, drag.ladder);
        setDrag(undefined);
      }}
      onPointerLeave={() => setDrag(undefined)}
    >
      {/* The platform area, so the throats read as throats. */}
      <rect
        x={diagram.bodyL}
        y={2}
        width={diagram.bodyR - diagram.bodyL}
        height={diagram.height - 4}
        fill={withAlpha(theme.panelAlt, 0.5)}
      />
      {(['up', 'down'] as const).map((end) => (
        <text
          key={end}
          x={end === 'down' ? diagram.width - 6 : 6}
          y={diagram.height - 5}
          textAnchor={end === 'down' ? 'end' : 'start'}
          fontSize={11}
          fill={theme.textFaint}
        >
          {STATION_END_LABEL[end]}
        </text>
      ))}

      {/* Shaded bands: what the selected road's routes sweep across. */}
      {routes.map((route) => (
        <rect
          key={route.key}
          data-testid={TID.wiringRoute}
          x={route.x0}
          y={yOf(route.fromY) - 6}
          width={Math.max(2, route.x1 - route.x0)}
          height={Math.max(4, yOf(route.toY) - yOf(route.fromY) + 12)}
          fill={withAlpha(theme.warning, 0.13)}
        >
          <title>{route.label}</title>
        </rect>
      ))}

      {/* Leads. */}
      {diagram.leads.map((lead) => (
        <g key={lead.key}>
          <line
            x1={lead.x0}
            y1={lead.y}
            x2={lead.x1}
            y2={lead.y}
            stroke={lead.isLine ? theme.borderStrong : theme.border}
            strokeWidth={ROAD_W}
            strokeDasharray={lead.isLine ? undefined : '5 3'}
          />
          {lead.closeX === undefined ? null : (
            <line
              x1={lead.closeX}
              y1={lead.y - 5}
              x2={lead.closeX}
              y2={lead.y + 5}
              stroke={theme.border}
              strokeWidth={ROAD_W}
            />
          )}
          <text
            x={lead.end === 'down' ? diagram.width - 6 : 6}
            y={lead.y - 6}
            textAnchor={lead.end === 'down' ? 'end' : 'start'}
            fontSize={10}
            fill={theme.textFaint}
          >
            {lead.label}
          </text>
        </g>
      ))}

      {/* Turnouts: the polyline from road to lead, and the point itself. */}
      {diagram.turnouts.map((t) => (
        <g key={t.key}>
          <polyline
            points={t.points.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke={theme.borderStrong}
            strokeWidth={ROAD_W}
          />
          <circle
            data-testid={TID.wiringTurnout(t.trackId, t.end, t.lead)}
            cx={t.x}
            cy={t.y}
            r={DOT_R}
            fill={theme.accent}
            style={{ cursor: onToggleLead === undefined ? 'default' : 'pointer' }}
            onClick={() => onToggleLead?.(t.trackId, t.end, t.lead)}
          >
            <title>{`${diagram.wiring.byTrack.get(t.trackId)?.name ?? ''} ${STATION_END_LABEL[t.end]} — ${t.lead === 'down' ? '下り本線' : t.lead === 'up' ? '上り本線' : t.lead} (クリックで切断)`}</title>
          </circle>
        </g>
      ))}

      {/* 渡り線. */}
      {diagram.crossovers.map((c) => (
        <g key={c.key} data-testid={TID.wiringCrossoverMark}>
          <line
            x1={c.x0}
            y1={c.y0}
            x2={c.x1}
            y2={c.y1}
            stroke={theme.accent}
            strokeWidth={ROAD_W}
          />
          <circle cx={c.x0} cy={c.y0} r={DOT_R} fill={theme.accent} />
          <circle cx={c.x1} cy={c.y1} r={DOT_R} fill={theme.accent}>
            <title>{c.name}</title>
          </circle>
        </g>
      ))}

      {/* The roads. */}
      {diagram.roads.map((road) => {
        const dragging = drag?.trackId === road.trackId;
        const y = dragging ? yOf(drag.ladder) : road.y;
        const selected = road.trackId === selectedTrackId;
        const colour = selected
          ? theme.accent
          : fouled.has(road.trackId)
            ? theme.warning
            : road.hasPlatform
              ? theme.text
              : theme.textDim;
        return (
          <g
            key={road.trackId}
            data-testid={TID.wiringRoad(road.trackId)}
            data-ladder={road.ladder}
            style={{ cursor: onMoveLadder === undefined ? 'pointer' : 'ns-resize' }}
            onPointerDown={(e) => {
              onSelect?.(road.trackId);
              if (onMoveLadder === undefined) return;
              e.currentTarget.setPointerCapture?.(e.pointerId);
              setDrag({ trackId: road.trackId, ladder: road.ladder });
            }}
          >
            <line
              x1={road.x0}
              y1={y}
              x2={road.x1}
              y2={y}
              stroke={colour}
              strokeWidth={selected ? ROAD_W + 1.5 : ROAD_W}
            />
            {road.hasPlatform ? (
              <rect
                x={road.x0 + 6}
                y={y - 9}
                width={Math.max(8, road.x1 - road.x0 - 12)}
                height={5}
                fill={withAlpha(colour, 0.45)}
              />
            ) : null}
            {road.buffers.map((x) => (
              <line
                key={x}
                x1={x}
                y1={y - 6}
                x2={x}
                y2={y + 6}
                stroke={colour}
                strokeWidth={ROAD_W}
              />
            ))}
            <text
              x={road.labelX}
              y={road.labelY + (y - road.y)}
              textAnchor="end"
              fontSize={11}
              fill={colour}
            >
              {road.name}
            </text>
            <title>{`${road.name} — 分岐位置 ${road.ladder}`}</title>
          </g>
        );
      })}
    </svg>
  );
}
