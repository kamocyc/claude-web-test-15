/**
 * 乗務員行路 construction.
 *
 * The same minimum path cover as 運用, over the same trains, with different
 * edges — and that difference is the whole reason crew are modelled at all. A
 * formation may only follow itself where it can physically reverse, keeping
 * its length and its pair of rails. A person may follow anything that leaves
 * from where they are standing, provided the station is a 交代可能駅 and there
 * is time to walk. So the cover is the same algorithm and a different graph.
 *
 * What the cover cannot express is *length*: maximum matching is local, and
 * 連続乗務 / 実乗務 / 拘束 are all properties of a whole path. So there are
 * four passes after it, in this order:
 *
 *   1. cut every chain wherever carrying on would break a working limit,
 *   2. **join the pieces back up across a 休憩** — a second path cover, this
 *      time over the pieces, whose edges are "ends at a 基地, and the next
 *      piece starts there late enough to have been a proper rest",
 *   3. cut again where a duty is long enough to owe 休憩 and hasn't got one,
 *   4. close both ends at a 乗務員基地 by 添乗 — riding someone else's train.
 *
 * Pass 2 is not an optimisation, it is the shape of the thing. Without it
 * every duty is capped at four hours of *elapsed* time and books about two and
 * a half hours of driving, which is a roster no railway would recognise: the
 * limit that bites is 連続乗務, and the answer to 連続乗務 is a break, not a
 * shorter day. With it the same trains need roughly half as many people, each
 * of whom works 前半 → 中休 → 後半.
 *
 * Pass 4 is why the limits are checked against a reduced spread: the 添乗 legs
 * are added afterwards and would otherwise push a just-legal duty over the
 * line, and repairing that would be a fixpoint rather than a pass.
 */

import type { CrewDutyId, StationId, TrainId } from '@/domain/ids';
import type { CrewDuty, CrewLeg, CrewRole, Station, Train, ValidationConfig } from '@/domain/model';
import type { DayTypeId } from '@/domain/ids';
import type { Sec } from '@/domain/units';
import { minimumPathCover, type PathNode } from './dutyMatch';

/** Beyond this a crew would be sent home rather than left standing about. */
const MAX_LAYOVER_AT_BASE_SEC = 60 * 60;
const MAX_LAYOVER_ELSEWHERE_SEC = 25 * 60;

/**
 * Spread kept in hand at each end for the 添乗 that gets the crew to and from
 * their base. 20 分 covers 鷺沼→自由が丘 with a wait; the seed's worst actual
 * case is well inside it.
 */
const DEADHEAD_HEADROOM_SEC = 20 * 60;

/** A wait shorter than this is not worth a row on the 行路表. */
const STANDBY_MIN_SEC = 5 * 60;

/** The longest 中休 worth planning; beyond it the crew would go home. */
const MAX_BREAK_SEC = 3 * 60 * 60;

export interface CrewNode extends PathNode {
  train: Train;
}

/** One half-duty, presented to the second cover as if it were a train. */
interface PieceNode extends PathNode {
  group: Group;
  index: number;
}

export interface CrewBuildInput {
  stationById: ReadonlyMap<StationId, Station>;
  /** Every train that needs this role, in any order. */
  trains: readonly Train[];
  /** All trains, including ones this role does not work — 添乗 can use those. */
  allTrains: readonly Train[];
  cfg: ValidationConfig;
  dayTypeId: DayTypeId;
  role: CrewRole;
  nextId: () => CrewDutyId;
  /** '運' → 運01, 運02, … */
  codePrefix: string;
}

export interface CrewBuildReport {
  duties: CrewDuty[];
  /** Chains split because carrying on would break a working limit. */
  workLimitCuts: number;
  /** Chains split again because the duty owed a 休憩 it did not have. */
  breakCuts: number;
  deadheadLegs: number;
  breakLegs: number;
  standbyLegs: number;
  /** Ends that could not be brought home. Non-zero means the plan is broken. */
  strandedEnds: number;
  totalWorkSec: number;
}

