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

/**
 * The 上り急行, as a 鷺沼始発 through service.
 *
 * Every 急行 in this timetable works through to the 田園都市線 rather than
 * turning at 溝の口, and that is forced by the 構内 at 溝の口, not chosen for
 * flavour. Only 2・3番線 belong to the 大井町線 there, backed by two 引上線 on
 * the 梶が谷 side, and a turning formation needs one of the four for its whole
 * layover while the two platform faces stay free for the flow of arrivals and
 * departures. At 16 本/時 the cycle already turns two 各停 there — 引上1 and
 * 引上2, both of them — so a third 大井町線 formation standing at 溝の口 would
 * have to squat on a platform face, and there is no cycle in which the
 * remaining face can then take every arrival and departure: the 各停 arrival at
 * +2:45 and the 各停 departure at +3:30 alone need two faces. Working the 急行
 * through to 鷺沼 removes that third formation, which is also what the real line
 * does with its 長津田行き.
 *
 * It leaves 鷺沼 490 s before the grid instant it passes 溝の口 at, so from
 * 溝の口 inwards the path is identical to the one a 溝の口始発 急行 would have
 * taken and the 旗の台 待避 is unchanged.
 */
const THROUGH_EXPRESS_UP = {
  offsetSec: GRID.u2 - SAGINUMA_LEAD_SEC,
  windowOffsetSec: GRID.u2,
  patternKey: 'expressUpSaginuma',
  note: THROUGH_NOTE,
} as const satisfies Omit<SlotDef, 'id'>;

/**
 * The 下り and 上り slot sets each band picks from.
 *
 * Split by direction on purpose, because the two directions do NOT change at
 * the same instant — see `RAMP_LEAD_SEC`.
 */
const DOWN_LIGHT: SlotDef[] = [
  { id: 'd1', offsetSec: GRID.d1, patternKey: 'greenDown', ...waitFor('hatanodai', 'd2') },
  { id: 'd2', offsetSec: GRID.d2, patternKey: 'expressDownSaginuma', note: THROUGH_NOTE },
];
const DOWN_TAPER: SlotDef[] = [
  { id: 'd1', offsetSec: GRID.d1, patternKey: 'blueDown', ...waitFor('hatanodai', 'd2') },
  { id: 'd2', offsetSec: GRID.d2, patternKey: 'expressDownSaginuma', note: THROUGH_NOTE },
  { id: 'd3', offsetSec: GRID.d3, patternKey: 'greenDown' },
];
const DOWN_FULL: SlotDef[] = [
  ...DOWN_TAPER,
  { id: 'd4', offsetSec: GRID.d4, patternKey: 'greenDown' },
];
const UP_LIGHT: SlotDef[] = [
  { id: 'u1', offsetSec: GRID.u1, patternKey: 'greenUp', ...waitFor('hatanodai', 'u2') },
  { id: 'u2', ...THROUGH_EXPRESS_UP },
];
const UP_TAPER: SlotDef[] = [
  ...UP_LIGHT,
  { id: 'u3', offsetSec: GRID.u3, patternKey: 'blueUp' },
];
const UP_FULL: SlotDef[] = [
  ...UP_TAPER,
  { id: 'u4', offsetSec: GRID.u4, patternKey: 'greenUp' },
];
/** 上り only, no 急行: the half hour in which the evening service winds down. */
const UP_NIGHT: SlotDef[] = [
  { id: 'u1', offsetSec: GRID.u1, patternKey: 'greenUp' },
  { id: 'u3', offsetSec: GRID.u3, patternKey: 'blueUp' },
];

/**
 * ===========================================================================
 * **3. The 上り changes gear before the 下り does, by one run time.**
 * ===========================================================================
 *
 * 大井町 is 頭端式1面2線 with no siding: it can hold about one spare formation,
 * not four. So every 下り train leaving it has to be a formation that arrived on
 * an 上り train a few minutes earlier — the terminal has no buffer to draw on
 * and none to absorb a surplus into.
 *
 * Write that as a balance. Formations arriving at 大井町 at time *t* are the
 * 上り trains that left 溝の口 at *t − 25 min*; formations leaving are the 下り
 * departures at *t*. The stock standing at 大井町 only stays constant if
 *
 *     上り本数(t − 25分) = 下り本数(t)
 *
 * which is to say: **when the service steps up or down, the 上り has to step
 * first, a full run time ahead of the 下り.** Ramping both at 07:30, as this
 * file used to, asks 大井町 to dispatch 16 本/時 while it is still receiving 8
 * for the twenty-five minutes it takes the first extra 上り train to arrive —
 * three formations that have to come from 鷺沼, thread the peak as empty stock
 * (they cannot: at 16 本/時 there is no path) and then stand on a platform road
 * for the best part of an hour (they cannot: there are two roads and the service
 * needs both). Ramping the 上り first moves the whole imbalance to 溝の口, which
 * is where it belongs: two 引上線, four platform faces, and 鷺沼車庫 eight
 * minutes down the line in the counter-peak direction.
 *
 * Each step therefore gets a transition band a run time long, in which the 上り
 * already runs the incoming pattern while the 下り still runs the outgoing one.
 * Boundaries stay on the 900-second grid measured from 06:30, so no band ever
 * has to re-phase.
 */
