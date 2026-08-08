/**
 * From `TrainSpec` to fully-timed `TrainStop[]` — the highest-risk file here.
 *
 * The algorithm is deliberately small:
 *
 *   1. Resolve the served stations from the `StopPattern`.
 *   2. Forward pass from the origin departure:
 *        t += baseRunSec
 *           + (departing from a stand ? startPenaltySec : 0)
 *           + (coming  to  a stand ? stopPenaltySec  : 0)
 *      then hold for max(minDwellSec, override, extra) at every stop.
 *   3. **Two-phase.** Every train is timed once with no waiting. Only then is
 *      each declared 待避 resolved against the (already final) times of the
 *      train doing the passing, by extending the waiting train's dwell and
 *      re-propagating everything downstream. Waits only ever push times later
 *      and an 急行 never waits, so the iteration is monotone and reaches a
 *      fixpoint in one or two passes.
 *   4. Anything infeasible throws a `SeedError` naming band, slot, cycle index
 *      and station. A loud failure beats a silently broken timetable.
 *
 * On the two clearances: `CLEARANCE_ARR_SEC` is how far ahead of the passing
 * train the waiting train must already be standing, and `CLEARANCE_DEP_SEC` is
 * how long after the passing train has gone before the waiting train may
 * follow. The departure clearance is set to the link headway, because after
 * the 待避 the two trains are running nose-to-tail on the same rails.
 *
 * Where the passing train STOPS (a real 緩急接続 at 旗の台) `express.at(S)`
 * splits into its arrival and its departure, and the two constraints use the
 * appropriate one — so the 各停 is already standing when the 急行 pulls in,
 * passengers cross the platform, and the 各停 leaves behind it.
 */

import type { PerfProfileId, StationId, TrainId } from '@/domain/ids';
import type { StopKind, StopPattern, TrainStop } from '@/domain/model';
import { roundToGrain } from '@/domain/time';
import type { Sec } from '@/domain/units';
import { SeedError } from '../errors';
import { OVERTAKE_STATIONS, type Facts } from '../oimachi/facts';
import { specKey, type TrainSpec } from './expand';

export const CLEARANCE_ARR_SEC = 45;
export const CLEARANCE_DEP_SEC = 90;
export const MAX_OVERTAKE_WAIT_SEC = 600;
export const GRAIN_SEC = 5;
const MAX_FIXPOINT_PASSES = 6;

export interface RouteStop {
  stationId: StationId;
  kind: StopKind;
  dwellBase: number;
}

export interface TimedTrain {
  spec: TrainSpec;
  route: RouteStop[];
  arr: Array<Sec | undefined>;
  dep: Array<Sec | undefined>;
  indexOf: Map<StationId, number>;
  extraDwell: Map<StationId, number>;
  overtakenBy: Map<StationId, TrainId[]>;
  connectsTo: Map<StationId, TrainId[]>;
  profileId: PerfProfileId;
}

