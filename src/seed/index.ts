/**
 * `buildOimachiProject()` — the 東急大井町線 平日ダイヤ, assembled.
 *
 * Pipeline:
 *
 *   facts.ts      infrastructure, types, patterns, fleet, inspection rules
 *   service.ts    eight time bands, each one repeating cycle
 *   expand.ts     band × cycle × slot  ->  TrainSpec
 *   stopTimes.ts  TrainSpec -> timed stops, 待避 solved to a fixpoint
 *   dutyMatch.ts  minimum path cover  ->  one chain per vehicle-day
 *   depotRuns.ts  bracket every chain with a 出庫 / 入庫 回送
 *   trackAssign.ts every stop gets a 番線
 *   (here)        formations, assignments, inspection history, the document
 *
 * Determinism is a hard requirement and is achieved structurally, not by
 * convention: there is no `Date.now()`, no `Math.random()` and no `Date` object
 * anywhere in the path; every id comes from a monotonic counter created fresh
 * inside this function; every sort has a total-order tiebreak. Building twice
 * produces byte-identical output, and `index.test.ts` asserts exactly that.
 */

import { ID_PREFIX, makeIdFactory } from '@/domain/ids';
import type {
  AssignmentId,
  StationTrackId,
  DutyId,
  FormationId,
  InspectionRecordId,
  StationId,
  TrainId,
} from '@/domain/ids';
import type {
  Assignment,
  Duty,
  DutyLeg,
  Formation,
  InspectionRecord,
  ProjectDocument,
  Train,
} from '@/domain/model';
import { createEmptyProject, DEFAULT_VALIDATION_CONFIG } from '@/domain/project';
import { addDays, daysBetween } from '@/domain/time';
import { entitiesFrom, type Sec } from '@/domain/units';
import { SeedError } from './errors';
import { buildFacts, CARS, SERIES_SPECS, type Facts, type SeriesSpec } from './oimachi/facts';
import { buildServicePlan } from './oimachi/service';
import { expandBands } from './generator/expand';
import { buildStopTimes, toTrainStops } from './generator/stopTimes';
import {
  TrackBooking,
  type AssignableTrain,
  type Routing,
  type TurnbackLink,
} from './generator/trackAssign';
import { minimumPathCover, type DutyNode } from './generator/dutyMatch';
import {
  buildDepotRuns,
  checkDepotCapacity,
  DEPOT_TURN_MARGIN_SEC,
  type DepotRunPins,
} from './generator/depotRuns';

/** Beyond this a formation goes back to the depot instead of waiting. */
const MAX_LAYOVER_SEC = 2400;
/**
 * 大井町 is 頭端式1面2線 — two dead-end roads, no siding, no tail track — so a
 * formation waiting there is a platform out of service. Two roads at 50 s of
 * approach + clear absorb `2 × 3600 / (layover + 50)` turnbacks an hour; ten
 * minutes therefore supports 11 本/時 per road, comfortably above the 20 本/時
 * the 朝ラッシュ asks of the pair. Anything longer runs 入庫 to 鷺沼 instead.
 */
const OIMACHI_MAX_LAYOVER_SEC = 1000;
/**
 * The same question at 溝の口, where the answer is set by the two 引上線.
 *
 * A shunted 折り返し books a tail track for the whole layover plus a minute of
 * yard margin either side, and there are two of them: at 16 本/時 the pair can
 * absorb `2 × 900 / (layover + 120)` of the four turnbacks in each 15-minute
 * cycle. Two of the four fit comfortably at a quarter-hour layover; a formation
 * wanting longer than that would take a tail track out of circulation for two
 * whole cycles and push the next 各停 onto a platform face. Fifteen minutes is
 * therefore the cut-off, and a chain that wants more runs 入庫 to 鷺沼 — eight
 * minutes away, and where a formation standing still costs nothing.
 */
const MIZONOKUCHI_MAX_LAYOVER_SEC = 960;
/** A layover longer than this becomes an explicit `stable` leg in the duty. */
const STABLE_LEG_MIN_SEC = 1200;
/**
 * At a station that HAS a 引上線, a turnback longer than this is shunted into
 * it instead of standing on the platform.
 *
 * That is what the two 溝の口 引上線 are for, and modelling it is what makes the
 * terminal work: only two of 溝の口's four faces belong to the 大井町線, and
 * three 大井町線 trains turn back there every cycle. Holding each of them on a
 * platform for its whole layover needs 2.7 roads and there are two. Seven
 * minutes is the threshold because below it the two shunt moves would cost more
 * than the wait saves.
 */
const SHUNT_TO_SIDING_MIN_SEC = 420;
/** Depot time a formation needs between two duties on the same day. */
const BETWEEN_DUTIES_SEC = 1800;
/** Reconstruction: average daily mileage, used to back-date odometer readings. */
const DAILY_KM = 340;

