/**
 * `snapshotAt` allocates and is what React and tests call. `snapshotInto`
 * reuses a pooled object and is what the 60fps render loop calls — the render
 * loop must not allocate.
 */

import type { DepotId, FormationId, StationId, StationTrackId } from '@/domain/ids';
import type { DutyLeg, ProjectDocument } from '@/domain/model';
import { depotByStationId, dutyLegSpan, dutySpan } from '@/domain/project';
import { entityList, type Sec } from '@/domain/units';
import { trainRuntimeAt } from './position';
import {
  NO_DELAY,
  type FormationPhase,
  type FormationRuntime,
  type SimSnapshot,
  type TimeOverlay,
  type TimetableIndex,
  type TrainRuntime,
} from './types';

/** Where a duty leg begins or ends, road included when the plan names one. */
function legEnd(
  doc: ProjectDocument,
  leg: DutyLeg,
  which: 'first' | 'last',
): { stationId: StationId; trackId?: StationTrackId } | undefined {
  if (leg.kind === 'train') {
    const train = doc.trains.byId[leg.trainId];
    const stop = which === 'first' ? train?.stops[0] : train?.stops[train.stops.length - 1];
    if (stop === undefined) return undefined;
    return stop.trackId === undefined
      ? { stationId: stop.stationId }
      : { stationId: stop.stationId, trackId: stop.trackId };
  }
  if (leg.kind === 'stable') {
    return leg.trackId === undefined
      ? { stationId: leg.stationId }
      : { stationId: leg.stationId, trackId: leg.trackId };
  }
  const depot = doc.depots.byId[leg.depotId];
  return depot === undefined ? undefined : { stationId: depot.stationId };
}

export function createEmptySnapshot(): SimSnapshot {
  return {
    t: 0,
    trains: [],
    formations: new Map(),
    trackOccupancy: new Map(),
    depotOccupancy: new Map(),
  };
}

export function snapshotAt(
  idx: TimetableIndex,
  t: Sec,
  overlay: TimeOverlay = NO_DELAY,
): SimSnapshot {
  return snapshotInto(idx, t, createEmptySnapshot(), overlay);
}

