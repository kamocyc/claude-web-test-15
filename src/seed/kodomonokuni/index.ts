/**
 * `buildKodomonokuniProject()` — the 東急こどもの国線 平日ダイヤ, assembled.
 *
 * The same pipeline as the Oimachi Line's, minus the parts a three-station
 * shuttle does not have:
 *
 *   facts.ts      infrastructure, types, patterns, fleet, inspection rules
 *   service.ts    five time bands, each one repeating cycle
 *   expand.ts     band × cycle × slot  ->  TrainSpec
 *   stopTimes.ts  TrainSpec -> timed stops
 *   dutyMatch.ts  minimum path cover  ->  one chain per vehicle-day
 *   trackAssign.ts every stop gets a 番線
 *   depotRuns.ts  bracket every chain with a 出庫 / 入庫 回送
 *   crewDuties.ts a second covering of the same trains, by people
 *   (here)        formations, assignments, inspection history, the document
 *
 * ## What is simpler here, and why
 *
 * **One pool.** Every train is the same two-car set over the same rails, so
 * there is no 5両/7両 split and no 大井町線/田園都市線 routing to keep apart.
 * `compatible` is the default.
 *
 * **No shunts.** Neither terminus has a 引上線 — 長津田 and こどもの国 are one
 * platform road each — so a formation always reverses on the road it arrived
 * at. Every branch in the Oimachi assembly that exists to move stock between a
 * platform and a tail track has no counterpart here, and the duty is simply
 * 出庫 → trains → 入庫 with a `stable` leg wherever the wait is long enough to
 * be worth recording.
 *
 * **One platform per terminus is the binding constraint instead.** 大井町 has
 * two dead-end roads; these termini have one. A formation left standing is the
 * whole station out of use, so the layover cap is short and a chain that would
 * exceed it is cut — the stock runs 入庫 to 長津田検車区 and comes out again.
 *
 * ## What is harder here
 *
 * The line is single track, so a 回送 cannot simply be slotted into a gap in
 * its own direction: the path search has to keep it out of the section
 * entirely while an opposing train is in it. That lives in
 * `TrackBooking.tryPlace` and reads `facts.isSingleTrack` — the same question
 * `headway.singleTrackOpposing` asks of the finished document.
 *
 * Determinism is a hard requirement and is achieved structurally: no
 * `Date.now()`, no `Math.random()`, no `Date` anywhere on the path; every id
 * from a monotonic counter created fresh inside this function; every sort with
 * a total-order tiebreak. Building twice produces byte-identical output.
 */

import { ID_PREFIX, makeIdFactory } from '@/domain/ids';
import type {
  AssignmentId,
  DutyId,
  FormationId,
  InspectionRecordId,
  StationId,
  StationTrackId,
  TrainId,
} from '@/domain/ids';
import type {
  Assignment,
  Crew,
  CrewAssignment,
  Duty,
  DutyLeg,
  Formation,
  InspectionRecord,
  ProjectDocument,
  Train,
} from '@/domain/model';
import { createEmptyProject, DEFAULT_VALIDATION_CONFIG } from '@/domain/project';
import { buildIndex, detectMeets } from '@/engine';
import { addDays, daysBetween } from '@/domain/time';
import { entitiesFrom, type Sec } from '@/domain/units';
import { SeedError } from '../errors';
import { buildKodomonokuniFacts, CARS, type Facts } from './facts';
import { buildServicePlan } from './service';
import { expandBands } from '../generator/expand';
import { buildStopTimes, toTrainStops } from '../generator/stopTimes';
import {
  TrackBooking,
  type AssignableTrain,
  type TurnbackLink,
} from '../generator/trackAssign';
import { buildCrewDuties } from '../generator/crewDuties';
import { minimumPathCover, type DutyNode } from '../generator/dutyMatch';
import {
  buildDepotRuns,
  checkDepotCapacity,
  DEPOT_TURN_MARGIN_SEC,
  type DepotRunPins,
} from '../generator/depotRuns';

