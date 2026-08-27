/**
 * Position interpolation and per-train runtime state.
 *
 * A train's position at time `t` follows entirely from its own stop list, so
 * there is nothing to step: we binary-search the bracketing events and shape
 * the movement between them with a trapezoidal speed profile.
 */

import type { ProjectDocument, PerfProfile, TrainStop } from '@/domain/model';
import type { Meters, Sec } from '@/domain/units';
import {
  NO_DELAY,
  type DwellReason,
  type LayoverPlan,
  type TimeOverlay,
  type TrainEvent,
  type TrainPhase,
  type TrainRuntime,
  type TrainTimeline,
} from './types';

/** km/h per second -> m/s². */
const MPS_PER_KMHPS = 1000 / 3600;
const MPS_TO_KMH = 3.6;

/** How close to a `pass` event counts as "通過中". */
export const PASS_WINDOW_SEC = 6;

/**
 * How long a formation takes to change roads during a layover.
 *
 * A shunt to a 引上線 and back is a real move over real pointwork, so the view
 * animates it over this window rather than snapping the marker sideways. Also
 * read by `buildIndex`, which uses it to time the last berth of a layover — the
 * stock has to be standing on the departure road before the departure.
 */
export const LAYOVER_SHUNT_SEC = 90;

interface SegmentSolution {
  /** Physically impossible in the booked time — fall back to constant speed. */
  linear: boolean;
  /** Cruise speed, m/s (for a linear fallback, the constant speed). */
  v: number;
  /** Acceleration, m/s². */
  a: number;
  /** Deceleration, m/s². */
  b: number;
  /** Duration of the acceleration ramp. */
  ta: number;
  /** Duration of the deceleration ramp. */
  td: number;
  /** Distance covered by the acceleration ramp. */
  da: number;
}

/**
 * Solve for the cruise speed `v` such that
 *
 *     d = (startsFromStop ? v²/2a : 0) + v·(T − ta − td) + (endsAtStop ? v²/2b : 0)
 *
 * which rearranges to `k·v² − T·v + d = 0` with
 * `k = [start]/2a + [end]/2b`. The smaller root is the one where the train
 * spends the least time at speed; the larger root is above the parabola's
 * vertex and is not reachable while still covering `d` in `T`.
 */
function solveSegment(
  d: Meters,
  T: number,
  profile: PerfProfile,
  startsFromStop: boolean,
  endsAtStop: boolean,
): SegmentSolution {
  const a = Math.max(profile.accelKmhps, 0.01) * MPS_PER_KMHPS;
  const b = Math.max(profile.decelKmhps, 0.01) * MPS_PER_KMHPS;
  const vmax = Math.max(profile.maxSpeedKmh, 1) * MPS_PER_KMHPS;
  const linear: SegmentSolution = {
    linear: true,
    v: T > 0 ? d / T : 0,
    a,
    b,
    ta: 0,
    td: 0,
    da: 0,
  };
  if (!(d > 0) || !(T > 0)) return linear;

  const k = (startsFromStop ? 1 / (2 * a) : 0) + (endsAtStop ? 1 / (2 * b) : 0);
  if (k === 0) {
    const v = d / T;
    // No ramps at either end: constant speed is the trapezoid.
    return v > vmax ? linear : { linear: false, v, a, b, ta: 0, td: 0, da: 0 };
  }

  const disc = T * T - 4 * k * d;
  if (disc < 0) return linear;
  const v = (T - Math.sqrt(disc)) / (2 * k);
  if (!(v > 0) || v > vmax) return linear;

  const ta = startsFromStop ? v / a : 0;
  const td = endsAtStop ? v / b : 0;
  if (ta + td > T) return linear;
  const da = startsFromStop ? (v * v) / (2 * a) : 0;
  return { linear: false, v, a, b, ta, td, da };
}

/**
 * Distance covered `tau` seconds into a segment of length `d` scheduled to
 * take `T` seconds, using a trapezoidal speed profile. Linear interpolation
 * makes trains move at constant speed and stop dead at platforms, which looks
 * wrong enough to make the line view untrustworthy.
 *
 * Exact at both endpoints and monotonic non-decreasing in `tau`.
 */
export function interpolateKm(
  d: Meters,
  T: number,
  tau: number,
  profile: PerfProfile,
  startsFromStop: boolean,
  endsAtStop: boolean,
): Meters {
  if (T <= 0) return d;
  if (tau <= 0) return 0;
  if (tau >= T) return d;

  const sol = solveSegment(d, T, profile, startsFromStop, endsAtStop);
  let x: number;
  if (sol.linear) {
    x = d * (tau / T);
  } else if (tau <= sol.ta) {
    x = 0.5 * sol.a * tau * tau;
  } else if (tau <= T - sol.td) {
    x = sol.da + sol.v * (tau - sol.ta);
  } else {
    const r = T - tau;
    x = d - 0.5 * sol.b * r * r;
  }
  return x < 0 ? 0 : x > d ? d : x;
}

