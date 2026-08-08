/**
 * The single write path into a `ProjectDocument`.
 *
 * `reduce` is an Immer producer *body*: it mutates a draft in place and returns
 * nothing. Everything that changes the document goes through here, so undo,
 * validation scoping and autosave all hang off one choke point.
 */

import { current } from 'immer';

import { ID_PREFIX, asId } from '@/domain/ids';
import type {
  AssignmentId,
  DayTypeId,
  DutyId,
  LinkId,
  StationId,
  StationTrackId,
  TrainId,
} from '@/domain/ids';
import type {
  Assignment,
  Direction,
  Duty,
  DutyLeg,
  Link,
  ProjectDocument,
  Station,
  StationTrack,
  Train,
  TrainStop,
} from '@/domain/model';
import {
  buildLinkLookup,
  rebuildLinks,
  trainStartSec,
  trainTerminusStationId,
  trainOriginStationId,
} from '@/domain/project';
import { ceilToGrain, intervalsOverlap } from '@/domain/time';
import { entityList, getEntity, putEntity, removeEntity } from '@/domain/units';

import type { Command } from './commands';
import { newId } from './idPool';

const DEFAULT_MAX_SPEED_KMH = 110;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * Apply a partial patch. An explicitly-`undefined` value clears the key, which
 * is the only way a form can unset an optional field. Type safety lives in the
 * `Command` union; by the time a patch reaches here it has been checked.
 */
function applyPatch(target: object, patch: object): void {
  const t = target as Record<string, unknown>;
  for (const key of Object.keys(patch)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) delete t[key];
    else t[key] = value;
  }
}

function setOrDelete(target: object, key: string, value: unknown): void {
  const t = target as Record<string, unknown>;
  if (value === undefined) delete t[key];
  else t[key] = value;
}

/** Rebuild the link chain from the current draft state. */
function refreshLinks(draft: ProjectDocument): void {
  const snapshot = current(draft);
  const { links } = rebuildLinks(snapshot, () => newId<'Link'>(ID_PREFIX.link), {
    minHeadwaySec: draft.validationConfig.defaultMinHeadwaySec,
    maxSpeedKmh: DEFAULT_MAX_SPEED_KMH,
  });
  const keep = new Set(links.allIds);
  draft.links = links as ProjectDocument['links'];
  draft.linkRunTimes = draft.linkRunTimes.filter((rt) => keep.has(rt.linkId));
}

/** Enforce "origin has no arr, terminus has no dep" after structural edits. */
function normalizeEndpoints(train: Train): void {
  const first = train.stops[0];
  const last = train.stops[train.stops.length - 1];
  if (first !== undefined && train.stops.length > 1) delete first.arr;
  if (last !== undefined && train.stops.length > 1) delete last.dep;
}

function removeTrackReferences(draft: ProjectDocument, trackId: StationTrackId): void {
  for (const station of entityList(draft.stations)) {
    for (const dir of ['down', 'up'] as const) {
      if (station.defaultTrackId[dir] === trackId) delete station.defaultTrackId[dir];
    }
    const i = station.trackIds.indexOf(trackId);
    if (i >= 0) station.trackIds.splice(i, 1);
  }
  for (const train of entityList(draft.trains)) {
    for (const stop of train.stops) if (stop.trackId === trackId) delete stop.trackId;
  }
  for (const duty of entityList(draft.duties)) {
    for (const leg of duty.legs) {
      if (leg.kind === 'stable' && leg.trackId === trackId) delete leg.trackId;
    }
  }
}

function removeTrainReferences(draft: ProjectDocument, ids: Set<string>): void {
  for (const duty of entityList(draft.duties)) {
    duty.legs = duty.legs.filter((leg) => leg.kind !== 'train' || !ids.has(leg.trainId));
  }
  for (const train of entityList(draft.trains)) {
    for (const stop of train.stops) {
      if (stop.overtakenBy) {
        const next = stop.overtakenBy.filter((id) => !ids.has(id));
        if (next.length === 0) delete stop.overtakenBy;
        else stop.overtakenBy = next;
      }
      if (stop.connectsTo) {
        const next = stop.connectsTo.filter((id) => !ids.has(id));
        if (next.length === 0) delete stop.connectsTo;
        else stop.connectsTo = next;
      }
    }
  }
}