export class CrewError extends Error {}

// ---------------------------------------------------------------------------

function depOf(train: Train): Sec | undefined {
  const first = train.stops[0];
  return first?.dep ?? first?.arr;
}

function arrOf(train: Train): Sec | undefined {
  const last = train.stops[train.stops.length - 1];
  return last?.arr ?? last?.dep;
}

/** A run of nodes that one person can work end to end. */
interface Group {
  nodes: CrewNode[];
  workSec: number;
  breakSec: number;
  /** Index into `nodes` of the gap that is longest, for the break repair. */
  longestGapAt: number;
  longestGapSec: number;
}

export function buildCrewDuties(input: CrewBuildInput): CrewBuildReport {
  const { cfg, stationById } = input;
  const isBase = (id: StationId): boolean => stationById.get(id)?.crewBase === true;
  const isRelief = (id: StationId): boolean => {
    const station = stationById.get(id);
    return station?.crewChange === true || station?.crewBase === true;
  };

  // -- nodes ----------------------------------------------------------------
  const nodes: CrewNode[] = [];
  for (const train of input.trains) {
    const dep = depOf(train);
    const arr = arrOf(train);
    const origin = train.stops[0]?.stationId;
    const terminus = train.stops[train.stops.length - 1]?.stationId;
    if (dep === undefined || arr === undefined || origin === undefined || terminus === undefined) {
      continue;
    }
    if (train.stops.length < 2) continue;
    nodes.push({
      trainId: train.id,
      originStationId: origin,
      terminusStationId: terminus,
      depSec: dep,
      arrSec: arr,
      train,
    });
  }

  // -- 1. the cover ---------------------------------------------------------
  const { chains } = minimumPathCover<CrewNode>(nodes, {
    turnaroundSec: () => cfg.crewMinHandoverSec,
    maxLayoverSec: (id) => (isBase(id) ? MAX_LAYOVER_AT_BASE_SEC : MAX_LAYOVER_ELSEWHERE_SEC),
    // The only extra condition: somebody has to be able to get on and off.
    compatible: (a) => isRelief(a.terminusStationId),
  });

  // -- 2. cut for the working limits ----------------------------------------
  const maxSpread = cfg.crewMaxSpreadSec - 2 * DEADHEAD_HEADROOM_SEC;
  let workLimitCuts = 0;


  const gapIsBreak = (prev: CrewNode, next: CrewNode): boolean =>
    next.depSec - prev.arrSec >= cfg.crewMinBreakSec && isBase(prev.terminusStationId);

  const groups: Group[] = [];
  for (const chain of chains) {
    groups.push(...cutForLimits(chain, gapIsBreak, cfg, isBase, (n) => (workLimitCuts += n)));
  }

  // -- 2b. join the pieces back up across a 休憩 -----------------------------
  // The same cover again, one level up: a piece may follow another when the
  // first ends at a 基地 and the second starts there after a gap long enough
  // to be a rest. `turnaroundSec` is therefore the minimum 休憩 rather than
  // the minimum hand-over — the edge *is* the break.
  const pieceNodes: PieceNode[] = groups.map((group, i) => ({
    trainId: group.nodes[0]!.trainId,
    originStationId: group.nodes[0]!.originStationId,
    terminusStationId: group.nodes[group.nodes.length - 1]!.terminusStationId,
    depSec: group.nodes[0]!.depSec,
    arrSec: group.nodes[group.nodes.length - 1]!.arrSec,
    group,
    index: i,
  }));

  const joined = minimumPathCover<PieceNode>(pieceNodes, {
    turnaroundSec: () => cfg.crewMinBreakSec,
    maxLayoverSec: () => MAX_BREAK_SEC,
    compatible: (a, b) =>
      isBase(a.terminusStationId) &&
      a.group.workSec + b.group.workSec <= cfg.crewMaxWorkSec &&
      b.arrSec + cfg.crewSignOffSec - (a.depSec - cfg.crewSignOnSec) <= maxSpread,
  }).chains;

  // Re-cut the merged sequences: the join added 休憩, which reset the
  // continuous clock, so this pass should find almost nothing to do — but a
  // three-piece chain can still overrun and this is what catches it.
  const merged: Group[] = [];
  for (const chain of joined) {
    const nodes = chain.flatMap((piece) => piece.group.nodes);
    merged.push(...cutForLimits(nodes, gapIsBreak, cfg, isBase, (n) => (workLimitCuts += n)));
  }

  // -- 3. the 休憩 total ----------------------------------------------------
  // A duty that works past the continuous limit owes a total; if it has not
  // got one, split it at its longest gap. Both halves then work less than the
  // continuous limit, so neither owes anything — the repair always terminates,
  // and it costs a duty rather than inventing a break that has nowhere to be
  // taken.
  const settled: Group[] = [];
  let breakCuts = 0;
  const queue = [...merged];
  while (queue.length > 0) {
    const group = queue.shift()!;
    const owes = group.workSec >= cfg.crewMaxContinuousWorkSec;
    if (!owes || group.breakSec >= cfg.crewMinTotalBreakSec || group.longestGapAt <= 0) {
      settled.push(group);
      continue;
    }
    breakCuts++;
    queue.unshift(regroup(group.nodes.slice(group.longestGapAt), gapIsBreak));
    queue.unshift(regroup(group.nodes.slice(0, group.longestGapAt), gapIsBreak));
  }
  settled.sort(
    (a, b) =>
      a.nodes[0]!.depSec - b.nodes[0]!.depSec ||
      a.nodes[0]!.trainId.localeCompare(b.nodes[0]!.trainId),
  );

  // -- 4. bring both ends home, and lay the legs out ------------------------
  const rides = buildRideIndex(input.allTrains);
  const duties: CrewDuty[] = [];
  const report: CrewBuildReport = {
    duties,
    workLimitCuts,
    breakCuts,
    deadheadLegs: 0,
    breakLegs: 0,
    standbyLegs: 0,
    strandedEnds: 0,
    totalWorkSec: 0,
  };

  for (const [i, group] of settled.entries()) {
    const head = group.nodes[0]!;
    const tail = group.nodes[group.nodes.length - 1]!;
    const legs: CrewLeg[] = [];

    if (!isBase(head.originStationId)) {
      const ride = rides.toReach(head.originStationId, head.depSec - cfg.crewMinHandoverSec, isBase);
      if (ride === undefined) {
        report.strandedEnds++;
        throw new CrewError(
          `乗務員行路の出勤箇所に着けません: ${head.originStationId} ${head.depSec}`,
        );
      }
      legs.push(ride.leg);
      report.deadheadLegs++;
      if (head.depSec - ride.arrSec >= STANDBY_MIN_SEC) {
        legs.push({
          kind: 'standby',
          stationId: head.originStationId,
          from: ride.arrSec,
          to: head.depSec,
        });
        report.standbyLegs++;
      }
    }

    for (const [k, node] of group.nodes.entries()) {
      legs.push({
        kind: 'train',
        trainId: node.trainId,
        fromIndex: 0,
        toIndex: node.train.stops.length - 1,
      });
      report.totalWorkSec += node.arrSec - node.depSec;
      const next = group.nodes[k + 1];
      if (next === undefined) continue;
      const gap = next.depSec - node.arrSec;
      if (gapIsBreak(node, next)) {
        legs.push({
          kind: 'break',
          stationId: node.terminusStationId,
          from: node.arrSec,
          to: next.depSec,
        });
        report.breakLegs++;
      } else if (gap >= STANDBY_MIN_SEC) {
        legs.push({
          kind: 'standby',
          stationId: node.terminusStationId,
          from: node.arrSec,
          to: next.depSec,
        });
        report.standbyLegs++;
      }
    }

    if (!isBase(tail.terminusStationId)) {
      const ride = rides.toLeave(
        tail.terminusStationId,
        tail.arrSec + cfg.crewMinHandoverSec,
        isBase,
      );
      if (ride === undefined) {
        report.strandedEnds++;
        throw new CrewError(
          `乗務員行路の退勤箇所に帰れません: ${tail.terminusStationId} ${tail.arrSec}`,
        );
      }
      if (ride.depSec - tail.arrSec >= STANDBY_MIN_SEC) {
        legs.push({
          kind: 'standby',
          stationId: tail.terminusStationId,
          from: tail.arrSec,
          to: ride.depSec,
        });
        report.standbyLegs++;
      }
      legs.push(ride.leg);
      report.deadheadLegs++;
    }

    const first = legs[0]!;
    const baseStationId =
      first.kind === 'deadhead'
        ? (input.allTrains
            .find((t) => t.id === first.trainId)
            ?.stops[first.fromIndex]?.stationId ?? head.originStationId)
        : head.originStationId;

    duties.push({
      id: input.nextId(),
      code: `${input.codePrefix}${String(i + 1).padStart(2, '0')}`,
      role: input.role,
      baseStationId,
      dayTypeIds: [input.dayTypeId],
      legs,
    });
  }

  return report;
}

