/**
 * 構内ダイヤ (station yard chart) layout — pure.
 *
 * One lane per 番線, time along x. Each `OccupancyInterval` becomes a bar
 * spanning `[from, to]` (booked times plus the track's approach and clear
 * margins), with the booked window drawn inside it so the margins are visible
 * as distinct from the timetabled dwell.
 *
 * Two bars on the same lane whose margin-inclusive windows overlap are a
 * double occupancy — the single most important thing this chart exists to
 * show, so it is computed here rather than left to the renderer.
 */

import type { DutyId, StationId, StationTrackId, TrainId } from '@/domain/ids';
import type { ProjectDocument, TrackUsage } from '@/domain/model';
import { tracksOfStation } from '@/domain/project';
import type { Sec } from '@/domain/units';
import { getEntity } from '@/domain/units';
import type { TimetableIndex } from '@/engine/types';

export interface YardLane {
  trackId: StationTrackId;
  name: string;
  index: number;
  hasPlatform: boolean;
  canBeOvertaken: boolean;
  usage: TrackUsage;
  maxCars: number;
}

export interface YardBar {
  trainId: TrainId;
  /** Index into `Train.stops` — what `onReassignTrack` needs. */
  stopIndex: number;
  trackId: StationTrackId;
  laneIndex: number;
  /** Margin-inclusive occupancy. */
  from: Sec;
  to: Sec;
  /** Timetabled arrival/departure. */
  bookedFrom: Sec;
  bookedTo: Sec;
  label: string;
  color: string;
  /**
   * The duty working this train. Two bars of the same duty are the same
   * physical formation and so are never a conflict — see the overlap scan.
   */
  dutyId?: DutyId;
  /** Overlaps another bar on the same lane, worked by a different formation. */
  conflict: boolean;
  /** 待避 — this dwell exists so another train can pass. */
  overtakeWait: boolean;
}

/**
 * A formation moving from one road to another without leaving the station.
 *
 * The bars say where the stock stands; only the line between them says it
 * *moved*, and a move between roads is the one thing a 構内ダイヤ is drawn for
 * that a list of occupancies cannot show. It is derived rather than authored:
 * two consecutive bookings of the same duty on two different roads, with no
 * gap between them, is a shunt whether or not anyone wrote one down.
 */
export interface YardShunt {
  dutyId: DutyId;
  fromTrackId: StationTrackId;
  toTrackId: StationTrackId;
  fromLane: number;
  toLane: number;
  /** Leaves the first road / takes the second. Equal for an instant move. */
  from: Sec;
  to: Sec;
  fromTrainId: TrainId;
  toTrainId: TrainId;
  label: string;
}

export interface YardLayout {
  stationId: StationId;
  stationName: string;
  lanes: YardLane[];
  bars: YardBar[];
  shunts: YardShunt[];
  /** Time window covering every bar, padded. */
  from: Sec;
  to: Sec;
  conflictCount: number;
}

const PAD_SEC = 300;

/**
 * The longest gap between two bookings that still reads as one stay.
 *
 * Beyond it the formation went somewhere — worked a train out and back, ran to
 * the depot — and joining the two bars would draw a shunt that never happened.
 */
const SHUNT_MAX_GAP_SEC = 300;

