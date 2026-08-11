/**
 * 運用 construction as a **minimum path cover on a DAG**.
 *
 * Nodes are trains. There is an edge A → B when a single formation could work
 * B straight after A: B starts where A finished, the gap is at least the
 * station's 折り返し time and at most a sensible layover, and the car counts
 * agree. Because every edge points forwards in time the graph is acyclic, and
 * for a DAG
 *
 *     minimum number of paths covering every node = n − maximum matching
 *
 * in the bipartite graph whose left copy is "A is followed by …" and whose
 * right copy is "… is preceded by B". Minimising the number of paths is
 * exactly minimising the number of vehicle-days, i.e. the fleet — which is the
 * real operational objective, not a proxy for it. Kuhn's algorithm finds the
 * maximum matching in about forty lines and runs in milliseconds at n ≈ 600.
 *
 * **Determinism.** Nodes are sorted by `(depSec, trainId)` and every adjacency
 * list by `(layoverSec, depSec, trainId)` before matching starts, so the
 * augmenting-path search visits candidates in a fixed order and the resulting
 * cover is byte-stable. The 7-car and 5-car pools are solved separately —
 * they are physically incompatible, and separating them also halves the work.
 */

import type { StationId, TrainId } from '@/domain/ids';
import type { Sec } from '@/domain/units';

/**
 * The part of a node the cover itself needs: where it starts and finishes, and
 * when. Everything that decides whether two nodes may be joined lives in
 * `compatible`, because "may the same *formation* work both" and "may the same
 * *person* work both" are genuinely different questions over the same graph.
 */
export interface PathNode {
  trainId: TrainId;
  originStationId: StationId;
  terminusStationId: StationId;
  depSec: Sec;
  arrSec: Sec;
}

export interface DutyNode extends PathNode {
  key: string;
  cars: number;
  /**
   * Which pair of rails the train uses where the line is 方向別複々線. At 溝の口
   * the 田園都市線 faces (1・4番線) and the 大井町線 faces (2・3番線) are
   * different platforms with no connection between them except through the
   * 引上線, so a formation cannot arrive on one and leave from the other
   * without a shunt the model does not have. Chaining only ever joins trains
   * that use the same pair.
   */
  routing: 'om' | 'dt';
}

export interface PathCoverOptions<N extends PathNode> {
  /** 折り返し時分 at the station where the resource changes trains. */
  turnaroundSec: (stationId: StationId) => number;
  /**
   * Beyond this the formation would go back to the depot instead — per
   * station, because what a terminal can hold is a property of the terminal.
   * 大井町 has two dead-end roads and nowhere else to put a formation, so its
   * bound is far tighter than 溝の口's.
   */
  maxLayoverSec: (stationId: StationId) => number;
  /**
   * May B follow A at all, beyond meeting in space and time? Defaults to yes.
   * The 運用 caller asks for equal car counts and the same pair of rails; the
   * 乗務員 caller asks only that the station allows a crew change, because a
   * person steps off a 5-car 各停 and onto a 7-car 急行 without difficulty.
   */
  compatible?: (a: N, b: N) => boolean;
  /**
   * Terminals whose arrivals are re-paired into FIFO order together. Defaults
   * to one bucket per station; the 運用 caller splits 溝の口 by pair of rails.
   */
  fifoKey?: (node: N) => string;
}

export interface PathCoverResult<N extends PathNode> {
  chains: N[][];
  matchedEdges: number;
}

/**
 * Re-pair the matching at every turnback station into arrival order.
 *
 * The maximum matching decides *how many* formations the plan needs; it says
 * nothing about *which* arrival works which departure, and Kuhn's algorithm
 * happily hands the 08:36 arrival the 09:15 departure while a later arrival
 * takes an earlier one. Physically that is a terminal full of stock: at 大井町,
 * a 頭端式1面2線 stub with no tail track and no siding, it produced eight
 * formations booked onto two roads at once.
 *
 * A stub terminal works first-in-first-out, and FIFO is also provably optimal
 * here. Take two pairs at one station, a₁ arriving before a₂, matched to
 * departures d₁ after d₂. Swapping them is always legal:
 *
 *   a₁ + turn ≤ a₂ + turn ≤ d₂   and   a₂ + turn ≤ d₂ < d₁
 *
 * and both new layovers are strictly shorter than d₁ − a₁, so neither can
 * break the maximum-layover bound either. Sorting is a sequence of such swaps,
 * so it preserves the matching *size* exactly — the fleet does not grow — while
 * minimising, at every instant, the number of formations standing at the
 * terminal. It is the one change that makes a dense stub terminal feasible
 * without touching the timetable.
 */