function dayTypeOfDate(draft: ProjectDocument, date: string): DayTypeId | undefined {
  const entry = draft.calendar.find((c) => c.date === date);
  return (entry?.dayTypeId ?? draft.settings.activeDayTypeId) as DayTypeId | undefined;
}

// ---------------------------------------------------------------------------
// train/recomputeTimes
// ---------------------------------------------------------------------------

/**
 * Re-derive every time from the origin departure.
 *
 *   arr(i) = dep(i-1) + baseRunSec
 *          + (previous stop was a stand ? startPenaltySec : 0)
 *          + (this stop is a stand      ? stopPenaltySec  : 0)
 *
 * An authored dwell longer than `minDwellSec` is preserved — that is how
 * overtake waits and turnback margins survive a recompute.
 */
export function recomputeTrainTimes(draft: ProjectDocument, train: Train): void {
  if (train.stops.length < 2) return;
  const grain = draft.settings.timeGrainSec;
  const type = getEntity(draft.trainTypes, train.typeId);
  const profileId = type?.perfProfileId;
  const lookup = buildLinkLookup(draft);

  const origin = train.stops[0]!;
  let cursor = origin.dep ?? origin.arr ?? draft.settings.serviceDayStartSec;
  origin.dep = cursor;
  delete origin.arr;

  for (let i = 1; i < train.stops.length; i++) {
    const prev = train.stops[i - 1]!;
    const stop = train.stops[i]!;
    const link = lookup.between(prev.stationId, stop.stationId);
    const runTime =
      link !== undefined && profileId !== undefined
        ? draft.linkRunTimes.find((rt) => rt.linkId === link.id && rt.profileId === profileId)
        : undefined;

    let run: number;
    if (runTime !== undefined) {
      run =
        runTime.baseRunSec +
        (prev.kind === 'stop' ? runTime.startPenaltySec : 0) +
        (stop.kind === 'stop' ? runTime.stopPenaltySec : 0);
    } else {
      const distance = link?.distance ?? 1000;
      const speed = link?.maxSpeedKmh ?? DEFAULT_MAX_SPEED_KMH;
      run = (distance / 1000 / speed) * 3600;
    }
    run = ceilToGrain(Math.max(run, 1), grain);

    const arr = cursor + run;
    stop.arr = arr;

    if (i === train.stops.length - 1) {
      delete stop.dep;
      cursor = arr;
      continue;
    }

    const station = getEntity(draft.stations, stop.stationId);
    let dwell = 0;
    if (stop.kind === 'stop') {
      const authored =
        stop.dep !== undefined && stop.arr !== undefined ? stop.dep - stop.arr : undefined;
      const previousDwell = authored !== undefined && authored > 0 ? authored : 0;
      dwell = Math.max(station?.minDwellSec ?? 0, previousDwell);
      dwell = ceilToGrain(dwell, grain);
    }
    stop.dep = arr + dwell;
    cursor = stop.dep;
  }
}

// ---------------------------------------------------------------------------
// train/autoAssignTracks
// ---------------------------------------------------------------------------

interface TrackEvent {
  train: Train;
  stop: TrainStop;
  at: number;
  direction: Direction;
  needsOvertakeCapable: boolean;
  needsPlatform: boolean;
}

function windowOf(stop: TrainStop, track: StationTrack | undefined): { from: number; to: number } {
  const arr = stop.arr ?? stop.dep ?? 0;
  const dep = stop.dep ?? stop.arr ?? 0;
  const approach = track?.approachSec ?? 45;
  const clear = track?.clearSec ?? 30;
  return { from: arr - approach, to: dep + clear };
}

/**
 * Greedy platform allocator. Events at one station are walked in time order;
 * each takes the station's default track for its direction when that track is
 * legal and free, otherwise the first track that is.
 */
