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
import { TrackBooking, type AssignableTrain } from './generator/trackAssign';
import { minimumPathCover, type DutyNode } from './generator/dutyMatch';
import { buildDepotRuns, checkDepotCapacity, DEPOT_TURN_MARGIN_SEC } from './generator/depotRuns';

/** Beyond this a formation goes back to the depot instead of waiting. */
const MAX_LAYOVER_SEC = 2400;
/** A layover longer than this becomes an explicit `stable` leg in the duty. */
const STABLE_LEG_MIN_SEC = 1200;
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

  // -- 2. 番線 for the service pattern -------------------------------------
  // Service trains are booked first, as a block: they are the timetable, and
  // the empty moves have to fit around them rather than the other way round.
  const typeById = new Map(facts.trainTypes.map((t) => [t.id, t]));
  const booking = new TrackBooking(facts);
  booking.placeSweep(serviceTrains.map((train) => toAssignable(train, typeById, facts)));

  // -- 3. duty chains -------------------------------------------------------
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

  const pools: Array<{ cars: number; chains: DutyNode[][] }> = [CARS.express, CARS.local].map(
    (cars) => ({
      cars,
      chains: minimumPathCover(
        nodes.filter((n) => n.cars === cars),
        { turnaroundSec, maxLayoverSec: MAX_LAYOVER_SEC },
      ).chains,
    }),
  );

  // -- 4. depot runs + duties ----------------------------------------------
  const saginuma = facts.depots[0]!;
  let deadheadSeq = 9001;
  const nextDeadheadNumber = (): string => `回${deadheadSeq++}`;
  const deadheadTrains: Train[] = [];
  const duties: Duty[] = [];
  const dutySpans: Array<{ dutyId: DutyId; cars: number; from: Sec; to: Sec }> = [];
  let maxDepotShiftSec = 0;

  for (const pool of pools) {
    const suffix = pool.cars === CARS.express ? 'Q' : 'K';
    pool.chains.forEach((chain, index) => {
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
      );
      maxDepotShiftSec = Math.max(maxDepotShiftSec, runs.outShiftSec, runs.inShiftSec);
      deadheadTrains.push(runs.out, runs.in);

      const legs: DutyLeg[] = [{ kind: 'train', trainId: runs.out.id }];
      const outLast = runs.out.stops[runs.out.stops.length - 1]!;
      let prevEnd: Sec = outLast.arr ?? outLast.dep ?? runs.fromSec;
      let prevStation: StationId = outLast.stationId;

      for (const node of chain) {
        if (node.depSec - prevEnd >= STABLE_LEG_MIN_SEC) {
          legs.push({ kind: 'stable', stationId: prevStation, from: prevEnd, to: node.depSec });
        }
        legs.push({ kind: 'train', trainId: node.trainId });
        prevEnd = node.arrSec;
        prevStation = node.terminusStationId;
      }

      const inFirst = runs.in.stops[0]!;
      const inDep = inFirst.dep ?? inFirst.arr ?? prevEnd + DEPOT_TURN_MARGIN_SEC;
      if (inDep - prevEnd >= STABLE_LEG_MIN_SEC) {
        legs.push({ kind: 'stable', stationId: prevStation, from: prevEnd, to: inDep });
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
    routing: train.typeId === facts.type.localBlue ? 'dt' : 'om',
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