/**
 * Walk a run of nodes and start a new group wherever carrying on would break
 * a working limit. A gap that counts as a 休憩 resets the continuous clock,
 * which is what lets a joined 前半+後半 survive this pass intact.
 */
function cutForLimits(
  chain: readonly CrewNode[],
  gapIsBreak: (a: CrewNode, b: CrewNode) => boolean,
  cfg: ValidationConfig,
  isBase: (id: StationId) => boolean,
  countCut: (n: number) => void,
): Group[] {
  const out: Group[] = [];
  let cur: Group | undefined;
  let resetSec = 0; // start of the stretch since the last 休憩

  for (const node of chain) {
    const ride = node.arrSec - node.depSec;
    if (cur === undefined) {
      cur = { nodes: [node], workSec: ride, breakSec: 0, longestGapAt: -1, longestGapSec: 0 };
      resetSec = node.depSec;
      out.push(cur);
      continue;
    }

    const prev = cur.nodes[cur.nodes.length - 1]!;
    const gap = node.depSec - prev.arrSec;
    const isBreak = gapIsBreak(prev, node);
    const nextReset = isBreak ? node.depSec : resetSec;
    const continuous = node.arrSec - nextReset;
    const work = cur.workSec + ride;
    const spread = node.arrSec + cfg.crewSignOffSec - (cur.nodes[0]!.depSec - cfg.crewSignOnSec);

    // Room for the 添乗 legs pass 4 will add. The front one only lengthens the
    // first stretch — after a 休憩 it is long past — and the back one only
    // matters if this node leaves the crew away from a base.
    const front =
      resetSec === cur.nodes[0]!.depSec && !isBase(cur.nodes[0]!.originStationId)
        ? DEADHEAD_HEADROOM_SEC
        : 0;
    const back = isBase(node.terminusStationId) ? 0 : DEADHEAD_HEADROOM_SEC;

    if (
      continuous + (isBreak ? 0 : front) + back > cfg.crewMaxContinuousWorkSec ||
      work > cfg.crewMaxWorkSec ||
      spread + front + back > cfg.crewMaxSpreadSec
    ) {
      countCut(1);
      cur = { nodes: [node], workSec: ride, breakSec: 0, longestGapAt: -1, longestGapSec: 0 };
      resetSec = node.depSec;
      out.push(cur);
      continue;
    }

    if (gap > cur.longestGapSec) {
      cur.longestGapSec = gap;
      cur.longestGapAt = cur.nodes.length;
    }
    if (isBreak) cur.breakSec += gap;
    cur.nodes.push(node);
    cur.workSec = work;
    resetSec = nextReset;
  }
  return out;
}