export function autoAssignTracks(draft: ProjectDocument, targetIds?: readonly TrainId[]): void {
  const targets = new Set<string>(
    targetIds !== undefined && targetIds.length > 0 ? targetIds : draft.trains.allIds,
  );

  const byStation = new Map<StationId, TrackEvent[]>();
  for (const train of entityList(draft.trains)) {
    const type = getEntity(draft.trainTypes, train.typeId);
    for (const stop of train.stops) {
      const list = byStation.get(stop.stationId) ?? [];
      list.push({
        train,
        stop,
        at: stop.arr ?? stop.dep ?? 0,
        direction: train.direction,
        needsOvertakeCapable: (stop.overtakenBy?.length ?? 0) > 0,
        needsPlatform:
          stop.kind === 'stop' &&
          stop.operational !== true &&
          (type?.isPassengerService ?? true),
      });
      byStation.set(stop.stationId, list);
    }
  }

  for (const [stationId, events] of byStation) {
    const station = getEntity(draft.stations, stationId);
    if (station === undefined) continue;
    const tracks = station.trackIds
      .map((id) => getEntity(draft.stationTracks, id))
      .filter((t): t is StationTrack => t !== undefined);
    if (tracks.length === 0) continue;

    const busy = new Map<StationTrackId, Array<{ from: number; to: number }>>();
    const reserve = (trackId: StationTrackId, from: number, to: number): void => {
      const list = busy.get(trackId) ?? [];
      list.push({ from, to });
      busy.set(trackId, list);
    };
    const isFree = (trackId: StationTrackId, from: number, to: number): boolean =>
      !(busy.get(trackId) ?? []).some((w) => intervalsOverlap(from, to, w.from, w.to));

    // Trains outside the target set keep the platform they already hold.
    for (const ev of events) {
      if (targets.has(ev.train.id)) continue;
      const trackId = ev.stop.trackId;
      if (trackId === undefined) continue;
      const w = windowOf(ev.stop, getEntity(draft.stationTracks, trackId));
      reserve(trackId, w.from, w.to);
    }

    const pending = events.filter((ev) => targets.has(ev.train.id)).sort((a, b) => a.at - b.at);
    for (const ev of pending) {
      delete ev.stop.trackId;
      const preferred = station.defaultTrackId[ev.direction];
      const ordered = [
        ...tracks.filter((t) => t.id === preferred),
        ...tracks.filter((t) => t.id !== preferred),
      ];
      let chosen: StationTrack | undefined;
      for (const track of ordered) {
        if (!track.directions.includes(ev.direction)) continue;
        if (ev.needsPlatform && !track.hasPlatform) continue;
        if (ev.needsOvertakeCapable && !track.canBeOvertaken) continue;
        const w = windowOf(ev.stop, track);
        if (!isFree(track.id, w.from, w.to)) continue;
        chosen = track;
        break;
      }
      if (chosen === undefined) continue;
      ev.stop.trackId = chosen.id;
      const w = windowOf(ev.stop, chosen);
      reserve(chosen.id, w.from, w.to);
    }
  }
}

// ---------------------------------------------------------------------------
// duty/autoAssign
// ---------------------------------------------------------------------------

interface Chain {
  legs: DutyLeg[];
  endSec: number;
  endStationId: StationId | undefined;
  cars: number;
}

/**
 * Chain trains into duties: A is followed by B when A terminates where B
 * originates and the gap clears that station's turnback minimum. Ties break
 * toward the *smallest* acceptable gap, which keeps a vehicle working rather
 * than parking it.
 */
export function autoAssignDuties(draft: ProjectDocument, dayTypeId: DayTypeId): void {
  for (const duty of entityList(draft.duties)) {
    if (duty.dayTypeIds.includes(dayTypeId)) removeEntity(draft.duties, duty.id);
  }

  const trains = entityList(draft.trains)
    .filter((t) => t.dayTypeIds.includes(dayTypeId))
    .filter((t) => trainStartSec(t) !== undefined)
    .sort((a, b) => (trainStartSec(a) ?? 0) - (trainStartSec(b) ?? 0) || a.id.localeCompare(b.id));

  const pools = new Map<number, Chain[]>();
  const fallbackTurnback = draft.validationConfig.defaultMinTurnbackSec;

  for (const train of trains) {
    const cars = train.minCars ?? 0;
    const pool = pools.get(cars) ?? [];
    const start = trainStartSec(train) ?? 0;
    const originId = trainOriginStationId(train);
    const endSec = lastTimeOf(train);

    let best: Chain | undefined;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const chain of pool) {
      if (chain.endStationId === undefined || chain.endStationId !== originId) continue;
      const station = getEntity(draft.stations, chain.endStationId);
      const required = station?.minTurnbackSec ?? fallbackTurnback;
      const gap = start - chain.endSec;
      if (gap < required) continue;
      if (gap < bestGap) {
        bestGap = gap;
        best = chain;
      }
    }

    if (best === undefined) {
      best = { legs: [], endSec: start, endStationId: originId, cars };
      pool.push(best);
    }
    best.legs.push({ kind: 'train', trainId: train.id });
    best.endSec = endSec;
    best.endStationId = trainTerminusStationId(train);
    pools.set(cars, pool);
  }

  const allChains: Chain[] = [];
  for (const pool of pools.values()) allChains.push(...pool);
  allChains.sort((a, b) => firstStartOf(draft, a) - firstStartOf(draft, b));

  allChains.forEach((chain, i) => {
    const duty: Duty = {
      id: newId<'Duty'>(ID_PREFIX.duty),
      code: String(i + 1).padStart(2, '0'),
      dayTypeIds: [dayTypeId],
      legs: chain.legs,
    };
    if (chain.cars > 0) duty.requiredCars = chain.cars;
    putEntity(draft.duties, duty);
  });
}