const RAMP_LEAD_SEC = 30 * M;

const BAND_DEFS: readonly BandDef[] = [
  // -------------------------------------------------------------- 早朝
  // On the same 900-second grid as everything that follows, and running the
  // same two slots as 立上り. That is not laziness: 早朝 used to run a 20-minute
  // cycle, and because 1200 s and 900 s do not mesh, every 06:30 boundary
  // stranded arrivals that no departure could take on — several formations went
  // 入庫 at 大井町 within twenty minutes while others came 出庫 into the same two
  // roads. A terminal with no siding cannot survive that, and the cheapest fix
  // is not to create it: one grid, and at most one step in service level per
  // boundary.
  {
    id: 'b1-early',
    name: '早朝',
    fromSec: 5 * H,
    toSec: 6 * H + 30 * M,
    cycleSec: 15 * M,
    slots: [...DOWN_LIGHT, ...UP_LIGHT],
  },
  // -------------------------------------------------------------- 立上り
  // 各停(緑) + 急行 only: with no 青各停 in the 上り there would be nothing at
  // 大井町 for a 青 to turn back into.
  {
    id: 'b2-buildup',
    name: '立上り',
    fromSec: 6 * H + 30 * M,
    toSec: 7 * H,
    cycleSec: 15 * M,
    slots: [...DOWN_LIGHT, ...UP_LIGHT],
  },
  // -------------------------------------------------------- 朝ラッシュ準備
  // 上り first: the extra formations enter service at 溝の口 and are at 大井町
  // in time to work the 下り peak out.
  {
    id: 'b3-ampeak-lead',
    name: '朝ラッシュ準備',
    fromSec: 7 * H,
    toSec: 7 * H + RAMP_LEAD_SEC,
    cycleSec: 15 * M,
    slots: [...DOWN_LIGHT, ...UP_FULL],
  },
  // -------------------------------------------------------------- 朝ラッシュ
  // 16 本/時 each way — the most one 待避線 per direction allows.
  {
    id: 'b4-ampeak',
    name: '朝ラッシュ',
    fromSec: 7 * H + 30 * M,
    toSec: 8 * H + 30 * M,
    cycleSec: 15 * M,
    slots: [...DOWN_FULL, ...UP_FULL],
  },
  // ------------------------------------------------------------ 逓減準備
  {
    id: 'b5-taper-lead',
    name: '逓減準備',
    fromSec: 8 * H + 30 * M,
    toSec: 9 * H,
    cycleSec: 15 * M,
    slots: [...DOWN_FULL, ...UP_TAPER],
  },
  // -------------------------------------------------------------- 逓減
  {
    id: 'b6-taper',
    name: '逓減',
    fromSec: 9 * H,
    toSec: 9 * H + 30 * M,
    cycleSec: 15 * M,
    slots: [...DOWN_TAPER, ...UP_TAPER],
  },
  // ------------------------------------------------------------ 日中準備
  {
    id: 'b7-midday-lead',
    name: '日中準備',
    fromSec: 9 * H + 30 * M,
    toSec: 10 * H,
    cycleSec: 15 * M,
    slots: [...DOWN_TAPER, ...UP_FULL],
  },
  // -------------------------------------------------------------- 日中
  {
    id: 'b8-midday',
    name: '日中',
    fromSec: 10 * H,
    toSec: 16 * H,
    cycleSec: 15 * M,
    slots: [...DOWN_FULL, ...UP_FULL],
  },
  // -------------------------------------------------------------- 夕ラッシュ
  {
    id: 'b9-pmpeak',
    name: '夕ラッシュ',
    fromSec: 16 * H,
    toSec: 20 * H,
    cycleSec: 15 * M,
    slots: [...DOWN_FULL, ...UP_FULL],
  },
  // -------------------------------------------------------------- 夜間
  {
    id: 'b10-evening',
    name: '夜間',
    fromSec: 20 * H,
    toSec: 22 * H + 30 * M,
    cycleSec: 15 * M,
    slots: [...DOWN_FULL, ...UP_FULL],
  },
  // ------------------------------------------------------------ 深夜準備
  // The mirror image of the morning: the 上り winds down first, so the surplus
  // stock piles up at 溝の口 — 引上線 and 鷺沼 — instead of at 大井町.
  {
    id: 'b11-latenight-lead',
    name: '深夜準備',
    fromSec: 22 * H + 30 * M,
    toSec: 23 * H,
    cycleSec: 15 * M,
    slots: [...DOWN_TAPER, ...UP_NIGHT],
  },
  // -------------------------------------------------------------- 深夜
  {
    id: 'b12-latenight',
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
