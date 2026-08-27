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
 *      pair, which has no platform there at all. At 溝の口 itself the pair is
 *      not what decides the face: stock that turns round there is 大井町線 stock
 *      and stands on 2・3番線, and stock that runs through is on the 田園都市線
 *      beyond the station and uses 1・4番線.
 *   3. **Platform.** A passenger stop may not be booked on a 通過線.
 *   4. **折り返し.** A formation that arrives and works the next train out of
 *      the same station without shunting reverses *in place*: the arrival and
 *      the departure are one continuous occupation of ONE road. Booking them as
 *      two independent events is what produced a plan where every 大井町 arrival
 *      was on 2番線, every departure on 1番線, and the stock crossed between them
 *      by magic — impossible at a 頭端式1面2線 stub with no tail track.
 *      `TurnbackLink` makes the pair a single `Event` with a single road. Where
 *      the formation DOES shunt — 溝の口, out to a 引上線 for the layover — the
 *      caller claims the tail track through `placeBerth` first and does not pass
 *      a `TurnbackLink`, so the two ends stay separate 50-second events and the
 *      platform faces stay free.
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
 * placed. It is checked exactly the way `headway.section` checks it — per
 * (link, direction), on the ENTRY sequence and the EXIT sequence separately —
 * because a generator that models the constraint differently from the validator
 * either lets errors through or, as happened here, forbids paths that are
 * perfectly legal. Lumping every instant at a station into one sequence made a
 * 回送 terminating at 溝の口 from 梶が谷 wait for the 上り departures towards
 * 高津, which are on another link entirely; the empty move then arrived a
 * quarter of an hour early and squatted on a 引上線.
 *
 * The per-link form still does the second job the old one did: it makes it
 * impossible for a 回送 to slide past a service train in mid-section, because
 * overtaking needs the gap to pass through zero and the entry and exit of the
 * link it happens in are both checked.
 */

import type { StationId, StationTrackId, TrainId } from '@/domain/ids';
import type { Direction, StationEnd, StationTrack, TrainStop } from '@/domain/model';
import { intervalsOverlap } from '@/domain/time';
import { canEnterFrom, defaultStubEnd, endTowards } from '@/domain/wiring';
import type { Sec } from '@/domain/units';
import { SeedError } from '../errors';
import type { GeneratorFacts } from './facts';

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
  /**
   * The mirror image, and the reason a 出庫 into 溝の口 does not block a
   * platform: an empty move that arrives well before the train it hands over to
   * belongs in a 引上線 for the wait, not on 2番線.
   */
  preferStablingAtTerminus?: boolean;
  stops: TrainStop[];
  /** This train's origin shares a road with the train that just terminated. */
  pinnedOrigin?: PinnedEnd;
  /** This train's terminus shares a road with the train that leaves next. */
  pinnedTerminus?: PinnedEnd;
  /**
   * Seconds of road this train needs BEFORE its origin departure, because the
   * 出庫回送 that brings the stock in has to stand there first. Reserving it
   * during the service sweep is what lets the empty move be pinned to the same
   * road afterwards; without it the sweep fills the road and the 回送 has
   * nowhere to reverse at a stub terminal.
   */
  reserveBeforeOriginSec?: number;
  /** The mirror image: road held after the terminus until the 入庫 leaves. */
  reserveAfterTerminusSec?: number;
  /**
   * Absolute instant until which this train's terminus road stays occupied —
   * used by a 出庫 that could not be pinned to its service train's road but
   * must still stand somewhere until that train leaves. Unlike a reservation
   * this is a hard requirement: a path that does not keep the road is not a
   * path the formation could actually work.
   */
  holdTerminusUntilSec?: Sec;
  /** The mirror image for an 入庫 taking over from an arriving train. */
  holdOriginFromSec?: Sec;
}

/** Two service trains of one duty reversing in place at the same station. */
export interface TurnbackLink {
  arrivingTrainId: TrainId;
  departingTrainId: TrainId;
}

