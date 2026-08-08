/**
 * 番線 assignment — the 構内ダイヤ — and the path-finding hook the 回送 need.
 *
 * Service trains are placed first, station by station in time order, with
 * four hard rules layered on top of "prefer the default platform, fall back to
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
 *   4. **折り返し.** A formation that arrives and works the next train out of
 *      the same station reverses *in place*: the arrival and the departure are
 *      one continuous occupation of ONE road. Booking them as two independent
 *      events is what produced a plan where every 大井町 arrival was on 2番線,
 *      every departure on 1番線, and the stock crossed between them by magic —
 *      impossible at a 頭端式1面2線 stub with no tail track. `TurnbackLink`
 *      makes the pair a single `Event` with a single road.
 *
 * Greedy is sufficient for the service trains because they come from a
 * repeating cycle: within a station the events arrive in a near-periodic order,
 * so first-fit is also the choice a planner would make.
 *
 * 回送 are different. They are not part of the cycle, so they have to be
 * *pathed into the gaps* the cycle leaves — which is exactly what a real
 * planner does with empty stock. `tryPlace` is therefore atomic: it either
 * books every stop of one 回送 or books none of them, so the caller can walk a
 * 回送's departure time backwards (出庫) or forwards (入庫) until it fits. A
 * 回送 that hands over to (or takes over from) a service train reverses in
 * place too, so it carries a `PinnedEnd` naming the road its partner already
 * holds; the combined occupation is booked against that road and is allowed to
 * overlap the partner's own interval, because the two are one formation.
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

/** The road a already-placed partner holds across a 折り返し. */
export interface PinnedEnd {
  trainId: TrainId;
  trackId: StationTrackId;
  /** The partner's own instant at the shared station. */
  at: Sec;
}

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
  /** This train's origin shares a road with the train that just terminated. */
  pinnedOrigin?: PinnedEnd;
  /** This train's terminus shares a road with the train that leaves next. */
  pinnedTerminus?: PinnedEnd;
}

/** Two service trains of one duty reversing in place at the same station. */
export interface TurnbackLink {
  arrivingTrainId: TrainId;
  departingTrainId: TrainId;
}

/** Stations where the inner/outer pair actually has to be chosen. */
const QUAD_SECTION: readonly StationKey[] = ['futakoshinchi', 'takatsu', 'mizonokuchi'];

interface Target {
  train: AssignableTrain;
  stopIndex: number;
}

interface Event {
  /** Every stop that has to end up on the SAME road. */
  targets: Target[];
  /** Occupation window, margins excluded. */
  occFrom: Sec;
  occTo: Sec;
  /** Instants this event puts a train on the running line, for 続行時隔. */
  headwayAt: Array<{ at: Sec; direction: Direction }>;
  mustWait: boolean;
  mustPass: boolean;
  /** Road forced by a 折り返し partner that is already booked. */
  forcedTrackId?: StationTrackId;
  /** Interval owner this event is allowed to overlap: the same formation. */
  exemptTrainId?: TrainId;
}

interface Occupied {
  from: Sec;
  to: Sec;
  trainId: TrainId;
}

export class TrackBooking {
  private readonly occupancy = new Map<StationTrackId, Occupied[]>();
  /** `${stationId}|${direction}` -> sorted line-occupation instants. */
  private readonly headway = new Map<string, Sec[]>();
  /** `${stationId}|${trainId}` for trains that must be on a through track. */
  private mustPass = new Set<string>();
  fallbacks = 0;

  constructor(private readonly facts: Facts) {
    for (const track of facts.tracks) this.occupancy.set(track.id, []);
  }

  /** The road a stop ended up on, once it has been committed. */
  trackOf(train: AssignableTrain, stopIndex: number): StationTrackId | undefined {
    return train.stops[stopIndex]?.trackId;
  }

