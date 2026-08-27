/**
 * 東急こどもの国線 — the service plan, as five time bands.
 *
 * ===========================================================================
 * Everything in this file is RECONSTRUCTION. See the header of `facts.ts`:
 * the two-set peak with a meet at 恩田, and the one-set shuttle either side of
 * it, are the arrangement this document was asked to model. They were not read
 * off a published timetable.
 * ===========================================================================
 *
 * ## Nothing here says "cross at 恩田"
 *
 * That is the point of the file. There is no meet flag on a slot, no crossing
 * declaration, nothing analogous to the Oimachi Line's `overtakes`. What the
 * bands state is how many minutes apart trains leave, and **the meet is the
 * consequence**: run two sets over a line whose half-journey is five minutes
 * on a twelve-minute cycle and they arrive at the middle station together,
 * because there is nowhere else for them to be.
 *
 * So 「ラッシュ時のみ恩田で交換」 is not implemented anywhere. It is what the
 * numbers below do. `detectMeets` finds it afterwards and
 * `headway.singleTrackOpposing` would fail the plan if it did not hold — which
 * is a much stronger statement than a flag could make, because a flag is only
 * ever as true as the person who set it.
 *
 * A declaration would also be the wrong shape. On a double-track line an
 * overtake is a *choice* — the planner decides which train stands aside, and
 * could have decided otherwise. On a single line a meet is not a choice: put
 * two trains on it going opposite ways and they meet somewhere, and the only
 * question the timetable answers is *where*. Declaring a fact that follows
 * from the rest of the document is how documents start to contradict
 * themselves.
 *
 * ## The clock
 *
 * A clear run is 300 s each way (150 + 20 standing + 130 — see `facts.ts`).
 *
 * **Off-peak — 1200 s cycle, one set, no meet.**
 *
 *     u1  offset    0   こどもの国発  →  長津田着   +300
 *     d1  offset  600   長津田発      →  こどもの国着 +900
 *
 * Turnbacks of 300 s at each end. One set closes the cycle exactly:
 * 300 + 300 + 300 + 300 = 1200. The line holds one train at a time, so the
 * single track is never contested and 恩田's second road is never touched.
 *
 * **Peak — 720 s cycle, two sets, one meet per cycle at 恩田.**
 *
 *     d1  offset    0   長津田発  0 → 恩田 150–210 → こどもの国着 340
 *     u1  offset   20   こどもの国発 20 → 恩田 150–210 → 長津田着   360
 *
 * Both trains stand at 恩田 across exactly the same minute. That is the meet.
 * The 60 s dwell (against a normal 20) is not padding: it is what a meet costs
 * on a single line, and stating it as one number per slot is the honest place
 * to put it.
 *
 * The sections either side stay clear of opposing movement by 60 s:
 *
 *     長津田〜恩田      下り [0, 150]    上り [210, 360]
 *     恩田〜こどもの国  上り [20, 150]   下り [210, 340]
 *
 * One set runs 長津田発 0 → こどもの国着 340 → 発 740 → 長津田着 1080 → 発 1440,
 * a round trip of 1440 s = two cycles, so the peak needs exactly two.
 *
 * ## Why there are no 準備 bands
 *
 * The Oimachi Line spends five of its thirteen bands ramping, with the up
 * direction starting one running time before the down (`RAMP_LEAD_SEC`). This
 * line needs none, and the reason is worth writing down because it is the same
 * fact seen from the other side.
 *
 * At 06:40 the last off-peak cycle sends a set こどもの国着 06:55. At 07:00:20
 * the first peak `u1` leaves こどもの国 — that set, after a 320 s turnback. The
 * peak's *other* set is the one that leaves 長津田 at 07:00, and it comes out
 * of the yard: 長津田 is where the depot is, so the extra set is already at the
 * end it is needed at, and the 出庫 never touches the running line. In the
 * evening the mirror image holds and the spare set finishes at 長津田 and goes
 * straight in.
 *
 * **Put the down train at the head of the cycle instead and none of that
 * works.** The extra set would have to be at こどもの国, which is 1面1線 with
 * nowhere to stand and no yard behind it, so it would have to be run down
 * there empty — into the teeth of the last off-peak up train, on single track,
 * with only 恩田 to get past it. The phase of the cycle decides whether the
 * line can be reinforced at all. That is not a fact about railways in general;
 * it is what happens when the only yard is at one end and the only loop is in
 * the middle.
 */