/** Instantaneous speed `tau` seconds into the same segment, in km/h. */
export function segmentSpeedKmh(
  d: Meters,
  T: number,
  tau: number,
  profile: PerfProfile,
  startsFromStop: boolean,
  endsAtStop: boolean,
): number {
  if (T <= 0) return 0;
  const sol = solveSegment(d, T, profile, startsFromStop, endsAtStop);
  const u = tau < 0 ? 0 : tau > T ? T : tau;
  let mps: number;
  if (sol.linear) mps = sol.v;
  else if (u < sol.ta) mps = sol.a * u;
  else if (u <= T - sol.td) mps = sol.v;
  else mps = sol.b * (T - u);
  return mps * MPS_TO_KMH;
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

function dwellReason(
  stop: TrainStop | undefined,
  event: TrainEvent,
  doc: ProjectDocument | undefined,
): DwellReason {
  const isDepot =
    doc !== undefined
      ? doc.stations.byId[event.stationId]?.kind === 'depot'
      : stop?.operation === 'depotIn' || stop?.operation === 'depotOut';
  if (isDepot) return 'depot';
  if (stop?.operation === 'turnback') return 'turnback';
  if (event.isOvertakeWait) return 'overtakeWait';
  if (event.isMeetWait) return 'meetWait';
  if (stop?.operational === true) return 'operational';
  return 'passenger';
}

type LayoverPhase = Extract<TrainPhase, { phase: 'layover' }>;
type PassingPhase = Extract<TrainPhase, { phase: 'passing' }>;

/**
 * Where the stock stands `t` seconds into a layover, and whether it is at that
 * moment crossing from one road to another.
 *
 * The berth list is short (an arrival road, at most a 引上線, a departure road)
 * so a linear scan is both the simplest and the fastest way to read it.
 */
function layoverPhase(plan: LayoverPlan, since: Sec, t: Sec): LayoverPhase {
  let i = 0;
  for (let j = 1; j < plan.berths.length; j++) {
    if (plan.berths[j]!.from > t) break;
    i = j;
  }
  const berth = plan.berths[i]!;
  const phase: LayoverPhase = {
    phase: 'layover',
    stationId: plan.stationId,
    km: plan.km,
    since,
    until: plan.untilSec,
    nextTrainId: plan.nextTrainId,
  };
  if (berth.trackId !== undefined) phase.trackId = berth.trackId;

  const prev = i > 0 ? plan.berths[i - 1] : undefined;
  if (prev !== undefined && prev.trackId !== berth.trackId) {
    // A layover shorter than the nominal shunt still has to finish the move
    // before the successor leaves, so the window is whatever time is left.
    const window = Math.min(LAYOVER_SHUNT_SEC, Math.max(1, plan.untilSec - berth.from));
    const moved = t - berth.from;
    if (moved < window) {
      if (prev.trackId !== undefined) phase.fromTrackId = prev.trackId;
      phase.shunt = moved <= 0 ? 0 : moved / window;
    }
  }
  return phase;
}

/**
 * The runtime state of one train at time `t`.
 *
 * `doc` is optional: without it the formation code, car count and the
 * "is this a depot station" test degrade gracefully (the latter falls back to
 * the stop's `depotIn`/`depotOut` operation).
 */
export function trainRuntimeAt(
  tl: TrainTimeline,
  t: Sec,
  overlay: TimeOverlay = NO_DELAY,
  doc?: ProjectDocument,
): TrainRuntime {
  const ev = tl.events;
  const n = ev.length;

  const out: TrainRuntime = {
    trainId: tl.trainId,
    label: tl.label,
    number: tl.train.number,
    typeId: tl.typeId,
    direction: tl.direction,
    category: tl.category,
    phase: { phase: 'pending' },
    km: n > 0 ? ev[0]!.km : 0,
    delaySec: 0,
  };
  if (tl.dutyId !== undefined) out.dutyId = tl.dutyId;
  if (tl.formationId !== undefined) {
    out.formationId = tl.formationId;
    const formation = doc?.formations.byId[tl.formationId];
    if (formation) {
      out.formationCode = formation.code;
      out.cars = formation.cars;
    }
  }
  if (n === 0) return out;

  const last = ev[n - 1]!;
  out.destinationStationId = last.stationId;

  const delayOf = (i: number): number =>
    overlay.isEmpty ? 0 : overlay.delaySec(tl.trainId, ev[i]!.stopIndex);
  const arrOf = (i: number): Sec | undefined => {
    const e = ev[i]!;
    return e.arr === undefined ? undefined : e.arr + delayOf(i);
  };
  const depOf = (i: number): Sec | undefined => {
    const e = ev[i]!;
    return e.dep === undefined ? undefined : e.dep + delayOf(i);
  };
  const atOf = (i: number): Sec => ev[i]!.at + delayOf(i);

  const firstDep = depOf(0) ?? atOf(0);
  const lastArr = arrOf(n - 1) ?? atOf(n - 1);

  /** The next event the train is booked to *arrive* at, strictly after `t`. */
  const setNext = (): void => {
    for (let j = 0; j < n; j++) {
      const arr = arrOf(j);
      if (arr !== undefined && arr > t) {
        out.nextStationId = ev[j]!.stationId;
        out.nextArrSec = arr;
        return;
      }
    }
  };

  if (t < firstDep) {
    out.phase = { phase: 'pending' };
    out.km = ev[0]!.km;
    setNext();
    return out;
  }
  if (t > lastArr) {
    // Terminating is not the same as vanishing: while the duty runs on into
    // another train from this platform, the stock is still standing there.
    const plan = tl.layover;
    if (plan !== undefined && t < plan.untilSec) {
      out.phase = layoverPhase(plan, lastArr, t);
      out.km = plan.km;
      return out;
    }
    out.phase = { phase: 'finished' };
    out.km = last.km;
    return out;
  }

  // Greatest i with at(i) <= t. Guaranteed to exist because t >= firstDep.
  let lo = 0;
  let hi = n - 1;
  let i = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (atOf(mid) <= t) {
      i = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const cur = ev[i]!;
  const curAt = atOf(i);
  const curDep = depOf(i) ?? curAt;
  out.delaySec = delayOf(i);
  setNext();

  // Inside this event's own window.
  const nxt = i + 1 < n ? ev[i + 1]! : undefined;
  if (t <= curDep) {
    out.km = cur.km;
    if (cur.kind === 'pass') {
      const phase: PassingPhase = { phase: 'passing', stationId: cur.stationId, km: cur.km };
      if (cur.trackId !== undefined) phase.trackId = cur.trackId;
      if (nxt !== undefined) {
        phase.fromStationId = cur.stationId;
        phase.toStationId = nxt.stationId;
        if (cur.trackId !== undefined) phase.fromTrackId = cur.trackId;
        if (nxt.trackId !== undefined) phase.toTrackId = nxt.trackId;
      }
      out.phase = phase;
      return out;
    }
    const phase: TrainPhase = {
      phase: 'dwelling',
      stationId: cur.stationId,
      km: cur.km,
      since: curAt,
      until: curDep,
      reason: dwellReason(tl.train.stops[cur.stopIndex], cur, doc),
    };
    if (cur.trackId !== undefined) phase.trackId = cur.trackId;
    out.phase = phase;
    return out;
  }

  if (nxt === undefined) {
    out.phase = { phase: 'finished' };
    out.km = last.km;
    return out;
  }

  // Running between `cur` and `nxt`.
  const nxtAt = atOf(i + 1);
  const T = nxtAt - curDep;
  const tau = t - curDep;
  const span = nxt.km - cur.km;
  const d = Math.abs(span);
  const sign = span < 0 ? -1 : 1;
  const travelled = interpolateKm(d, T, tau, tl.profile, cur.kind === 'stop', nxt.kind === 'stop');
  const km = cur.km + sign * travelled;
  out.km = km;

  // Just past a pass event, or just short of the next one. This only relabels
  // the leg — the position stays the interpolated one, because snapping km to
  // the station made the marker jump onto it, stand still for twelve seconds
  // and jump off again.
  const passed =
    cur.kind === 'pass' && tau <= PASS_WINDOW_SEC
      ? cur
      : nxt.kind === 'pass' && nxtAt - t <= PASS_WINDOW_SEC
        ? nxt
        : undefined;
  if (passed !== undefined) {
    const phase: PassingPhase = {
      phase: 'passing',
      stationId: passed.stationId,
      km,
      fromStationId: cur.stationId,
      toStationId: nxt.stationId,
    };
    if (passed.trackId !== undefined) phase.trackId = passed.trackId;
    if (cur.trackId !== undefined) phase.fromTrackId = cur.trackId;
    if (nxt.trackId !== undefined) phase.toTrackId = nxt.trackId;
    out.phase = phase;
    return out;
  }

  const running: Extract<TrainPhase, { phase: 'running' }> = {
    phase: 'running',
    fromStationId: cur.stationId,
    toStationId: nxt.stationId,
    km,
    progress: T > 0 ? Math.max(0, Math.min(1, tau / T)) : 1,
    speedKmh: segmentSpeedKmh(d, T, tau, tl.profile, cur.kind === 'stop', nxt.kind === 'stop'),
  };
  if (cur.trackId !== undefined) running.fromTrackId = cur.trackId;
  if (nxt.trackId !== undefined) running.toTrackId = nxt.trackId;
  out.phase = running;
  return out;
}
