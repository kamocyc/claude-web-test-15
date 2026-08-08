/**
 * The 待避 solver, exercised on one band at a time.
 *
 * `index.test.ts` checks the whole day; this file checks the mechanism, and in
 * particular that it fails loudly rather than quietly producing a timetable
 * that cannot be run.
 */

import { describe, expect, it } from 'vitest';
import { makeIdFactory, ID_PREFIX } from '@/domain/ids';
import type { TrainId } from '@/domain/ids';
import { SEC_PER_HOUR } from '@/domain/time';
import { SeedError } from '../errors';
import { buildFacts } from '../oimachi/facts';
import { buildServicePlan } from '../oimachi/service';
import { expandBands } from './expand';
import { buildStopTimes, CLEARANCE_ARR_SEC, CLEARANCE_DEP_SEC } from './stopTimes';
import type { ServicePattern, TimeBand } from './patternTypes';

const facts = buildFacts();
const plan = buildServicePlan(facts);

function ids(): () => TrainId {
  const next = makeIdFactory(ID_PREFIX.train);
  return () => next<'Train'>();
}

function bandNamed(name: string): { band: TimeBand; pattern: ServicePattern } {
  const band = plan.bands.find((b) => b.name === name)!;
  const pattern = plan.patterns.find((p) => p.id === band.patternId)!;
  return { band, pattern };
}

describe('日中パターン単体 — 15分サイクル', () => {
  const { band, pattern } = bandNamed('日中');
  const specs = expandBands([band], [pattern], ids());
  const result = buildStopTimes(facts, specs);

  it('emits four trains per direction per cycle, 16 本/時', () => {
    const cycle0 = specs.filter((s) => s.cycleIndex === 0);
    expect(cycle0.filter((s) => s.direction === 'down')).toHaveLength(4);
    expect(cycle0.filter((s) => s.direction === 'up')).toHaveLength(4);
  });

  it('converges without hunting: one productive pass, one confirming pass', () => {
    expect(result.passes).toBe(2);
    expect(result.resolvedOvertakes).toBeGreaterThan(0);
  });

  it('holds the 各停 at 旗の台 until the 急行 has gone, with clearance both sides', () => {
    const local = result.trains.get(`${band.id}:d1:3`)!;
    const express = result.trains.get(`${band.id}:d2:3`)!;
    const at = facts.S.hatanodai;
    const li = local.indexOf.get(at)!;
    const ei = express.indexOf.get(at)!;

    expect(local.arr[li]!).toBeLessThanOrEqual(express.arr[ei]! - CLEARANCE_ARR_SEC);
    expect(local.dep[li]!).toBeGreaterThanOrEqual(express.dep[ei]! + CLEARANCE_DEP_SEC);
    // ...and the 急行 really does stop there — this is a 緩急接続, not a flypast.
    expect(local.route[li]!.kind).toBe('stop');
    expect(express.route[ei]!.kind).toBe('stop');
    expect(express.dep[ei]!).toBeGreaterThan(express.arr[ei]!);
  });

  it('extends the wait by lengthening the dwell, not by moving the origin', () => {
    const local = result.trains.get(`${band.id}:d1:3`)!;
    const spec = specs.find((s) => s.key === `${band.id}:d1:3`)!;
    expect(local.dep[0]).toBe(spec.departureSec);
    const at = facts.S.hatanodai;
    const i = local.indexOf.get(at)!;
    const dwell = local.dep[i]! - local.arr[i]!;
    expect(dwell).toBeGreaterThan(facts.stationById.get(at)!.minDwellSec);
    expect(local.extraDwell.get(at)).toBe(dwell);
  });

  it('re-propagates downstream: the wait shows up at the terminus too', () => {
    const waiter = result.trains.get(`${band.id}:d1:3`)!;
    const clear = result.trains.get(`${band.id}:d4:3`)!;
    const journey = (t: typeof waiter): number =>
      t.arr[t.route.length - 1]! - t.dep[0]!;
    expect(journey(waiter)).toBeGreaterThan(journey(clear));
  });

  it('leaves the 急行 itself untouched — it never waits for anyone', () => {
    for (const spec of specs.filter((s) => s.trainTypeId === facts.type.express)) {
      expect(result.trains.get(spec.key)!.extraDwell.size).toBe(0);
    }
  });
});

describe('朝ラッシュ — 待避は旗の台', () => {
  const { band, pattern } = bandNamed('朝ラッシュ');
  const result = buildStopTimes(facts, expandBands([band], [pattern], ids()));

  it('stands the 各停 ahead of the 急行 aside at 旗の台', () => {
    const atHatanodai = result.trains.get(`${band.id}:u1:2`)!;
    expect(atHatanodai.extraDwell.has(facts.S.hatanodai)).toBe(true);
    expect(atHatanodai.overtakenBy.get(facts.S.hatanodai)).toHaveLength(1);
  });

  it('keeps every wait inside the sanity limit', () => {
    expect(result.maxWaitSec).toBeLessThanOrEqual(600);
  });
});

describe('不正な待避は静かに通さない', () => {
  it('throws naming band, slot, cycle and station when 待避 is declared off-loop', () => {
    const { band, pattern } = bandNamed('日中');
    // 自由が丘 has four platform faces in reality, but two of them belong to the
    // 東横線 — a 大井町線 train cannot be overtaken there, and saying otherwise
    // must be an error rather than a plausible-looking timetable.
    const broken: ServicePattern = {
      ...pattern,
      slots: pattern.slots.map((s) =>
        s.id === 'd1'
          ? { ...s, overtakes: [{ atStationId: facts.S.jiyugaoka, bySlotId: 'd2' }] }
          : s,
      ),
    };
    const specs = expandBands([{ ...band, toSec: 11 * SEC_PER_HOUR }], [broken], ids());
    expect(() => buildStopTimes(facts, specs)).toThrow(SeedError);
    expect(() => buildStopTimes(facts, specs)).toThrow(/待避可能駅ではありません/);
    try {
      buildStopTimes(facts, specs);
    } catch (err) {
      expect((err as SeedError).context).toMatchObject({
        band: band.id,
        slot: 'd1',
        cycle: 0,
        station: '自由が丘',
      });
    }
  });

  it('rejects 上野毛 in the 下り — its loop is 上り-only', () => {
    const { band, pattern } = bandNamed('日中');
    const broken: ServicePattern = {
      ...pattern,
      slots: pattern.slots.map((s) =>
        s.id === 'd1'
          ? { ...s, overtakes: [{ atStationId: facts.S.kaminoge, bySlotId: 'd2' }] }
          : s,
      ),
    };
    const specs = expandBands([{ ...band, toSec: 11 * SEC_PER_HOUR }], [broken], ids());
    expect(() => buildStopTimes(facts, specs)).toThrow(/待避可能駅ではありません/);
  });

  it('throws when the 各停 could not reach the 待避 station ahead of the 急行', () => {
    const { band, pattern } = bandNamed('日中');
    // Launch the 急行 only 30 s behind the 各停: it arrives at 旗の台 before the
    // 各停 has cleared the section, which is unrunnable, not merely tight.
    const broken: ServicePattern = {
      ...pattern,
      slots: pattern.slots.map((s) => (s.id === 'd2' ? { ...s, offsetSec: 30 } : s)),
    };
    const specs = expandBands([{ ...band, toSec: 11 * SEC_PER_HOUR }], [broken], ids());
    expect(() => buildStopTimes(facts, specs)).toThrow(/待避不能/);
  });
});