export function computeYardLayout(
  doc: ProjectDocument,
  index: TimetableIndex,
  stationId: StationId,
): YardLayout {
  const station = getEntity(doc.stations, stationId);
  const tracks = tracksOfStation(doc, stationId);
  const lanes: YardLane[] = tracks.map((t, i) => ({
    trackId: t.id,
    name: t.name,
    index: i,
    hasPlatform: t.hasPlatform,
    canBeOvertaken: t.canBeOvertaken,
    usage: t.usage,
    maxCars: t.maxCars,
  }));
  const laneIndexOf = new Map<StationTrackId, number>();
  for (const l of lanes) laneIndexOf.set(l.trackId, l.index);

  const bars: YardBar[] = [];
  for (const lane of lanes) {
    const intervals = index.trackIntervals.get(lane.trackId) ?? [];
    for (const iv of intervals) {
      if (iv.stationId !== stationId) continue;
      const tl = index.timelines.get(iv.trainId);
      const dutyId = index.dutyOfTrain.get(iv.trainId);
      const type = tl ? getEntity(doc.trainTypes, tl.typeId) : undefined;
      const ev = tl?.events.find(
        (e) =>
          e.stationId === stationId &&
          (e.trackId === lane.trackId || e.trackId === undefined) &&
          (e.arr ?? e.at) === iv.bookedFrom,
      );
      bars.push({
        trainId: iv.trainId,
        stopIndex: ev?.stopIndex ?? findStopIndex(doc, iv.trainId, stationId),
        trackId: lane.trackId,
        laneIndex: lane.index,
        from: iv.from,
        to: iv.to,
        bookedFrom: iv.bookedFrom,
        bookedTo: iv.bookedTo,
        label: tl?.label ?? iv.trainId,
        color: type?.color ?? '#38bdf8',
        conflict: false,
        overtakeWait: ev?.isOvertakeWait ?? false,
        ...(dutyId !== undefined ? { dutyId } : {}),
      });
    }
  }

  bars.sort((a, b) => a.laneIndex - b.laneIndex || a.from - b.from || b.to - a.to);
  dropContainedBookings(bars);

  // Mark overlaps, applying the same exclusion `track.doubleOccupancy` uses:
  // one duty is one physical formation, so it cannot conflict with itself. A
  // turnback necessarily produces two overlapping bars — the arrival held to
  // the hand-over, and the departure's own booking opening an approach margin
  // earlier — and without this the chart paints every terminal solid red while
  // the problem panel correctly reports no errors.
  //
  // The pairwise scan is O(bars per lane squared) in the worst case but breaks
  // as soon as a later bar starts after the current one ends, so on real data
  // it stays close to linear.
  let conflictCount = 0;
  for (let i = 0; i < bars.length; i++) {
    const a = bars[i]!;
    for (let j = i + 1; j < bars.length; j++) {
      const b = bars[j]!;
      if (b.laneIndex !== a.laneIndex || b.from >= a.to) break;
      if (a.dutyId !== undefined && a.dutyId === b.dutyId) continue;
      a.conflict = true;
      b.conflict = true;
      conflictCount++;
    }
  }

  let from = Infinity;
  let to = -Infinity;
  for (const b of bars) {
    from = Math.min(from, b.from);
    to = Math.max(to, b.to);
  }
  if (!Number.isFinite(from)) {
    from = doc.settings.serviceDayStartSec;
    to = Math.min(doc.settings.serviceDayEndSec, from + 3600);
  }

  return {
    stationId,
    stationName: station?.name ?? '',
    lanes,
    bars,
    shunts: findShunts(bars),
    from: from - PAD_SEC,
    to: to + PAD_SEC,
    conflictCount,
  };
}

/**
 * Drop a booking that another booking of the same stock already covers.
 *
 * A terminating arrival held for its own 折り返し produces both the stop's
 * booking and the extended one, on the same road, starting at the same second.
 * They are one stay, so the shorter is a bar drawn exactly on top of another —
 * invisible, but a second click target and a second copy of the label.
 * Mutates in place, keeping the sort order.
 */
function dropContainedBookings(bars: YardBar[]): void {
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i]!;
    for (let j = 0; j < bars.length; j++) {
      if (j === i) continue;
      const other = bars[j]!;
      if (other.trainId !== b.trainId || other.trackId !== b.trackId) continue;
      const covers = other.from <= b.from && other.to >= b.to;
      const strictly = other.from < b.from || other.to > b.to;
      // Identical pairs would otherwise remove each other; keep the earlier.
      if (covers && (strictly || j < i)) {
        bars.splice(i, 1);
        break;
      }
    }
  }
}

/** Consecutive bookings of one duty on two roads: the stock was moved. */
function findShunts(bars: readonly YardBar[]): YardShunt[] {
  const byDuty = new Map<DutyId, YardBar[]>();
  for (const bar of bars) {
    if (bar.dutyId === undefined) continue;
    const list = byDuty.get(bar.dutyId);
    if (list === undefined) byDuty.set(bar.dutyId, [bar]);
    else list.push(bar);
  }

  const out: YardShunt[] = [];
  for (const [dutyId, list] of byDuty) {
    list.sort((a, b) => a.bookedFrom - b.bookedFrom || a.laneIndex - b.laneIndex);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!;
      const b = list[i]!;
      if (a.trackId === b.trackId) continue;
      if (b.from - a.to > SHUNT_MAX_GAP_SEC) continue;
      out.push({
        dutyId,
        fromTrackId: a.trackId,
        toTrackId: b.trackId,
        fromLane: a.laneIndex,
        toLane: b.laneIndex,
        from: a.bookedTo,
        to: Math.max(b.bookedFrom, a.bookedTo),
        fromTrainId: a.trainId,
        toTrainId: b.trainId,
        label: b.label,
      });
    }
  }
  out.sort((a, b) => a.from - b.from || a.fromLane - b.fromLane);
  return out;
}

function findStopIndex(doc: ProjectDocument, trainId: TrainId, stationId: StationId): number {
  const train = getEntity(doc.trains, trainId);
  if (!train) return 0;
  const i = train.stops.findIndex((s) => s.stationId === stationId);
  return i < 0 ? 0 : i;
}

/** Which lane a y position falls on — used while dragging a bar. */
export function laneAtY(y: number, laneHeight: number, laneCount: number): number {
  const i = Math.floor(y / laneHeight);
  return i < 0 ? 0 : i >= laneCount ? laneCount - 1 : i;
}