export interface BuildReport {
  serviceTrains: number;
  deadheadTrains: number;
  duties: number;
  formations: number;
  solverPasses: number;
  resolvedOvertakes: number;
  skippedOvertakesAtBandEdge: number;
  maxOvertakeWaitSec: number;
  trackFallbacks: number;
  /** Chains cut because a terminal had no road free to hold the formation. */
  terminalCuts: number;
  /** `stable` legs left without a road because the station had none free. */
  unberthedStableLegs: number;
  /** Largest shift a 回送 needed to find a clear path, in seconds. */
  maxDepotShiftSec: number;
  depotPeakStabled: number;
  depotCapacityExceeded: boolean;
  perBand: Array<{ bandId: string; name: string; trains: number; down: number; up: number; tph: number }>;
}

let lastReport: BuildReport | undefined;

/** Diagnostics from the most recent `buildOimachiProject()` call. */
export function lastBuildReport(): BuildReport | undefined {
  return lastReport;
}

export function buildOimachiProject(): ProjectDocument {
  const base = createEmptyProject({
    name: '東急大井町線 平日ダイヤ',
    lineName: '大井町線',
  });
  const activeDate = base.settings.activeDate;

  const facts = buildFacts();
  const plan = buildServicePlan(facts);

  const nextTrainId = makeIdFactory(ID_PREFIX.train);
  const nextDutyId = makeIdFactory(ID_PREFIX.duty);
  const nextFormationId = makeIdFactory(ID_PREFIX.formation);
  const nextAssignmentId = makeIdFactory(ID_PREFIX.assignment);
  const nextRecordId = makeIdFactory(ID_PREFIX.inspectionRecord);

  // -- 1. trains ------------------------------------------------------------
  const specs = expandBands(plan.bands, plan.patterns, () => nextTrainId<'Train'>());
  const timed = buildStopTimes(facts, specs);

  const serviceTrains: Train[] = specs.map((spec) => {
    const t = timed.trains.get(spec.key);
    if (t === undefined) throw new SeedError('missing timed train', { key: spec.key });
    const train: Train = {
      id: spec.trainId,
      number: spec.number,
      typeId: spec.trainTypeId,
      direction: spec.direction,
      category: 'service',
      patternId: spec.stopPatternId,
      stops: toTrainStops(t),
      dayTypeIds: [facts.dayTypeId],
      minCars: spec.cars,
      origin: {
        generator: 'seed',
        bandId: spec.bandId,
        slotId: spec.slotId,
        cycleIndex: spec.cycleIndex,
      },
      ...(spec.slot.note === undefined ? {} : { note: spec.slot.note }),
    };
    return train;
  });

  // -- 2. duty chains -------------------------------------------------------
  // Chains are solved BEFORE the 番線, not after. Which arrival works which
  // departure is what decides whether a formation reverses in place or has to
  // cross to the other face of the platform, and at 大井町 — 頭端式1面2線, no
  // tail track — it cannot cross. The 構内ダイヤ therefore has to be built
  // knowing the roster, not the other way round.
  const nodes: DutyNode[] = serviceTrains.map((train, i) => {
    const spec = specs[i]!;
    const first = train.stops[0]!;
    const last = train.stops[train.stops.length - 1]!;
    if (first.dep === undefined || last.arr === undefined) {
      throw new SeedError('service train has no origin departure or terminus arrival', {
        number: train.number,
      });
    }
    return {
      trainId: train.id,
      key: spec.key,
      originStationId: first.stationId,
      terminusStationId: last.stationId,
      depSec: first.dep,
      arrSec: last.arr,
      cars: spec.cars,
      routing: routingOf(train, facts),
    };
  });

  /**
   * 折り返し時分 for duty matching. Deliberately the *preferred* figure, not the
   * bare minimum: `minTurnbackSec` is what the infrastructure allows, but a
   * roster that books every turnback at the absolute minimum has no recovery
   * margin anywhere and trips `turnback.tight` on every single one. Taking the
   * larger of the two costs a formation or two and buys a plan that a real
   * depot would sign off.
   */
  const preferredTurnback = Math.max(
    DEFAULT_VALIDATION_CONFIG.preferredTurnbackSec,
    base.validationConfig.preferredTurnbackSec,
  );
  const turnaroundSec = (stationId: StationId): number =>
    Math.max(
      facts.stationById.get(stationId)?.minTurnbackSec ??
        DEFAULT_VALIDATION_CONFIG.defaultMinTurnbackSec,
      preferredTurnback,
    );

  /**
   * How long a formation may stand at a terminal before the plan sends it home
   * instead. A layover is not free: it books a road for its whole length.
   *
   * 大井町 is the binding case. Two dead-end platform roads, no siding, no tail
   * track — so with an approach/clear margin of 50 s the terminal can absorb
   * `2 × 3600 / (layover + 50)` turnbacks an hour and not one more. At the peak
   * density that leaves room for about ten minutes, and anything longer has to
   * leave: the chain is cut and the formation runs 入庫 to 鷺沼. Everywhere
   * else there is either a 引上線 (溝の口) or plenty of platform (鷺沼), so the
   * old blanket 40 minutes still applies.
   */
  const terminalLayoverCap = (stationId: StationId): number => {
    if (stationId === facts.S.oimachi) return OIMACHI_MAX_LAYOVER_SEC;
    if (stationId === facts.S.mizonokuchi) return MIZONOKUCHI_MAX_LAYOVER_SEC;
    return MAX_LAYOVER_SEC;
  };

  const pools: Array<{ cars: number; chains: DutyNode[][] }> = [CARS.express, CARS.local].map(
    (cars) => ({
      cars,
      chains: minimumPathCover(
        nodes.filter((n) => n.cars === cars),
        { turnaroundSec, maxLayoverSec: terminalLayoverCap },
      ).chains,
    }),
  );

  // The pools are solved independently but they share the terminal, so the
  // road count has to be enforced across both of them at once.
  const terminalCuts = enforceTerminalCapacity(pools, facts, nodes);


  // -- 3. 番線 for the service pattern -------------------------------------
  // Service trains are booked first, as a block: they are the timetable, and
  // the empty moves have to fit around them rather than the other way round.
  // Each short turnback inside a chain is booked as ONE occupation of ONE road:
  // the formation reverses in place, which is the only thing a stub terminal
  // can do.
  const typeById = new Map(facts.trainTypes.map((t) => [t.id, t]));
  const saginumaStationId = facts.depots[0]!.stationId;
  const booking = new TrackBooking(facts);
  const assignables = new Map<TrainId, AssignableTrain>();
  for (const train of serviceTrains) {
    assignables.set(train.id, toAssignable(train, typeById, facts));
  }
  /**
   * How long a formation may stand on the platform road it arrived at before
   * the plan moves it out of the way. Where a 引上線 exists that is the seven
   * minutes above; where none does — 大井町 — the only thing a formation can do
   * is sit on the platform, so the threshold is the full `stable` leg limit and
   * `OIMACHI_MAX_LAYOVER_SEC` is what keeps that bounded.
   */
  const berthAfterSec = (stationId: StationId): number =>
    (facts.tracksOf.get(stationId) ?? []).some((t) => t.usage === 'stabling')
      ? SHUNT_TO_SIDING_MIN_SEC
      : STABLE_LEG_MIN_SEC;

  /**
   * Road a chain end has to hold for its own empty move. The 出庫 arrives, the
   * stock reverses, the first service train leaves — one occupation of one
   * road, exactly like a service turnback, and it has to be reserved during
   * the sweep or the road will already be gone when the 回送 is pathed.
   */
  const CHAIN_END_RESERVE_SEC = DEPOT_TURN_MARGIN_SEC;
  /**
   */
  for (const pool of pools) {
    for (const chain of pool.chains) {
      const first = chain[0]!;
      const head = assignables.get(first.trainId);
      const headStation = head?.stops[0]!.stationId;
      if (head !== undefined && headStation !== undefined && headStation !== saginumaStationId) {
        head.reserveBeforeOriginSec = CHAIN_END_RESERVE_SEC;
      }
      const last = chain[chain.length - 1]!;
      const tail = assignables.get(last.trainId);
      const tailStation = tail?.stops[tail.stops.length - 1]!.stationId;
      if (tail !== undefined && tailStation !== undefined) {
        tail.reserveAfterTerminusSec = CHAIN_END_RESERVE_SEC;
      }
    }
  }

  /**
   * How every 折り返し inside a chain is actually worked.
   *
   * Two plans, and the difference is the 引上線:
   *
   * - **In place.** The formation reverses on the road it arrived at and stands
   *   there for the whole layover. One road, one continuous occupation. It is
   *   the only thing 大井町 can do, and it is what 溝の口 does when the tail
   *   tracks are full.
   * - **Shunted.** 溝の口 is 島式2面4線 — 2・3番線 are the 大井町線 faces, the
   *   構内図 marks 2番線 降車専用 and 3番線 大井町方面 — plus two 引上線 on the
   *   梶が谷 side. The formation berths at 2番線, empties, shunts out to a 引上線
   *   for the body of the layover and comes back into 3番線 to load. That is
   *   what the tail tracks are *for*: a turning train does not squat on a
   *   platform. Each platform face is then held for fifty seconds instead of a
   *   quarter of an hour.
   *
   * Which one a link gets is decided here, before the 番線 sweep, because the
   * sweep has to know whether the arrival and the departure are one occupation
   * or two. A tail track is claimed first-come-first-served in arrival order —
   * the order a real 信号扱所 would work in — and a link that cannot get one
   * reverses in place. At 16 本/時 that leaves the 急行, whose layover is the
   * longest, standing on 3番線 while the two 各停 either side of it use the
   * 引上線: two tail tracks cannot hold three quarter-hour layovers.
   */
  interface ShuntPlan {
    stationId: StationId;
    trackId: StationTrackId;
    from: Sec;
    to: Sec;
  }
  /** Keyed by the ARRIVING train of the link. */
  const shuntedLinks = new Map<TrainId, ShuntPlan>();
  const turnbackLinks: TurnbackLink[] = [];
  const chainLinks: Array<{ a: DutyNode; b: DutyNode; cars: number }> = [];
  for (const pool of pools) {
    for (const chain of pool.chains) {
      for (let i = 0; i + 1 < chain.length; i++) {
        const a = chain[i]!;
        const b = chain[i + 1]!;
        if (a.terminusStationId !== b.originStationId) continue;
        chainLinks.push({ a, b, cars: pool.cars });
      }
    }
  }
  chainLinks.sort(
    (x, y) => x.a.arrSec - y.a.arrSec || x.a.trainId.localeCompare(y.a.trainId),
  );
  for (const { a, b, cars } of chainLinks) {
    const layover = b.depSec - a.arrSec;
    if (layover >= SHUNT_TO_SIDING_MIN_SEC) {
      const trackId = booking.placeBerth(
        a.terminusStationId,
        a.trainId,
        cars,
        a.routing,
        a.arrSec,
        b.depSec,
        { sidingOnly: true },
      );
      if (trackId !== undefined) {
        shuntedLinks.set(a.trainId, {
          stationId: a.terminusStationId,
          trackId,
          from: a.arrSec,
          to: b.depSec,
        });
        continue;
      }
    }
    turnbackLinks.push({ arrivingTrainId: a.trainId, departingTrainId: b.trainId });
    // Authored intent, for the 折り返し dwell reason and the yard view. The
    // occupancy model deliberately does not depend on it — see occupancy.ts.
    const arriving = assignables.get(a.trainId)!.stops;
    arriving[arriving.length - 1]!.operation = 'turnback';
  }
  booking.placeSweep([...assignables.values()], turnbackLinks);

  // -- 4. depot runs + duties ----------------------------------------------
  const saginuma = facts.depots[0]!;
  let deadheadSeq = 9001;
  const nextDeadheadNumber = (): string => `回${deadheadSeq++}`;
  const deadheadTrains: Train[] = [];
  const duties: Duty[] = [];
  const dutySpans: Array<{ dutyId: DutyId; cars: number; from: Sec; to: Sec }> = [];
  let maxDepotShiftSec = 0;
  let unberthed = 0;

  /**
   * A `stable` leg is a formation standing on a specific road, so it has to
   * name one — 96 of them named none, which meant 96 stabled formations that
   * occupied nothing and conflicted with nobody. `placeBerth` books a 引上線
   * where the station has one and reports failure where it does not, and a
   * berth it cannot find is an error rather than a silence.
   */
  const berth = (
    stationId: StationId,
    trainId: TrainId,
    cars: number,
    routing: Routing,
    from: Sec,
    to: Sec,
    holdTrackId?: StationTrackId,
  ): DutyLeg => {
    const trackId = booking.placeBerth(stationId, trainId, cars, routing, from, to);
    if (trackId === undefined && holdTrackId !== undefined) {
      // Nowhere to shunt to: the formation stays on the road it arrived at,
      // which is what really happens and is booked accordingly.
      if (booking.extendBooking(holdTrackId, trainId, from, to)) {
        return { kind: 'stable', stationId, trackId: holdTrackId, from, to };
      }
    }
    if (trackId === undefined) {
      // No road anywhere: the formation stays where it is and the occupancy
      // model holds the arrival road, which is the honest reading and will be
      // reported by `track.doubleOccupancy` if it genuinely does not fit.
      unberthed++;
      return { kind: 'stable', stationId, from, to };
    }
    return { kind: 'stable', stationId, trackId, from, to };
  };

  /**
   * A berth on a road the same formation is already standing on — the road an
   * empty move arrived at, or the one it will leave from. Falls back to a free
   * road when the pinned one is wanted by somebody else.
   */
  const berthOn = (
    stationId: StationId,
    trackId: StationTrackId | undefined,
    holderTrainId: TrainId,
    prevTrainId: TrainId,
    cars: number,
    routing: Routing,
    from: Sec,
    to: Sec,
  ): DutyLeg => {
    if (trackId !== undefined && booking.extendBooking(trackId, holderTrainId, from, to)) {
      return { kind: 'stable', stationId, trackId, from, to };
    }
    return berth(stationId, prevTrainId, cars, routing, from, to, trackId);
  };

  for (const pool of pools) {
    const suffix = pool.cars === CARS.express ? 'Q' : 'K';
    pool.chains.forEach((chain, index) => {
      const first = chain[0]!;
      const last = chain[chain.length - 1]!;
      const firstStops = assignables.get(first.trainId)!.stops;
      const lastStops = assignables.get(last.trainId)!.stops;
      const firstTrackId = firstStops[0]!.trackId;
      const lastTrackId = lastStops[lastStops.length - 1]!.trackId;
      // The empty moves reverse in place against the chain they bracket, just
      // like two service trains do: one formation, one road.
      const pins: DepotRunPins = {};
      if (firstTrackId !== undefined) {
        pins.outTerminus = { trainId: first.trainId, trackId: firstTrackId, at: first.depSec };
      }
      if (lastTrackId !== undefined) {
        pins.inOrigin = { trainId: last.trainId, trackId: lastTrackId, at: last.arrSec };
      }

      const runs = buildDepotRuns(
        {
          facts,
          depot: saginuma,
          booking,
          nextTrainId: () => nextTrainId<'Train'>(),
          nextNumber: nextDeadheadNumber,
        },
        chain,
        pool.cars,
        pins,
      );
      maxDepotShiftSec = Math.max(maxDepotShiftSec, runs.outShiftSec, runs.inShiftSec);
      deadheadTrains.push(runs.out, runs.in);

      const legs: DutyLeg[] = [{ kind: 'train', trainId: runs.out.id }];
      const outLast = runs.out.stops[runs.out.stops.length - 1]!;
      let prevEnd: Sec = outLast.arr ?? outLast.dep ?? runs.fromSec;
      let prevStation: StationId = outLast.stationId;
      let prevTrainId: TrainId = runs.out.id;
      let prevRouting: Routing = 'om';
      let prevTrackId: StationTrackId | undefined = outLast.trackId;

      // Where the 出庫 could not take the road its first train leaves from, the
      // formation has to stand somewhere else in between, and the plan has to
      // say where.
      const outTrackId = outLast.trackId;
      const outShunted = outTrackId !== undefined && outTrackId !== firstTrackId;

      chain.forEach((node, nodeIndex) => {
        const wait = node.depSec - prevEnd;
        if (nodeIndex === 0) {
          // The 出庫 is pinned to the road its first train leaves from, so the
          // wait after it needs no berth of its own — it is already booked.
          if (wait >= berthAfterSec(prevStation) || (outShunted && wait > 0)) {
            legs.push(
              berthOn(
                prevStation,
                outShunted ? outTrackId : firstTrackId,
                runs.out.id,
                prevTrainId,
                pool.cars,
                prevRouting,
                prevEnd,
                node.depSec,
              ),
            );
          }
        } else {
          // A 折り返し inside the chain: either the tail track claimed above, or
          // an in-place reversal, in which case the road is the one the arriving
          // train is already standing on and the leg only records the fact.
          const shunt = shuntedLinks.get(prevTrainId);
          if (shunt !== undefined) {
            legs.push({
              kind: 'stable',
              stationId: shunt.stationId,
              trackId: shunt.trackId,
              from: shunt.from,
              to: shunt.to,
            });
          } else if (wait >= STABLE_LEG_MIN_SEC && prevTrackId !== undefined) {
            legs.push({
              kind: 'stable',
              stationId: prevStation,
              trackId: prevTrackId,
              from: prevEnd,
              to: node.depSec,
            });
          }
        }
        legs.push({ kind: 'train', trainId: node.trainId });
        prevEnd = node.arrSec;
        prevStation = node.terminusStationId;
        prevTrainId = node.trainId;
        prevRouting = node.routing;
        const nodeStops = assignables.get(node.trainId)!.stops;
        prevTrackId = nodeStops[nodeStops.length - 1]!.trackId;
      });

      const inFirst = runs.in.stops[0]!;
      const inDep = inFirst.dep ?? inFirst.arr ?? prevEnd + DEPOT_TURN_MARGIN_SEC;
      const inShunted = inFirst.trackId !== undefined && inFirst.trackId !== lastTrackId;
      const inWait = inDep - prevEnd;
      if (inWait >= berthAfterSec(prevStation) || (inShunted && inWait > 0)) {
        // Likewise the 入庫 is pinned to the road its last train arrived on —
        // unless it could not be, in which case the berth is the road it did
        // find, so the shunt out of the platform is in the plan.
        legs.push(
          berthOn(
            prevStation,
            inShunted ? inFirst.trackId : lastTrackId,
            inShunted ? runs.in.id : prevTrainId,
            prevTrainId,
            pool.cars,
            prevRouting,
            prevEnd,
            inDep,
          ),
        );
      }
      legs.push({ kind: 'train', trainId: runs.in.id });

      const dutyId = nextDutyId<'Duty'>();
      duties.push({
        id: dutyId,
        code: `${String(index + 1).padStart(2, '0')}${suffix}`,
        dayTypeIds: [facts.dayTypeId],
        legs,
        requiredCars: pool.cars,
      });
      dutySpans.push({ dutyId, cars: pool.cars, from: runs.fromSec, to: runs.toSec });
    });
  }

  const allTrains: Train[] = [...serviceTrains, ...deadheadTrains];
  for (const train of allTrains) {
    for (const stop of train.stops) {
      if (stop.trackId === undefined) {
        throw new SeedError('番線が未割当のまま残りました', { number: train.number });
      }
    }
  }

  // -- 5. formations --------------------------------------------------------
  const { formations, assignments } = buildFleet(
    dutySpans,
    activeDate,
    () => nextFormationId<'Formation'>(),
    () => nextAssignmentId<'Assignment'>(),
    facts,
  );

  // -- 6. inspection history ------------------------------------------------
  const inspectionRecords = buildInspectionHistory(
    facts,
    formations,
    activeDate,
    () => nextRecordId<'InspectionRecord'>(),
  );

  // -- 7. report ------------------------------------------------------------
  const capacity = checkDepotCapacity(saginuma, formations.length, 0);
  lastReport = {
    serviceTrains: serviceTrains.length,
    deadheadTrains: deadheadTrains.length,
    duties: duties.length,
    formations: formations.length,
    solverPasses: timed.passes,
    resolvedOvertakes: timed.resolvedOvertakes,
    skippedOvertakesAtBandEdge: timed.skippedAtBandEdge,
    maxOvertakeWaitSec: timed.maxWaitSec,
    trackFallbacks: booking.fallbacks,
    terminalCuts,
    unberthedStableLegs: unberthed,
    maxDepotShiftSec,
    depotPeakStabled: capacity.peakStabled,
    depotCapacityExceeded: capacity.exceeded,
    perBand: plan.bands.map((band) => {
      const inBand = serviceTrains.filter((t) => t.origin?.bandId === band.id);
      const down = inBand.filter((t) => t.direction === 'down').length;
      const hours = (band.toSec - band.fromSec) / 3600;
      return {
        bandId: band.id,
        name: band.name,
        trains: inBand.length,
        down,
        up: inBand.length - down,
        tph: Math.round((down / hours) * 10) / 10,
      };
    }),
  };

  // -- 8. the document ------------------------------------------------------
  return {
    ...base,
    meta: {
      ...base.meta,
      id: 'project-oimachi',
      name: '東急大井町線 平日ダイヤ',
    },
    settings: { ...base.settings, timeGrainSec: 5 },
    validationConfig: {
      ...base.validationConfig,
      defaultMinHeadwaySec: 90,
      defaultMinTurnbackSec: 180,
      preferredTurnbackSec: 300,
      connectionMaxWaitSec: 600,
      overtakeClearanceSec: 30,
    },
    line: facts.line,
    stations: entitiesFrom(facts.stations),
    stationTracks: entitiesFrom(facts.tracks),
    links: entitiesFrom(facts.links),
    perfProfiles: entitiesFrom(facts.perfProfiles),
    linkRunTimes: facts.linkRunTimes,
    depots: entitiesFrom(facts.depots),
    trainTypes: entitiesFrom(facts.trainTypes),
    stopPatterns: entitiesFrom(facts.stopPatterns),
    trains: entitiesFrom(allTrains),
    duties: entitiesFrom(duties),
    formationSeries: entitiesFrom(facts.formationSeries),
    formations: entitiesFrom(formations),
    inspectionRules: entitiesFrom(facts.inspectionRules),
    inspectionRecords: entitiesFrom(inspectionRecords),
    calendar: [{ date: activeDate, dayTypeId: facts.dayTypeId }],
    assignments: entitiesFrom(assignments),
  };
}