  /**
   * Place a whole fleet of service trains: per station, in time order. The
   * `mustPass` index is derived from the waiting trains' `overtakenBy`, so the
   * two sides of an overtake can never disagree. `turnbacks` fuses the two
   * halves of each in-place reversal into one event on one road.
   */
  placeSweep(
    trains: readonly AssignableTrain[],
    turnbacks: readonly TurnbackLink[] = [],
  ): void {
    this.mustPass = new Set<string>();
    for (const train of trains) {
      for (const stop of train.stops) {
        for (const other of stop.overtakenBy ?? []) {
          this.mustPass.add(`${stop.stationId}|${other}`);
        }
      }
    }

    const byId = new Map(trains.map((t) => [t.trainId, t]));
    /** trainId -> the train that takes its formation on at the terminus. */
    const successor = new Map<TrainId, AssignableTrain>();
    const predecessor = new Set<TrainId>();
    for (const link of turnbacks) {
      const arriving = byId.get(link.arrivingTrainId);
      const departing = byId.get(link.departingTrainId);
      if (arriving === undefined || departing === undefined) continue;
      const last = arriving.stops[arriving.stops.length - 1];
      const first = departing.stops[0];
      if (last === undefined || first === undefined) continue;
      if (last.stationId !== first.stationId) continue;
      successor.set(arriving.trainId, departing);
      predecessor.add(departing.trainId);
    }

    const byStation = new Map<StationId, Event[]>();
    const push = (stationId: StationId, ev: Event): void => {
      const list = byStation.get(stationId) ?? [];
      list.push(ev);
      byStation.set(stationId, list);
    };

    for (const train of trains) {
      const lastIndex = train.stops.length - 1;
      train.stops.forEach((stop, stopIndex) => {
        // The departing half of a fused reversal is booked with the arriving
        // half, not on its own.
        if (stopIndex === 0 && predecessor.has(train.trainId)) return;
        const ev = eventOf(train, stopIndex, this.mustPass);
        if (stopIndex === lastIndex) {
          const next = successor.get(train.trainId);
          const nextFirst = next?.stops[0];
          const nextDep = nextFirst?.dep ?? nextFirst?.arr;
          if (next !== undefined && nextFirst !== undefined && nextDep !== undefined) {
            ev.targets.push({ train: next, stopIndex: 0 });
            ev.occTo = Math.max(ev.occTo, nextDep);
            ev.headwayAt.push({ at: nextDep, direction: next.direction });
          }
        }
        push(stop.stationId, ev);
      });
    }

    for (const station of this.facts.stations) {
      const events = byStation.get(station.id);
      if (events === undefined) continue;
      events.sort(
        (a, b) =>
          a.occFrom - b.occFrom ||
          a.targets[0]!.train.trainId.localeCompare(b.targets[0]!.train.trainId),
      );
      for (const ev of events) {
        const chosen = this.pick(station.id, ev);
        if (chosen === undefined) {
          throw new SeedError('番線を割り当てられません', {
            station: station.name,
            train: ev.targets[0]!.train.label,
            window: `${ev.occFrom}-${ev.occTo}`,
          });
        }
        this.commit(station.id, ev, chosen);
      }
    }
  }

  /**
   * Book a road for a formation that is standing still — a `stable` leg.
   *
   * A layover long enough to be worth writing down is a layover long enough
   * that the platform road cannot be held: the terminal has to keep turning
   * trains round. So the berth goes on a 引上線 / 留置線 if the station has one,
   * and only falls back to a platform face if it does not. `undefined` means
   * there is nowhere to put it, which is a fact about the plan the caller has
   * to deal with rather than something to paper over.
   */
  placeBerth(
    stationId: StationId,
    trainId: TrainId,
    cars: number,
    from: Sec,
    to: Sec,
  ): StationTrackId | undefined {
    const tracks = this.facts.tracksOf.get(stationId) ?? [];
    const ranked = [...tracks]
      .filter((t) => t.maxCars >= cars && t.canTurnBack)
      .sort((a, b) => berthScore(this.facts, a) - berthScore(this.facts, b));
    for (const track of ranked) {
      const slotFrom = from - track.approachSec;
      const slotTo = to + track.clearSec;
      const busy = this.occupancy.get(track.id) ?? [];
      if (busy.some((s) => intervalsOverlap(slotFrom, slotTo, s.from, s.to))) continue;
      busy.push({ from: slotFrom, to: slotTo, trainId });
      this.occupancy.set(track.id, busy);
      return track.id;
    }
    return undefined;
  }

