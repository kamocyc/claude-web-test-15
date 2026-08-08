/**
 * The weekday service plan: eight time bands, each with one repeating cycle.
 *
 *   05:00–06:30 早朝     20分周期  各停のみ、鷺沼発着の青各停を含む
 *   06:30–07:30 立上り   15分周期  急行運転開始 (8本/時)
 *   07:30–09:00 朝ラッシュ 15分周期  上り20本/時・下り16本/時
 *   09:00–10:00 逓減     15分周期  12本/時
 *   10:00–16:00 日中     15分周期  急行1+各停3 = 16本/時
 *   16:00–20:00 夕ラッシュ 15分周期  16本/時、急行は鷺沼まで直通
 *   20:00–23:00 夜間     15分周期  日中パターンに復帰
 *   23:00–24:30 深夜     20分周期  終列車、溝の口引上線から入庫
 *
 * ===========================================================================
 * Two structural findings that shaped this file — both of them consequences of
 * the researched infrastructure, not of the numbers chosen here
 * ===========================================================================
 *
 * **1. One 待避線 per direction caps the line at 16 本/時 wherever an 急行 runs.**
 * An 急行 covers 大井町〜溝の口 about 350 s faster than a 緑各停 and 430 s faster
 * than a 青各停. Between 大井町 and 旗の台 (km 0.0–3.1) there is no passing
 * track at all, so an 急行 must still be *behind* every 各停 it has not yet
 * passed when it reaches 旗の台 — and it can stand exactly one of them aside
 * there per cycle. Any other 各停 therefore has to be far enough ahead to stay
 * ahead for the whole run: ≥ 350 + 90 s of headway for a 緑, ≥ 430 + 90 for a
 * 青. Four trains in a 15-minute cycle satisfies that. Five does not, in either
 * direction, unless a second passing track exists.
 *
 * **2. 上り can do 20 本/時 in the morning because it has a second one.**
 * 上野毛's passing loop is 上り-only, so the 朝ラッシュ 上り — and only the 上り
 * — can carry a fifth train per cycle, standing one 各停 aside at 旗の台 and a
 * second at 上野毛 for the same 急行. The 下り peak, morning or evening, cannot:
 * the 夕ラッシュ therefore tightens by running 7-car 急行 through onto the
 * 田園都市線 rather than by running more trains. That asymmetry is a real
 * property of the 大井町線 and the model reproduces it rather than papering
 * over it.
 *
 * ===========================================================================
 * The 15-minute grid
 * ===========================================================================
 *
 * Every band from 立上り to 夜間 uses the SAME 900-second cycle and the same
 * slot offsets, and every band boundary falls on a multiple of 900 s from
 * 06:30. Bands differ only in which slots they populate. That is what keeps the
 * transitions clean: a band never has to re-phase, so no train from the
 * outgoing pattern can arrive inside the incoming one's headway.
 *
 *   下り  d1 緑 +0:00 (旗の台で待避)   d2 急 +4:10   d3 青 +7:30   d4 緑 +11:00
 *   上り  u1 緑 +0:00 (旗の台で待避)   u2 急 +5:00   u3 青 +8:00   u4 緑 +11:00
 *                                      u5 緑 +13:20 (上野毛で待避、朝のみ)
 *
 * The 急行 leaves four to five minutes behind the 各停 it will overtake — far
 * enough that it is still 100 s behind on arrival at 旗の台, which is where the
 * only 待避線 in that direction is. Offsets are all multiples of 10 s, so every
 * computed time lands on the 5-second grain with no rounding.
 *
 * Everything in this file is a reconstruction. The band boundaries, the cycle
 * lengths and the mix inside a cycle follow the researched pattern; the exact
 * offsets do not come from any published timetable.
 */

import type { Direction } from '@/domain/model';
import type { Sec } from '@/domain/units';
import { SEC_PER_HOUR, SEC_PER_MIN } from '@/domain/time';
import type { PatternSlot, ServicePattern, TimeBand } from '../generator/patternTypes';
import { CARS, type Facts, type PatternKey, type StationKey } from './facts';

const H = SEC_PER_HOUR;
const M = SEC_PER_MIN;

interface SlotDef {
  id: string;
  offsetSec: number;
  windowOffsetSec?: number;
  patternKey: PatternKey;
  overtakes?: Array<{ at: StationKey; by: string; cycleDelta?: number }>;
  connectsWith?: Array<{ at: StationKey; withSlot: string; cycleDelta?: number }>;
  note?: string;
}

