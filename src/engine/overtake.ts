/**
 * Overtake and connection detection.
 *
 * Overtake detection is the backbone of the 緩急接続 feature: it sets
 * `TrainEvent.isOvertakeWait` (which produces the 待避中 phase in the line
 * view) and feeds three validation rules.
 */

import type { StationId, TrainId } from '@/domain/ids';
import type { Direction, ProjectDocument } from '@/domain/model';
import { stationKmMap, tracksOfStation } from '@/domain/project';
import type { Sec } from '@/domain/units';
import type { ConnectionEvent, OvertakeEvent, TrainEvent, TrainTimeline } from './types';

interface StationVisit {
  tl: TrainTimeline;
  event: TrainEvent;
}

/**
 * Position along the direction of travel: increasing as the train advances.
 * Lets "before S" / "after S" be a plain numeric comparison for both senses.
 */
function orderKey(km: number, direction: Direction): number {
  return direction === 'down' ? km : -km;
}

function visitsByStation(
  timelines: Map<TrainId, TrainTimeline>,
): Map<StationId, StationVisit[]> {
  const map = new Map<StationId, StationVisit[]>();
  for (const tl of timelines.values()) {
    for (const event of tl.events) {
      const list = map.get(event.stationId);
      if (list) list.push({ tl, event });
      else map.set(event.stationId, [{ tl, event }]);
    }
  }
  return map;
}

/** trainId -> (stationId -> the moment it is there). */
function timesByTrain(
  timelines: Map<TrainId, TrainTimeline>,
): Map<TrainId, Map<StationId, Sec>> {
  const map = new Map<TrainId, Map<StationId, Sec>>();
  for (const tl of timelines.values()) {
    const inner = new Map<StationId, Sec>();
    for (const event of tl.events) inner.set(event.stationId, event.at);
    map.set(tl.trainId, inner);
  }
  return map;
}

export function detectOvertakes(
  doc: ProjectDocument,
  timelines: Map<TrainId, TrainTimeline>,
): OvertakeEvent[] {
  const kms = stationKmMap(doc);
  const byStation = visitsByStation(timelines);
  const times = timesByTrain(timelines);
  const out: OvertakeEvent[] = [];

  for (const [stationId, visits] of byStation) {
    const stationKm = kms.get(stationId);
    if (stationKm === undefined) continue;

    for (const waiting of visits) {
      const arr = waiting.event.arr;
      const dep = waiting.event.dep;
      // Only a train that actually stands here can be passed.
      if (arr === undefined || dep === undefined || dep <= arr) continue;
      const direction = waiting.tl.direction;

      for (const passing of visits) {
        if (passing.tl.trainId === waiting.tl.trainId) continue;
        if (passing.tl.direction !== direction) continue;
        const passAt = passing.event.at;
        if (!(passAt > arr && passAt < dep)) continue;

        // The pass is only real if the relative order flips around S.
        const aTimes = times.get(waiting.tl.trainId);
        const bTimes = times.get(passing.tl.trainId);
        if (!aTimes || !bTimes) continue;
        const here = orderKey(stationKm, direction);
        let prev: StationId | undefined;
        let next: StationId | undefined;
        let prevKey = Number.NEGATIVE_INFINITY;
        let nextKey = Number.POSITIVE_INFINITY;
        for (const sid of aTimes.keys()) {
          if (!bTimes.has(sid) || sid === stationId) continue;
          const k = orderKey(kms.get(sid) ?? 0, direction);
          if (k < here && k > prevKey) {
            prevKey = k;
            prev = sid;
          }
          if (k > here && k < nextKey) {
            nextKey = k;
            next = sid;
          }
        }
        const behindBefore =
          prev === undefined ? undefined : (bTimes.get(prev) ?? 0) > (aTimes.get(prev) ?? 0);
        const aheadAfter =
          next === undefined ? undefined : (bTimes.get(next) ?? 0) < (aTimes.get(next) ?? 0);
        if (behindBefore === false || aheadAfter === false) continue;
        if (behindBefore === undefined && aheadAfter === undefined) continue;

        const stop = waiting.tl.train.stops[waiting.event.stopIndex];
        const declared = (stop?.overtakenBy ?? []).includes(passing.tl.trainId);

        const tracks = tracksOfStation(doc, stationId);
        const capable = tracks.filter(
          (t) => t.canBeOvertaken && t.directions.includes(direction),
        );
        const assigned =
          waiting.event.trackId === undefined
            ? undefined
            : doc.stationTracks.byId[waiting.event.trackId];

        const ev: OvertakeEvent = {
          stationId,
          direction,
          waitingTrainId: waiting.tl.trainId,
          passingTrainId: passing.tl.trainId,
          waitArr: arr,
          passAt,
          waitDep: dep,
          declared,
          legal: true,
        };
        if (capable.length === 0) {
          ev.legal = false;
          ev.reason = 'noPassingTrack';
        } else if (assigned !== undefined && assigned.canBeOvertaken === false) {
          ev.legal = false;
          ev.reason = 'trackNotOvertakeCapable';
        }
        out.push(ev);
      }
    }
  }

  out.sort(
    (a, b) =>
      a.passAt - b.passAt ||
      a.waitingTrainId.localeCompare(b.waitingTrainId) ||
      a.passingTrainId.localeCompare(b.passingTrainId),
  );
  return out;
}