  /**
   * Atomically book every stop of one train, or nothing. Used to path 回送 into
   * the gaps the service pattern leaves.
   */
  tryPlace(train: AssignableTrain, minHeadwaySec: number): boolean {
    const events = eventsOf(train, this.mustPass);
    const booked: Array<{ stationId: StationId; ev: Event; track: StationTrack }> = [];

    for (const ev of events) {
      const stationId = train.stops[ev.targets[0]!.stopIndex]!.stationId;
      // Both instants matter: the arrival is a link EXIT and the departure a
      // link ENTRY, and `headway.section` checks the two sequences separately.
      const clear = ev.headwayAt.every((h) =>
        this.headwayOk(stationId, h.direction, h.at, minHeadwaySec),
      );
      if (!clear) return false;
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

  private free(
    track: StationTrack,
    ev: Event,
    pending: ReadonlyArray<{ stationId: StationId; ev: Event; track: StationTrack }>,
  ): boolean {
    const from = ev.occFrom - track.approachSec;
    const to = ev.occTo + track.clearSec;
    const busy = this.occupancy.get(track.id) ?? [];
    for (const slot of busy) {
      if (slot.trainId === ev.exemptTrainId) continue;
      if (intervalsOverlap(from, to, slot.from, slot.to)) return false;
    }
    return !pending.some(
      (p) =>
        p.track.id === track.id &&
        intervalsOverlap(from, to, p.ev.occFrom - p.track.approachSec, p.ev.occTo + p.track.clearSec),
    );
  }

  private pick(
    stationId: StationId,
    ev: Event,
    pending: ReadonlyArray<{ stationId: StationId; ev: Event; track: StationTrack }> = [],
  ): StationTrack | undefined {
    const tracks = this.facts.tracksOf.get(stationId) ?? [];
    if (ev.forcedTrackId !== undefined) {
      const forced = tracks.find((t) => t.id === ev.forcedTrackId);
      if (forced === undefined) return undefined;
      if (!permitted(this.facts, stationId, forced, ev)) return undefined;
      return this.free(forced, ev, pending) ? forced : undefined;
    }
    for (const track of preferenceOrder(this.facts, stationId, tracks, ev)) {
      if (this.free(track, ev, pending)) return track;
    }
    return undefined;
  }

  private commit(stationId: StationId, ev: Event, track: StationTrack): void {
    const busy = this.occupancy.get(track.id) ?? [];
    busy.push({
      from: ev.occFrom - track.approachSec,
      to: ev.occTo + track.clearSec,
      trainId: ev.targets[0]!.train.trainId,
    });
    this.occupancy.set(track.id, busy);

    // Both the arrival and the departure matter: `headway.section` checks
    // successive link ENTRY times (= departures) and successive EXIT times
    // (= arrivals) separately, so a 回送 has to clear both. A fused 折り返し
    // puts one instant on each direction's sequence, not two on one.
    const seen = new Set<string>();
    for (const h of ev.headwayAt) {
      const key = `${stationId}|${h.direction}`;
      if (seen.has(`${key}|${h.at}`)) continue;
      seen.add(`${key}|${h.at}`);
      const list = this.headway.get(key) ?? [];
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid]! < h.at) lo = mid + 1;
        else hi = mid;
      }
      list.splice(lo, 0, h.at);
      this.headway.set(key, list);
    }

    const station = this.facts.stationById.get(stationId);
    for (const target of ev.targets) {
      target.train.stops[target.stopIndex]!.trackId = track.id;
      if (station !== undefined && track.id !== station.defaultTrackId[target.train.direction]) {
        this.fallbacks++;
      }
    }
  }
}

/** Sidings first, then depot roads, then — reluctantly — a platform face. */
function berthScore(facts: Facts, track: StationTrack): number {
  const role = facts.trackRole.get(track.id);
  if (role === 'stabling') return 0;
  if (role === 'depot') return 1;
  return 2;
}