interface BandDef {
  id: string;
  name: string;
  fromSec: Sec;
  toSec: Sec;
  cycleSec: number;
  slots: SlotDef[];
}

/**
 * Every 各停 that is overtaken also makes a 緩急接続 with the train that passes
 * it — that is the entire point of the 待避 at 旗の台. Declaring the overtake
 * therefore implies the connection, and this helper keeps the two in step.
 */
function waitFor(at: StationKey, by: string, cycleDelta?: number): Pick<SlotDef, 'overtakes' | 'connectsWith'> {
  const ov = cycleDelta === undefined ? { at, by } : { at, by, cycleDelta };
  const cn =
    cycleDelta === undefined ? { at, withSlot: by } : { at, withSlot: by, cycleDelta };
  return { overtakes: [ov], connectsWith: [cn] };
}

/** 鷺沼〜溝の口 run time: a 鷺沼発 slot leaves this much earlier. */
const SAGINUMA_LEAD_SEC = 490;

const THROUGH_NOTE = '田園都市線直通 長津田行き（本モデルでは鷺沼止まり）';

/** The shared 15-minute grid. Bands pick a subset of these slots. */
const GRID = {
  d1: 0,
  d2: 250,
  d3: 440,
  d4: 640,
  u1: 210,
  u2: 510,
  u3: 740,
  u4: 610,
} as const;