/** How much of a yard road is already spoken for; see `preferenceOrder`. */
interface YardLoad {
  /** Movements booked on it so far. */
  count: number;
  /** When the last of them clears. */
  until: number;
}

const NO_LOAD = (): YardLoad => ({ count: 0, until: 0 });

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
  mustWait: boolean;
  mustPass: boolean;
  /** Road forced by a 折り返し partner that is already booked. */
  forcedTrackId?: StationTrackId;
  /** Interval owner this event is allowed to overlap: the same formation. */
  exemptTrainId?: TrainId;
  /**
   * Extra road time this event would LIKE, for the 出庫/入庫 that brings the
   * stock in or takes it away. Booked in a second pass so that a reservation
   * can never crowd out a train that actually has to be somewhere.
   */
  wanted?: { from: Sec; to: Sec };
  /**
   * The window without the chain-end hold folded in. A hold is how a terminal
   * with no 引上線 says "the empty move stands on this road": it has to be
   * booked in the first pass or the 回送 will find the road gone. But a hold
   * that cannot be had is not a reason to abandon the timetable — the train
   * still has to stand somewhere — so the event falls back to its bare window
   * and the hold becomes a preference like any other.
   */
  core?: { from: Sec; to: Sec } | undefined;
}

interface Occupied {
  from: Sec;
  to: Sec;
  trainId: TrainId;
  /**
   * Set when part of this booking is only a chain end's *reservation* — road
   * time the 出庫 or 入庫 would like, on top of the window the train itself
   * needs. A later train that finds nowhere else to go may take it back, which
   * is what makes booking the reservation eagerly safe.
   */
  bare?: { from: Sec; to: Sec } | undefined;
}

export class TrackBooking {
  private readonly occupancy = new Map<StationTrackId, Occupied[]>();
  /**
   * `${fromStationId}>${toStationId}` — one bucket per link AND direction, each
   * holding the sorted ENTRY and EXIT instants of the trains already placed.
   */
  private readonly traversals = new Map<string, { enter: Sec[]; exit: Sec[] }>();
  /** `${stationId}|${trainId}` for trains that must be on a through track. */
  private mustPass = new Set<string>();
  fallbacks = 0;

