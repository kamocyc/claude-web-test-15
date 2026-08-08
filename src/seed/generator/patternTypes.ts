/**
 * The declarative shape of a timetable.
 *
 * A `ServicePattern` is one repeating cycle: "every 15 minutes, in this order,
 * these four trains leave". A `TimeBand` says which pattern applies between
 * which two clock times. Everything else in the generator is mechanical.
 *
 * The single most important design decision lives here: **overtakes are
 * declared, never inferred**. `PatternSlot.overtakes` names the slot that does
 * the passing, so the solver in `stopTimes.ts` only ever has to *satisfy* a
 * plan — it never has to *find* one. Searching for a feasible overtaking plan
 * is a hard combinatorial problem; checking one is a forward pass with a
 * dwell extension. That reduction is what makes a full-day 東急大井町線
 * timetable tractable in a few hundred lines.
 */

import type { DayTypeId, StationId, StopPatternId, TrainTypeId } from '@/domain/ids';
import type { Direction } from '@/domain/model';
import type { Sec } from '@/domain/units';

export interface PatternSlot {
  /** Unique within its ServicePattern. */
  id: string;
  /** Seconds after the start of the cycle at which this train leaves its origin. */
  offsetSec: number;
  /**
   * Where this train sits in the *cycle*, when that differs from where it
   * leaves its origin — which happens when a slot starts further out on the
   * line than the rest of the cycle (the 鷺沼発 急行 leaves 490 s before the
   * cycle it belongs to). The band window is tested against this, so a band
   * does not spill an extra train into its successor's first cycle. Defaults
   * to `offsetSec`.
   */
  windowOffsetSec?: number;
  direction: Direction;
  trainTypeId: TrainTypeId;
  stopPatternId: StopPatternId;
  originStationId: StationId;
  terminusStationId: StationId;
  /**
   * "I wait at `atStationId` to be passed by slot `bySlotId`." `cycleDelta`
   * selects a train from a neighbouring cycle (+1 = the next cycle's train).
   * The only legal `atStationId` values are 旗の台 (both directions) and
   * 上野毛 (up only) — the generator asserts this.
   */
  overtakes?: Array<{ atStationId: StationId; bySlotId: string; cycleDelta?: number }>;
  /** 緩急接続 — recorded on the stop so the connection rules can check it. */
  connectsWith?: Array<{ atStationId: StationId; withSlotId: string; cycleDelta?: number }>;
  /** 列車番号 = `${prefix ?? ''}${base + cycleIndex * step}`. */
  numbering: { base: number; step: number; prefix?: string };
  /** Station id -> dwell, overriding `Station.minDwellSec` for this slot only. */
  dwellOverrideSec?: Record<string, number>;
  /** Copied onto every train produced from this slot. */
  note?: string;
  /** 編成両数. Drives duty matching and formation assignment. */
  cars: number;
}

export interface ServicePattern {
  id: string;
  name: string;
  cycleSec: number;
  slots: PatternSlot[];
}

export interface TimeBand {
  id: string;
  name: string;
  dayTypeId: DayTypeId;
  fromSec: Sec;
  toSec: Sec;
  patternId: string;
}
