/**
 * 番線 assignment — the 構内ダイヤ — and the path-finding hook the 回送 need.
 *
 * Service trains are placed first, station by station in time order, with
 * three hard rules layered on top of "prefer the default platform, fall back to
 * the first free permitted one":
 *
 *   1. **待避.** A train marked as waiting to be overtaken must stand on a
 *      `canBeOvertaken` track, and the train doing the passing must be on the
 *      through track. Otherwise the two would be on the same rails and the
 *      overtake is a fiction.
 *   2. **方向別複々線.** In the 二子玉川〜溝の口 section the 青各停 belongs on
 *      the 田園都市線 (outer) pair — those are the only tracks with a platform
 *      at 二子新地 and 高津 — while 急行 and 緑各停 stay on the 大井町線 (inner)
 *      pair, which has no platform there at all.
 *   3. **Platform.** A passenger stop may not be booked on a 通過線.
 *
 * Greedy is sufficient for the service trains because they come from a
 * repeating cycle: within a station the events arrive in a near-periodic order,
 * so first-fit is also the choice a planner would make.
 *
 * 回送 are different. They are not part of the cycle, so they have to be
 * *pathed into the gaps* the cycle leaves — which is exactly what a real
 * planner does with empty stock. `tryPlace` is therefore atomic: it either
 * books every stop of one 回送 or books none of them, so the caller can walk a
 * 回送's departure time backwards (出庫) or forwards (入庫) until it fits.
 *
 * `tryPlace` also enforces a minimum 続行時隔 against every train already
 * placed, at every intermediate station of the 回送's route. That single check
 * does double duty: it keeps the 回送 out of the block behind a service train,
 * and — because a station is only ~60 s from its neighbour, while the check
 * demands a much larger gap at *every* station — it also makes it impossible
 * for a 回送 to slide past a service train in mid-section. Overtaking requires
 * the gap to pass through zero, and it cannot do that between two stations
 * without failing the check at one of them.
 */

import type { StationId, StationTrackId, TrainId } from '@/domain/ids';
import type { Direction, StationTrack, TrainStop } from '@/domain/model';
import { intervalsOverlap } from '@/domain/time';
import type { Sec } from '@/domain/units';
import { SeedError } from '../errors';
import type { Facts, StationKey } from '../oimachi/facts';

/** Which pair of rails the train uses in the 二子玉川〜溝の口 quad section. */
export type Routing = 'om' | 'dt';

export interface AssignableTrain {
  trainId: TrainId;
  /** Human label used in error messages: '各青 5301'. */
  label: string;
  direction: Direction;
  cars: number;
  routing: Routing;
  isPassenger: boolean;
  /** 入庫回送 leaving 溝の口: berth it on a 引上線 if one is free. */
  preferStablingAtOrigin: boolean;
  stops: TrainStop[];
}

/** Stations where the inner/outer pair actually has to be chosen. */
const QUAD_SECTION: readonly StationKey[] = ['futakoshinchi', 'takatsu', 'mizonokuchi'];

interface Event {
  train: AssignableTrain;
  stopIndex: number;
  t0: Sec;
  t1: Sec;
  mustWait: boolean;
  mustPass: boolean;
}

export class TrackBooking {
  private readonly occupancy = new Map<StationTrackId, Array<[Sec, Sec]>>();
  /** `${stationId}|${direction}` -> sorted line-occupation instants. */
  private readonly headway = new Map<string, Sec[]>();
  /** `${stationId}|${trainId}` for trains that must be on a through track. */
  private mustPass = new Set<string>();
  fallbacks = 0;

  constructor(private readonly facts: Facts) {
    for (const track of facts.tracks) this.occupancy.set(track.id, []);
  }

  /**
   * Place a whole fleet of service trains: per station, in time order. The
   * `mustPass` index is derived from the waiting trains' `overtakenBy`, so the
   * two sides of an overtake can never disagree.
   */
  placeSweep(trains: readonly AssignableTrain[]): void {
    this.mustPass = new Set<string>();
    for (const train of trains) {
      for (const stop of train.stops) {
        for (const other of stop.overtakenBy ?? []) {
          this.mustPass.add(`${stop.stationId}|${other}`);
        }
      }
    }

    const byStation = new Map<StationId, Event[]>();
    for (const train of trains) {
      for (const ev of eventsOf(train, this.mustPass)) {
        const list = byStation.get(train.stops[ev.stopIndex]!.stationId) ?? [];
        list.push(ev);
        byStation.set(train.stops[ev.stopIndex]!.stationId, list);
      }
    }

    for (const station of this.facts.stations) {
      const events = byStation.get(station.id);
      if (events === undefined) continue;
      events.sort((a, b) => a.t0 - b.t0 || a.train.trainId.localeCompare(b.train.trainId));
      for (const ev of events) {
        const chosen = this.pick(station.id, ev);
        if (chosen === undefined) {
          throw new SeedError('番線を割り当てられません', {
            station: station.name,
            train: ev.train.label,
            window: `${ev.t0}-${ev.t1}`,
          });
        }
        this.commit(station.id, ev, chosen);
      }
    }
  }