/**
 * How long a formation may stand at a terminus before the plan sends it home.
 *
 * Both termini are 1面1線. A formation waiting on the single road is the whole
 * station shut, so the cap is much tighter than the Oimachi Line's forty
 * minutes: fifteen leaves room for every turnback the cycles actually ask for
 * (300 s off-peak, 360–400 s in the peak) with margin to spare, and cuts the
 * long band-transition waits where a set is simply not needed for hours.
 */
const MAX_LAYOVER_SEC = 900;

/**
 * A wait long enough to be worth a `stable` leg of its own.
 *
 * Below this the formation is just turning round and the two trains say so
 * between them. There is nowhere to shunt to, so the leg — when there is one —
 * only ever records the road the stock is already standing on.
 */
const STABLE_LEG_MIN_SEC = 900;

/** Rest between two duties worked by the same formation. */
const BETWEEN_DUTIES_SEC = 1800;

/**
 * Reconstruction: a set's daily mileage, used to date the odometer and the
 * inspection history backwards. A round trip is 6.8 km and a set makes rather
 * a lot of them, but the line is 3.4 km long — this is a small number by the
 * standards of the Oimachi Line's 340, and that is the honest figure.
 */
const DAILY_KM = 150;

const ACTIVE_DATE = '2025-06-02';

export interface BuildReport {
  serviceTrains: number;
  deadheadTrains: number;
  duties: number;
  formations: number;
  trackFallbacks: number;
  maxDepotShiftSec: number;
  depotPeakStabled: number;
  depotCapacityExceeded: boolean;
  crewDuties: number;
  crewWorkHours: number;
  /**
   * 交換 — how many times two opposing trains stand at a station together.
   *
   * Not in `SeedDigest`, deliberately. That summarises the *document*, and a
   * meet is not in the document: 待避 is authored on the stop that waits
   * (`TrainStop.overtakenBy`) and can be counted by reading, but a meet is
   * only ever a consequence of the times, so counting one means running the
   * engine. Keeping it here says which kind of number it is.
   */
  meets: number;
  meetsByBand: Record<string, number>;
  perBand: Array<{
    bandId: string;
    name: string;
    trains: number;
    down: number;
    up: number;
    tph: number;
  }>;
}

let lastReport: BuildReport | undefined;

/** Diagnostics from the most recent `buildKodomonokuniProject()` call. */
export function lastKodomonokuniBuildReport(): BuildReport | undefined {
  return lastReport;
}