/**
 * Cut chains until every terminal's road count is enough to hold the plan.
 *
 * The path cover minimises the fleet; it has no idea how many roads a station
 * has. At 大井町 — two dead-end roads and no siding — the band transitions
 * produce moments where three or four formations would be standing at once,
 * mostly because the 早朝 20-minute cycle and the 立上り 15-minute cycle do not
 * mesh and the terminal briefly takes in more than it sends out.
 *
 * A terminal that is full does exactly one thing: it sends stock home. Cutting
 * the longest layover across the busiest instant is that decision — the chain
 * splits, `buildDepotRuns` brackets each half with its own 回送, and the
 * formation runs 入庫 to 鷺沼 instead of blocking a platform. Iterating from the
 * longest layover means the plan gives up the least useful occupation first.
 */
function enforceTerminalCapacity(
  pools: ReadonlyArray<{ cars: number; chains: DutyNode[][] }>,
  facts: Facts,
  nodes: readonly DutyNode[],
): number {
  const capacity = new Map<StationId, number>();
  for (const station of facts.stations) {
    const tracks = facts.tracksOf.get(station.id) ?? [];
    // A road that can hold a reversing formation. Sidings count; through roads
    // with no turnback capability do not.
    const usable = tracks.filter((t) => t.canTurnBack).length;
    if (usable > 0 && usable <= 3) capacity.set(station.id, usable);
  }

  const marginOf = (stationId: StationId): { approach: number; clear: number } => {
    const tracks = facts.tracksOf.get(stationId) ?? [];
    return {
      approach: Math.max(0, ...tracks.map((t) => t.approachSec)),
      clear: Math.max(0, ...tracks.map((t) => t.clearSec)),
    };
  };

  interface Item {
    from: Sec;
    to: Sec;
    /** Set only for a link that can be cut. */
    ref?: { chain: DutyNode[]; index: number; layover: number };
  }

  let cuts = 0;
  for (const [stationId, roads] of capacity) {
    const { approach, clear } = marginOf(stationId);
    for (;;) {
      const items: Item[] = [];
      const linked = new Set<string>();
      for (const pool of pools) {
        for (const chain of pool.chains) {
          for (let i = 0; i + 1 < chain.length; i++) {
            const a = chain[i]!;
            const b = chain[i + 1]!;
            if (a.terminusStationId !== stationId) continue;
            linked.add(a.trainId);
            linked.add(b.trainId);
            items.push({
              from: a.arrSec - approach,
              to: b.depSec + clear,
              ref: { chain, index: i, layover: b.depSec - a.arrSec },
            });
          }
        }
      }
      // A chain end wants extra road time for its own empty move, but that is
      // a preference the sweep gives up when it has to (see `Event.wanted`),
      // so counting it here would cut chains to make room for something that
      // will simply not be booked. Only the train's own stop is counted.
      for (const n of nodes) {
        if (n.terminusStationId === stationId && !linked.has(n.trainId)) {
          items.push({ from: n.arrSec - approach, to: n.arrSec + clear });
        }
        if (n.originStationId === stationId && !linked.has(n.trainId)) {
          items.push({ from: n.depSec - approach, to: n.depSec + clear });
        }
      }

      // Only an item's own start can raise the count, so those are the only
      // instants worth probing. Work through the overloaded ones worst-first:
      // the busiest moment may be made entirely of occupations that cannot be
      // cut (a chain end holding a road for its own empty move), and the next
      // one down may still have a link to give up.
      const over: Array<{ at: Sec; n: number }> = [];
      for (const probe of items) {
        let n = 0;
        for (const it of items) if (it.from <= probe.from && probe.from < it.to) n++;
        if (n > roads) over.push({ at: probe.from, n });
      }
      if (over.length === 0) break;
      over.sort((a, b) => b.n - a.n || a.at - b.at);

      let victim: Item | undefined;
      for (const spot of over) {
        for (const it of items) {
          if (it.ref === undefined) continue;
          // Cutting is only worth it when the link is longer than the two
          // chain-end reservations that replace it: below that the 入庫 and the
          // next 出庫 hold the road for longer than simply waiting would.
          if (it.ref.layover < 2 * DEPOT_TURN_MARGIN_SEC) continue;
          if (!(it.from <= spot.at && spot.at < it.to)) continue;
          if (victim === undefined || it.ref.layover > victim.ref!.layover) victim = it;
        }
        if (victim !== undefined) break;
      }
      if (victim === undefined) break; // nothing cuttable: a real, reported error
      const { chain, index } = victim.ref!;
      const tail = chain.splice(index + 1);
      for (const pool of pools) {
        if (pool.chains.includes(chain)) pool.chains.push(tail);
      }
      cuts++;
    }
  }

  for (const pool of pools) {
    pool.chains.sort(
      (a, b) => a[0]!.depSec - b[0]!.depSec || a[0]!.trainId.localeCompare(b[0]!.trainId),
    );
  }
  return cuts;
}