import type { DayTypeId } from '@/domain/ids';
import type { PatternSlot, ServicePattern, TimeBand } from '../generator/patternTypes';
import { CARS, type Facts } from './facts';

const H = 3600;

/** A clear half-journey. Every offset below is chosen against this. */
export const HALF_JOURNEY_SEC = 300;

/** What a meet costs the train that makes it, in place of the usual 20 s. */
export const MEET_DWELL_SEC = 60;

export interface ServicePlan {
  bands: TimeBand[];
  patterns: ServicePattern[];
}

type PatternKind = 'offPeak' | 'peak';

interface BandDef {
  id: string;
  name: string;
  fromSec: number;
  toSec: number;
  kind: PatternKind;
  /** 列車番号 block: 上り = base, 下り = base + 1, +2 per cycle. */
  numberBase: number;
}

/**
 * Five bands. Both cycle lengths divide an hour, so every band boundary falls
 * on the hour and no cycle is ever cut in half by one.
 */
const BAND_DEFS: readonly BandDef[] = [
  { id: 'early', name: '早朝', fromSec: 5 * H, toSec: 7 * H, kind: 'offPeak', numberBase: 500 },
  { id: 'amPeak', name: '朝ラッシュ', fromSec: 7 * H, toSec: 9 * H, kind: 'peak', numberBase: 600 },
  { id: 'midday', name: '日中', fromSec: 9 * H, toSec: 16 * H, kind: 'offPeak', numberBase: 700 },
  { id: 'pmPeak', name: '夕ラッシュ', fromSec: 16 * H, toSec: 19 * H, kind: 'peak', numberBase: 800 },
  { id: 'night', name: '夜間', fromSec: 19 * H, toSec: 24 * H, kind: 'offPeak', numberBase: 900 },
];

const CYCLE_SEC: Record<PatternKind, number> = { offPeak: 1200, peak: 720 };

interface SlotDef {
  id: string;
  offsetSec: number;
  direction: 'down' | 'up';
  /** Dwell at 恩田, when it differs from the station's own minimum. */
  ondaDwellSec?: number;
}

const SLOT_DEFS: Record<PatternKind, readonly SlotDef[]> = {
  // Up first: the set that is at こどもの国 at the top of the cycle brings
  // itself home, then goes back out. One set, one line, no contest.
  offPeak: [
    { id: 'u1', offsetSec: 0, direction: 'up' },
    { id: 'd1', offsetSec: 600, direction: 'down' },
  ],
  // Down first, by 20 seconds — the offset that puts both trains at 恩田
  // across the same minute. See the header.
  peak: [
    { id: 'd1', offsetSec: 0, direction: 'down', ondaDwellSec: MEET_DWELL_SEC },
    { id: 'u1', offsetSec: 20, direction: 'up', ondaDwellSec: MEET_DWELL_SEC },
  ],
};

export function buildServicePlan(facts: Facts): ServicePlan {
  const dayTypeId: DayTypeId = facts.dayTypeId;
  const bands: TimeBand[] = [];
  const patterns: ServicePattern[] = [];

  for (const band of BAND_DEFS) {
    const patternId = `pat-${band.id}`;
    const slots: PatternSlot[] = SLOT_DEFS[band.kind].map((def) => {
      const down = def.direction === 'down';
      const slot: PatternSlot = {
        id: def.id,
        offsetSec: def.offsetSec,
        direction: def.direction,
        trainTypeId: facts.type.local,
        stopPatternId: down ? facts.pattern.localDown : facts.pattern.localUp,
        originStationId: down ? facts.S.nagatsuta : facts.S.kodomonokuni,
        terminusStationId: down ? facts.S.kodomonokuni : facts.S.nagatsuta,
        // 下り odd, 上り even — off the *direction*, not off the slot's place
        // in the cycle. The peak leads with the down train and the off-peak
        // with the up one, so numbering by slot index would silently flip the
        // convention halfway through the day.
        numbering: { base: band.numberBase + (down ? 1 : 0), step: 2 },
        cars: CARS,
      };
      if (def.ondaDwellSec !== undefined) {
        slot.dwellOverrideSec = { [facts.S.onda]: def.ondaDwellSec };
      }
      return slot;
    });

    patterns.push({
      id: patternId,
      name: band.name,
      cycleSec: CYCLE_SEC[band.kind],
      slots,
    });
    bands.push({
      id: band.id,
      name: band.name,
      dayTypeId,
      fromSec: band.fromSec,
      toSec: band.toSec,
      patternId,
    });
  }

  return { bands, patterns };
}
