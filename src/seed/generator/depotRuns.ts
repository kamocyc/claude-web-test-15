/**
 * 出庫 / 入庫 回送.
 *
 * There is no "depot movement" concept in the model, and deliberately so: a
 * 出庫 is an ordinary `Train` whose first stop happens to be the depot station
 * with `operation: 'depotOut'`, and a 入庫 is one whose last stop is the depot
 * with `operation: 'depotIn'`. Position interpolation, occupancy, the string
 * diagram, duty continuity and validation therefore all work on them without a
 * single special case.
 *
 * They are timed by the same forward pass as a service train over the real
 * chain of stations between 鷺沼車庫 and wherever the duty starts, so a
 * formation coming out for an early 大井町 departure genuinely spends twenty-odd
 * minutes on the road and that shows up on the string diagram.
 *
 * The ideal 出庫 leaves at `firstDep − runSec − prepSec`, exactly the rule the
 * plan calls for, with `runSec` generalised from `Depot.accessRunSec` to the
 * whole 鷺沼車庫 → origin run. But an empty move has to fit between the
 * timetabled trains, so the caller walks that time *earlier* (出庫) or *later*
 * (入庫) in one-minute steps until the path is clear. Bringing a formation out
 * early and letting it stand is exactly what a real roster does when the peak
 * leaves no gap.
 */

import type { StationId, TrainId } from '@/domain/ids';
import type { Depot, Direction, Train, TrainStop } from '@/domain/model';
import type { Sec } from '@/domain/units';
import { SeedError } from '../errors';
import type { Facts, StationKey } from '../oimachi/facts';
import { timeRoute, type RouteStop } from './stopTimes';
import type { DutyNode } from './dutyMatch';
import type { AssignableTrain, TrackBooking } from './trackAssign';

/** Margin between a service train arriving and its 入庫回送 setting off. */
export const DEPOT_TURN_MARGIN_SEC = 300;
/** Step and range of the search that paths an empty move into a gap. */
const SEARCH_STEP_SEC = 60;
const SEARCH_STEPS = 75;
/** 続行時隔 demanded of a 回送 against every already-placed train. */
const DEADHEAD_HEADWAY_SEC = 95;

export interface DepotRunContext {
  facts: Facts;
  depot: Depot;
  booking: TrackBooking;
  nextTrainId: () => TrainId;
  nextNumber: () => string;
}

export interface DepotRunPair {
  out: Train;
  in: Train;
  /** Whole-duty span including both 回送. */
  fromSec: Sec;
  toSec: Sec;
  /** How far each move had to be shifted from its ideal time, in seconds. */
  outShiftSec: number;
  inShiftSec: number;
}

/** The full km-ordered chain including the depot stub. */
function depotAxis(facts: Facts): StationKey[] {
  return [...facts.axis, 'saginumaDepot'];
}

function routeBetween(facts: Facts, fromKey: StationKey, toKey: StationKey): RouteStop[] {
  const axis = depotAxis(facts);
  const i = axis.indexOf(fromKey);
  const j = axis.indexOf(toKey);
  if (i < 0 || j < 0) throw new SeedError('回送経路が引けません', { from: fromKey, to: toKey });
  if (i === j) throw new SeedError('回送の起終点が同一です', { from: fromKey });
  const slice = i < j ? axis.slice(i, j + 1) : axis.slice(j, i + 1).reverse();
  return slice.map((key, idx) => ({
    stationId: facts.S[key],
    kind: idx === 0 || idx === slice.length - 1 ? ('stop' as const) : ('pass' as const),
    dwellBase: 0,
  }));
}

function directionOf(facts: Facts, route: readonly RouteStop[]): Direction {
  const first = facts.stationById.get(route[0]!.stationId)!;
  const last = facts.stationById.get(route[route.length - 1]!.stationId)!;
  return last.kmFromOrigin > first.kmFromOrigin ? 'down' : 'up';
}

function keyOfStation(facts: Facts, id: StationId): StationKey {
  const key = facts.keyOf.get(id);
  if (key === undefined) throw new SeedError('未知の駅です', { station: String(id) });
  return key;
}

function makeStops(
  route: readonly RouteStop[],
  timed: { arr: Array<Sec | undefined>; dep: Array<Sec | undefined> },
  markFirst: TrainStop['operation'] | undefined,
  markLast: TrainStop['operation'] | undefined,
): TrainStop[] {
  return route.map((r, i) => {
    const stop: TrainStop = { stationId: r.stationId, kind: r.kind };
    const a = timed.arr[i];
    const d = timed.dep[i];
    if (a !== undefined) stop.arr = a;
    if (d !== undefined) stop.dep = d;
    if (i === 0) {
      stop.operational = true;
      if (markFirst !== undefined) stop.operation = markFirst;
    }
    if (i === route.length - 1) {
      stop.operational = true;
      if (markLast !== undefined) stop.operation = markLast;
    }
    return stop;
  });
}

