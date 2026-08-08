import { describe, expect, it } from 'vitest';

import { TOY, toyProject } from '@/testing/toyProject';
import { buildIndex } from './buildIndex';
import { createEmptySnapshot, snapshotAt, snapshotInto } from './snapshot';

const H = 3600;
const M = 60;

describe('snapshotAt', () => {
  const doc = toyProject();
  const idx = buildIndex(doc);

  it('returns only the trains active in that minute', () => {
    const snap = snapshotAt(idx, 8 * H + 5 * M);
    const ids = snap.trains.map((t) => t.trainId).sort();
    expect(ids).toEqual([TOY.localDown, TOY.expressDown].sort());
  });

  it('is empty before anything moves', () => {
    expect(snapshotAt(idx, 4 * H).trains).toEqual([]);
  });

  it('maps the roads that are occupied right now', () => {
    const snap = snapshotAt(idx, 8 * H + 5 * M);
    expect(snap.trackOccupancy.get(TOY.c2)).toBe(TOY.localDown);
    expect(snap.trackOccupancy.has(TOY.b1)).toBe(false);
  });

  it('tracks each formation through its duty', () => {
    const morning = snapshotAt(idx, 7 * H);
    expect(morning.formations.get(TOY.formation1)?.phase).toBe('inDepot');
    expect(morning.depotOccupancy.get(TOY.depot)).toContain(TOY.formation1);

    const running = snapshotAt(idx, 8 * H + 5 * M);
    const f1 = running.formations.get(TOY.formation1)!;
    expect(f1.phase).toBe('inService');
    expect(f1.currentTrainId).toBe(TOY.localDown);
    expect(f1.dutyId).toBe(TOY.dutyLocal);
    expect(f1.kmToday).toBe(7000);
    expect(f1.kmSoFarToday).toBeGreaterThan(500);
    expect(f1.kmSoFarToday).toBeLessThan(7000);

    const stabled = snapshotAt(idx, 8 * H + 15 * M);
    expect(stabled.formations.get(TOY.formation1)?.phase).toBe('stabled');
    expect(stabled.formations.get(TOY.formation1)?.stationId).toBe(TOY.stationD);

    const home = snapshotAt(idx, 9 * H);
    expect(home.formations.get(TOY.formation1)?.phase).toBe('inDepot');
  });

  it('calls the 出庫 leg a deadhead out of the shed', () => {
    const snap = snapshotAt(idx, 7 * H + 51 * M);
    expect(snap.formations.get(TOY.formation1)?.phase).toBe('deadheadOut');
  });

  it('reuses the pooled snapshot object', () => {
    const pooled = createEmptySnapshot();
    const a = snapshotInto(idx, 8 * H + 5 * M, pooled);
    expect(a).toBe(pooled);
    const b = snapshotInto(idx, 4 * H, pooled);
    expect(b).toBe(pooled);
    expect(b.trains).toEqual([]);
    expect(b.trackOccupancy.size).toBe(0);
  });
});