export interface StopTimesResult {
  trains: Map<string, TimedTrain>;
  /** Diagnostics for the build report. */
  passes: number;
  resolvedOvertakes: number;
  /** Declared overtakes whose partner train falls outside the band. */
  skippedAtBandEdge: number;
  maxWaitSec: number;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** The served stations of a pattern, in travel order, with their base dwell. */
export function routeOf(facts: Facts, pattern: StopPattern): RouteStop[] {
  const kmOf = (id: StationId): number => {
    const st = facts.stationById.get(id);
    if (st === undefined) throw new SeedError('unknown station in pattern', { pattern: pattern.id });
    return st.kmFromOrigin;
  };
  const originKm = kmOf(pattern.originStationId);
  const terminusKm = kmOf(pattern.terminusStationId);
  const lo = Math.min(originKm, terminusKm);
  const hi = Math.max(originKm, terminusKm);

  let ids = facts.axis.map((k) => facts.S[k]).filter((id) => {
    const km = kmOf(id);
    return km >= lo && km <= hi;
  });
  if (originKm > terminusKm) ids = ids.reverse();

  const route: RouteStop[] = [];
  for (const id of ids) {
    const kind = pattern.entries[id];
    if (kind === undefined) continue;
    route.push({ stationId: id, kind, dwellBase: facts.stationById.get(id)!.minDwellSec });
  }
  if (route.length < 2) {
    throw new SeedError('pattern produced fewer than two stops', { pattern: pattern.id });
  }
  route[0]!.kind = 'stop';
  route[route.length - 1]!.kind = 'stop';
  return route;
}

// ---------------------------------------------------------------------------
// Forward pass
// ---------------------------------------------------------------------------

export interface TimedRoute {
  arr: Array<Sec | undefined>;
  dep: Array<Sec | undefined>;
}

/**
 * The forward pass. Shared with `depotRuns.ts` so a 回送 is timed by exactly
 * the same rules as a service train.
 */
export function timeRoute(
  facts: Facts,
  route: readonly RouteStop[],
  profileId: PerfProfileId,
  startSec: Sec,
  opts: { dwellOverride?: Record<string, number>; extraDwell?: Map<StationId, number> } = {},
): TimedRoute {
  const n = route.length;
  const arr: Array<Sec | undefined> = new Array<Sec | undefined>(n).fill(undefined);
  const dep: Array<Sec | undefined> = new Array<Sec | undefined>(n).fill(undefined);
  dep[0] = startSec;

  for (let i = 1; i < n; i++) {
    const prev = route[i - 1]!;
    const cur = route[i]!;
    const rt = facts.runTime(prev.stationId, cur.stationId, profileId);
    const run =
      rt.baseRunSec +
      (prev.kind === 'stop' ? rt.startPenaltySec : 0) +
      (cur.kind === 'stop' ? rt.stopPenaltySec : 0);
    const a = dep[i - 1]! + run;
    arr[i] = a;
    if (i === n - 1) continue; // terminus: no departure
    if (cur.kind === 'pass') {
      dep[i] = a;
      continue;
    }
    const dwell = Math.max(
      cur.dwellBase,
      opts.dwellOverride?.[cur.stationId] ?? 0,
      opts.extraDwell?.get(cur.stationId) ?? 0,
    );
    dep[i] = a + dwell;
  }

  return { arr, dep };
}

// ---------------------------------------------------------------------------
// The two-phase build
// ---------------------------------------------------------------------------

export function buildStopTimes(facts: Facts, specs: readonly TrainSpec[]): StopTimesResult {
  const profileByType = new Map(facts.trainTypes.map((t) => [t.id, t.perfProfileId]));
  const patternById = new Map(facts.stopPatterns.map((p) => [p.id, p]));
  const routeCache = new Map<string, RouteStop[]>();

  const trains = new Map<string, TimedTrain>();

  // -- phase 1: everything runs clear --------------------------------------
  for (const spec of specs) {
    const pattern = patternById.get(spec.stopPatternId);
    if (pattern === undefined) {
      throw new SeedError('train references an unknown stop pattern', { key: spec.key });
    }
    let route = routeCache.get(pattern.id);
    if (route === undefined) {
      route = routeOf(facts, pattern);
      routeCache.set(pattern.id, route);
    }
    const profileId = profileByType.get(spec.trainTypeId);
    if (profileId === undefined) {
      throw new SeedError('train type has no performance profile', { key: spec.key });
    }
    const indexOf = new Map<StationId, number>();
    route.forEach((r, i) => indexOf.set(r.stationId, i));

    const t: TimedTrain = {
      spec,
      route,
      arr: [],
      dep: [],
      indexOf,
      extraDwell: new Map(),
      overtakenBy: new Map(),
      connectsTo: new Map(),
      profileId,
    };
    repropagate(facts, t);
    trains.set(spec.key, t);
  }

  // -- phase 2: satisfy every declared 待避 --------------------------------
  let passes = 0;
  let resolvedOvertakes = 0;
  let skippedAtBandEdge = 0;
  let maxWaitSec = 0;
  let changed = true;

  while (changed) {
    changed = false;
    passes++;
    if (passes > MAX_FIXPOINT_PASSES) {
      throw new SeedError('待避 solver failed to converge', { passes: MAX_FIXPOINT_PASSES });
    }
    for (const spec of specs) {
      const declared = spec.slot.overtakes;
      if (declared === undefined || declared.length === 0) continue;
      const me = trains.get(spec.key)!;

      const ordered = [...declared].sort(
        (a, b) => (me.indexOf.get(a.atStationId) ?? -1) - (me.indexOf.get(b.atStationId) ?? -1),
      );

      for (const ov of ordered) {
        assertOvertakeLegal(facts, spec, ov.atStationId);
        const idx = me.indexOf.get(ov.atStationId);
        if (idx === undefined) {
          throw new SeedError('待避 declared at a station this train does not serve', {
            band: spec.bandId, slot: spec.slotId, cycle: spec.cycleIndex,
            station: stationName(facts, ov.atStationId),
          });
        }
        const partnerKey = specKey(
          spec.bandId,
          ov.bySlotId,
          spec.cycleIndex + (ov.cycleDelta ?? 0),
        );
        const partner = trains.get(partnerKey);
        if (partner === undefined) {
          // Edge of the band: the passing train does not exist, so there is
          // nothing to wait for and the 各停 simply runs clear.
          if (passes === 1) skippedAtBandEdge++;
          continue;
        }
        const pIdx = partner.indexOf.get(ov.atStationId);
        if (pIdx === undefined) {
          throw new SeedError('待避 partner does not serve the 待避 station', {
            band: spec.bandId, slot: spec.slotId, cycle: spec.cycleIndex,
            partner: partner.spec.slotId,
            station: stationName(facts, ov.atStationId),
          });
        }

        const pArr = partner.arr[pIdx] ?? partner.dep[pIdx];
        const pDep = partner.dep[pIdx] ?? partner.arr[pIdx];
        const myArr = me.arr[idx];
        if (pArr === undefined || pDep === undefined || myArr === undefined) {
          throw new SeedError('待避 station is an endpoint of one of the two trains', {
            band: spec.bandId, slot: spec.slotId, cycle: spec.cycleIndex,
            station: stationName(facts, ov.atStationId),
          });
        }

        if (myArr > pArr - CLEARANCE_ARR_SEC) {
          throw new SeedError(
            '待避不能: 待避列車の到着が追い抜き列車に対して遅すぎます',
            {
              band: spec.bandId, slot: spec.slotId, cycle: spec.cycleIndex,
              station: stationName(facts, ov.atStationId),
              localArr: myArr, expressArr: pArr,
              shortfallSec: myArr - (pArr - CLEARANCE_ARR_SEC),
            },
          );
        }

        const requiredDep = pDep + CLEARANCE_DEP_SEC;
        const wait = requiredDep - myArr;
        if (wait > MAX_OVERTAKE_WAIT_SEC) {
          throw new SeedError('待避時間が上限を超えました', {
            band: spec.bandId, slot: spec.slotId, cycle: spec.cycleIndex,
            station: stationName(facts, ov.atStationId),
            waitSec: wait, limitSec: MAX_OVERTAKE_WAIT_SEC,
          });
        }
        const currentDep = me.dep[idx];
        if (currentDep === undefined || currentDep < requiredDep) {
          me.extraDwell.set(ov.atStationId, wait);
          repropagate(facts, me);
          changed = true;
        }
        maxWaitSec = Math.max(maxWaitSec, wait);
        if (passes === 1) resolvedOvertakes++;
        const list = me.overtakenBy.get(ov.atStationId) ?? [];
        if (!list.includes(partner.spec.trainId)) list.push(partner.spec.trainId);
        me.overtakenBy.set(ov.atStationId, list);
      }
    }
  }

  // -- declared 緩急接続 ----------------------------------------------------
  for (const spec of specs) {
    const declared = spec.slot.connectsWith;
    if (declared === undefined) continue;
    const me = trains.get(spec.key)!;
    for (const cn of declared) {
      const partnerKey = specKey(spec.bandId, cn.withSlotId, spec.cycleIndex + (cn.cycleDelta ?? 0));
      const partner = trains.get(partnerKey);
      if (partner === undefined) continue;
      if (!me.indexOf.has(cn.atStationId)) continue;
      const list = me.connectsTo.get(cn.atStationId) ?? [];
      if (!list.includes(partner.spec.trainId)) list.push(partner.spec.trainId);
      me.connectsTo.set(cn.atStationId, list);
      // A 緩急接続 is mutual: record it on the 急行 too.
      if (partner.indexOf.has(cn.atStationId)) {
        const back = partner.connectsTo.get(cn.atStationId) ?? [];
        if (!back.includes(me.spec.trainId)) back.push(me.spec.trainId);
        partner.connectsTo.set(cn.atStationId, back);
      }
    }
  }

  // -- final verification, independent of the solver's own bookkeeping ------
  for (const spec of specs) {
    const me = trains.get(spec.key)!;
    verifyMonotonic(facts, me);
    for (const ov of spec.slot.overtakes ?? []) {
      const partner = trains.get(
        specKey(spec.bandId, ov.bySlotId, spec.cycleIndex + (ov.cycleDelta ?? 0)),
      );
      if (partner === undefined) continue;
      const i = me.indexOf.get(ov.atStationId)!;
      const j = partner.indexOf.get(ov.atStationId)!;
      const pDep = partner.dep[j] ?? partner.arr[j]!;
      const myDep = me.dep[i];
      if (myDep === undefined || myDep < pDep + CLEARANCE_DEP_SEC) {
        throw new SeedError('待避解が収束していません', {
          band: spec.bandId, slot: spec.slotId, cycle: spec.cycleIndex,
          station: stationName(facts, ov.atStationId),
        });
      }
    }
  }

  return { trains, passes, resolvedOvertakes, skippedAtBandEdge, maxWaitSec };
}

function repropagate(facts: Facts, t: TimedTrain): void {
  const override = facts.stopPatterns.find((p) => p.id === t.spec.stopPatternId)?.dwellOverrideSec;
  const slotOverride = t.spec.slot.dwellOverrideSec;
  const merged: Record<string, number> = { ...(override ?? {}), ...(slotOverride ?? {}) };
  const timed = timeRoute(facts, t.route, t.profileId, t.spec.departureSec, {
    dwellOverride: merged,
    extraDwell: t.extraDwell,
  });
  t.arr = timed.arr.map((v) => (v === undefined ? undefined : roundToGrain(v, GRAIN_SEC)));
  t.dep = timed.dep.map((v) => (v === undefined ? undefined : roundToGrain(v, GRAIN_SEC)));
}

function assertOvertakeLegal(facts: Facts, spec: TrainSpec, stationId: StationId): void {
  const key = facts.keyOf.get(stationId);
  const allowed = key === undefined ? undefined : OVERTAKE_STATIONS[key];
  if (allowed === undefined || !allowed.includes(spec.direction)) {
    throw new SeedError(
      '待避可能駅ではありません（旗の台=両方向 / 上野毛=上りのみ、それ以外は不可）',
      {
        band: spec.bandId, slot: spec.slotId, cycle: spec.cycleIndex,
        station: stationName(facts, stationId),
        direction: spec.direction,
      },
    );
  }
}

function verifyMonotonic(facts: Facts, t: TimedTrain): void {
  let last = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < t.route.length; i++) {
    const a = t.arr[i];
    const d = t.dep[i];
    if (a !== undefined) {
      if (a <= last) {
        throw new SeedError('列車時刻が単調増加していません', {
          band: t.spec.bandId, slot: t.spec.slotId, cycle: t.spec.cycleIndex,
          station: stationName(facts, t.route[i]!.stationId),
        });
      }
      last = a;
    }
    if (d !== undefined) {
      if (d < last) {
        throw new SeedError('出発時刻が到着時刻より前です', {
          band: t.spec.bandId, slot: t.spec.slotId, cycle: t.spec.cycleIndex,
          station: stationName(facts, t.route[i]!.stationId),
        });
      }
      last = d;
    }
  }
}

function stationName(facts: Facts, id: StationId): string {
  return facts.stationById.get(id)?.name ?? String(id);
}

// ---------------------------------------------------------------------------
// Materialize
// ---------------------------------------------------------------------------

/** `TrainStop[]` with everything except the 番線, which `trackAssign` fills in. */
export function toTrainStops(t: TimedTrain): TrainStop[] {
  return t.route.map((r, i) => {
    const stop: TrainStop = { stationId: r.stationId, kind: r.kind };
    const a = t.arr[i];
    const d = t.dep[i];
    if (a !== undefined) stop.arr = a;
    if (d !== undefined) stop.dep = d;
    const ob = t.overtakenBy.get(r.stationId);
    if (ob !== undefined && ob.length > 0) stop.overtakenBy = [...ob];
    const ct = t.connectsTo.get(r.stationId);
    if (ct !== undefined && ct.length > 0) stop.connectsTo = [...ct];
    return stop;
  });
}