/** Stops still to come after `stationId`, in travel order. */
function remainingStops(tl: TrainTimeline, stationId: StationId): number {
  const at = tl.events.findIndex((e) => e.stationId === stationId);
  if (at < 0) return 0;
  let n = 0;
  for (let i = at + 1; i < tl.events.length; i++) {
    if (tl.events[i]!.kind === 'stop') n++;
  }
  return n;
}

/** Does `b` run through anywhere `a` calls at? That makes it the faster train. */
function skipsStopsOf(b: TrainTimeline, a: TrainTimeline): boolean {
  const aStops = new Set<StationId>();
  for (const e of a.events) if (e.kind === 'stop') aStops.add(e.stationId);
  return b.events.some((e) => e.kind === 'pass' && aStops.has(e.stationId));
}

/**
 * 緩急接続 is a transfer from a slower product to a faster one. Two conditions
 * have to hold and both were missing:
 *
 * - **The target must stop.** A 通過 cannot be boarded. 上野毛 is the case that
 *   made this visible: the 急行 runs through, so a 各停 standing there has
 *   nothing to change to however long it waits.
 * - **The target must actually be faster.** 各停 → 各停 of the same product is
 *   not a connection, it is two trains at the same platform. `remainingStops`
 *   is the operative measure of "faster from here": fewer calls left means an
 *   earlier arrival at every station both of them serve.
 */
function isTransferTarget(
  stationId: StationId,
  from: StationVisit,
  to: StationVisit,
): boolean {
  if (to.event.kind !== 'stop') return false;
  const leftForTo = remainingStops(to.tl, stationId);
  if (leftForTo === 0) return false;
  if (leftForTo < remainingStops(from.tl, stationId)) return true;
  return to.tl.typeId !== from.tl.typeId && skipsStopsOf(to.tl, from.tl);
}