function lastTimeOf(train: Train): number {
  const last = train.stops[train.stops.length - 1];
  return last?.arr ?? last?.dep ?? 0;
}

function firstStartOf(draft: ProjectDocument, chain: Chain): number {
  const first = chain.legs[0];
  if (first === undefined) return 0;
  if (first.kind !== 'train') return first.from;
  const train = getEntity(draft.trains, first.trainId);
  return train === undefined ? 0 : (trainStartSec(train) ?? 0);
}

// ---------------------------------------------------------------------------
// assignment/autoFill
// ---------------------------------------------------------------------------

export function autoFillAssignments(draft: ProjectDocument, date: string): void {
  const dayTypeId = dayTypeOfDate(draft, date);
  if (dayTypeId === undefined) return;

  const onDate = entityList(draft.assignments).filter((a) => a.date === date);
  const usedFormations = new Set(onDate.map((a) => a.formationId));
  const coveredDuties = new Set(onDate.map((a) => a.dutyId));

  const duties = entityList(draft.duties)
    .filter((d) => d.dayTypeIds.includes(dayTypeId))
    .filter((d) => !coveredDuties.has(d.id))
    .sort((a, b) => a.code.localeCompare(b.code));

  const free = entityList(draft.formations).filter(
    (f) => f.status === 'active' && !usedFormations.has(f.id),
  );

  for (const duty of duties) {
    const i = free.findIndex((f) => {
      if (duty.requiredCars !== undefined && f.cars !== duty.requiredCars) return false;
      if (duty.requiredSeriesIds !== undefined && duty.requiredSeriesIds.length > 0) {
        return duty.requiredSeriesIds.includes(f.seriesId);
      }
      return true;
    });
    if (i < 0) continue;
    const formation = free.splice(i, 1)[0]!;
    const assignment: Assignment = {
      id: newId<'Assignment'>(ID_PREFIX.assignment),
      date,
      dutyId: duty.id,
      formationId: formation.id,
    };
    putEntity(draft.assignments, assignment);
  }
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

export function reduce(draft: ProjectDocument, cmd: Command): void {
  switch (cmd.type) {
    // -- whole document ----------------------------------------------------
    case 'project/replace': {
      const next = cmd.doc;
      const target = draft as unknown as Record<string, unknown>;
      const source = next as unknown as Record<string, unknown>;
      for (const key of Object.keys(source)) target[key] = source[key];
      return;
    }
    case 'project/setMeta':
      applyPatch(draft.meta, cmd.patch);
      return;
    case 'settings/update':
      applyPatch(draft.settings, cmd.patch);
      return;
    case 'validationConfig/update':
      applyPatch(draft.validationConfig, cmd.patch);
      return;
    case 'line/update':
      applyPatch(draft.line, cmd.patch);
      return;

    // -- infrastructure ----------------------------------------------------
    case 'station/add': {
      const station: Station = { ...cmd.station, trackIds: [...cmd.station.trackIds] };
      for (const track of cmd.tracks ?? []) {
        putEntity(draft.stationTracks, track);
        if (!station.trackIds.includes(track.id)) station.trackIds.push(track.id);
      }
      putEntity(draft.stations, station);
      refreshLinks(draft);
      return;
    }
    case 'station/update': {
      const station = getEntity(draft.stations, cmd.id);
      if (station === undefined) return;
      applyPatch(station, cmd.patch);
      if (cmd.patch.kmFromOrigin !== undefined || cmd.patch.kind !== undefined) {
        refreshLinks(draft);
      }
      return;
    }
    case 'station/remove': {
      const station = getEntity(draft.stations, cmd.id);
      if (station === undefined) return;
      for (const trackId of [...station.trackIds]) {
        removeEntity(draft.stationTracks, trackId);
      }
      for (const track of entityList(draft.stationTracks)) {
        if (track.stationId === cmd.id) removeEntity(draft.stationTracks, track.id);
      }
      removeEntity(draft.stations, cmd.id);
      for (const train of entityList(draft.trains)) {
        const before = train.stops.length;
        train.stops = train.stops.filter((s) => s.stationId !== cmd.id);
        if (train.stops.length !== before) normalizeEndpoints(train);
      }
      for (const pattern of entityList(draft.stopPatterns)) {
        delete pattern.entries[cmd.id];
        if (pattern.dwellOverrideSec) delete pattern.dwellOverrideSec[cmd.id];
      }
      for (const link of entityList(draft.links)) {
        if (link.fromStationId === cmd.id || link.toStationId === cmd.id) {
          removeEntity(draft.links, link.id);
          draft.linkRunTimes = draft.linkRunTimes.filter((rt) => rt.linkId !== link.id);
        }
      }
      refreshLinks(draft);
      return;
    }
    case 'station/reorderByKm': {
      const order = entityList(draft.stations)
        .slice()
        .sort((a, b) => a.kmFromOrigin - b.kmFromOrigin || a.id.localeCompare(b.id))
        .map((s) => s.id);
      draft.stations.allIds = order;
      refreshLinks(draft);
      return;
    }
    case 'track/add': {
      putEntity(draft.stationTracks, cmd.track);
      const station = getEntity(draft.stations, cmd.track.stationId);
      if (station !== undefined && !station.trackIds.includes(cmd.track.id)) {
        const at = cmd.atIndex;
        if (at === undefined || at < 0 || at >= station.trackIds.length) {
          station.trackIds.push(cmd.track.id);
        } else {
          station.trackIds.splice(at, 0, cmd.track.id);
        }
        if (station.defaultTrackId.down === undefined && cmd.track.directions.includes('down')) {
          station.defaultTrackId.down = cmd.track.id;
        }
        if (station.defaultTrackId.up === undefined && cmd.track.directions.includes('up')) {
          station.defaultTrackId.up = cmd.track.id;
        }
      }
      return;
    }
    case 'track/update': {
      const track = getEntity(draft.stationTracks, cmd.id);
      if (track === undefined) return;
      applyPatch(track, cmd.patch);
      return;
    }
    case 'track/remove': {
      if (getEntity(draft.stationTracks, cmd.id) === undefined) return;
      removeTrackReferences(draft, cmd.id);
      removeEntity(draft.stationTracks, cmd.id);
      return;
    }
    case 'link/update': {
      const link = getEntity(draft.links, cmd.id);
      if (link === undefined) return;
      applyPatch(link, cmd.patch);
      return;
    }
    case 'link/rebuild':
      refreshLinks(draft);
      return;
    case 'runTime/set': {
      const existing = draft.linkRunTimes.find(
        (rt) => rt.linkId === cmd.linkId && rt.profileId === cmd.profileId,
      );
      if (existing !== undefined) {
        existing.baseRunSec = cmd.baseRunSec;
        existing.startPenaltySec = cmd.startPenaltySec;
        existing.stopPenaltySec = cmd.stopPenaltySec;
        return;
      }
      draft.linkRunTimes.push({
        linkId: cmd.linkId,
        profileId: cmd.profileId,
        baseRunSec: cmd.baseRunSec,
        startPenaltySec: cmd.startPenaltySec,
        stopPenaltySec: cmd.stopPenaltySec,
      });
      return;
    }
    case 'perfProfile/add':
      putEntity(draft.perfProfiles, cmd.profile);
      return;
    case 'perfProfile/update': {
      const profile = getEntity(draft.perfProfiles, cmd.id);
      if (profile === undefined) return;
      applyPatch(profile, cmd.patch);
      return;
    }
    case 'perfProfile/remove':
      removeEntity(draft.perfProfiles, cmd.id);
      draft.linkRunTimes = draft.linkRunTimes.filter((rt) => rt.profileId !== cmd.id);
      return;
    case 'depot/add': {
      putEntity(draft.stations, { ...cmd.station, trackIds: [...cmd.station.trackIds] });
      const station = getEntity(draft.stations, cmd.station.id);
      for (const track of cmd.tracks) {
        putEntity(draft.stationTracks, track);
        if (station !== undefined && !station.trackIds.includes(track.id)) {
          station.trackIds.push(track.id);
        }
      }
      putEntity(draft.depots, cmd.depot);
      const attached = getEntity(draft.stations, cmd.depot.attachedStationId);
      if (attached !== undefined && buildLinkLookup(draft).between(cmd.station.id, attached.id) === undefined) {
        const lower = cmd.station.kmFromOrigin <= attached.kmFromOrigin ? cmd.station : attached;
        const upper = lower === attached ? cmd.station : attached;
        const link: Link = {
          id: newId<'Link'>(ID_PREFIX.link),
          fromStationId: lower.id,
          toStationId: upper.id,
          distance: Math.abs(upper.kmFromOrigin - lower.kmFromOrigin),
          trackCount: 1,
          minHeadwaySec: draft.validationConfig.defaultMinHeadwaySec,
          maxSpeedKmh: 45,
        };
        putEntity(draft.links, link);
      }
      return;
    }
    case 'depot/update': {
      const depot = getEntity(draft.depots, cmd.id);
      if (depot === undefined) return;
      applyPatch(depot, cmd.patch);
      return;
    }
    case 'depot/remove': {
      const depot = getEntity(draft.depots, cmd.id);
      if (depot === undefined) return;
      const stationId = depot.stationId;
      removeEntity(draft.depots, cmd.id);
      for (const track of entityList(draft.stationTracks)) {
        if (track.stationId === stationId) {
          removeTrackReferences(draft, track.id);
          removeEntity(draft.stationTracks, track.id);
        }
      }
      removeEntity(draft.stations, stationId);
      for (const link of entityList(draft.links)) {
        if (link.fromStationId === stationId || link.toStationId === stationId) {
          removeEntity(draft.links, link.id);
          draft.linkRunTimes = draft.linkRunTimes.filter((rt) => rt.linkId !== link.id);
        }
      }
      return;
    }

    // -- service definition ------------------------------------------------
    case 'trainType/add':
      putEntity(draft.trainTypes, cmd.trainType);
      return;
    case 'trainType/update': {
      const type = getEntity(draft.trainTypes, cmd.id);
      if (type === undefined) return;
      applyPatch(type, cmd.patch);
      return;
    }
    case 'trainType/remove':
      removeEntity(draft.trainTypes, cmd.id);
      return;
    case 'stopPattern/add':
      putEntity(draft.stopPatterns, cmd.pattern);
      return;
    case 'stopPattern/update': {
      const pattern = getEntity(draft.stopPatterns, cmd.id);
      if (pattern === undefined) return;
      applyPatch(pattern, cmd.patch);
      return;
    }
    case 'stopPattern/setEntry': {
      const pattern = getEntity(draft.stopPatterns, cmd.patternId);
      if (pattern === undefined) return;
      if (cmd.kind === 'none') delete pattern.entries[cmd.stationId];
      else pattern.entries[cmd.stationId] = cmd.kind;
      return;
    }
    case 'stopPattern/remove': {
      removeEntity(draft.stopPatterns, cmd.id);
      for (const type of entityList(draft.trainTypes)) {
        if (type.defaultStopPatternId === cmd.id) delete type.defaultStopPatternId;
      }
      for (const train of entityList(draft.trains)) {
        if (train.patternId === cmd.id) delete train.patternId;
      }
      return;
    }

    // -- trains ------------------------------------------------------------
    case 'train/add':
      putEntity(draft.trains, cmd.train);
      return;
    case 'train/addMany':
      for (const train of cmd.trains) putEntity(draft.trains, train);
      return;
    case 'train/update': {
      const train = getEntity(draft.trains, cmd.id);
      if (train === undefined) return;
      applyPatch(train as Omit<Train, 'stops'>, cmd.patch);
      return;
    }
    case 'train/setStopTime': {
      const stop = getEntity(draft.trains, cmd.trainId)?.stops[cmd.stopIndex];
      if (stop === undefined) return;
      setOrDelete(stop, cmd.field, cmd.value);
      return;
    }
    case 'train/setStopTrack': {
      const stop = getEntity(draft.trains, cmd.trainId)?.stops[cmd.stopIndex];
      if (stop === undefined) return;
      setOrDelete(stop, 'trackId', cmd.trackId);
      return;
    }
    case 'train/setStopKind': {
      const stop = getEntity(draft.trains, cmd.trainId)?.stops[cmd.stopIndex];
      if (stop === undefined) return;
      stop.kind = cmd.kind;
      return;
    }
    case 'train/setStopFlags': {
      const stop = getEntity(draft.trains, cmd.trainId)?.stops[cmd.stopIndex];
      if (stop === undefined) return;
      if ('operational' in cmd) setOrDelete(stop, 'operational', cmd.operational);
      if ('note' in cmd) setOrDelete(stop, 'note', cmd.note);
      return;
    }
    case 'train/setOvertakenBy': {
      const stop = getEntity(draft.trains, cmd.trainId)?.stops[cmd.stopIndex];
      if (stop === undefined) return;
      if (cmd.trainIds.length === 0) delete stop.overtakenBy;
      else stop.overtakenBy = [...cmd.trainIds];
      return;
    }
    case 'train/setConnectsTo': {
      const stop = getEntity(draft.trains, cmd.trainId)?.stops[cmd.stopIndex];
      if (stop === undefined) return;
      if (cmd.trainIds.length === 0) delete stop.connectsTo;
      else stop.connectsTo = [...cmd.trainIds];
      return;
    }
    case 'train/shift': {
      for (const id of cmd.trainIds) {
        const train = getEntity(draft.trains, id);
        if (train === undefined) continue;
        for (const stop of train.stops) {
          if (stop.arr !== undefined) stop.arr += cmd.deltaSec;
          if (stop.dep !== undefined) stop.dep += cmd.deltaSec;
        }
      }
      return;
    }
    case 'train/recomputeTimes': {
      const train = getEntity(draft.trains, cmd.trainId);
      if (train === undefined) return;
      recomputeTrainTimes(draft, train);
      return;
    }
    case 'train/remove': {
      const ids = new Set<string>(cmd.trainIds);
      for (const id of cmd.trainIds) removeEntity(draft.trains, id);
      removeTrainReferences(draft, ids);
      return;
    }
    case 'train/autoAssignTracks':
      autoAssignTracks(draft, cmd.trainIds);
      return;

    // -- duties ------------------------------------------------------------
    case 'duty/add':
      putEntity(draft.duties, cmd.duty);
      return;
    case 'duty/addMany':
      for (const duty of cmd.duties) putEntity(draft.duties, duty);
      return;
    case 'duty/update': {
      const duty = getEntity(draft.duties, cmd.id);
      if (duty === undefined) return;
      applyPatch(duty as Omit<Duty, 'legs'>, cmd.patch);
      return;
    }
    case 'duty/insertLeg': {
      const duty = getEntity(draft.duties, cmd.dutyId);
      if (duty === undefined) return;
      const at = cmd.atIndex;
      if (at === undefined || at < 0 || at >= duty.legs.length) duty.legs.push(cmd.leg);
      else duty.legs.splice(at, 0, cmd.leg);
      return;
    }
    case 'duty/removeLeg': {
      const duty = getEntity(draft.duties, cmd.dutyId);
      if (duty === undefined) return;
      if (cmd.legIndex < 0 || cmd.legIndex >= duty.legs.length) return;
      duty.legs.splice(cmd.legIndex, 1);
      return;
    }
    case 'duty/reorderLegs': {
      const duty = getEntity(draft.duties, cmd.dutyId);
      if (duty === undefined) return;
      const next: DutyLeg[] = [];
      for (const i of cmd.order) {
        const leg = duty.legs[i];
        if (leg !== undefined) next.push(leg);
      }
      if (next.length !== duty.legs.length) return;
      duty.legs = next;
      return;
    }
    case 'duty/sortLegsByTime': {
      const duty = getEntity(draft.duties, cmd.dutyId);
      if (duty === undefined) return;
      const startOf = (leg: DutyLeg): number => {
        if (leg.kind !== 'train') return leg.from;
        const train = getEntity(draft.trains, leg.trainId);
        return train === undefined ? Number.POSITIVE_INFINITY : (trainStartSec(train) ?? 0);
      };
      duty.legs = duty.legs.slice().sort((a, b) => startOf(a) - startOf(b));
      return;
    }
    case 'duty/remove': {
      const ids = new Set<string>(cmd.dutyIds);
      for (const id of cmd.dutyIds) removeEntity(draft.duties, id);
      for (const assignment of entityList(draft.assignments)) {
        if (ids.has(assignment.dutyId)) removeEntity(draft.assignments, assignment.id);
      }
      return;
    }
    case 'duty/autoAssign':
      autoAssignDuties(draft, cmd.dayTypeId);
      return;

    // -- rolling stock -----------------------------------------------------
    case 'series/add':
      putEntity(draft.formationSeries, cmd.series);
      return;
    case 'series/update': {
      const series = getEntity(draft.formationSeries, cmd.id);
      if (series === undefined) return;
      applyPatch(series, cmd.patch);
      return;
    }
    case 'series/remove':
      removeEntity(draft.formationSeries, cmd.id);
      return;
    case 'formation/add':
      putEntity(draft.formations, cmd.formation);
      return;
    case 'formation/update': {
      const formation = getEntity(draft.formations, cmd.id);
      if (formation === undefined) return;
      applyPatch(formation, cmd.patch);
      return;
    }
    case 'formation/remove': {
      removeEntity(draft.formations, cmd.id);
      for (const assignment of entityList(draft.assignments)) {
        if (assignment.formationId === cmd.id) removeEntity(draft.assignments, assignment.id);
      }
      for (const record of entityList(draft.inspectionRecords)) {
        if (record.formationId === cmd.id) removeEntity(draft.inspectionRecords, record.id);
      }
      return;
    }
    case 'assignment/set': {
      for (const assignment of entityList(draft.assignments)) {
        if (assignment.date === cmd.date && assignment.dutyId === cmd.dutyId && assignment.id !== cmd.id) {
          removeEntity(draft.assignments, assignment.id);
        }
      }
      putEntity(draft.assignments, {
        id: cmd.id,
        date: cmd.date,
        dutyId: cmd.dutyId,
        formationId: cmd.formationId,
      });
      return;
    }
    case 'assignment/clear': {
      for (const assignment of entityList(draft.assignments)) {
        if (assignment.date === cmd.date && assignment.dutyId === cmd.dutyId) {
          removeEntity(draft.assignments, assignment.id);
        }
      }
      return;
    }
    case 'assignment/autoFill':
      autoFillAssignments(draft, cmd.date);
      return;

    // -- inspections -------------------------------------------------------
    case 'inspectionRule/add':
      putEntity(draft.inspectionRules, cmd.rule);
      return;
    case 'inspectionRule/update': {
      const rule = getEntity(draft.inspectionRules, cmd.id);
      if (rule === undefined) return;
      applyPatch(rule, cmd.patch);
      return;
    }
    case 'inspectionRule/remove':
      removeEntity(draft.inspectionRules, cmd.id);
      return;
    case 'inspectionRecord/add':
      putEntity(draft.inspectionRecords, cmd.record);
      return;
    case 'inspectionRecord/update': {
      const record = getEntity(draft.inspectionRecords, cmd.id);
      if (record === undefined) return;
      applyPatch(record, cmd.patch);
      return;
    }
    case 'inspectionRecord/remove':
      removeEntity(draft.inspectionRecords, cmd.id);
      return;

    // -- calendar ----------------------------------------------------------
    case 'dayType/add':
      putEntity(draft.dayTypes, cmd.dayType);
      return;
    case 'dayType/update': {
      const dayType = getEntity(draft.dayTypes, cmd.id);
      if (dayType === undefined) return;
      applyPatch(dayType, cmd.patch);
      return;
    }
    case 'dayType/remove': {
      removeEntity(draft.dayTypes, cmd.id);
      draft.calendar = draft.calendar.filter((c) => c.dayTypeId !== cmd.id);
      return;
    }
    case 'calendar/set': {
      const existing = draft.calendar.find((c) => c.date === cmd.date);
      if (existing !== undefined) existing.dayTypeId = cmd.dayTypeId;
      else draft.calendar.push({ date: cmd.date, dayTypeId: cmd.dayTypeId });
      return;
    }

    default: {
      const exhaustive: never = cmd;
      throw new Error(`未対応のコマンドです: ${JSON.stringify(exhaustive)}`);
    }
  }
}
