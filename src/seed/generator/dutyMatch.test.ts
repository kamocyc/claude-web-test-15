/**
 * Minimum path cover, tested on hand-checkable graphs.
 *
 * The property that matters is not "some cover" but "the smallest one": the
 * number of paths IS the fleet size, so an off-by-one here is a formation that
 * a real depot would have to find from somewhere.
 */

import { describe, expect, it } from 'vitest';
import { asId } from '@/domain/ids';
import type { StationId, TrainId } from '@/domain/ids';
import { minimumPathCover, type DutyNode } from './dutyMatch';

const A = asId<'Station'>('stn-A');
const B = asId<'Station'>('stn-B');

let seq = 0;
function node(from: StationId, to: StationId, dep: number, arr: number, cars = 5): DutyNode {
  seq += 1;
  const id = asId<'Train'>(`trn-${String(seq).padStart(3, '0')}`);
  return {
    trainId: id as TrainId,
    key: String(id),
    originStationId: from,
    terminusStationId: to,
    depSec: dep,
    arrSec: arr,
    cars,
    routing: 'om' as const,
  };
}

const opts = {
  turnaroundSec: () => 300,
  maxLayoverSec: () => 3600,
  compatible: (a: DutyNode, b: DutyNode) => b.cars === a.cars && b.routing === a.routing,
  fifoKey: (n: DutyNode) => n.routing,
};

describe('minimumPathCover', () => {
  it('chains a there-and-back shuttle into a single duty', () => {
    seq = 0;
    const nodes = [
      node(A, B, 0, 1000),
      node(B, A, 1400, 2400),
      node(A, B, 2800, 3800),
    ];
    const { chains } = minimumPathCover(nodes, opts);
    expect(chains).toHaveLength(1);
    expect(chains[0]).toHaveLength(3);
  });

  it('refuses to chain across a gap shorter than the turnaround', () => {
    seq = 0;
    const nodes = [node(A, B, 0, 1000), node(B, A, 1100, 2100)]; // 100 s < 300 s
    expect(minimumPathCover(nodes, opts).chains).toHaveLength(2);
  });

  it('refuses to chain across a layover longer than the limit', () => {
    seq = 0;
    const nodes = [node(A, B, 0, 1000), node(B, A, 1000 + 3601, 6000)];
    expect(minimumPathCover(nodes, opts).chains).toHaveLength(2);
  });

  it('never mixes car counts', () => {
    seq = 0;
    const nodes = [node(A, B, 0, 1000, 5), node(B, A, 1400, 2400, 7)];
    expect(minimumPathCover(nodes, opts).chains).toHaveLength(2);
  });

  it('finds the MINIMUM cover, not merely a greedy one', () => {
    // Two trains arrive at B; two leave B. A greedy sweep that pairs the first
    // arrival with the first feasible departure can strand one of them; the
    // matching must pair both.
    seq = 0;
    const a1 = node(A, B, 0, 1000);
    const a2 = node(A, B, 200, 1200);
    const b1 = node(B, A, 1500, 2500);
    const b2 = node(B, A, 1600, 2600);
    const { chains } = minimumPathCover([a1, a2, b1, b2], opts);
    expect(chains).toHaveLength(2);
    expect(chains.every((c) => c.length === 2)).toBe(true);
  });

  it('is deterministic under input permutation', () => {
    seq = 0;
    const nodes = [
      node(A, B, 0, 1000),
      node(B, A, 1400, 2400),
      node(A, B, 2800, 3800),
      node(A, B, 100, 1100),
      node(B, A, 1500, 2500),
    ];
    const forward = minimumPathCover(nodes, opts).chains.map((c) => c.map((n) => n.trainId));
    const reversed = minimumPathCover([...nodes].reverse(), opts).chains.map((c) =>
      c.map((n) => n.trainId),
    );
    expect(reversed).toEqual(forward);
  });

  it('handles an empty pool', () => {
    expect(minimumPathCover([], opts)).toEqual({ chains: [], matchedEdges: 0 });
  });
});