  constructor(private readonly facts: GeneratorFacts) {
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

    for (const train of trains) this.addTraversals(train);

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
      // Pass 1: every train gets the road it actually needs — and, where the
      // road it would have taken anyway can also carry the chain end's
      // reservation, it takes that in the same breath. Deferring the whole
      // reservation to pass 2 lost it every time a later train in the sweep
      // moved into the window, which at 大井町 is how the 出庫 ended up on the
      // other face of a platform it cannot cross to.
      const placed: Array<{ ev: Event; track: StationTrack }> = [];
      for (const ev of events) {
        const roomy = roomyWindow(ev);
        let booked = ev;
        let chosen = roomy === undefined ? undefined : this.pick(station.id, roomy);
        if (chosen !== undefined && roomy !== undefined) booked = roomy;
        else chosen = this.pick(station.id, ev);
        if (chosen === undefined) chosen = this.reclaim(station.id, ev);
        if (chosen === undefined && ev.core !== undefined) {
          // The hold does not fit. Book what the train actually needs and let
          // the empty move ask for the rest in pass 2.
          ev.wanted = { from: ev.occFrom, to: ev.occTo };
          ev.occFrom = ev.core.from;
          ev.occTo = ev.core.to;
          ev.core = undefined;
          booked = ev;
          chosen = this.pick(station.id, ev);
        }
        if (chosen === undefined) {
          throw new SeedError('番線を割り当てられません', {
            station: station.name,
            train: ev.targets[0]!.train.label,
            window: `${ev.occFrom}-${ev.occTo}`,
          });
        }
        this.commit(
          station.id,
          booked,
          chosen,
          booked === ev
            ? undefined
            : { from: ev.occFrom - chosen.approachSec, to: ev.occTo + chosen.clearSec },
        );
        if (booked === ev) placed.push({ ev, track: chosen });
      }
      // Pass 2: chain ends take the extra road time their empty move needs, if
      // and only if nothing else wants it. A reservation that cannot be had is
      // not an error — the 回送 will shunt to another road and the duty will
      // carry a `stable` leg saying so.
      for (const { ev, track } of placed) {
        if (ev.wanted === undefined) continue;
        this.extendBooking(
          track.id,
          ev.targets[0]!.train.trainId,
          ev.wanted.from,
          ev.wanted.to,
        );
      }
    }
  }

  /**
   * Hold a road the same formation is already using, for longer.
   *
   * Used when a `stable` leg berths a formation on the road its own empty move
   * arrived at or leaves from: the road is right, the window is not, and the
   * existing interval belongs to the same formation so it is not a conflict.
   * Returns false if somebody else needs the road in that window.
   */
  extendBooking(trackId: StationTrackId, trainId: TrainId, from: Sec, to: Sec): boolean {
    const track = this.facts.tracks.find((t) => t.id === trackId);
    if (track === undefined) return false;
    const slotFrom = from - track.approachSec;
    const slotTo = to + track.clearSec;
    const busy = this.occupancy.get(trackId) ?? [];
    for (const slot of busy) {
      if (slot.trainId === trainId) continue;
      if (intervalsOverlap(slotFrom, slotTo, slot.from, slot.to)) return false;
    }
    busy.push({ from: slotFrom, to: slotTo, trainId });
    this.occupancy.set(trackId, busy);
    return true;
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
    routing: Routing,
    from: Sec,
    to: Sec,
    opts: { sidingOnly?: boolean } = {},
  ): StationTrackId | undefined {
    const tracks = this.facts.tracksOf.get(stationId) ?? [];
    const inQuad = this.facts.chooseRailPairAt.has(stationId);
    const ranked = [...tracks]
      .filter((t) => {
        if (t.maxCars < cars || !t.canTurnBack) return false;
        const role = this.facts.trackRole.get(t.id);
        // `sidingOnly` asks the question the 引上線 exist to answer: is there a
        // tail track free, so the formation can clear the platform? A platform
        // face is not an acceptable substitute — the caller falls back to an
        // in-place reversal instead, which is a different plan, not a worse
        // berth.
        if (opts.sidingOnly === true && role !== 'stabling') return false;
        if (!inQuad) return true;
        // A 引上線 at 溝の口 hangs off the 大井町線 faces, and a formation being
        // berthed there has finished its run: it is already on that side of the
        // station, whichever pair of rails it came in on. What it may not do is
        // stand on a 田園都市線 platform face.
        return role === 'stabling' || role === routing;
      })
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

    if (!this.traversalsClear(train, minHeadwaySec)) return false;

    for (const ev of events) {
      const stationId = train.stops[ev.targets[0]!.stopIndex]!.stationId;
      const track = this.pick(stationId, ev, booked);
      if (track === undefined) return false;
      booked.push({ stationId, ev, track });
    }

    for (const b of booked) this.commit(b.stationId, b.ev, b.track);
    this.addTraversals(train);
    return true;
  }

  /** The (link, direction) buckets one train's run touches, with its instants. */
  private static walk(
    train: AssignableTrain,
  ): Array<{ key: string; enter: Sec; exit: Sec }> {
    const out: Array<{ key: string; enter: Sec; exit: Sec }> = [];
    for (let i = 1; i < train.stops.length; i++) {
      const prev = train.stops[i - 1]!;
      const cur = train.stops[i]!;
      const enter = prev.dep ?? prev.arr;
      const exit = cur.arr ?? cur.dep;
      if (enter === undefined || exit === undefined) continue;
      out.push({ key: `${prev.stationId}>${cur.stationId}`, enter, exit });
    }
    return out;
  }

  private traversalsClear(train: AssignableTrain, minSec: number): boolean {
    for (const t of TrackBooking.walk(train)) {
      const bucket = this.traversals.get(t.key);
      if (bucket === undefined) continue;
      if (!gapOk(bucket.enter, t.enter, minSec)) return false;
      if (!gapOk(bucket.exit, t.exit, minSec)) return false;
    }
    return true;
  }

  private addTraversals(train: AssignableTrain): void {
    for (const t of TrackBooking.walk(train)) {
      const bucket = this.traversals.get(t.key) ?? { enter: [], exit: [] };
      insertSorted(bucket.enter, t.enter);
      insertSorted(bucket.exit, t.exit);
      this.traversals.set(t.key, bucket);
    }
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
    for (const track of preferenceOrder(this.facts, stationId, tracks, ev, this.yardLoad)) {
      if (this.free(track, ev, pending)) return track;
    }
    return undefined;
  }

  /** How much a yard road has been asked for already — see `preferenceOrder`. */
  private readonly yardLoad = (trackId: StationTrackId): YardLoad => {
    const slots = this.occupancy.get(trackId) ?? [];
    let until = Number.NEGATIVE_INFINITY;
    for (const slot of slots) if (slot.to > until) until = slot.to;
    return { count: slots.length, until };
  };

  /**
   * Take back a chain end's reservation when a train has nowhere else to stand.
   *
   * The reservation is real road time and booking it early is what keeps the
   * empty move on the right face of a stub platform — but a train that actually
   * has to be somewhere outranks a formation that would merely like to wait
   * there, so the reservation shrinks back to the window its own train needs
   * and the 回送 falls back to whatever the second pass can find.
   */
  private reclaim(stationId: StationId, ev: Event): StationTrack | undefined {
    const tracks = this.facts.tracksOf.get(stationId) ?? [];
    const candidates =
      ev.forcedTrackId === undefined
        ? preferenceOrder(this.facts, stationId, tracks, ev, this.yardLoad)
        : tracks.filter((t) => t.id === ev.forcedTrackId && permitted(this.facts, stationId, t, ev));
    for (const track of candidates) {
      const from = ev.occFrom - track.approachSec;
      const to = ev.occTo + track.clearSec;
      const busy = this.occupancy.get(track.id) ?? [];
      const shrink: Occupied[] = [];
      let ok = true;
      for (const slot of busy) {
        if (slot.trainId === ev.exemptTrainId) continue;
        if (!intervalsOverlap(from, to, slot.from, slot.to)) continue;
        if (slot.bare === undefined || intervalsOverlap(from, to, slot.bare.from, slot.bare.to)) {
          ok = false;
          break;
        }
        shrink.push(slot);
      }
      if (!ok) continue;
      for (const slot of shrink) {
        slot.from = slot.bare!.from;
        slot.to = slot.bare!.to;
        slot.bare = undefined;
      }
      return track;
    }
    return undefined;
  }

  private commit(
    stationId: StationId,
    ev: Event,
    track: StationTrack,
    bare?: { from: Sec; to: Sec },
  ): void {
    const busy = this.occupancy.get(track.id) ?? [];
    busy.push({
      from: ev.occFrom - track.approachSec,
      to: ev.occTo + track.clearSec,
      trainId: ev.targets[0]!.train.trainId,
      ...(bare === undefined ? {} : { bare }),
    });
    this.occupancy.set(track.id, busy);

    const station = this.facts.stationById.get(stationId);
    for (const target of ev.targets) {
      target.train.stops[target.stopIndex]!.trackId = track.id;
      if (station !== undefined && track.id !== station.defaultTrackId[target.train.direction]) {
        this.fallbacks++;
      }
    }
  }
}