/** Build the 出庫 and 入庫 that bracket one chain of service trains. */
export function buildDepotRuns(
  ctx: DepotRunContext,
  chain: readonly DutyNode[],
  cars: number,
): DepotRunPair {
  const { facts, depot } = ctx;
  const first = chain[0];
  const last = chain[chain.length - 1];
  if (first === undefined || last === undefined) {
    throw new SeedError('空の運用に入出庫を付けようとしました');
  }
  const profileId = cars >= 7 ? facts.profile.car7 : facts.profile.car5;
  const depotKey = keyOfStation(facts, depot.stationId);

  // -- 出庫: ideal, then progressively earlier ------------------------------
  const outRoute = routeBetween(facts, depotKey, keyOfStation(facts, first.originStationId));
  const outRunSec = timeRoute(facts, outRoute, profileId, 0).arr[outRoute.length - 1]!;
  const outIdeal = first.depSec - outRunSec - depot.prepSec;
  const outTrainId = ctx.nextTrainId();
  const outNumber = ctx.nextNumber();
  const outDirection = directionOf(facts, outRoute);

  const out = searchPath(ctx, {
    trainId: outTrainId,
    number: outNumber,
    route: outRoute,
    profileId,
    direction: outDirection,
    cars,
    idealStart: outIdeal,
    stepSign: -1,
    markFirst: 'depotOut',
    markLast: undefined,
    note: '出庫回送',
    preferStablingAtOrigin: false,
    label: `回 ${outNumber}`,
  });

  // -- 入庫: ideal, then progressively later --------------------------------
  const inRoute = routeBetween(facts, keyOfStation(facts, last.terminusStationId), depotKey);
  const inIdeal = last.arrSec + DEPOT_TURN_MARGIN_SEC;
  const inTrainId = ctx.nextTrainId();
  const inNumber = ctx.nextNumber();

  const inbound = searchPath(ctx, {
    trainId: inTrainId,
    number: inNumber,
    route: inRoute,
    profileId,
    direction: directionOf(facts, inRoute),
    cars,
    idealStart: inIdeal,
    stepSign: +1,
    markFirst: undefined,
    markLast: 'depotIn',
    note: '入庫回送',
    // The last movement of the night out of 溝の口 starts from the 引上線.
    preferStablingAtOrigin: true,
    label: `回 ${inNumber}`,
  });

  const outLast = out.train.stops[out.train.stops.length - 1]!;
  const inFirst = inbound.train.stops[0]!;
  if ((outLast.arr ?? 0) > first.depSec) {
    throw new SeedError('出庫回送が営業列車の出発に間に合いません', {
      number: outNumber, arr: outLast.arr ?? 0, firstDep: first.depSec,
    });
  }
  if ((inFirst.dep ?? 0) < last.arrSec) {
    throw new SeedError('入庫回送が営業列車の到着より前に出発しています', { number: inNumber });
  }

  return {
    out: out.train,
    in: inbound.train,
    fromSec: out.train.stops[0]!.dep!,
    toSec: inbound.train.stops[inbound.train.stops.length - 1]!.arr!,
    outShiftSec: out.shiftSec,
    inShiftSec: inbound.shiftSec,
  };
}

interface PathRequest {
  trainId: TrainId;
  number: string;
  label: string;
  route: RouteStop[];
  profileId: Parameters<typeof timeRoute>[2];
  direction: Direction;
  cars: number;
  idealStart: Sec;
  stepSign: -1 | 1;
  markFirst: TrainStop['operation'] | undefined;
  markLast: TrainStop['operation'] | undefined;
  note: string;
  preferStablingAtOrigin: boolean;
}

function searchPath(
  ctx: DepotRunContext,
  req: PathRequest,
): { train: Train; shiftSec: number } {
  const { facts, booking } = ctx;
  for (let step = 0; step <= SEARCH_STEPS; step++) {
    const shift = step * SEARCH_STEP_SEC * req.stepSign;
    const timed = timeRoute(facts, req.route, req.profileId, req.idealStart + shift);
    const stops = makeStops(req.route, timed, req.markFirst, req.markLast);
    const candidate: AssignableTrain = {
      trainId: req.trainId,
      label: req.label,
      direction: req.direction,
      cars: req.cars,
      routing: 'om',
      isPassenger: false,
      preferStablingAtOrigin: req.preferStablingAtOrigin,
      stops,
    };
    if (!booking.tryPlace(candidate, DEADHEAD_HEADWAY_SEC)) continue;
    const train: Train = {
      id: req.trainId,
      number: req.number,
      typeId: facts.type.deadhead,
      direction: req.direction,
      category: 'deadhead',
      stops,
      dayTypeIds: [facts.dayTypeId],
      minCars: req.cars,
      note: req.note,
    };
    return { train, shiftSec: Math.abs(shift) };
  }
  throw new SeedError('回送の筋を引けませんでした', {
    number: req.number,
    idealStart: req.idealStart,
    searchedSec: SEARCH_STEPS * SEARCH_STEP_SEC,
  });
}

/**
 * How many formations are standing in the depot at once, and whether that fits.
 *
 * A formation occupies a berth from the moment its 入庫 arrives until its next
 * 出庫 leaves, so the peak is at the quietest hour of the night, not the
 * busiest hour of the day: everything that is not out on the line is at 鷺沼.
 */
export function checkDepotCapacity(
  depot: Depot,
  fleetSize: number,
  minConcurrentDuties: number,
): { peakStabled: number; exceeded: boolean } {
  const peakStabled = Math.max(0, fleetSize - Math.max(0, minConcurrentDuties));
  return { peakStabled, exceeded: peakStabled > depot.capacityFormations };
}