const BAND_DEFS: readonly BandDef[] = [
  // -------------------------------------------------------------- 早朝
  // Off-grid: a 20-minute cycle, but nothing overtakes and the band ends far
  // enough before 06:30 that it cannot interfere with 立上り.
  {
    id: 'b1-early',
    name: '早朝',
    fromSec: 5 * H,
    toSec: 6 * H + 30 * M,
    cycleSec: 20 * M,
    slots: [
      { id: 'd1', offsetSec: 0, patternKey: 'greenDown' },
      { id: 'd2', offsetSec: 10 * M, patternKey: 'blueDownSaginuma' },
      // The 上り offsets are set by the 大井町 turnback, not by symmetry: each
      // arrival has to land a turnback time before a 下り departure, because
      // the stub terminal has nowhere to park anything that does not.
      { id: 'u1', offsetSec: 465, patternKey: 'greenUp' },
      { id: 'u2', offsetSec: 1005, windowOffsetSec: 1005 + SAGINUMA_LEAD_SEC, patternKey: 'blueUpSaginuma' },
    ],
  },
  // -------------------------------------------------------------- 立上り
  {
    id: 'b2-buildup',
    name: '立上り',
    fromSec: 6 * H + 30 * M,
    toSec: 7 * H + 30 * M,
    cycleSec: 15 * M,
    slots: [
      // 立上り runs 各停(緑) + 急行 only: with no 青各停 in the 上り there would be
      // nothing at 大井町 for a 青 to turn back into.
      { id: 'd1', offsetSec: GRID.d1, patternKey: 'greenDown', ...waitFor('hatanodai', 'd2') },
      { id: 'd2', offsetSec: GRID.d2, patternKey: 'expressDown' },
      { id: 'u1', offsetSec: GRID.u1, patternKey: 'greenUp', ...waitFor('hatanodai', 'u2') },
      { id: 'u2', offsetSec: GRID.u2, patternKey: 'expressUp' },
    ],
  },
  // -------------------------------------------------------------- 朝ラッシュ
  {
    id: 'b3-ampeak',
    name: '朝ラッシュ',
    fromSec: 7 * H + 30 * M,
    toSec: 9 * H,
    cycleSec: 15 * M,
    slots: [
      // 下り, the counter-peak, is the full grid: 16 本/時, the most one
      // 待避線 allows.
      { id: 'd1', offsetSec: GRID.d1, patternKey: 'blueDown', ...waitFor('hatanodai', 'd2') },
      { id: 'd2', offsetSec: GRID.d2, patternKey: 'expressDown' },
      { id: 'd3', offsetSec: GRID.d3, patternKey: 'greenDown' },
      { id: 'd4', offsetSec: GRID.d4, patternKey: 'greenDown' },
      // 上り, the peak, adds a fifth train — 20 本/時, a 3-minute average
      // headway — paid for by the 上り-only loop at 上野毛. u1 stands aside at
      // 旗の台 for this cycle's 急行; u5 stands aside at 上野毛 for the next
      // one, which is why it carries `cycleDelta: 1`.
      { id: 'u1', offsetSec: GRID.u1, patternKey: 'greenUp', ...waitFor('hatanodai', 'u2') },
      { id: 'u2', offsetSec: GRID.u2, patternKey: 'expressUp' },
      { id: 'u3', offsetSec: GRID.u3, patternKey: 'blueUp' },
      { id: 'u4', offsetSec: GRID.u4, patternKey: 'greenUp' },
    ],
  },
  // -------------------------------------------------------------- 逓減
  {
    id: 'b4-taper',
    name: '逓減',
    fromSec: 9 * H,
    toSec: 10 * H,
    cycleSec: 15 * M,
    slots: [
      { id: 'd1', offsetSec: GRID.d1, patternKey: 'blueDown', ...waitFor('hatanodai', 'd2') },
      { id: 'd2', offsetSec: GRID.d2, patternKey: 'expressDown' },
      { id: 'd3', offsetSec: GRID.d3, patternKey: 'greenDown' },
      { id: 'u1', offsetSec: GRID.u1, patternKey: 'greenUp', ...waitFor('hatanodai', 'u2') },
      { id: 'u2', offsetSec: GRID.u2, patternKey: 'expressUp' },
      { id: 'u3', offsetSec: GRID.u3, patternKey: 'blueUp' },
    ],
  },
  // -------------------------------------------------------------- 日中
  {
    id: 'b5-midday',
    name: '日中',
    fromSec: 10 * H,
    toSec: 16 * H,
    cycleSec: 15 * M,
    slots: [
      { id: 'd1', offsetSec: GRID.d1, patternKey: 'blueDown', ...waitFor('hatanodai', 'd2') },
      { id: 'd2', offsetSec: GRID.d2, patternKey: 'expressDown' },
      { id: 'd3', offsetSec: GRID.d3, patternKey: 'greenDown' },
      { id: 'd4', offsetSec: GRID.d4, patternKey: 'greenDown' },
      { id: 'u1', offsetSec: GRID.u1, patternKey: 'greenUp', ...waitFor('hatanodai', 'u2') },
      { id: 'u2', offsetSec: GRID.u2, patternKey: 'expressUp' },
      { id: 'u3', offsetSec: GRID.u3, patternKey: 'blueUp' },
      { id: 'u4', offsetSec: GRID.u4, patternKey: 'greenUp' },
    ],
  },
  // -------------------------------------------------------------- 夕ラッシュ
  {
    id: 'b6-pmpeak',
    name: '夕ラッシュ',
    fromSec: 16 * H,
    toSec: 20 * H,
    cycleSec: 15 * M,
    slots: [
      { id: 'd1', offsetSec: GRID.d1, patternKey: 'blueDown', ...waitFor('hatanodai', 'd2') },
      { id: 'd2', offsetSec: GRID.d2, patternKey: 'expressDownSaginuma', note: THROUGH_NOTE },
      { id: 'd3', offsetSec: GRID.d3, patternKey: 'greenDown' },
      { id: 'd4', offsetSec: GRID.d4, patternKey: 'greenDown' },
      // u2 starts at 鷺沼, 490 s further out than the 溝の口 slots, so it leaves
      // one cycle earlier (900 − 490 + 300 = 710) to land on the grid at +5:00.
      // Read from u1's side that makes the 急行 that passes it the PREVIOUS
      // cycle's u2 — hence `cycleDelta: -1`. The very first cycle of the band
      // has no such 急行 and simply runs clear.
      { id: 'u1', offsetSec: GRID.u1, patternKey: 'greenUp', ...waitFor('hatanodai', 'u2') },
      {
        id: 'u2',
        offsetSec: GRID.u2 - SAGINUMA_LEAD_SEC,
        windowOffsetSec: GRID.u2,
        patternKey: 'expressUpSaginuma',
        note: THROUGH_NOTE,
      },
      { id: 'u3', offsetSec: GRID.u3, patternKey: 'blueUp' },
      { id: 'u4', offsetSec: GRID.u4, patternKey: 'greenUp' },
    ],
  },
  // -------------------------------------------------------------- 夜間
  {
    id: 'b7-evening',
    name: '夜間',
    fromSec: 20 * H,
    toSec: 23 * H,
    cycleSec: 15 * M,
    slots: [
      { id: 'd1', offsetSec: GRID.d1, patternKey: 'blueDown', ...waitFor('hatanodai', 'd2') },
      { id: 'd2', offsetSec: GRID.d2, patternKey: 'expressDown' },
      { id: 'd3', offsetSec: GRID.d3, patternKey: 'greenDown' },
      { id: 'd4', offsetSec: GRID.d4, patternKey: 'greenDown' },
      { id: 'u1', offsetSec: GRID.u1, patternKey: 'greenUp', ...waitFor('hatanodai', 'u2') },
      { id: 'u2', offsetSec: GRID.u2, patternKey: 'expressUp' },
      { id: 'u3', offsetSec: GRID.u3, patternKey: 'blueUp' },
      { id: 'u4', offsetSec: GRID.u4, patternKey: 'greenUp' },
    ],
  },
  // -------------------------------------------------------------- 深夜
  {
    id: 'b8-latenight',
    name: '深夜',
    fromSec: 23 * H,
    toSec: 24 * H + 30 * M, // 24:30 — deliberately NOT wrapped past midnight
    cycleSec: 20 * M,
    slots: [
      { id: 'd1', offsetSec: 0, patternKey: 'greenDown' },
      { id: 'd2', offsetSec: 10 * M, patternKey: 'blueDownSaginuma' },
      { id: 'u1', offsetSec: 525, patternKey: 'greenUp' },
      { id: 'u2', offsetSec: 1045, patternKey: 'blueUp' },
    ],
  },
];