function eventOf(
  train: AssignableTrain,
  stopIndex: number,
  mustPass: ReadonlySet<string>,
): Event {
  const stop = train.stops[stopIndex]!;
  const t0 = stop.arr ?? stop.dep;
  const t1 = stop.dep ?? stop.arr;
  if (t0 === undefined || t1 === undefined) {
    throw new SeedError('番線割当: 時刻のない停車があります', { train: train.label });
  }
  const ev: Event = {
    targets: [{ train, stopIndex }],
    occFrom: t0,
    occTo: t1,
    headwayAt:
      t0 === t1
        ? [{ at: t0, direction: train.direction }]
        : [
            { at: t0, direction: train.direction },
            { at: t1, direction: train.direction },
          ],
    mustWait: (stop.overtakenBy ?? []).length > 0,
    mustPass: mustPass.has(`${stop.stationId}|${train.trainId}`),
  };

  // A 回送 handing over to, or taking over from, an already-booked service
  // train reverses in place: same road, one continuous occupation.
  const pin =
    stopIndex === 0
      ? train.pinnedOrigin
      : stopIndex === train.stops.length - 1
        ? train.pinnedTerminus
        : undefined;
  if (pin !== undefined) {
    ev.forcedTrackId = pin.trackId;
    ev.exemptTrainId = pin.trainId;
    ev.occFrom = Math.min(ev.occFrom, pin.at);
    ev.occTo = Math.max(ev.occTo, pin.at);
  }
  return ev;
}

function eventsOf(train: AssignableTrain, mustPass: ReadonlySet<string>): Event[] {
  return train.stops.map((_stop, stopIndex) => eventOf(train, stopIndex, mustPass));
}

/** Is this road usable by every stop the event has to place on it? */
function permitted(
  facts: Facts,
  stationId: StationId,
  track: StationTrack,
  ev: Event,
): boolean {
  const stationKey = facts.keyOf.get(stationId);
  const role = facts.trackRole.get(track.id);

  return ev.targets.every(({ train, stopIndex }) => {
    const stop = train.stops[stopIndex]!;
    const isOrigin = stopIndex === 0;
    if (!track.directions.includes(train.direction)) return false;
    if (track.maxCars < train.cars) return false;

    if (stationKey !== undefined && QUAD_SECTION.includes(stationKey)) {
      const stablingOk =
        role === 'stabling' && !train.isPassenger && train.preferStablingAtOrigin && isOrigin;
      if (!stablingOk && role !== train.routing) return false;
    } else if (stationKey === 'futakotamagawa') {
      // 大井町線 trains use the 大井町線 faces even when they are about to
      // cross over: the crossover itself lies in the 二子玉川〜二子新地 link.
      if (role !== 'om') return false;
    } else if (role === 'stabling' || role === 'depot') {
      // Never park a service train in a siding by accident.
      if (train.isPassenger) return false;
    }

    if (stop.kind === 'stop' && train.isPassenger && !track.hasPlatform) return false;
    if (ev.mustWait && !track.canBeOvertaken) return false;
    if (ev.mustPass && track.canBeOvertaken) return false;
    // A reversal needs a road that can actually reverse.
    if (ev.targets.length > 1 && !track.canTurnBack) return false;
    return true;
  });
}

function preferenceOrder(
  facts: Facts,
  stationId: StationId,
  tracks: readonly StationTrack[],
  ev: Event,
): StationTrack[] {
  const station = facts.stationById.get(stationId)!;
  const primary = ev.targets[0]!;
  const isOrigin = primary.stopIndex === 0;
  const allowed = tracks.filter((track) => permitted(facts, stationId, track, ev));

  const score = (track: StationTrack): number => {
    const role = facts.trackRole.get(track.id);
    if (primary.train.preferStablingAtOrigin && isOrigin && role === 'stabling') return 0;
    if (track.id === station.defaultTrackId[primary.train.direction]) return 1;
    return 2;
  };

  const order = new Map(tracks.map((t, i) => [t.id, i]));
  return allowed.sort(
    (a, b) => score(a) - score(b) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
}
