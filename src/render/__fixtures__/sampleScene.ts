/**
 * A complete, hand-built scene for developing and testing the render stream.
 *
 * `src/engine/**` is being written concurrently and currently returns empty
 * stubs, so nothing here calls `buildIndex` or `snapshotAt`. Instead this
 * module builds objects that satisfy the *contracts* in `@/engine/types` from
 * the `toyProject()` document, which means the draw code is exercised against
 * realistic data today and needs no change when the real engine lands.
 *
 * The snapshot is taken at **08:05:00**, chosen because at that instant the
 * toy timetable has one of each interesting state:
 *
 *   - 各 101 is *dwelling at C on the 待避線* waiting to be passed (08:04→08:08)
 *   - 急 201 is *running* B→C and will pass it at 08:06
 *   - 回8001 has *finished* (it berthed at A at 07:52)
 *   - 回8002 has not started (pending — and is therefore never drawn)
 */

import type { StationTrackId, TrainId } from '@/domain/ids';
import type { PerfProfile, ProjectDocument, Train } from '@/domain/model';
import { dutyOfTrainMap, stationKmMap, trainDistance, trainLabel } from '@/domain/project';
import type { Meters, Sec } from '@/domain/units';
import { entityList, getEntity } from '@/domain/units';
import type {
  ConnectionEvent,
  FormationRuntime,
  OccupancyInterval,
  OvertakeEvent,
  SimSnapshot,
  TimetableIndex,
  TrainEvent,
  TrainRuntime,
  TrainTimeline,
} from '@/engine/types';
import { TOY, toyProject } from '@/testing/toyProject';
import type { RenderScene } from '../scene';

const H = 3600;
const M = 60;

/** 08:05:00 — see the file header. */
export const FIXTURE_T: Sec = 8 * H + 5 * M;

const FALLBACK_PROFILE: PerfProfile = {
  id: TOY.profile,
  name: '既定',
  accelKmhps: 3,
  decelKmhps: 3.5,
  maxSpeedKmh: 110,
};

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

function buildTimeline(
  doc: ProjectDocument,
  train: Train,
  kms: Map<string, Meters>,
  dutyOf: Map<TrainId, string>,
  formationOf: Map<TrainId, string>,
): TrainTimeline {
  const events: TrainEvent[] = train.stops.map((stop, stopIndex) => {
    const at = stop.arr ?? stop.dep ?? 0;
    const ev: TrainEvent = {
      stopIndex,
      stationId: stop.stationId,
      km: kms.get(stop.stationId) ?? 0,
      kind: stop.kind,
      at,
      isOvertakeWait: (stop.overtakenBy?.length ?? 0) > 0,
    };
    if (stop.trackId !== undefined) ev.trackId = stop.trackId;
    if (stop.arr !== undefined) ev.arr = stop.arr;
    if (stop.dep !== undefined) ev.dep = stop.dep;
    return ev;
  });

  const first = events[0];
  const last = events[events.length - 1];
  const type = getEntity(doc.trainTypes, train.typeId);
  const profile =
    (type ? getEntity(doc.perfProfiles, type.perfProfileId) : undefined) ?? FALLBACK_PROFILE;

  const tl: TrainTimeline = {
    trainId: train.id,
    train,
    typeId: train.typeId,
    direction: train.direction,
    category: train.category,
    events,
    startSec: first?.dep ?? first?.at ?? 0,
    endSec: last?.arr ?? last?.at ?? 0,
    profile,
    label: trainLabel(doc, train),
    distance: trainDistance(doc, train),
  };
  const dutyId = dutyOf.get(train.id) as TrainTimeline['dutyId'];
  if (dutyId !== undefined) tl.dutyId = dutyId;
  const formationId = formationOf.get(train.id) as TrainTimeline['formationId'];
  if (formationId !== undefined) tl.formationId = formationId;
  return tl;
}

