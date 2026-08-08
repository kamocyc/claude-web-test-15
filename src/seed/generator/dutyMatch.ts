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

export interface DutyNode {
  trainId: TrainId;
  key: string;
  originStationId: StationId;
  terminusStationId: StationId;
  depSec: Sec;
  arrSec: Sec;
  cars: number;
}

export interface PathCoverOptions {
  /** 折り返し時分 at the station where the formation changes trains. */
  turnaroundSec: (stationId: StationId) => number;
  /** Beyond this the formation would go back to the depot instead. */
  maxLayoverSec: number;
}

export interface PathCoverResult {
  chains: DutyNode[][];
  matchedEdges: number;
}

export function minimumPathCover(
  input: readonly DutyNode[],
  opts: PathCoverOptions,
): PathCoverResult {
  const nodes = [...input].sort(
    (a, b) => a.depSec - b.depSec || a.trainId.localeCompare(b.trainId),
  );
  const n = nodes.length;
  if (n === 0) return { chains: [], matchedEdges: 0 };

  // -- adjacency ------------------------------------------------------------
  const adjacency: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = nodes[i]!;
    const turn = opts.turnaroundSec(a.terminusStationId);
    const candidates: Array<{ j: number; layover: number }> = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const b = nodes[j]!;
      if (b.cars !== a.cars) continue;
      if (b.originStationId !== a.terminusStationId) continue;
      const layover = b.depSec - a.arrSec;
      if (layover < turn || layover > opts.maxLayoverSec) continue;
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

  // -- chains ---------------------------------------------------------------
  const chains: DutyNode[][] = [];
  for (let i = 0; i < n; i++) {
    if (matchRight[i] !== -1) continue; // has a predecessor: not a chain head
    const chain: DutyNode[] = [];
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