/** The event's window with its chain-end reservation folded in, if it has one. */
function roomyWindow(ev: Event): Event | undefined {
  if (ev.wanted === undefined) return undefined;
  return {
    ...ev,
    occFrom: Math.min(ev.occFrom, ev.wanted.from),
    occTo: Math.max(ev.occTo, ev.wanted.to),
  };
}

/** Binary-search insertion point, then the two neighbours. */
function gapOk(sorted: readonly Sec[], at: Sec, minSec: number): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < at) lo = mid + 1;
    else hi = mid;
  }
  const before = sorted[lo - 1];
  const after = sorted[lo];
  if (before !== undefined && at - before < minSec) return false;
  if (after !== undefined && after - at < minSec) return false;
  return true;
}

function insertSorted(sorted: Sec[], at: Sec): void {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < at) lo = mid + 1;
    else hi = mid;
  }
  sorted.splice(lo, 0, at);
}

/** Sidings first, then depot roads, then — reluctantly — a platform face. */
function berthScore(facts: GeneratorFacts, track: StationTrack): number {
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
  const last = train.stops.length - 1;
  const before = stopIndex === 0 ? (train.reserveBeforeOriginSec ?? 0) : 0;
  const after = stopIndex === last ? (train.reserveAfterTerminusSec ?? 0) : 0;
  const holdFrom = stopIndex === 0 ? train.holdOriginFromSec : undefined;
  const holdTo = stopIndex === last ? train.holdTerminusUntilSec : undefined;
  const ev: Event = {
    targets: [{ train, stopIndex }],
    occFrom: holdFrom === undefined ? t0 : Math.min(t0, holdFrom),
    occTo: holdTo === undefined ? t1 : Math.max(t1, holdTo),
    ...(holdFrom === undefined && holdTo === undefined ? {} : { core: { from: t0, to: t1 } }),
    ...(before === 0 && after === 0
      ? {}
      : { wanted: { from: t0 - before, to: t1 + after } }),
    mustWait: (stop.overtakenBy ?? []).length > 0,
    mustPass: mustPass.has(`${stop.stationId}|${train.trainId}`),
  };

  // A 回送 handing over to, or taking over from, an already-booked service
  // train reverses in place: same road, one continuous occupation.
  const pin =
    stopIndex === 0
      ? train.pinnedOrigin
      : stopIndex === last
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

/**
 * Which end a stub hangs off at each station when the document does not say.
 *
 * Memoized per `Facts` because `permitted` asks for it once per candidate road
 * per event, and the answer depends only on the km axis.
 */
const stubEnds = new WeakMap<GeneratorFacts, Map<StationId, StationEnd>>();

function stubEndAt(facts: GeneratorFacts, stationId: StationId): StationEnd {
  let byStation = stubEnds.get(facts);
  if (byStation === undefined) {
    const kms = facts.stations.map((s) => s.kmFromOrigin);
    const from = Math.min(...kms);
    const to = Math.max(...kms);
    byStation = new Map(
      facts.stations.map((s) => [s.id, defaultStubEnd(s.kmFromOrigin, from, to)]),
    );
    stubEnds.set(facts, byStation);
  }
  return byStation.get(stationId) ?? 'down';
}

/**
 * Can this train reach this road from the stations either side of the stop?
 *
 * The 構内配線 read exactly the way `track.routeMissing` reads it, and on
 * purpose: a generator that books a road the validator then calls unreachable
 * ships a plan that looks broken and is not. What it rules out is the move the
 * layout has no rails for — a 回送 off the 鷺沼 line straight into 溝の口 2番線,
 * which has to terminate in a 引上線 and shunt across instead.
 */
function reachable(
  facts: GeneratorFacts,
  stationId: StationId,
  track: StationTrack,
  train: AssignableTrain,
  stopIndex: number,
): boolean {
  const station = facts.stationById.get(stationId);
  if (station === undefined) return true;
  const fallback = stubEndAt(facts, stationId);
  for (const neighbour of [train.stops[stopIndex - 1], train.stops[stopIndex + 1]]) {
    if (neighbour === undefined) continue;
    const other = facts.stationById.get(neighbour.stationId);
    if (other === undefined) continue;
    const end = endTowards(station, other.kmFromOrigin);
    if (!canEnterFrom(station, track, end, train.direction, fallback)) return false;
  }
  return true;
}

/** Is this road usable by every stop the event has to place on it? */
function permitted(
  facts: GeneratorFacts,
  stationId: StationId,
  track: StationTrack,
  ev: Event,
): boolean {
  const inQuad = facts.chooseRailPairAt.has(stationId);
  const role = facts.trackRole.get(track.id);

  return ev.targets.every(({ train, stopIndex }) => {
    const stop = train.stops[stopIndex]!;
    const isOrigin = stopIndex === 0;
    const isTerminus = stopIndex === train.stops.length - 1;
    if (!track.directions.includes(train.direction)) return false;
    if (track.maxCars < train.cars) return false;
    if (!reachable(facts, stationId, track, train, stopIndex)) return false;

    if (inQuad) {
      const stablingOk =
        role === 'stabling' &&
        !train.isPassenger &&
        ((train.preferStablingAtOrigin && isOrigin) ||
          (train.preferStablingAtTerminus === true && isTerminus));
      // At 溝の口 the face is chosen by what the train does NEXT, not by the
      // pair of rails it arrived on — the throat has the crossovers, which is
      // also how the 引上線 beyond the 大井町線 faces are reached at all.
      //
      //   - a train that starts or ends its run here is 大井町線 stock turning
      //     round, so it uses the 大井町線 island (2・3番線) or a 引上線;
      //   - a train that runs through is on the 田園都市線 beyond this station,
      //     so it uses that line's own faces (1・4番線).
      //
      // Before this, the pair was carried straight through to the platform: a
      // 各停(青) — which runs the outer pair through the quad section so that it
      // can call at 二子新地 and 高津 — terminated on 1番線 and stood there for a
      // quarter of an hour, 134 times a day. 1・4番線 belong to a line this
      // document does not model, so they merely *looked* free; in fact one of
      // that line's own trains is through them every couple of minutes.
      const endsHere = isOrigin || isTerminus;
      // `'om'` is this document's own line and `'dt'` the railway it shares
      // rails with — see `TrackRole`.
      const needed: string = facts.railPairTerminusAt.has(stationId)
        ? endsHere
          ? 'om'
          : 'dt'
        : train.routing;
      if (!stablingOk && role !== needed) return false;
    } else if (facts.ownRailsOnlyAt.has(stationId)) {
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
  facts: GeneratorFacts,
  stationId: StationId,
  tracks: readonly StationTrack[],
  ev: Event,
  yardLoad: (trackId: StationTrackId) => YardLoad = NO_LOAD,
): StationTrack[] {
  const station = facts.stationById.get(stationId)!;
  const primary = ev.targets[0]!;
  const isOrigin = primary.stopIndex === 0;
  const isTerminus = primary.stopIndex === primary.train.stops.length - 1;
  const allowed = tracks.filter((track) => permitted(facts, stationId, track, ev));
  const order = new Map(tracks.map((t, i) => [t.id, i]));

  // A yard has no through road and no direction, so the station's "default"
  // road means nothing there — and taking it anyway put every single 出庫 of
  // the day on 留置10番線 and every 入庫 on 留置1番線, which is how nineteen
  // formations ended up drawn on one road with `+18` beside them. A yard fills
  // its emptiest road, which is also what a real 車庫 does.
  if (station.kind === 'depot') {
    return allowed.sort((a, b) => {
      const la = yardLoad(a.id);
      const lb = yardLoad(b.id);
      return (
        la.count - lb.count ||
        la.until - lb.until ||
        (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
      );
    });
  }

  const score = (track: StationTrack): number => {
    const role = facts.trackRole.get(track.id);
    if (role === 'stabling' || role === 'depot') {
      if (primary.train.preferStablingAtOrigin && isOrigin) return 0;
      if (primary.train.preferStablingAtTerminus === true && isTerminus) return 0;
    }
    if (track.id === station.defaultTrackId[primary.train.direction]) return 1;
    return 2;
  };

  return allowed.sort(
    (a, b) => score(a) - score(b) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
}