/** 青各停 work the 田園都市線 pair through the 二子玉川〜溝の口 quad section. */
function routingOf(train: Train, facts: Facts): Routing {
  return train.typeId === facts.type.localBlue ? 'dt' : 'om';
}

function toAssignable(
  train: Train,
  typeById: ReadonlyMap<string, { shortName: string; isPassengerService: boolean }>,
  facts: Facts,
): AssignableTrain {
  const type = typeById.get(train.typeId);
  return {
    trainId: train.id,
    label: `${type?.shortName ?? '?'} ${train.number}`,
    direction: train.direction,
    cars: train.minCars ?? CARS.local,
    routing: routingOf(train, facts),
    isPassenger: type?.isPassengerService ?? true,
    preferStablingAtOrigin: train.stops[train.stops.length - 1]?.operation === 'depotIn',
    stops: train.stops,
  };
}

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

interface FleetSlot {
  formationId: FormationId;
  cars: number;
  freeAt: Sec;
  dutyIds: DutyId[];
}

/**
 * Formations, and which duty each one works.
 *
 * A duty is one vehicle-*day-fragment*, not a vehicle: a formation that works
 * the 朝ラッシュ, goes back to 鷺沼 for the morning and comes out again at 16:00
 * is two duties and one formation, which is how the real roster works. Greedy
 * interval packing over the duty spans therefore gives exactly the peak
 * concurrent fleet, and the listed 6000/6020/9000/9020 numbers are extended
 * only if the timetable genuinely needs more.
 */
