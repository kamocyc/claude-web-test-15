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

  it('keeps a terminated train in the bucket through its layover', () => {
    // 各101 arrives D at 08:10:30 and its stock leaves as 回8002 at 08:20, so
    // it has to still be in the snapshot at 08:15 or the line view has nothing
    // to draw standing at the platform.
    const snap = snapshotAt(idx, 8 * H + 15 * M);
    const local = snap.trains.find((t) => t.trainId === TOY.localDown);
    expect(local?.phase.phase).toBe('layover');
    // …and the successor is not in the snapshot yet, so exactly one marker
    // stands at D — the stock, not two trains and not none.
    expect(snap.trains.map((t) => t.trainId)).toEqual([TOY.localDown]);
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

  it('says which yard road a stabled formation is standing on', () => {
    // Before the duty starts, the road its 出庫回送 leaves from…
    const before = snapshotAt(idx, 7 * H);
    expect(before.formations.get(TOY.formation1)?.stationId).toBe(TOY.stationDepot);
    expect(before.formations.get(TOY.formation1)?.trackId).toBe(TOY.x1);

    // …and afterwards, the road its 入庫回送 arrived at. Without this the
    // formation would come out of nowhere and vanish into a caption.
    const after = snapshotAt(idx, 9 * H);
    expect(after.formations.get(TOY.formation1)?.trackId).toBe(TOY.x1);
  });

  it('does not invent a road for a formation stabled away from a depot', () => {
    const stabled = snapshotAt(idx, 8 * H + 15 * M);
    const f1 = stabled.formations.get(TOY.formation1)!;
    // D駅 is not a depot, so the stable leg's own road is what is reported.
    expect(f1.stationId).toBe(TOY.stationD);
    expect(f1.trackId).toBe(TOY.d1);
    expect(f1.depotId).toBeUndefined();
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