function buildIntervals(
  doc: ProjectDocument,
  timelines: Map<TrainId, TrainTimeline>,
): Map<StationTrackId, OccupancyInterval[]> {
  const out = new Map<StationTrackId, OccupancyInterval[]>();
  for (const tl of timelines.values()) {
    for (const ev of tl.events) {
      if (ev.trackId === undefined) continue;
      const track = getEntity(doc.stationTracks, ev.trackId);
      if (!track) continue;
      const bookedFrom = ev.arr ?? ev.dep ?? ev.at;
      const bookedTo = ev.dep ?? ev.arr ?? ev.at;
      const interval: OccupancyInterval = {
        trackId: ev.trackId,
        stationId: ev.stationId,
        trainId: tl.trainId,
        from: bookedFrom - track.approachSec,
        to: bookedTo + track.clearSec,
        bookedFrom,
        bookedTo,
      };
      const list = out.get(ev.trackId);
      if (list) list.push(interval);
      else out.set(ev.trackId, [interval]);
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.from - b.from);
  return out;
}

/**
 * A `TimetableIndex` built from a document without the engine.
 *
 * Deliberately straightforward — this is fixture code, not a second
 * implementation of the engine. It exists so the render stream has real
 * timelines, real occupancy intervals and real overtake events to draw.
 */
export function buildFixtureIndex(doc: ProjectDocument): TimetableIndex {
  const kms = stationKmMap(doc);
  const dutyOf = dutyOfTrainMap(doc);

  const formationOf = new Map<TrainId, string>();
  for (const asg of entityList(doc.assignments)) {
    if (asg.date !== doc.settings.activeDate) continue;
    const duty = getEntity(doc.duties, asg.dutyId);
    if (!duty) continue;
    for (const leg of duty.legs) {
      if (leg.kind === 'train') formationOf.set(leg.trainId, asg.formationId);
    }
  }

  const timelines = new Map<TrainId, TrainTimeline>();
  for (const train of entityList(doc.trains)) {
    timelines.set(train.id, buildTimeline(doc, train, kms, dutyOf, formationOf));
  }

  const orderedTrainIds = [...timelines.values()]
    .sort((a, b) => a.startSec - b.startSec || a.trainId.localeCompare(b.trainId))
    .map((tl) => tl.trainId);

  const bucketStartSec = doc.settings.serviceDayStartSec;
  const bucketCount = Math.max(
    1,
    Math.ceil((doc.settings.serviceDayEndSec - bucketStartSec) / 60),
  );
  const activeByMinute: TrainId[][] = Array.from({ length: bucketCount }, () => []);
  for (const tl of timelines.values()) {
    const lo = Math.max(0, Math.floor((tl.startSec - bucketStartSec) / 60));
    const hi = Math.min(bucketCount - 1, Math.floor((tl.endSec - bucketStartSec) / 60));
    for (let i = lo; i <= hi; i++) activeByMinute[i]?.push(tl.trainId);
  }

  const runTimeKey = new Map<string, (typeof doc.linkRunTimes)[number]>();
  for (const rt of doc.linkRunTimes) runTimeKey.set(`${rt.linkId}|${rt.profileId}`, rt);

  // 各 101 waits at C for 急 201 — declared through `overtakenBy`.
  const overtakes: OvertakeEvent[] = [];
  const connections: ConnectionEvent[] = [];
  for (const tl of timelines.values()) {
    for (const ev of tl.events) {
      if (!ev.isOvertakeWait) continue;
      const stop = tl.train.stops[ev.stopIndex];
      for (const passingId of stop?.overtakenBy ?? []) {
        const passer = timelines.get(passingId);
        const passAt = passer?.events.find((e) => e.stationId === ev.stationId)?.at;
        if (passAt === undefined) continue;
        overtakes.push({
          stationId: ev.stationId,
          direction: tl.direction,
          waitingTrainId: tl.trainId,
          passingTrainId: passingId,
          waitArr: ev.arr ?? ev.at,
          passAt,
          waitDep: ev.dep ?? ev.at,
          declared: true,
          legal: true,
        });
        connections.push({
          stationId: ev.stationId,
          direction: tl.direction,
          fromTrainId: tl.trainId,
          toTrainId: passingId,
          transferSec: passAt - (ev.arr ?? ev.at),
          declared: false,
          viable: true,
        });
      }
    }
  }

  return {
    doc,
    date: doc.settings.activeDate,
    timelines,
    orderedTrainIds,
    activeByMinute,
    bucketStartSec,
    kmOfStation: kms as TimetableIndex['kmOfStation'],
    runTimeOf: (linkId, profileId) => runTimeKey.get(`${linkId}|${profileId}`),
    trackIntervals: buildIntervals(doc, timelines),
    dutyOfTrain: dutyOf as TimetableIndex['dutyOfTrain'],
    formationOfTrain: formationOf as TimetableIndex['formationOfTrain'],
    overtakes,
    connections,
  };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * A snapshot built straight from the timelines. Same contract as
 * `snapshotAt(index, t)`, without depending on the engine stub.
 */
export function buildFixtureSnapshot(idx: TimetableIndex, t: Sec): SimSnapshot {
  const doc = idx.doc;
  const trains: TrainRuntime[] = [];
  const trackOccupancy = new Map<StationTrackId, TrainId>();
  const formations = new Map<string, FormationRuntime>();
  const depotOccupancy = new Map<string, string[]>();

  for (const trainId of idx.orderedTrainIds) {
    const tl = idx.timelines.get(trainId);
    if (!tl) continue;
    const rt = runtimeOf(idx, tl, t);
    trains.push(rt);
    const phase = rt.phase;
    if ((phase.phase === 'dwelling' || phase.phase === 'passing') && phase.trackId) {
      trackOccupancy.set(phase.trackId, trainId);
    }
  }

  for (const formation of entityList(doc.formations)) {
    const series = getEntity(doc.formationSeries, formation.seriesId);
    const current = trains.find(
      (r) => r.formationId === formation.id && r.phase.phase !== 'pending' && r.phase.phase !== 'finished',
    );
    const rt: FormationRuntime = {
      formationId: formation.id,
      code: formation.code,
      cars: formation.cars,
      phase: current ? 'inService' : 'inDepot',
      kmToday: 0,
      kmSoFarToday: 0,
    };
    if (current) rt.currentTrainId = current.trainId;
    if (!current) {
      rt.depotId = formation.homeDepotId;
      const list = depotOccupancy.get(formation.homeDepotId);
      if (list) list.push(formation.id);
      else depotOccupancy.set(formation.homeDepotId, [formation.id]);
    }
    void series;
    formations.set(formation.id, rt);
  }

  return {
    t,
    trains,
    formations: formations as SimSnapshot['formations'],
    trackOccupancy,
    depotOccupancy: depotOccupancy as SimSnapshot['depotOccupancy'],
  };
}

function runtimeOf(idx: TimetableIndex, tl: TrainTimeline, t: Sec): TrainRuntime {
  const doc = idx.doc;
  const formationId = tl.formationId;
  const formation = formationId ? getEntity(doc.formations, formationId) : undefined;

  const base: TrainRuntime = {
    trainId: tl.trainId,
    label: tl.label,
    number: tl.train.number,
    typeId: tl.typeId,
    direction: tl.direction,
    category: tl.category,
    phase: { phase: 'pending' },
    km: tl.events[0]?.km ?? 0,
    delaySec: 0,
  };
  if (tl.dutyId !== undefined) base.dutyId = tl.dutyId;
  if (formationId !== undefined) base.formationId = formationId;
  if (formation) {
    base.formationCode = formation.code;
    base.cars = formation.cars;
  }
  const terminus = tl.events[tl.events.length - 1];
  if (terminus) base.destinationStationId = terminus.stationId;

  if (t < tl.startSec) return base;
  if (t >= tl.endSec) {
    return { ...base, phase: { phase: 'finished' }, km: terminus?.km ?? base.km };
  }

  for (let i = 0; i < tl.events.length; i++) {
    const ev = tl.events[i]!;
    const arr = ev.arr ?? ev.at;
    const dep = ev.dep ?? ev.at;
    if (t >= arr && t < dep) {
      const stop = tl.train.stops[ev.stopIndex];
      const reason = ev.isOvertakeWait
        ? 'overtakeWait'
        : stop?.operation === 'depotIn' || stop?.operation === 'depotOut'
          ? 'depot'
          : stop?.operation === 'turnback'
            ? 'turnback'
            : stop?.operational
              ? 'operational'
              : 'passenger';
      const next = tl.events[i + 1];
      const out: TrainRuntime = {
        ...base,
        km: ev.km,
        phase: {
          phase: 'dwelling',
          stationId: ev.stationId,
          km: ev.km,
          since: arr,
          until: dep,
          reason,
          ...(ev.trackId !== undefined ? { trackId: ev.trackId } : {}),
        },
      };
      if (next) {
        out.nextStationId = next.stationId;
        out.nextArrSec = next.arr ?? next.at;
      }
      return out;
    }
    if (t === arr && ev.kind === 'pass') {
      return {
        ...base,
        km: ev.km,
        phase: {
          phase: 'passing',
          stationId: ev.stationId,
          km: ev.km,
          ...(ev.trackId !== undefined ? { trackId: ev.trackId } : {}),
        },
      };
    }
    const next = tl.events[i + 1];
    if (!next) continue;
    const nextArr = next.arr ?? next.at;
    if (t >= dep && t < nextArr) {
      const span = Math.max(1, nextArr - dep);
      const progress = (t - dep) / span;
      const km = ev.km + (next.km - ev.km) * progress;
      const speedKmh = (Math.abs(next.km - ev.km) / span) * 3.6;
      const out: TrainRuntime = {
        ...base,
        km,
        phase: {
          phase: 'running',
          fromStationId: ev.stationId,
          toStationId: next.stationId,
          km,
          progress,
          speedKmh,
        },
      };
      out.nextStationId = next.stationId;
      out.nextArrSec = nextArr;
      return out;
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------

let cachedDoc: ProjectDocument | undefined;
let cachedIndex: TimetableIndex | undefined;

export function sampleDoc(): ProjectDocument {
  cachedDoc ??= toyProject();
  return cachedDoc;
}

export function sampleIndex(): TimetableIndex {
  cachedIndex ??= buildFixtureIndex(sampleDoc());
  return cachedIndex;
}

/** The full scene at `FIXTURE_T` (or any other instant). */
export function sampleScene(t: Sec = FIXTURE_T): RenderScene {
  const index = sampleIndex();
  return {
    doc: index.doc,
    index,
    t,
    snapshot: buildFixtureSnapshot(index, t),
    generation: 1,
  };
}

/**
 * A variant whose C 1番線 is double-booked, so the yard chart's conflict
 * rendering has something to show.
 */
export function sampleSceneWithYardConflict(t: Sec = FIXTURE_T): RenderScene {
  const scene = sampleScene(t);
  const index: TimetableIndex = {
    ...scene.index,
    trackIntervals: new Map(scene.index.trackIntervals),
  };
  const existing = index.trackIntervals.get(TOY.c1) ?? [];
  const clash = existing[0];
  if (clash) {
    index.trackIntervals.set(TOY.c1, [
      ...existing,
      {
        ...clash,
        trainId: TOY.localDown,
        from: clash.from - 30,
        to: clash.to + 120,
        bookedFrom: clash.bookedFrom - 30,
        bookedTo: clash.bookedTo + 120,
      },
    ]);
  }
  return { ...scene, index, generation: scene.generation + 1 };
}

/** Drop the memoized document — for tests that mutate it. */
export function resetSampleScene(): void {
  cachedDoc = undefined;
  cachedIndex = undefined;
}