function buildFleet(
  spans: ReadonlyArray<{ dutyId: DutyId; cars: number; from: Sec; to: Sec }>,
  activeDate: string,
  nextFormationId: () => FormationId,
  nextAssignmentId: () => AssignmentId,
  facts: Facts,
): {
  formations: Formation[];
  assignments: Assignment[];
  fleetByCars: Record<number, number>;
} {
  const formations: Formation[] = [];
  const assignments: Assignment[] = [];
  const fleetByCars: Record<number, number> = {};

  for (const cars of [CARS.express, CARS.local]) {
    const mine = spans
      .filter((s) => s.cars === cars)
      .sort((a, b) => a.from - b.from || a.dutyId.localeCompare(b.dutyId));

    const slots: FleetSlot[] = [];
    for (const span of mine) {
      let slot = slots.find((s) => s.freeAt + BETWEEN_DUTIES_SEC <= span.from);
      if (slot === undefined) {
        slot = {
          formationId: '' as FormationId,
          cars,
          freeAt: Number.NEGATIVE_INFINITY,
          dutyIds: [],
        };
        slots.push(slot);
      }
      slot.freeAt = span.to;
      slot.dutyIds.push(span.dutyId);
    }

    // 予備編成. One 7-car spare is what the real depot keeps for eight sets;
    // the 5-car pool is larger and carries two.
    const spares = cars === CARS.express ? 1 : 2;
    const fleet = allocateCodes(cars, slots.length + spares);
    fleetByCars[cars] = fleet.length;

    fleet.forEach((entry, i) => {
      const id = nextFormationId();
      const commissionedOn = entry.commissionedOn;
      const inService = Math.max(1, daysBetween(commissionedOn, activeDate));
      // The last spare of each pool is in the shops today — every depot has one.
      const inShops = i === fleet.length - 1;
      formations.push({
        id,
        code: entry.code,
        seriesId: facts.seriesId[entry.seriesKey]!,
        cars,
        homeDepotId: facts.depotId.saginuma,
        status: inShops ? 'inInspection' : 'active',
        // Reconstruction: mileage implied by age at the daily average, with a
        // deterministic per-formation offset so the fleet is not uniform.
        odometerKm: Math.round(inService * DAILY_KM * 0.92) + i * 4_300,
        odometerAsOf: activeDate,
        commissionedOn,
        note: inShops ? '長津田検車区所属 / 鷺沼常駐 / 月検査入場中' : '長津田検車区所属 / 鷺沼常駐',
      });
      const slot = slots[i];
      if (slot === undefined) return; // spare
      slot.formationId = id;
      for (const dutyId of slot.dutyIds) {
        assignments.push({ id: nextAssignmentId(), date: activeDate, dutyId, formationId: id });
      }
    });
  }

  return { formations, assignments, fleetByCars };
}

