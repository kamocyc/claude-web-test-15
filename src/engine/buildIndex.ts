/**
 * Builds the derived, memoizable view of a project that everything else reads:
 * per-train timelines with km attached, per-minute activity buckets, track
 * occupancy intervals, and the detected overtake / connection events.
 */

import {
  asId,
  type DayTypeId,
  type DutyId,
  type FormationId,
  type LinkId,
  type PerfProfileId,
  type TrainId,
} from '@/domain/ids';
import type { LinkRunTime, PerfProfile, ProjectDocument } from '@/domain/model';
import {
  stationKmMap,
  trainDistance,
  trainEndSec,
  trainLabel,
  trainStartSec,
} from '@/domain/project';
import { entityList, type IsoDate } from '@/domain/units';
import { buildTrackIntervals } from './occupancy';
import { detectConnections, detectOvertakes } from './overtake';
import type { TimetableIndex, TrainEvent, TrainTimeline } from './types';

const BUCKET_SEC = 60;

/** Used only when a train type points at a PerfProfile that does not exist. */
const FALLBACK_PROFILE: PerfProfile = {
  id: asId<'PerfProfile'>('prf-fallback'),
  name: '既定性能',
  accelKmhps: 3.0,
  decelKmhps: 3.5,
  maxSpeedKmh: 100,
};

/** The day type in force on `date`, falling back to the active one. */
export function dayTypeIdFor(doc: ProjectDocument, date: IsoDate): DayTypeId {
  for (const entry of doc.calendar) {
    if (entry.date === date) return entry.dayTypeId;
  }
  return doc.settings.activeDayTypeId;
}

export function buildIndex(doc: ProjectDocument, date?: IsoDate): TimetableIndex {
  const resolvedDate = date ?? doc.settings.activeDate;
  const dayTypeId = dayTypeIdFor(doc, resolvedDate);
  const kmOfStation = stationKmMap(doc);

  // -- run-time lookup ------------------------------------------------------
  const runTimes = new Map<string, LinkRunTime>();
  for (const rt of doc.linkRunTimes) runTimes.set(`${rt.linkId}|${rt.profileId}`, rt);
  const runTimeOf = (linkId: LinkId, profileId: PerfProfileId): LinkRunTime | undefined =>
    runTimes.get(`${linkId}|${profileId}`);

  // -- duty / formation attribution ----------------------------------------
  const dutyOfTrain = new Map<TrainId, DutyId>();
  const formationOfTrain = new Map<TrainId, FormationId>();
  const formationOfDuty = new Map<DutyId, FormationId>();
  for (const assignment of entityList(doc.assignments)) {
    if (assignment.date !== resolvedDate) continue;
    formationOfDuty.set(assignment.dutyId, assignment.formationId);
  }
  for (const duty of entityList(doc.duties)) {
    if (!duty.dayTypeIds.includes(dayTypeId)) continue;
    for (const leg of duty.legs) {
      if (leg.kind !== 'train') continue;
      dutyOfTrain.set(leg.trainId, duty.id);
      const formationId = formationOfDuty.get(duty.id);
      if (formationId !== undefined) formationOfTrain.set(leg.trainId, formationId);
    }
  }

  // -- timelines ------------------------------------------------------------
  const timelines = new Map<TrainId, TrainTimeline>();
  for (const train of entityList(doc.trains)) {
    if (!train.dayTypeIds.includes(dayTypeId)) continue;

    const events: TrainEvent[] = [];
    train.stops.forEach((stop, stopIndex) => {
      const at = stop.arr ?? stop.dep;
      if (at === undefined) return;
      const event: TrainEvent = {
        stopIndex,
        stationId: stop.stationId,
        km: kmOfStation.get(stop.stationId) ?? 0,
        kind: stop.kind,
        at,
        isOvertakeWait: false,
      };
      if (stop.trackId !== undefined) event.trackId = stop.trackId;
      if (stop.arr !== undefined) event.arr = stop.arr;
      if (stop.dep !== undefined) event.dep = stop.dep;
      events.push(event);
    });
    events.sort((a, b) => a.at - b.at || a.stopIndex - b.stopIndex);
    if (events.length === 0) continue;

    const type = doc.trainTypes.byId[train.typeId];
    const profile =
      (type ? doc.perfProfiles.byId[type.perfProfileId] : undefined) ?? FALLBACK_PROFILE;

    const timeline: TrainTimeline = {
      trainId: train.id,
      train,
      typeId: train.typeId,
      direction: train.direction,
      category: train.category,
      events,
      startSec: trainStartSec(train) ?? events[0]!.at,
      endSec: trainEndSec(train) ?? events[events.length - 1]!.at,
      profile,
      label: trainLabel(doc, train),
      distance: trainDistance(doc, train),
    };
    const dutyId = dutyOfTrain.get(train.id);
    if (dutyId !== undefined) timeline.dutyId = dutyId;
    const formationId = formationOfTrain.get(train.id);
    if (formationId !== undefined) timeline.formationId = formationId;
    timelines.set(train.id, timeline);
  }

  const orderedTrainIds = [...timelines.values()]
    .sort((a, b) => a.startSec - b.startSec || a.trainId.localeCompare(b.trainId))
    .map((tl) => tl.trainId);

  // -- activity buckets -----------------------------------------------------
  const bucketStartSec = doc.settings.serviceDayStartSec;
  let maxEnd = doc.settings.serviceDayEndSec;
  for (const tl of timelines.values()) maxEnd = Math.max(maxEnd, tl.endSec);
  const bucketCount = Math.max(1, Math.floor((maxEnd - bucketStartSec) / BUCKET_SEC) + 1);
  const activeByMinute: TrainId[][] = Array.from({ length: bucketCount }, () => []);
  const bucketOf = (t: number): number => {
    const i = Math.floor((t - bucketStartSec) / BUCKET_SEC);
    return i < 0 ? 0 : i >= bucketCount ? bucketCount - 1 : i;
  };
  for (const trainId of orderedTrainIds) {
    const tl = timelines.get(trainId)!;
    const lo = bucketOf(tl.startSec);
    const hi = bucketOf(tl.endSec);
    for (let i = lo; i <= hi; i++) activeByMinute[i]!.push(trainId);
  }

  // -- derived conflict / connection analysis -------------------------------
  const overtakes = detectOvertakes(doc, timelines);
  for (const ot of overtakes) {
    const tl = timelines.get(ot.waitingTrainId);
    if (!tl) continue;
    for (const event of tl.events) {
      if (event.stationId === ot.stationId && event.arr === ot.waitArr) {
        event.isOvertakeWait = true;
      }
    }
  }
  const connections = detectConnections(doc, timelines, overtakes);
  const trackIntervals = buildTrackIntervals(doc, timelines);

  return {
    doc,
    date: resolvedDate,
    timelines,
    orderedTrainIds,
    activeByMinute,
    bucketStartSec,
    kmOfStation,
    runTimeOf,
    trackIntervals,
    dutyOfTrain,
    formationOfTrain,
    overtakes,
    connections,
  };
}