export function buildKodomonokuniProject(): ProjectDocument {
  const facts: Facts = buildKodomonokuniFacts();
  const plan = buildServicePlan(facts);

  const nextTrainId = makeIdFactory(ID_PREFIX.train);
  const nextDutyId = makeIdFactory(ID_PREFIX.duty);
  const nextFormationId = makeIdFactory(ID_PREFIX.formation);
  const nextAssignmentId = makeIdFactory(ID_PREFIX.assignment);
  const nextRecordId = makeIdFactory(ID_PREFIX.inspectionRecord);
  const nextCrewDutyId = makeIdFactory(ID_PREFIX.crewDuty);
  const nextCrewId = makeIdFactory(ID_PREFIX.crew);
  const nextCrewAssignmentId = makeIdFactory(ID_PREFIX.crewAssignment);

  const base = createEmptyProject({ name: '東急こどもの国線 平日ダイヤ' });
  const activeDate = ACTIVE_DATE;

  // -- 1. trains ------------------------------------------------------------
  const specs = expandBands(plan.bands, plan.patterns, () => nextTrainId<'Train'>());
  const timed = buildStopTimes(facts, specs);

  const serviceTrains: Train[] = specs.map((spec) => {
    const t = timed.trains.get(spec.key);
    if (t === undefined) throw new SeedError('missing timed train', { key: spec.key });
    return {
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
    };
  });

  // -- 2. duty chains -------------------------------------------------------
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
      // One railway, one pair of rails, one kind of set. The routing field
      // exists for lines that share their tracks with another operator.
      routing: 'om' as const,
    };
  });

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

  const chains = minimumPathCover<DutyNode>(nodes, {
    turnaroundSec,
    maxLayoverSec: () => MAX_LAYOVER_SEC,
  }).chains;

  // -- 3. 番線 --------------------------------------------------------------
  // Only 恩田 has a choice to make, and it is the interesting one: the loop is
  // taken when the through road is already spoken for by an opposing train,
  // and left alone otherwise. Because both directions default to 1番線, the
  // second road appears in the plan exactly when the timetable needs it —
  // which is what makes 「ラッシュ時のみ交換」 a result rather than a setting.
  const typeById = new Map(facts.trainTypes.map((t) => [t.id, t]));
  const booking = new TrackBooking(facts);
  const assignables = new Map<TrainId, AssignableTrain>();
  for (const train of serviceTrains) {
    const type = typeById.get(train.typeId);
    assignables.set(train.id, {
      trainId: train.id,
      label: `${type?.shortName ?? '?'} ${train.number}`,
      direction: train.direction,
      cars: train.minCars ?? CARS,
      routing: 'om',
      isPassenger: type?.isPassengerService ?? true,
      preferStablingAtOrigin: false,
      stops: train.stops,
    });
  }

  // A turnback holds one road across both trains. With one road per terminus
  // that is not an optimisation, it is the only way the plan fits at all.
  const turnbackLinks: TurnbackLink[] = [];
  for (const chain of chains) {
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1]!;
      const b = chain[i]!;
      if (a.terminusStationId !== b.originStationId) continue;
      turnbackLinks.push({ arrivingTrainId: a.trainId, departingTrainId: b.trainId });
      const arriving = assignables.get(a.trainId)!.stops;
      arriving[arriving.length - 1]!.operation = 'turnback';
    }
  }
  booking.placeSweep([...assignables.values()], turnbackLinks);

  // -- 4. depot runs + duties ----------------------------------------------
  const yard = facts.depots[0]!;
  let deadheadSeq = 9001;
  const nextDeadheadNumber = (): string => `回${deadheadSeq++}`;
  const deadheadTrains: Train[] = [];
  const duties: Duty[] = [];
  const dutySpans: Array<{ dutyId: DutyId; from: Sec; to: Sec }> = [];
  let maxDepotShiftSec = 0;

  chains.forEach((chain, index) => {
    const first = chain[0]!;
    const last = chain[chain.length - 1]!;
    const firstStops = assignables.get(first.trainId)!.stops;
    const lastStops = assignables.get(last.trainId)!.stops;
    const firstTrackId = firstStops[0]!.trackId;
    const lastTrackId = lastStops[lastStops.length - 1]!.trackId;

    // The empty moves reverse in place against the chain they bracket, the
    // same way two service trains do: one formation, one road.
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
        depot: yard,
        booking,
        nextTrainId: () => nextTrainId<'Train'>(),
        nextNumber: nextDeadheadNumber,
      },
      chain,
      CARS,
      pins,
    );
    maxDepotShiftSec = Math.max(maxDepotShiftSec, runs.outShiftSec, runs.inShiftSec);
    deadheadTrains.push(runs.out, runs.in);

    const legs: DutyLeg[] = [{ kind: 'train', trainId: runs.out.id }];
    const outLast = runs.out.stops[runs.out.stops.length - 1]!;
    let prevEnd: Sec = outLast.arr ?? outLast.dep ?? runs.fromSec;
    let prevStation: StationId = outLast.stationId;
    let prevTrackId: StationTrackId | undefined = outLast.trackId;

    chain.forEach((node) => {
      const wait = node.depSec - prevEnd;
      // There is nowhere to shunt to, so a wait is always spent on the road
      // the stock is already standing on and the leg records only that.
      if (wait >= STABLE_LEG_MIN_SEC && prevTrackId !== undefined) {
        legs.push({
          kind: 'stable',
          stationId: prevStation,
          trackId: prevTrackId,
          from: prevEnd,
          to: node.depSec,
        });
      }
      legs.push({ kind: 'train', trainId: node.trainId });
      prevEnd = node.arrSec;
      prevStation = node.terminusStationId;
      const nodeStops = assignables.get(node.trainId)!.stops;
      prevTrackId = nodeStops[nodeStops.length - 1]!.trackId;
    });

    const inFirst = runs.in.stops[0]!;
    const inDep = inFirst.dep ?? inFirst.arr ?? prevEnd + DEPOT_TURN_MARGIN_SEC;
    if (inDep - prevEnd >= STABLE_LEG_MIN_SEC && prevTrackId !== undefined) {
      legs.push({
        kind: 'stable',
        stationId: prevStation,
        trackId: prevTrackId,
        from: prevEnd,
        to: inDep,
      });
    }
    legs.push({ kind: 'train', trainId: runs.in.id });

    const dutyId = nextDutyId<'Duty'>();
    duties.push({
      id: dutyId,
      code: `${String(index + 1).padStart(2, '0')}K`,
      dayTypeIds: [facts.dayTypeId],
      legs,
      requiredCars: CARS,
    });
    dutySpans.push({ dutyId, from: runs.fromSec, to: runs.toSec });
  });

  const allTrains: Train[] = [...serviceTrains, ...deadheadTrains].sort((a, b) => {
    const aStart = a.stops[0]?.dep ?? a.stops[0]?.arr ?? 0;
    const bStart = b.stops[0]?.dep ?? b.stops[0]?.arr ?? 0;
    return aStart - bStart || a.number.localeCompare(b.number) || a.id.localeCompare(b.id);
  });

  // -- 4b. 乗務員行路 -------------------------------------------------------
  // ワンマン運転, so 運転士 only. The line has one relief point (長津田) and one
  // base (長津田検車区), which is as few as a covering can have and still be a
  // covering — a crew signs on at the shed, rides out on the 出庫 and comes
  // back in on the 入庫.
  const crewReport = buildCrewDuties({
    stationById: facts.stationById,
    trains: allTrains,
    allTrains,
    cfg: { ...base.validationConfig },
    dayTypeId: facts.dayTypeId,
    role: 'driver',
    nextId: () => nextCrewDutyId<'CrewDuty'>(),
    codePrefix: '運',
  });
  const crewDuties = crewReport.duties;
  const crew: Crew[] = crewDuties.map((duty, i) => ({
    id: nextCrewId<'Crew'>(),
    code: `D${String(i + 1).padStart(3, '0')}`,
    name: `運転士${i + 1}`,
    role: 'driver',
    baseStationId: duty.baseStationId,
  }));
  const crewAssignments: CrewAssignment[] = crewDuties.map((duty, i) => ({
    id: nextCrewAssignmentId<'CrewAssignment'>(),
    date: activeDate,
    crewDutyId: duty.id,
    crewId: crew[i]!.id,
  }));

  // -- 5. formations --------------------------------------------------------
  // Three sets, and the third is not rostered. That is what three sets are
  // for: two work the peak and one covers an examination, so a 列車検査 does
  // not stop the railway. `formation.insufficientFleet` stays quiet.
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

  // -- 7. the document ------------------------------------------------------
  const doc: ProjectDocument = {
    ...base,
    meta: {
      ...base.meta,
      id: 'project-kodomonokuni',
      name: '東急こどもの国線 平日ダイヤ',
    },
    settings: { ...base.settings, timeGrainSec: 5, activeDate },
    validationConfig: {
      ...base.validationConfig,
      // The line's own section minimum. Wider than the Oimachi Line's 90 s
      // because a three-station single line has no reason to run tighter, and
      // because the deadhead search is held to the same figure.
      defaultMinHeadwaySec: 180,
      defaultMinTurnbackSec: 180,
      preferredTurnbackSec: 300,
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
    crew: entitiesFrom(crew),
    crewDuties: entitiesFrom(crewDuties),
    crewAssignments: entitiesFrom(crewAssignments),
  };

  // -- 8. report ------------------------------------------------------------
  // The meets are counted off the finished document rather than planned into
  // it. Nothing in `service.ts` asks for one; they are what the cycles do, and
  // this is where the seed finds out whether they happened where it expected.
  const capacity = checkDepotCapacity(yard, formations.length, 0);
  const bandOfTrain = new Map<TrainId, string>(
    serviceTrains.map((t) => [t.id, t.origin?.bandId ?? '(回送)']),
  );
  const meets = detectMeets(doc, buildIndex(doc).timelines);
  const meetsByBand: Record<string, number> = {};
  for (const meet of meets) {
    const band = bandOfTrain.get(meet.downTrainId) ?? '(回送)';
    meetsByBand[band] = (meetsByBand[band] ?? 0) + 1;
  }

  lastReport = {
    serviceTrains: serviceTrains.length,
    deadheadTrains: deadheadTrains.length,
    duties: duties.length,
    formations: formations.length,
    trackFallbacks: booking.fallbacks,
    maxDepotShiftSec,
    depotPeakStabled: capacity.peakStabled,
    depotCapacityExceeded: capacity.exceeded,
    crewDuties: crewDuties.length,
    crewWorkHours: Math.round(crewReport.totalWorkSec / 3600),
    meets: meets.length,
    meetsByBand,
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

  return doc;
}

// ---------------------------------------------------------------------------
// Fleet & inspection
// ---------------------------------------------------------------------------

/** The three Y000系 sets, in order. Reconstruction, including the dates. */
const FLEET = [
  { code: 'Y001F', commissionedOn: '1999-08-01' },
  { code: 'Y002F', commissionedOn: '1999-08-01' },
  { code: 'Y003F', commissionedOn: '2000-03-01' },
] as const;

interface FleetSlot {
  formationId: FormationId;
  freeAt: Sec;
  dutyIds: DutyId[];
}

function buildFleet(
  spans: ReadonlyArray<{ dutyId: DutyId; from: Sec; to: Sec }>,
  activeDate: string,
  nextFormationId: () => FormationId,
  nextAssignmentId: () => AssignmentId,
  facts: Facts,
): { formations: Formation[]; assignments: Assignment[] } {
  const formations: Formation[] = [];
  const assignments: Assignment[] = [];

  const ordered = [...spans].sort((a, b) => a.from - b.from || a.dutyId.localeCompare(b.dutyId));
  const slots: FleetSlot[] = [];
  for (const span of ordered) {
    let slot = slots.find((s) => s.freeAt + BETWEEN_DUTIES_SEC <= span.from);
    if (slot === undefined) {
      slot = { formationId: '' as FormationId, freeAt: Number.NEGATIVE_INFINITY, dutyIds: [] };
      slots.push(slot);
    }
    slot.freeAt = span.to;
    slot.dutyIds.push(span.dutyId);
  }

  if (slots.length > FLEET.length) {
    throw new SeedError('Y000系は3本しかありません', {
      needed: slots.length,
      have: FLEET.length,
    });
  }

  FLEET.forEach((entry, i) => {
    const id = nextFormationId();
    const inService = Math.max(1, daysBetween(entry.commissionedOn, activeDate));
    // The set with no duty today is the one in the shed. On a three-set
    // railway that is not an accident of the roster — it is the roster.
    const idle = i >= slots.length;
    formations.push({
      id,
      code: entry.code,
      seriesId: facts.seriesId,
      cars: CARS,
      homeDepotId: facts.depotId.yard,
      status: idle ? 'inInspection' : 'active',
      odometerKm: Math.round(inService * DAILY_KM * 0.92) + i * 3_100,
      odometerAsOf: activeDate,
      commissionedOn: entry.commissionedOn,
      note: idle ? '長津田検車区所属 / 列車検査入場中' : '長津田検車区所属',
    });
    const slot = slots[i];
    if (slot === undefined) return;
    slot.formationId = id;
    for (const dutyId of slot.dutyIds) {
      assignments.push({ id: nextAssignmentId(), date: activeDate, dutyId, formationId: id });
    }
  });

  return { formations, assignments };
}

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
      // The rule names the depot that can do it — the running shed for the
      // light examinations, the works at 恩田 for the heavy ones.
      const depotId = rule.depotIds[0] ?? facts.depotId.yard;

      if (formation.status === 'inInspection' && rule.kind === 'train') {
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

      // `1 +`: a completed inspection dated today, on a formation also
      // rostered today, is a 検査と運用の重複 error.
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