export interface ServicePlan {
  bands: TimeBand[];
  patterns: ServicePattern[];
}

/**
 * 列車番号 blocks: band *b* owns 1000·(b+1) … 1000·(b+2)−1, slot *j* owns the
 * next hundred inside it, 下り = odd, 上り = even, +2 per cycle. Because no
 * band has more than 8 slots or 30 cycles, the blocks can never collide, which
 * is what makes the numbers unique across the whole document by construction.
 */
function numberingFor(bandIndex: number, slotIndex: number, direction: Direction) {
  return {
    base: 1000 * (bandIndex + 1) + 100 * slotIndex + (direction === 'down' ? 1 : 2),
    step: 2,
  };
}

export function buildServicePlan(facts: Facts): ServicePlan {
  const bands: TimeBand[] = [];
  const patterns: ServicePattern[] = [];

  BAND_DEFS.forEach((band, bandIndex) => {
    const patternId = `pat-${band.id}`;
    const slots: PatternSlot[] = band.slots.map((def, slotIndex) => {
      const spec = facts.patternSpec[def.patternKey];
      const cars = spec.typeKey === 'express' ? CARS.express : CARS.local;
      const slot: PatternSlot = {
        id: def.id,
        offsetSec: def.offsetSec,
        direction: spec.direction,
        trainTypeId: facts.type[spec.typeKey],
        stopPatternId: facts.pattern[def.patternKey],
        originStationId: facts.S[spec.originKey],
        terminusStationId: facts.S[spec.terminusKey],
        numbering: numberingFor(bandIndex, slotIndex, spec.direction),
        cars,
        ...(def.windowOffsetSec === undefined ? {} : { windowOffsetSec: def.windowOffsetSec }),
        ...(def.note === undefined ? {} : { note: def.note }),
      };
      if (def.overtakes !== undefined) {
        slot.overtakes = def.overtakes.map((o) => ({
          atStationId: facts.S[o.at],
          bySlotId: o.by,
          ...(o.cycleDelta === undefined ? {} : { cycleDelta: o.cycleDelta }),
        }));
      }
      if (def.connectsWith !== undefined) {
        slot.connectsWith = def.connectsWith.map((c) => ({
          atStationId: facts.S[c.at],
          withSlotId: c.withSlot,
          ...(c.cycleDelta === undefined ? {} : { cycleDelta: c.cycleDelta }),
        }));
      }
      return slot;
    });

    patterns.push({ id: patternId, name: `${band.name}パターン`, cycleSec: band.cycleSec, slots });
    bands.push({
      id: band.id,
      name: band.name,
      dayTypeId: facts.dayTypeId,
      fromSec: band.fromSec,
      toSec: band.toSec,
      patternId,
    });
  });

  return { bands, patterns };
}
