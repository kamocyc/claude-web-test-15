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
    out.push({
      stationId,
      direction: from.tl.direction,
      fromTrainId: from.tl.trainId,
      toTrainId: to.tl.trainId,
      transferSec,
      declared: (stop?.connectsTo ?? []).includes(to.tl.trainId),
      viable:
        transferSec >= cfg.connectionMinTransferSec &&
        transferSec <= cfg.connectionMaxWaitSec,
    });
  };

  for (const [stationId, visits] of byStation) {
    const station = doc.stations.byId[stationId];
    if (!station?.isConnectionPoint) continue;

    for (const from of visits) {
      if (from.event.kind !== 'stop') continue;
      if (!isPassenger(from.tl)) continue;
      const arrA = from.event.arr ?? from.event.at;

      for (const to of visits) {
        if (to.tl.trainId === from.tl.trainId) continue;
        if (to.tl.direction !== from.tl.direction) continue;
        if (!isPassenger(to.tl)) continue;
        const depB = to.event.dep ?? to.event.at;
        if (depB < arrA) continue;
        // B must still be going somewhere beyond this station.
        if (remainingStops(to.tl, stationId) === 0) continue;
        const faster =
          remainingStops(to.tl, stationId) < remainingStops(from.tl, stationId) ||
          (to.tl.typeId !== from.tl.typeId && skipsStopsOf(to.tl, from.tl));
        if (!faster) continue;
        add(stationId, from, to);
      }
    }
  }

  // Every overtake at a connection point is, by construction, a candidate
  // transfer: the local is standing there while the express goes through.
  for (const ot of overtakes) {
    const station = doc.stations.byId[ot.stationId];
    if (!station?.isConnectionPoint) continue;
    const visits = byStation.get(ot.stationId);
    if (!visits) continue;
    const from = visits.find((v) => v.tl.trainId === ot.waitingTrainId);
    const to = visits.find((v) => v.tl.trainId === ot.passingTrainId);
    if (!from || !to) continue;
    if (!isPassenger(from.tl) || !isPassenger(to.tl)) continue;
    add(ot.stationId, from, to);
  }

  out.sort(
    (a, b) =>
      a.transferSec - b.transferSec ||
      a.fromTrainId.localeCompare(b.fromTrainId) ||
      a.toTrainId.localeCompare(b.toTrainId),
  );
  return out;
}
