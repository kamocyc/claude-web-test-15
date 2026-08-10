/**
 * String diagram (運行図表) layout — pure, no canvas, no React.
 *
 * World space:
 *   x = `Sec` (seconds from the start of the service day)
 *   y = distance, in one of two scales:
 *       - `'km'`    — linear in kilometres, the classic diagram; the slope of
 *                     a line is literally its speed
 *       - `'index'` — stations evenly spaced, which stops a line with one long
 *                     rural section from wasting most of the sheet
 *
 * Each train becomes ONE polyline containing a **horizontal segment across
 * every dwell**. That horizontal stub is not decoration: it is precisely what
 * makes a 待避 legible — the local's flat bar at the station with the express's
 * line crossing over it is the picture an operator is looking for.
 */

import type { StationId, TrainId, TrainTypeId } from '@/domain/ids';
import type { Direction, TrainCategory, TrainType } from '@/domain/model';
import { orderedStations } from '@/domain/project';
import type { Meters, Sec } from '@/domain/units';
import { getEntity, metersToKm } from '@/domain/units';
import type { ConnectionEvent, OvertakeEvent, TimetableIndex } from '@/engine/types';
import { SegmentGrid, type WorldSegment } from '../canvas/hit';

export type VerticalScale = 'km' | 'index';

/**
 * Which direction is drawn. On a busy line the two directions are two
 * interleaved lattices, and reading either one means ignoring the other; a
 * sheet with one of them removed is the classic 下り単独 diagram.
 */
export type DiagramDirection = Direction | 'both';

export interface DiagramStation {
  stationId: StationId;
  name: string;
  km: Meters;
  /** World y. */
  y: number;
  index: number;
  isConnectionPoint: boolean;
}

export interface DiagramPoint {
  /** World x — seconds. */
  x: Sec;
  /** World y. */
  y: number;
  stationId: StationId;
  stopIndex: number;
  /** Second vertex of a dwell pair. */
  isDwellEnd: boolean;
}

export interface DiagramTrain {
  trainId: TrainId;
  label: string;
  number: string;
  typeId: TrainTypeId;
  typeName: string;
  category: TrainCategory;
  direction: Direction;
  dutyId?: string;
  formationId?: string;
  color: string;
  lineWidth: number;
  dash: number[];
  points: DiagramPoint[];
  startSec: Sec;
  endSec: Sec;
}

export interface DiagramMarker {
  stationId: StationId;
  /** World coordinates of the marker anchor. */
  x: Sec;
  y: number;
  waitingTrainId?: TrainId;
  passingTrainId?: TrainId;
  fromTrainId?: TrainId;
  toTrainId?: TrainId;
  /** Overtake: legal. Connection: viable. */
  ok: boolean;
  /** Connections only — seconds between arrival and the connecting departure. */
  transferSec?: number;
  /** Connections only: the world x the bracket ends at. */
  x2?: number;
}

export interface DiagramLayout {
  verticalScale: VerticalScale;
  direction: DiagramDirection;
  stations: DiagramStation[];
  yOfStation: Map<StationId, number>;
  trains: DiagramTrain[];
  trainById: Map<TrainId, DiagramTrain>;
  overtakes: DiagramMarker[];
  connections: DiagramMarker[];
  /** Built once per rebuild; used by hover hit testing. */
  segments: SegmentGrid<TrainId>;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  /** Total number of polyline vertices — a useful size signal for tests. */
  pointCount: number;
}

export interface DiagramLayoutOptions {
  verticalScale?: VerticalScale;
  showDeadhead?: boolean;
  /** Draw one direction only; defaults to `'both'`. */
  direction?: DiagramDirection;
  /** Time window; defaults to the document's service day. */
  from?: Sec;
  to?: Sec;
}

const DASH_OF: Record<TrainType['lineStyle'], number[]> = {
  solid: [],
  dashed: [7, 4],
  dotted: [2, 3],
};

// ---------------------------------------------------------------------------
// Vertical axis
// ---------------------------------------------------------------------------

/**
 * World y for an arbitrary km — needed because a train may be mid-section.
 *
 * In `'km'` mode this is just kilometres. In `'index'` mode it interpolates
 * linearly between the two bracketing stations, so a train halfway between
 * them lands halfway down the gap regardless of the real distance.
 */
