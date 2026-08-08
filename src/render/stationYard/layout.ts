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

import type { StationId, StationTrackId, TrainId } from '@/domain/ids';
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
  /** Overlaps another bar on the same lane. */
  conflict: boolean;
  /** 待避 — this dwell exists so another train can pass. */
  overtakeWait: boolean;
}

export interface YardLayout {
  stationId: StationId;
  stationName: string;
  lanes: YardLane[];
  bars: YardBar[];
  /** Time window covering every bar, padded. */
  from: Sec;
  to: Sec;
  conflictCount: number;
}

const PAD_SEC = 300;

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
      });
    }
  }

  bars.sort((a, b) => a.laneIndex - b.laneIndex || a.from - b.from);

  // Mark overlaps. Bars are lane-major then time-ordered, so a single pass
  // comparing each bar with the previous one on the same lane suffices for the
  // pairwise case, and the running max handles chains of three or more.
  let conflictCount = 0;
  let prev: YardBar | undefined;
  let laneMaxTo = -Infinity;
  let laneOfMax = -1;
  for (const bar of bars) {
    if (prev === undefined || prev.laneIndex !== bar.laneIndex) {
      laneMaxTo = bar.to;
      laneOfMax = bar.laneIndex;
      prev = bar;
      continue;
    }
    if (laneOfMax === bar.laneIndex && bar.from < laneMaxTo) {
      bar.conflict = true;
      prev.conflict = true;
      conflictCount++;
    }
    if (bar.to > laneMaxTo) laneMaxTo = bar.to;
    prev = bar;
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
    from: from - PAD_SEC,
    to: to + PAD_SEC,
    conflictCount,
  };
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