export function snapshotInto(
  idx: TimetableIndex,
  t: Sec,
  out: SimSnapshot,
  overlay: TimeOverlay = NO_DELAY,
): SimSnapshot {
  out.t = t;
  out.trains.length = 0;
  out.formations.clear();
  out.trackOccupancy.clear();
  out.depotOccupancy.clear();

  const { doc } = idx;

  // -- trains ---------------------------------------------------------------
  const bucket = Math.floor((t - idx.bucketStartSec) / 60);
  const clamped = bucket < 0 ? 0 : bucket >= idx.activeByMinute.length ? -1 : bucket;
  const active = clamped < 0 ? [] : (idx.activeByMinute[clamped] ?? []);
  const runtimeOf = new Map<string, TrainRuntime>();
  for (const trainId of active) {
    const tl = idx.timelines.get(trainId);
    if (!tl) continue;
    const rt = trainRuntimeAt(tl, t, overlay, doc);
    out.trains.push(rt);
    runtimeOf.set(trainId, rt);
  }

  // -- station tracks -------------------------------------------------------
  for (const [trackId, intervals] of idx.trackIntervals) {
    for (const interval of intervals) {
      if (interval.bookedFrom <= t && t <= interval.bookedTo) {
        out.trackOccupancy.set(trackId, interval.trainId);
        break;
      }
    }
  }

  // -- formations -----------------------------------------------------------
  const depotOfStation = depotByStationId(doc);
  const depotOccupancy = new Map<DepotId, FormationId[]>();
  const assigned = new Map<FormationId, string>();
  for (const assignment of entityList(doc.assignments)) {
    if (assignment.date !== idx.date) continue;
    assigned.set(assignment.formationId, assignment.dutyId);
  }

  for (const formation of entityList(doc.formations)) {
    if (formation.status === 'retired') continue;
    const dutyId = assigned.get(formation.id);
    const duty = dutyId === undefined ? undefined : doc.duties.byId[dutyId];

    const runtime: FormationRuntime = {
      formationId: formation.id,
      code: formation.code,
      cars: formation.cars,
      phase: 'unassigned',
      kmToday: 0,
      kmSoFarToday: 0,
    };
    if (duty === undefined) {
      out.formations.set(formation.id, runtime);
      continue;
    }
    runtime.dutyId = duty.id;

    let phase: FormationPhase = 'inDepot';
    let kmToday = 0;
    let kmSoFar = 0;
    // Where the stock was last seen, and where it is next seen. A formation
    // sitting in the yard is not on "the depot" in general — it is on one road
    // of it, the one its 入庫回送 arrived at or its 出庫回送 will leave from —
    // and that is what the line view draws it on.
    let restStationId: StationId | undefined;
    let restTrackId: StationTrackId | undefined;
    let nextStationId: StationId | undefined;
    let nextTrackId: StationTrackId | undefined;

    for (const leg of duty.legs) {
      const span = dutyLegSpan(doc, leg);
      if (span !== undefined && span.to <= t) {
        const ends = legEnd(doc, leg, 'last');
        if (ends !== undefined) {
          restStationId = ends.stationId;
          restTrackId = ends.trackId;
        }
      } else if (span !== undefined && span.from > t && nextStationId === undefined) {
        const starts = legEnd(doc, leg, 'first');
        if (starts !== undefined) {
          nextStationId = starts.stationId;
          nextTrackId = starts.trackId;
        }
      }
      if (leg.kind === 'train') {
        const tl = idx.timelines.get(leg.trainId);
        const distance = tl?.distance ?? 0;
        kmToday += distance;
        if (span && t >= span.to) kmSoFar += distance;
        else if (span && t >= span.from && span.to > span.from) {
          kmSoFar += (distance * (t - span.from)) / (span.to - span.from);
        }
        if (span && t >= span.from && t <= span.to && tl) {
          const rt = runtimeOf.get(leg.trainId) ?? trainRuntimeAt(tl, t, overlay, doc);
          runtime.currentTrainId = leg.trainId;
          if (rt.phase.phase === 'dwelling' || rt.phase.phase === 'passing') {
            runtime.stationId = rt.phase.stationId;
            if (rt.phase.trackId !== undefined) runtime.trackId = rt.phase.trackId;
          }
          const origin = tl.events[0]?.stationId;
          const terminus = tl.events[tl.events.length - 1]?.stationId;
          if (tl.category === 'deadhead' && origin !== undefined && depotOfStation.has(origin)) {
            phase = 'deadheadOut';
          } else if (
            tl.category === 'deadhead' &&
            terminus !== undefined &&
            depotOfStation.has(terminus)
          ) {
            phase = 'deadheadIn';
          } else {
            phase = 'inService';
          }
        }
      } else if (leg.kind === 'stable') {
        if (span && t >= span.from && t <= span.to) {
          phase = depotOfStation.has(leg.stationId) ? 'inDepot' : 'stabled';
          runtime.stationId = leg.stationId;
          if (leg.trackId !== undefined) runtime.trackId = leg.trackId;
        }
      } else if (span && t >= span.from && t <= span.to) {
        phase = 'underInspection';
        runtime.depotId = leg.depotId;
      }
    }

    const span = dutySpan(doc, duty);
    if (span && (t < span.from || t > span.to)) phase = 'inDepot';

    if (phase === 'inDepot' && runtime.stationId === undefined) {
      const berth =
        restStationId !== undefined && depotOfStation.has(restStationId)
          ? { stationId: restStationId, trackId: restTrackId }
          : nextStationId !== undefined && depotOfStation.has(nextStationId)
            ? { stationId: nextStationId, trackId: nextTrackId }
            : undefined;
      if (berth !== undefined) {
        runtime.stationId = berth.stationId;
        if (berth.trackId !== undefined) runtime.trackId = berth.trackId;
      }
    }

    runtime.phase = phase;
    runtime.kmToday = kmToday;
    runtime.kmSoFarToday = kmSoFar;
    if (runtime.stationId !== undefined) {
      const depotId = depotOfStation.get(runtime.stationId);
      if (depotId !== undefined) runtime.depotId = depotId;
    }
    if (phase === 'inDepot' && runtime.depotId === undefined) {
      runtime.depotId = formation.homeDepotId;
    }
    out.formations.set(formation.id, runtime);

    if (phase === 'inDepot' || phase === 'underInspection') {
      const depotId = runtime.depotId ?? formation.homeDepotId;
      const list = depotOccupancy.get(depotId);
      if (list) list.push(formation.id);
      else depotOccupancy.set(depotId, [formation.id]);
    }
  }

  for (const [depotId, list] of depotOccupancy) out.depotOccupancy.set(depotId, list);
  return out;
}