export function diagramYOfKm(layout: DiagramLayout, km: Meters): number {
  if (layout.verticalScale === 'km') return metersToKm(km);
  const list = layout.stations;
  if (list.length === 0) return 0;
  const first = list[0]!;
  const last = list[list.length - 1]!;
  if (km <= first.km) return first.y;
  if (km >= last.km) return last.y;
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1]!;
    const b = list[i]!;
    if (km <= b.km) {
      const span = b.km - a.km;
      const f = span === 0 ? 0 : (km - a.km) / span;
      return a.y + (b.y - a.y) * f;
    }
  }
  return last.y;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function computeDiagramLayout(
  index: TimetableIndex,
  opts: DiagramLayoutOptions = {},
): DiagramLayout {
  const doc = index.doc;
  const verticalScale = opts.verticalScale ?? 'km';
  const showDeadhead = opts.showDeadhead ?? true;
  const direction = opts.direction ?? 'both';

  const ordered = orderedStations(doc);
  const stations: DiagramStation[] = ordered.map((s, i) => ({
    stationId: s.id,
    name: s.name,
    km: s.kmFromOrigin,
    y: verticalScale === 'km' ? metersToKm(s.kmFromOrigin) : i,
    index: i,
    isConnectionPoint: s.isConnectionPoint,
  }));
  const yOfStation = new Map<StationId, number>();
  for (const s of stations) yOfStation.set(s.stationId, s.y);

  // Depot stations sit off the main axis; pin them to their nearest km so a
  // 出庫 still draws as a line reaching the attached station.
  const kmToY = (km: Meters): number => {
    if (verticalScale === 'km') return metersToKm(km);
    if (stations.length === 0) return 0;
    const first = stations[0]!;
    const last = stations[stations.length - 1]!;
    if (km <= first.km) return first.y - (first.km - km) / Math.max(1, stationGap(stations));
    if (km >= last.km) return last.y + (km - last.km) / Math.max(1, stationGap(stations));
    for (let i = 1; i < stations.length; i++) {
      const a = stations[i - 1]!;
      const b = stations[i]!;
      if (km <= b.km) {
        const span = b.km - a.km;
        const f = span === 0 ? 0 : (km - a.km) / span;
        return a.y + (b.y - a.y) * f;
      }
    }
    return last.y;
  };

  const trains: DiagramTrain[] = [];
  const trainById = new Map<TrainId, DiagramTrain>();
  const segments: Array<WorldSegment<TrainId>> = [];
  let pointCount = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const trainId of index.orderedTrainIds) {
    const tl = index.timelines.get(trainId);
    if (!tl) continue;
    if (!showDeadhead && tl.category !== 'service') continue;
    if (direction !== 'both' && tl.direction !== direction) continue;

    const type = getEntity(doc.trainTypes, tl.typeId);
    const points: DiagramPoint[] = [];

    for (const ev of tl.events) {
      const y = kmToY(ev.km);
      const arr = ev.arr ?? ev.dep ?? ev.at;
      const dep = ev.dep ?? ev.arr ?? ev.at;
      points.push({ x: arr, y, stationId: ev.stationId, stopIndex: ev.stopIndex, isDwellEnd: false });
      // The horizontal dwell stub — see the file header.
      if (dep > arr) {
        points.push({ x: dep, y, stationId: ev.stationId, stopIndex: ev.stopIndex, isDwellEnd: true });
      }
    }
    if (points.length === 0) continue;

    const dt: DiagramTrain = {
      trainId,
      label: tl.label,
      number: tl.train.number,
      typeId: tl.typeId,
      typeName: type?.name ?? '',
      category: tl.category,
      direction: tl.direction,
      color: type?.color ?? '#38bdf8',
      lineWidth: type?.lineWidth ?? 1.5,
      dash: type ? (DASH_OF[type.lineStyle] ?? []) : [],
      points,
      startSec: points[0]!.x,
      endSec: points[points.length - 1]!.x,
    };
    if (tl.dutyId !== undefined) dt.dutyId = tl.dutyId;
    if (tl.formationId !== undefined) dt.formationId = tl.formationId;

    trains.push(dt);
    trainById.set(trainId, dt);
    pointCount += points.length;

    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      segments.push({ ref: trainId, x0: a.x, y0: a.y, x1: b.x, y1: b.y });
      minX = Math.min(minX, a.x, b.x);
      maxX = Math.max(maxX, a.x, b.x);
      minY = Math.min(minY, a.y, b.y);
      maxY = Math.max(maxY, a.y, b.y);
    }
  }

  // A 待避 diamond or a 接続 bracket describes a relationship between two
  // lines. With one of those lines filtered away the marker is left pointing
  // at nothing, so it goes too.
  const drawn = (trainId: TrainId | undefined): boolean =>
    trainId === undefined || trainById.has(trainId);

  const overtakes: DiagramMarker[] = index.overtakes
    .filter((o: OvertakeEvent) => drawn(o.waitingTrainId) && drawn(o.passingTrainId))
    .map((o: OvertakeEvent) => ({
      stationId: o.stationId,
      x: o.passAt,
      y: yOfStation.get(o.stationId) ?? kmToY(index.kmOfStation.get(o.stationId) ?? 0),
      waitingTrainId: o.waitingTrainId,
      passingTrainId: o.passingTrainId,
      ok: o.legal,
    }));

  const connections: DiagramMarker[] = index.connections
    .filter((c: ConnectionEvent) => c.viable && drawn(c.fromTrainId) && drawn(c.toTrainId))
    .map((c: ConnectionEvent) => {
      const y = yOfStation.get(c.stationId) ?? kmToY(index.kmOfStation.get(c.stationId) ?? 0);
      const at = connectionAnchorSec(index, c);
      return {
        stationId: c.stationId,
        x: at,
        y,
        fromTrainId: c.fromTrainId,
        toTrainId: c.toTrainId,
        ok: c.viable,
        transferSec: c.transferSec,
        x2: at + c.transferSec,
      };
    });

  // Fall back to the service day when there are no trains at all.
  const from = opts.from ?? doc.settings.serviceDayStartSec;
  const to = opts.to ?? doc.settings.serviceDayEndSec;
  if (!Number.isFinite(minX)) {
    minX = from;
    maxX = to;
    minY = stations[0]?.y ?? 0;
    maxY = stations[stations.length - 1]?.y ?? 1;
  }

  const grid = new SegmentGrid<TrainId>(300, verticalScale === 'km' ? 0.5 : 1);
  grid.build(segments);

  return {
    verticalScale,
    direction,
    stations,
    yOfStation,
    trains,
    trainById,
    overtakes,
    connections,
    segments: grid,
    bounds: {
      minX: Math.min(minX, from),
      maxX: Math.max(maxX, Math.min(to, maxX + 600)),
      minY,
      maxY: maxY > minY ? maxY : minY + 1,
    },
    pointCount,
  };
}