function fifoAtEachStation<N extends PathNode>(
  nodes: readonly N[],
  matchLeft: Int32Array,
  matchRight: Int32Array,
  fifoKey: (node: N) => string,
): void {
  // Keyed by station AND routing: the two pairs of faces at 溝の口 are separate
  // terminals as far as a formation is concerned, and re-pairing across them
  // would undo the routing constraint the matching just honoured.
  const byStation = new Map<string, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    if (matchLeft[i] === -1) continue;
    const key = `${nodes[i]!.terminusStationId}|${fifoKey(nodes[i]!)}`;
    const list = byStation.get(key);
    if (list) list.push(i);
    else byStation.set(key, [i]);
  }

  for (const arrivals of byStation.values()) {
    if (arrivals.length < 2) continue;
    const departures = arrivals.map((i) => matchLeft[i]!);
    arrivals.sort(
      (a, b) =>
        nodes[a]!.arrSec - nodes[b]!.arrSec ||
        nodes[a]!.trainId.localeCompare(nodes[b]!.trainId),
    );
    departures.sort(
      (a, b) =>
        nodes[a]!.depSec - nodes[b]!.depSec ||
        nodes[a]!.trainId.localeCompare(nodes[b]!.trainId),
    );
    for (let k = 0; k < arrivals.length; k++) {
      const left = arrivals[k]!;
      const right = departures[k]!;
      matchLeft[left] = right;
      matchRight[right] = left;
    }
  }
}

export function minimumPathCover<N extends PathNode>(
  input: readonly N[],
  opts: PathCoverOptions<N>,
): PathCoverResult<N> {
  const nodes = [...input].sort(
    (a, b) => a.depSec - b.depSec || a.trainId.localeCompare(b.trainId),
  );
  const n = nodes.length;
  if (n === 0) return { chains: [], matchedEdges: 0 };
  const compatible = opts.compatible ?? (() => true);
  const fifoKey = opts.fifoKey ?? (() => '');

  // -- adjacency ------------------------------------------------------------
  const adjacency: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = nodes[i]!;
    const turn = opts.turnaroundSec(a.terminusStationId);
    const maxLayover = opts.maxLayoverSec(a.terminusStationId);
    const candidates: Array<{ j: number; layover: number }> = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const b = nodes[j]!;
      if (b.originStationId !== a.terminusStationId) continue;
      if (!compatible(a, b)) continue;
      const layover = b.depSec - a.arrSec;
      if (layover < turn || layover > maxLayover) continue;
      candidates.push({ j, layover });
    }
    candidates.sort(
      (x, y) =>
        x.layover - y.layover ||
        nodes[x.j]!.depSec - nodes[y.j]!.depSec ||
        nodes[x.j]!.trainId.localeCompare(nodes[y.j]!.trainId),
    );
    adjacency.push(candidates.map((c) => c.j));
  }

  // -- Kuhn's algorithm -----------------------------------------------------
  const matchRight = new Int32Array(n).fill(-1); // right node -> left node
  const matchLeft = new Int32Array(n).fill(-1); // left node -> right node
  const seen = new Uint8Array(n);
  let matchedEdges = 0;

  const tryAugment = (left: number): boolean => {
    for (const right of adjacency[left]!) {
      if (seen[right] === 1) continue;
      seen[right] = 1;
      const owner = matchRight[right]!;
      if (owner === -1 || tryAugment(owner)) {
        matchRight[right] = left;
        matchLeft[left] = right;
        return true;
      }
    }
    return false;
  };

  for (let i = 0; i < n; i++) {
    seen.fill(0);
    if (tryAugment(i)) matchedEdges++;
  }

  // -- FIFO at every turnback point -----------------------------------------
  fifoAtEachStation(nodes, matchLeft, matchRight, fifoKey);

  // -- chains ---------------------------------------------------------------
  const chains: N[][] = [];
  for (let i = 0; i < n; i++) {
    if (matchRight[i] !== -1) continue; // has a predecessor: not a chain head
    const chain: N[] = [];
    let cur = i;
    for (;;) {
      chain.push(nodes[cur]!);
      const next = matchLeft[cur]!;
      if (next === -1) break;
      cur = next;
    }
    chains.push(chain);
  }

  chains.sort(
    (a, b) => a[0]!.depSec - b[0]!.depSec || a[0]!.trainId.localeCompare(b[0]!.trainId),
  );
  return { chains, matchedEdges };
}
