/**
 * The weekday service plan: thirteen time bands, each with one repeating cycle.
 *
 *   05:00–06:30 早朝           8本/時   15分周期  緑各停 + 急行
 *   06:30–07:00 立上り         8本/時   15分周期
 *   07:00–07:30 朝ラッシュ準備 下り8 / 上り16      上りが先に立ち上がる
 *   07:30–08:30 朝ラッシュ    16本/時   15分周期  急行1+各停3
 *   08:30–09:00 日中準備      下り16 / 上り12
 *   09:00–15:00 日中          12本/時   15分周期  急行1+各停2
 *   15:00–15:30 夕ラッシュ準備 下り12 / 上り16
 *   15:30–19:30 夕ラッシュ    16本/時   15分周期  急行1+各停3
 *   19:30–20:00 夜間準備      下り16 / 上り12
 *   20:00–22:00 夜間          12本/時   15分周期  急行1+各停2
 *   22:00–22:30 夜間後半      12本/時   15分周期  夜間の続き（境界を残すためだけ）
 *   22:30–23:00 深夜準備      下り12 / 上り8
 *   23:00–24:30 深夜           6本/時   20分周期、終列車
 *
 * ラッシュ 16本/時 とオフピーク 12本/時 のコントラストが時間帯構造の主眼。
 * 16本/時 は線区の上限そのもので、その理由は下の **1.** に書いてある。
 * オフピークが 急行1:各停2 に留まる理由は「一つのグリッド」節に書いてある。
 *
 * ===========================================================================
 * Three structural findings that shaped this file — all of them consequences
 * of the researched infrastructure, not of the numbers chosen here
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
 * The 朝ラッシュ used to run a fifth 上り train per cycle — 20 本/時 — standing a
 * second 各停 aside in 上野毛's 上り-only loop. It cannot: 大井町 is a stub, so
 * every 上り train that arrives has to leave again as a 下り train and the peak
 * is symmetric by conservation. The extra 上り trains had nowhere to go and
 * simply flooded the terminal. 16 本/時 each way is the line's real ceiling
 * here, and 上野毛's loop instead buys recovery margin.
 *
 * **2. Every 急行 works through to 鷺沼, because 溝の口 cannot turn it.**
 * See `THROUGH_EXPRESS_UP`.
 *
 * **3. The 上り changes gear a run time before the 下り does.**
 * See `RAMP_LEAD_SEC`. That is what the 準備 bands are.
 *
 * ===========================================================================
 * One grid — and why 12 本/時 cannot be run at 急行1 : 各停3
 * ===========================================================================
 *
 * Every band except 深夜 sits on the same 900-second grid:
 *
 *   下り  d1 青 +0:00 (旗の台で待避)   d2 急 +4:10   d3 緑 +7:20   d4 緑 +10:40
 *   上り  u1 緑 +3:30 (旗の台で待避)   u2 急 +8:30   u3 青 +12:20  u4 緑 +10:10
 *
 * The 急行 leaves four to five minutes behind the 各停 it will overtake — far
 * enough that it is still 100 s behind on arrival at 旗の台, which is where the
 * only 待避線 in that direction is. Offsets are all multiples of 10 s, so every
 * computed time lands on the 5-second grain with no rounding. 16 本/時 fills all
 * four slots; 12 本/時 drops d4 / u4, which is 急行1 : 各停2; 8 本/時 keeps only
 * the 待避 pair, d1/d2 and u1/u2.
 *
 * **The off-peak would rather be 急行1 : 各停3, and cannot be.** Four trains in
 * 1200 s is 12 本/時 at the nominal mix, and 大井町 can take it on its own terms:
 * 頭端式1面2線, two dead-end roads, a turnback holding one road from
 * `arrival − 30 s` to `departure + 20 s`, four turnbacks a cycle, so each road
 * turns two of them — one every 600 s — and every layover has to land in
 * [300, 550] s (300 s being the preferred 折り返し the roster books, 550 =
 * 600 − 50 s of approach and clear). The 15-minute grid sits at 305–365 s
 * against its own bound of 400 s, so the shape is nothing unusual. Grids that
 * satisfy the 550 s bound, the 旗の台 overtake geometry AND the 90 s headways
 * where a 1200 s cycle abuts the 900 s one do exist: a sweep of the whole
 * eight-offset space found 78 359 of them.
 *
 * What none of them survives is the **pool split at the band edges**. 青各停 and
 * 緑各停 are not interchangeable stock: at 溝の口 they stand on different islands
 * — the 田園都市線 faces 1・4 against the 大井町線 faces 2・3 — so a formation
 * that arrived as one cannot leave as the other, and the roster carries them as
 * two pools (`DutyNode.routing`). A 1200 s cycle at 急行1 : 各停3 runs
 * 3 急 / 3 青 / 6 緑 an hour. The 30-minute 準備 bands cannot hold a 1200 s cycle
 * at all (1800 / 1200 = 1.5), so their 12 本/時 side is three slots of the
 * 900 s grid: 4 / 4 / 4 an hour. The 緑 pool would therefore step 6 → 4 → 8
 * across every off-peak boundary.
 *
 * And 大井町 keeps receiving the *outgoing* pattern for a full run time after
 * the boundary — that is the whole point of `RAMP_LEAD_SEC` — so between 15:00
 * and 15:29 it would take in 6 緑/h and send out 4: one 緑 formation more than
 * the plan has any use for. Two dead-end roads cannot park it, because the
 * 夕ラッシュ already books 1535 of the 1800 road-seconds in every cycle. So it
 * has to run 入庫 to 鷺沼 — a full-line empty move leaving 大井町 at about 15:30,
 * straight into four hours of 16 本/時. There is no path for it; `depotRuns`
 * searches ±100 minutes and gives up. 09:00 is the mirror image and costs a
 * 出庫 instead; 20:00 and 22:00 repeat both. Measured across those 78 359 grids
 * — and with the 溝の口 layover bound stretched to the longer cycle, which is
 * a concession in their favour — the best still needed 56 duty chains against
 * this plan's 34, which is 112 empty moves against 68, and every one of them
 * put at least one 入庫 into a peak.
 *
 * Restoring 1 : 3 off-peak needs one of the two things this line has not got: a
 * 準備 band a whole hour long (which would move four formations' worth of
 * imbalance onto 大井町's two roads — worse than the problem it solves, and it
 * would make the 上り lead the 下り by an hour), or a formation that can change
 * between the 青 and 緑 routes at 溝の口. The nominal mix therefore survives
 * where it can actually be worked: at 16 本/時, in both peaks.
 *
 * **A corollary worth keeping: a 1200-second band must begin and end on the
 * hour.** 900 and 1200 share a period of 3600 s, so the hour is the only instant
 * at which both rhythms complete together. 早朝 used to run a 20-minute cycle
 * from 05:00 to 06:30 — four and a half cycles — and the truncated one stranded
 * arrivals at 大井町 that the incoming pattern had no departure for. Several
 * formations went 入庫 there within twenty minutes while others came 出庫 into
 * the same two roads, and a terminal with no siding cannot survive that. 深夜 is
 * the one 1200 s band left, and it is safe only because nothing follows it.
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
  // ------------------------------------------------------------ 日中準備
  // The 上り drops to 12 first; the 下り follows at 09:00. Its 12 本/時 runs on
  // the 15-minute grid (1 : 2), because a 1200 s cycle does not fit in 1800 s.
  {
    id: 'b5-midday-lead',
    name: '日中準備',
    fromSec: 8 * H + 30 * M,
    toSec: 9 * H,
    cycleSec: 15 * M,
    slots: [...DOWN_FULL, ...UP_TAPER],
  },
  // -------------------------------------------------------------- 日中
  // 12 本/時, on the same 900-second grid as everything else: one 急行 and two
  // 各停 per cycle. The nominal 急行1 : 各停3 would need a 1200 s cycle, and the
  // header explains at length why 大井町 cannot be handed one — the 緑 pool
  // steps 6 → 4 → 8 本/時 across the 準備 bands and the surplus formation has to
  // deadhead home through the peak.
  {
    id: 'b6-midday',
    name: '日中',
    fromSec: 9 * H,
    toSec: 15 * H,
    cycleSec: 15 * M,
    slots: [...DOWN_TAPER, ...UP_TAPER],
  },
  // ------------------------------------------------------------ 夕ラッシュ準備
  {
    id: 'b7-pmpeak-lead',
    name: '夕ラッシュ準備',
    fromSec: 15 * H,
    toSec: 15 * H + 30 * M,
    cycleSec: 15 * M,
    slots: [...DOWN_TAPER, ...UP_FULL],
  },
  // -------------------------------------------------------------- 夕ラッシュ
  {
    id: 'b8-pmpeak',
    name: '夕ラッシュ',
    fromSec: 15 * H + 30 * M,
    toSec: 19 * H + 30 * M,
    cycleSec: 15 * M,
    slots: [...DOWN_FULL, ...UP_FULL],
  },
  // ------------------------------------------------------------ 夜間準備
  {
    id: 'b9-evening-lead',
    name: '夜間準備',
    fromSec: 19 * H + 30 * M,
    toSec: 20 * H,
    cycleSec: 15 * M,
    slots: [...DOWN_FULL, ...UP_TAPER],
  },
  // -------------------------------------------------------------- 夜間
  {
    id: 'b10-evening',
    name: '夜間',
    fromSec: 20 * H,
    toSec: 22 * H,
    cycleSec: 15 * M,
    slots: [...DOWN_TAPER, ...UP_TAPER],
  },
  // ------------------------------------------------------------ 夜間後半
  // No change in service level and no change in pattern: 夜間 and 夜間後半 are
  // the same twelve trains an hour. The split is kept because 22:00 is where
  // the evening would have handed a 20-minute cycle back to the 15-minute one,
  // and because the band boundary is the natural place to change the service
  // if this reconstruction is ever given a real evening taper.
  {
    id: 'b11-evening-late',
    name: '夜間後半',
    fromSec: 22 * H,
    toSec: 22 * H + 30 * M,
    cycleSec: 15 * M,
    slots: [...DOWN_TAPER, ...UP_TAPER],
  },
  // ------------------------------------------------------------ 深夜準備
  // The mirror image of the morning: the 上り winds down first, so the surplus
  // stock piles up at 溝の口 — 引上線 and 鷺沼 — instead of at 大井町.
  {
    id: 'b12-latenight-lead',
    name: '深夜準備',
    fromSec: 22 * H + 30 * M,
    toSec: 23 * H,
    cycleSec: 15 * M,
    slots: [...DOWN_TAPER, ...UP_NIGHT],
  },
  // -------------------------------------------------------------- 深夜
  // A 20-minute cycle that does NOT end on the hour, which the grid rule
  // otherwise forbids. It is safe only because this is the last band: there is
  // no following pattern for a truncated cycle to strand an arrival into, and
  // whatever is left over simply goes 入庫. Do not copy this shape inland.
  {
    id: 'b13-latenight',
    name: '深夜',
    fromSec: 23 * H,
    toSec: 24 * H + 30 * M, // 24:30 — deliberately NOT wrapped past midnight
    cycleSec: 20 * M,
    // The 23:00 下り is the 青 that works through to 鷺沼, and that order is not
    // cosmetic: a formation cannot change between the 青 and 緑 routes (see
    // `DutyNode.routing`), so the first 深夜 下り has to be the kind of stock
    // that is actually standing at 大井町 at 23:00. The last 各停 to arrive
    // before it is the 青 off the 22:27 上り, at 22:54; the last 緑 gets in at
    // 22:58:55, 65 s before the departure and well short of the 折り返し. With
    // the 緑 first, that departure needs a 出庫 while the 青 is still on the
    // other road — three formations, two roads, and `track.doubleOccupancy`.
    slots: [
      { id: 'd1', offsetSec: 0, patternKey: 'blueDownSaginuma' },
      { id: 'd2', offsetSec: 10 * M, patternKey: 'greenDown' },
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