  /**
   * Atomically book every stop of one train, or nothing. Used to path 回送 into
   * the gaps the service pattern leaves.
   */
  tryPlace(train: AssignableTrain, minHeadwaySec: number): boolean {
    const events = eventsOf(train, this.mustPass);
    const booked: Array<{ stationId: StationId; ev: Event; track: StationTrack }> = [];

    for (const ev of events) {
      const stationId = train.stops[ev.stopIndex]!.stationId;
      const isIntermediate = ev.stopIndex > 0 && ev.stopIndex < train.stops.length - 1;
      if (isIntermediate && !this.headwayOk(stationId, train.direction, ev.t0, minHeadwaySec)) {
        return false;
      }
      const track = this.pick(stationId, ev, booked);
      if (track === undefined) return false;
      booked.push({ stationId, ev, track });
    }

    for (const b of booked) this.commit(b.stationId, b.ev, b.track);
    return true;
  }

  private headwayOk(stationId: StationId, direction: Direction, at: Sec, minSec: number): boolean {
    const list = this.headway.get(`${stationId}|${direction}`);
    if (list === undefined) return true;
    // Linear scan from the binary-search insertion point.
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]! < at) lo = mid + 1;
      else hi = mid;
    }
    const before = list[lo - 1];
    const after = list[lo];
    if (before !== undefined && at - before < minSec) return false;
    if (after !== undefined && after - at < minSec) return false;
    return true;
  }

  private pick(
    stationId: StationId,
    ev: Event,
    pending: ReadonlyArray<{ stationId: StationId; ev: Event; track: StationTrack }> = [],
  ): StationTrack | undefined {
    const tracks = this.facts.tracksOf.get(stationId) ?? [];
    for (const track of preferenceOrder(this.facts, stationId, tracks, ev)) {
      const from = ev.t0 - track.approachSec;
      const to = ev.t1 + track.clearSec;
      const busy = this.occupancy.get(track.id) ?? [];
      if (busy.some(([f, t]) => intervalsOverlap(from, to, f, t))) continue;
      const clashesWithPending = pending.some(
        (p) =>
          p.track.id === track.id &&
          intervalsOverlap(from, to, p.ev.t0 - p.track.approachSec, p.ev.t1 + p.track.clearSec),
      );
      if (clashesWithPending) continue;
      return track;
    }
    return undefined;
  }

  private commit(stationId: StationId, ev: Event, track: StationTrack): void {
    const busy = this.occupancy.get(track.id) ?? [];
    busy.push([ev.t0 - track.approachSec, ev.t1 + track.clearSec]);
    this.occupancy.set(track.id, busy);

    // Both the arrival and the departure matter: `headway.section` checks
    // successive link ENTRY times (= departures) and successive EXIT times
    // (= arrivals) separately, so a 回送 has to clear both.
    const key = `${stationId}|${ev.train.direction}`;
    const list = this.headway.get(key) ?? [];
    for (const t of ev.t0 === ev.t1 ? [ev.t0] : [ev.t0, ev.t1]) {
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid]! < t) lo = mid + 1;
        else hi = mid;
      }
      list.splice(lo, 0, t);
    }
    this.headway.set(key, list);

    ev.train.stops[ev.stopIndex]!.trackId = track.id;
    const station = this.facts.stationById.get(stationId);
    if (station !== undefined && track.id !== station.defaultTrackId[ev.train.direction]) {
      this.fallbacks++;
    }
  }
}

function eventsOf(train: AssignableTrain, mustPass: ReadonlySet<string>): Event[] {
  return train.stops.map((stop, stopIndex) => {
    const t0 = stop.arr ?? stop.dep;
    const t1 = stop.dep ?? stop.arr;
    if (t0 === undefined || t1 === undefined) {
      throw new SeedError('番線割当: 時刻のない停車があります', { train: train.label });
    }
    return {
      train,
      stopIndex,
      t0,
      t1,
      mustWait: (stop.overtakenBy ?? []).length > 0,
      mustPass: mustPass.has(`${stop.stationId}|${train.trainId}`),
    };
  });
}

function preferenceOrder(
  facts: Facts,
  stationId: StationId,
  tracks: readonly StationTrack[],
  ev: Event,
): StationTrack[] {
  const station = facts.stationById.get(stationId)!;
  const stationKey = facts.keyOf.get(stationId);
  const stop = ev.train.stops[ev.stopIndex]!;
  const isOrigin = ev.stopIndex === 0;

  const permitted = tracks.filter((track) => {
    if (!track.directions.includes(ev.train.direction)) return false;
    if (track.maxCars < ev.train.cars) return false;

    const role = facts.trackRole.get(track.id);
    if (stationKey !== undefined && QUAD_SECTION.includes(stationKey)) {
      const stablingOk =
        role === 'stabling' && !ev.train.isPassenger && ev.train.preferStablingAtOrigin && isOrigin;
      if (!stablingOk && role !== ev.train.routing) return false;
    } else if (stationKey === 'futakotamagawa') {
      // 大井町線 trains use the 大井町線 faces even when they are about to
      // cross over: the crossover itself lies in the 二子玉川〜二子新地 link.
      if (role !== 'om') return false;
    } else if (role === 'stabling' || role === 'depot') {
      // Never park a service train in a siding by accident.
      if (ev.train.isPassenger) return false;
    }

    if (stop.kind === 'stop' && ev.train.isPassenger && !track.hasPlatform) return false;
    if (ev.mustWait && !track.canBeOvertaken) return false;
    if (ev.mustPass && track.canBeOvertaken) return false;
    return true;
  });

  const score = (track: StationTrack): number => {
    const role = facts.trackRole.get(track.id);
    if (ev.train.preferStablingAtOrigin && isOrigin && role === 'stabling') return 0;
    if (track.id === station.defaultTrackId[ev.train.direction]) return 1;
    return 2;
  };

  const order = new Map(tracks.map((t, i) => [t.id, i]));
  return permitted.sort(
    (a, b) => score(a) - score(b) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
}
