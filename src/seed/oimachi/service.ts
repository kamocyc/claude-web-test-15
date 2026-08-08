/**
 * The weekday service plan: eight time bands, each with one repeating cycle.
 *
 * The band boundaries, cycle lengths and the mix inside each cycle come from
 * the researched operating pattern:
 *
 *   05:00–06:30 早朝     20分サイクル  各停のみ、鷺沼発着の青各停を含む
 *   06:30–07:30 立上り   15分サイクル  急行運転開始
 *   07:30–09:00 朝ラッシュ 9分サイクル  上り優位・20本/時、各停は全て待避
 *   09:00–10:00 逓減     15分サイクル  12本/時
 *   10:00–16:00 日中     15分サイクル  急行1+各停3 = 16本/時
 *   16:00–20:00 夕ラッシュ 12分サイクル 下り優位・20本/時、急行は鷺沼まで直通
 *   20:00–23:00 夜間     15分サイクル  日中パターンに復帰
 *   23:00–24:30 深夜     20分サイクル  終列車、溝の口引上線から入庫
 *
 * On the 朝ラッシュ cycle: the *published* interval is 3 minutes, but a
 * 3-second… a 3-*minute* cycle cannot carry a 急行+各停×2 mix, because the mix
 * itself is three trains long. We therefore model it as a 9-minute cycle
 * containing three trains per direction, which is exactly 20 trains/hour and
 * an average 3-minute headway. Same for 夕ラッシュ: a 12-minute cycle with
 * four trains per direction = 20/hour.
 *
 * Offsets are a reconstruction, tuned so that (a) no two same-direction trains
 * are closer than the 90 s link headway anywhere on the line, and (b) every
 * declared 待避 has at least ~30 s of slack on the arrival side. They are all
 * multiples of 10 s, which keeps every computed time on the 5-second grain
 * without any rounding.
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

const THROUGH_NOTE = '田園都市線直通 長津田行き（本モデルでは鷺沼止まり）';

const BAND_DEFS: readonly BandDef[] = [
  // -------------------------------------------------------------- 早朝
  {
    id: 'b1-early',
    name: '早朝',
    fromSec: 5 * H,
    toSec: 6 * H + 30 * M,
    cycleSec: 20 * M,
    slots: [
      { id: 'd1', offsetSec: 0, patternKey: 'greenDown' },
      { id: 'd2', offsetSec: 10 * M, patternKey: 'blueDownSaginuma' },
      { id: 'u1', offsetSec: 0, patternKey: 'greenUp' },
      // Leaves 鷺沼 8 minutes into the cycle and is on the 溝の口 clock at
      // +15:40, comfortably clear of the next 緑各停.
      { id: 'u2', offsetSec: 8 * M, patternKey: 'blueUpSaginuma' },
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
      { id: 'd1', offsetSec: 0, patternKey: 'greenDown', ...waitFor('hatanodai', 'd2') },
      { id: 'd2', offsetSec: 250, patternKey: 'expressDown' },
      { id: 'u1', offsetSec: 0, patternKey: 'greenUp', ...waitFor('hatanodai', 'u2') },
      { id: 'u2', offsetSec: 300, patternKey: 'expressUp' },
    ],
  },
  // -------------------------------------------------------------- 朝ラッシュ
  {
    id: 'b3-ampeak',
    name: '朝ラッシュ',
    fromSec: 7 * H + 30 * M,
    toSec: 9 * H,
    cycleSec: 9 * M,
    slots: [
      // 下り is the counter-peak, and it is *capacity limited by the layout*:
      // with only one 待避線 per direction at 旗の台 an 急行 can stand aside
      // exactly one 各停 per cycle, and an 急行 gains ~350 s on a 緑各停 over
      // the 12.4 km, so any 各停 departing less than ~440 s ahead of it also
      // has to be overtaken. Three trains in a 9-minute cycle would need two
      // 待避 in the 下り, which the line simply cannot do. Two it is —
      // 13.3 本/時, which is what the real counter-peak looks like.
      { id: 'd1', offsetSec: 0, patternKey: 'greenDown', ...waitFor('hatanodai', 'd2') },
      { id: 'd2', offsetSec: 250, patternKey: 'expressDown' },
      // 上り is the peak, and it has TWO 待避 points — 旗の台 and the
      // 上り-only loop at 上野毛 — so it can carry the full 20 本/時 with both
      // 各停 standing aside for the same 急行.
      { id: 'u1', offsetSec: 0, patternKey: 'greenUp', ...waitFor('hatanodai', 'u3') },
      { id: 'u2', offsetSec: 180, patternKey: 'blueUp', ...waitFor('kaminoge', 'u3') },
      { id: 'u3', offsetSec: 360, patternKey: 'expressUp' },
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
      { id: 'd1', offsetSec: 0, patternKey: 'greenDown', ...waitFor('hatanodai', 'd2') },
      { id: 'd2', offsetSec: 250, patternKey: 'expressDown' },
      { id: 'd3', offsetSec: 480, patternKey: 'blueDown' },
      { id: 'u1', offsetSec: 0, patternKey: 'greenUp', ...waitFor('hatanodai', 'u2') },
      { id: 'u2', offsetSec: 300, patternKey: 'expressUp' },
      { id: 'u3', offsetSec: 540, patternKey: 'blueUp' },
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
      { id: 'd1', offsetSec: 0, patternKey: 'greenDown', ...waitFor('hatanodai', 'd2') },
      { id: 'd2', offsetSec: 250, patternKey: 'expressDown' },
      { id: 'd3', offsetSec: 450, patternKey: 'blueDown' },
      { id: 'd4', offsetSec: 660, patternKey: 'greenDown' },
      { id: 'u1', offsetSec: 0, patternKey: 'greenUp', ...waitFor('hatanodai', 'u2') },
      { id: 'u2', offsetSec: 300, patternKey: 'expressUp' },
      { id: 'u3', offsetSec: 480, patternKey: 'blueUp' },
      { id: 'u4', offsetSec: 690, patternKey: 'greenUp' },
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
      // Peak direction is 下り — and 下り has only the one 待避線, so the
      // evening peak cannot be denser than the daytime 16 本/時 (see the note
      // on 朝ラッシュ). What tightens is the *product*, not the interval: the
      // 急行 runs through onto the 田園都市線, seven cars deep.
      { id: 'd1', offsetSec: 0, patternKey: 'greenDown', ...waitFor('hatanodai', 'd2') },
      { id: 'd2', offsetSec: 250, patternKey: 'expressDownSaginuma', note: THROUGH_NOTE },
      { id: 'd3', offsetSec: 450, patternKey: 'blueDown' },
      { id: 'd4', offsetSec: 660, patternKey: 'greenDown' },
      // u2 starts at 鷺沼, 490 s further out than the 溝の口 slots, so its
      // offset is shifted round by one cycle (900 − 490 + 300 = 710) to put it
      // on the 溝の口 clock at +300. The 各停 it stands aside at 旗の台 is
      // therefore the NEXT cycle's u1 — which is what `cycleDelta: -1` says
      // when read from that 各停's side.
      { id: 'u1', offsetSec: 0, patternKey: 'greenUp', ...waitFor('hatanodai', 'u2', -1) },
      { id: 'u2', offsetSec: 710, patternKey: 'expressUpSaginuma', note: THROUGH_NOTE },
      { id: 'u3', offsetSec: 480, patternKey: 'blueUp' },
      { id: 'u4', offsetSec: 690, patternKey: 'greenUp' },
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
      { id: 'd1', offsetSec: 0, patternKey: 'greenDown', ...waitFor('hatanodai', 'd2') },
      { id: 'd2', offsetSec: 250, patternKey: 'expressDown' },
      { id: 'd3', offsetSec: 450, patternKey: 'blueDown' },
      { id: 'd4', offsetSec: 660, patternKey: 'greenDown' },
      { id: 'u1', offsetSec: 0, patternKey: 'greenUp', ...waitFor('hatanodai', 'u2') },
      { id: 'u2', offsetSec: 300, patternKey: 'expressUp' },
      { id: 'u3', offsetSec: 480, patternKey: 'blueUp' },
      { id: 'u4', offsetSec: 690, patternKey: 'greenUp' },
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
      { id: 'u1', offsetSec: 0, patternKey: 'greenUp' },
      { id: 'u2', offsetSec: 10 * M, patternKey: 'blueUp' },
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