function stationGap(stations: readonly DiagramStation[]): number {
  if (stations.length < 2) return 1000;
  const first = stations[0]!;
  const last = stations[stations.length - 1]!;
  return Math.max(1, (last.km - first.km) / (stations.length - 1));
}

/** When the alighting train arrives — the left end of a connection bracket. */
function connectionAnchorSec(index: TimetableIndex, c: ConnectionEvent): Sec {
  const from = index.timelines.get(c.fromTrainId);
  const ev = from?.events.find((e) => e.stationId === c.stationId);
  return ev?.arr ?? ev?.at ?? 0;
}

// ---------------------------------------------------------------------------
// Time gridlines
// ---------------------------------------------------------------------------

export interface TimeGrid {
  /** Major gridline step, seconds. */
  major: number;
  /** Minor gridline step, seconds — 0 when the zoom cannot fit any. */
  minor: number;
}

const GRID_STEPS = [60, 300, 600, 1800, 3600, 7200] as const;
/** Below this many pixels apart, gridlines stop being information. */
const MIN_GRID_PX = 34;

/**
 * Choose 1 / 10 / 60-minute gridlines from the current zoom.
 *
 * Pure, so a zoom-level regression shows up as a failing assertion instead of
 * an unreadable screenshot.
 */
export function chooseTimeGrid(scaleX: number): TimeGrid {
  let major: number = GRID_STEPS[GRID_STEPS.length - 1]!;
  for (const step of GRID_STEPS) {
    if (step * scaleX >= MIN_GRID_PX) {
      major = step;
      break;
    }
  }
  const idx = (GRID_STEPS as readonly number[]).indexOf(major);
  let minor = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const step = GRID_STEPS[i]!;
    if (step * scaleX >= 6) {
      minor = step;
      break;
    }
  }
  return { major, minor };
}

/** Distance gridline step in world-y units, for the `'km'` scale. */
export function chooseDistanceGrid(scaleY: number): number {
  const steps = [0.5, 1, 2, 5, 10, 20, 50] as const;
  for (const s of steps) if (s * scaleY >= 28) return s;
  return steps[steps.length - 1]!;
}