/** Recompute a group's totals after a split. */
function regroup(
  nodes: CrewNode[],
  gapIsBreak: (a: CrewNode, b: CrewNode) => boolean,
): Group {
  const group: Group = { nodes, workSec: 0, breakSec: 0, longestGapAt: -1, longestGapSec: 0 };
  for (const [i, node] of nodes.entries()) {
    group.workSec += node.arrSec - node.depSec;
    const next = nodes[i + 1];
    if (next === undefined) continue;
    const gap = next.depSec - node.arrSec;
    if (gap > group.longestGapSec) {
      group.longestGapSec = gap;
      group.longestGapAt = i + 1;
    }
    if (gapIsBreak(node, next)) group.breakSec += gap;
  }
  return group;
}

// ---------------------------------------------------------------------------
// 添乗 — riding someone else's train
// ---------------------------------------------------------------------------

interface RideOption {
  leg: Extract<CrewLeg, { kind: 'deadhead' }>;
  depSec: Sec;
  arrSec: Sec;
}

/**
 * Both directions of the same question: which train will carry a person
 * between a base and somewhere else, near a given moment?
 *
 * Only stops count. A crew member cannot get off a train that runs through,
 * which is why this walks `stops` rather than the timetable's km axis.
 */
function buildRideIndex(trains: readonly Train[]) {
  const sorted = [...trains].sort((a, b) => (depOf(a) ?? 0) - (depOf(b) ?? 0) || a.id.localeCompare(b.id));

  const stopsAt = (train: Train): Array<{ index: number; stationId: StationId; arr?: Sec; dep?: Sec }> => {
    const out: Array<{ index: number; stationId: StationId; arr?: Sec; dep?: Sec }> = [];
    for (const [index, stop] of train.stops.entries()) {
      if (stop.kind !== 'stop') continue;
      out.push({
        index,
        stationId: stop.stationId,
        ...(stop.arr === undefined ? {} : { arr: stop.arr }),
        ...(stop.dep === undefined ? {} : { dep: stop.dep }),
      });
    }
    return out;
  };

  return {
    /** The latest train that gets a crew from any base to `stationId` by `by`. */
    toReach(stationId: StationId, by: Sec, isBase: (id: StationId) => boolean): RideOption | undefined {
      let best: RideOption | undefined;
      for (const train of sorted) {
        const stops = stopsAt(train);
        for (const [k, stop] of stops.entries()) {
          if (stop.stationId !== stationId) continue;
          const arr = stop.arr ?? stop.dep;
          if (arr === undefined || arr > by) continue;
          for (let j = k - 1; j >= 0; j--) {
            const from = stops[j]!;
            if (!isBase(from.stationId)) continue;
            const dep = from.dep ?? from.arr;
            if (dep === undefined) continue;
            if (best === undefined || arr > best.arrSec) {
              best = {
                leg: { kind: 'deadhead', trainId: train.id, fromIndex: from.index, toIndex: stop.index },
                depSec: dep,
                arrSec: arr,
              };
            }
            break;
          }
        }
      }
      return best;
    },

    /** The earliest train that takes a crew from `stationId` to any base after `from`. */
    toLeave(stationId: StationId, from: Sec, isBase: (id: StationId) => boolean): RideOption | undefined {
      let best: RideOption | undefined;
      for (const train of sorted) {
        const stops = stopsAt(train);
        for (const [k, stop] of stops.entries()) {
          if (stop.stationId !== stationId) continue;
          const dep = stop.dep ?? stop.arr;
          if (dep === undefined || dep < from) continue;
          for (let j = k + 1; j < stops.length; j++) {
            const to = stops[j]!;
            if (!isBase(to.stationId)) continue;
            const arr = to.arr ?? to.dep;
            if (arr === undefined) continue;
            if (best === undefined || dep < best.depSec) {
              best = {
                leg: { kind: 'deadhead', trainId: train.id, fromIndex: stop.index, toIndex: to.index },
                depSec: dep,
                arrSec: arr,
              };
            }
            break;
          }
        }
      }
      return best;
    },
  };
}

export type { TrainId };