interface FleetEntry {
  seriesKey: string;
  code: string;
  commissionedOn: string;
}

/**
 * The listed fleet for a car count, extended by continuing the numbering of
 * its largest series if the timetable needs more sets than really exist.
 */
function allocateCodes(cars: number, needed: number): FleetEntry[] {
  const pool: SeriesSpec[] = SERIES_SPECS.filter((s) => s.cars === cars);
  const out: FleetEntry[] = [];
  for (const series of pool) {
    for (const code of series.codes) {
      out.push({ seriesKey: series.key, code, commissionedOn: series.commissionedOn });
    }
  }
  if (out.length >= needed) return out.slice(0, needed);

  const biggest = pool.reduce((a, b) => (b.codes.length > a.codes.length ? b : a), pool[0]!);
  const lastCode = biggest.codes[biggest.codes.length - 1]!;
  const stem = lastCode.slice(0, -1); // strip the trailing 'F'
  let n = Number(stem);
  while (out.length < needed) {
    n += 1;
    out.push({
      seriesKey: biggest.key,
      code: `${n}F`,
      commissionedOn: biggest.commissionedOn,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inspection history
// ---------------------------------------------------------------------------

/**
 * Deterministically staggered history, so the demo opens on a realistic spread
 * of 期限内 and 期限間近 with no randomness anywhere.
 *
 * Formation *i*'s last 列車検査 was `1 + (4i mod 9)` days ago against a ten-day
 * interval, so about a fifth of the fleet is inside the two-day warning window
 * on any given morning; the other three kinds use co-prime strides against
 * moduli chosen to land just short of their own limits, which puts a handful of
 * formations into 期限間近 on days, on kilometres, or both.
 *
 * Nothing in the *rostered* fleet is deliberately overdue. An overdue
 * inspection is a validation **error**, and a sample project that ships with
 * errors is not a sample, it is a bug report. The state the demo needs — "this
 * formation is in the shops today" — is expressed the way a real depot expresses
 * it: the formation is `inInspection`, carries a **planned** record spanning the
 * date, and is not rostered. `buildFleet` reserves the spares for exactly that.
 *
 * The moduli also leave room for the day's own mileage: `computeInspectionStatus`
 * derives current km as the baseline plus today's assigned duty, so a formation
 * one day short of its 30,000 km 月検査 limit would tip over during the day.
 */
function buildInspectionHistory(
  facts: Facts,
  formations: readonly Formation[],
  activeDate: string,
  nextRecordId: () => InspectionRecordId,
): InspectionRecord[] {
  const strides: Record<string, number> = { train: 4, monthly: 11, bogie: 197, general: 389 };
  const moduli: Record<string, number> = { train: 9, monthly: 82, bogie: 1_420, general: 2_870 };
  const out: InspectionRecord[] = [];

  formations.forEach((formation, i) => {
    const maxAge = Math.max(1, daysBetween(formation.commissionedOn, activeDate));
    for (const rule of facts.inspectionRules) {
      const stride = strides[rule.kind] ?? 7;
      const modulus = moduli[rule.kind] ?? 30;
      const depotId = rule.depotIds[0] ?? facts.depotId.saginuma;

      if (formation.status === 'inInspection' && rule.kind === 'monthly') {
        // In the shops today: a planned record spanning the active date.
        out.push({
          id: nextRecordId(),
          formationId: formation.id,
          ruleId: rule.id,
          kind: rule.kind,
          status: 'planned',
          from: activeDate,
          to: addDays(activeDate, rule.outOfServiceDays),
          depotId,
          note: '入場中',
        });
      }

      // `1 +` matters: a completed inspection dated today, on a formation that
      // is also rostered today, is a 検査と運用の重複 error.
      const daysAgo = Math.min(1 + (((i + 1) * stride) % modulus), maxAge);
      const on = addDays(activeDate, -daysAgo);
      out.push({
        id: nextRecordId(),
        formationId: formation.id,
        ruleId: rule.id,
        kind: rule.kind,
        status: 'completed',
        from: on,
        to: on,
        odometerKmAt: Math.max(0, formation.odometerKm - daysAgo * DAILY_KM),
        depotId,
      });
    }
  });

  return out;
}

export { projectDigest, type SeedDigest } from './digest';
export { SeedError } from './errors';

// Exported so tests can reach the pieces without rebuilding the whole project.
export type { TrainId };