export function detectConnections(
  doc: ProjectDocument,
  timelines: Map<TrainId, TrainTimeline>,
  overtakes: OvertakeEvent[],
): ConnectionEvent[] {
  const cfg = doc.validationConfig;
  const byStation = visitsByStation(timelines);
  const out: ConnectionEvent[] = [];
  const seen = new Set<string>();

  const isPassenger = (tl: TrainTimeline): boolean =>
    doc.trainTypes.byId[tl.typeId]?.isPassengerService !== false;

  const add = (
    stationId: StationId,
    from: StationVisit,
    to: StationVisit,
  ): void => {
    const key = `${stationId}|${from.tl.trainId}|${to.tl.trainId}`;
    if (seen.has(key)) return;
    const arrA = from.event.arr ?? from.event.at;
    const depB = to.event.dep ?? to.event.at;
    const transferSec = depB - arrA;
    const stop = from.tl.train.stops[from.event.stopIndex];
    seen.add(key);
    const event: ConnectionEvent = {
      stationId,
      direction: from.tl.direction,
      fromTrainId: from.tl.trainId,
      toTrainId: to.tl.trainId,
      transferSec,
      declared: (stop?.connectsTo ?? []).includes(to.tl.trainId),
      viable: false,
    };
    if (to.event.kind !== 'stop') {
      event.blockedReason = 'targetDoesNotStop';
    } else if (!isTransferTarget(stationId, from, to)) {
      event.blockedReason = 'targetNotFaster';
    } else {
      event.viable =
        transferSec >= cfg.connectionMinTransferSec &&
        transferSec <= cfg.connectionMaxWaitSec;
    }
    out.push(event);
  };

  /**
   * A transfer is only interesting inside the wait window, so the candidate
   * search is bounded by it instead of scanning every later departure at the
   * station. Sorting the visits by departure once per station turns the pair
   * search from O(visits²) into O(visits · candidates-in-window); at ~500
   * visits per station that is ~45k pair evaluations down to a few hundred.
   *
   * Declared connections are added separately below, so bounding the window
   * here cannot turn a declared-but-too-slow transfer into a phantom
   * "the two trains were never both here" report.
   */
  for (const [stationId, visits] of byStation) {
    const station = doc.stations.byId[stationId];
    if (!station?.isConnectionPoint) continue;

    const byDeparture = [...visits].sort(
      (a, b) =>
        (a.event.dep ?? a.event.at) - (b.event.dep ?? b.event.at) ||
        a.tl.trainId.localeCompare(b.tl.trainId),
    );
    const departures = byDeparture.map((v) => v.event.dep ?? v.event.at);

    for (const from of visits) {
      if (from.event.kind !== 'stop') continue;
      if (!isPassenger(from.tl)) continue;
      const arrA = from.event.arr ?? from.event.at;
      const until = arrA + cfg.connectionMaxWaitSec;

      // First candidate departing at or after this train arrives.
      let lo = 0;
      let hi = departures.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (departures[mid]! < arrA) lo = mid + 1;
        else hi = mid;
      }

      for (let i = lo; i < byDeparture.length && departures[i]! <= until; i++) {
        const to = byDeparture[i]!;
        if (to.tl.trainId === from.tl.trainId) continue;
        if (to.tl.direction !== from.tl.direction) continue;
        if (!isPassenger(to.tl)) continue;
        if (!isTransferTarget(stationId, from, to)) continue;
        add(stationId, from, to);
      }
    }
  }

  // An overtake at a connection point is a candidate transfer *when the train
  // doing the passing stops*: the local is standing there and the express
  // pulls in alongside. Where the express runs straight through — 上野毛, where
  // it does not call at all — the 待避 is a spacing move and no passenger can
  // use it, which is exactly what `isTransferTarget` refuses.
  for (const ot of overtakes) {
    const station = doc.stations.byId[ot.stationId];
    if (!station?.isConnectionPoint) continue;
    const visits = byStation.get(ot.stationId);
    if (!visits) continue;
    const from = visits.find((v) => v.tl.trainId === ot.waitingTrainId);
    const to = visits.find((v) => v.tl.trainId === ot.passingTrainId);
    if (!from || !to) continue;
    if (!isPassenger(from.tl) || !isPassenger(to.tl)) continue;
    if (!isTransferTarget(ot.stationId, from, to)) continue;
    add(ot.stationId, from, to);
  }

  // Declared transfers are always evaluated, in or out of the window: it is
  // `connection.declaredFails`' job to say whether a declaration holds, and it
  // needs the measured `transferSec` to say *why* it does not.
  for (const [stationId, visits] of byStation) {
    const byTrain = new Map(visits.map((v) => [v.tl.trainId, v]));
    for (const from of visits) {
      const stop = from.tl.train.stops[from.event.stopIndex];
      for (const toTrainId of stop?.connectsTo ?? []) {
        const to = byTrain.get(toTrainId);
        if (to === undefined) continue;
        add(stationId, from, to);
      }
    }
  }

  out.sort(
    (a, b) =>
      a.transferSec - b.transferSec ||
      a.fromTrainId.localeCompare(b.fromTrainId) ||
      a.toTrainId.localeCompare(b.toTrainId),
  );
  return out;
}
