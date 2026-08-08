/**
 * Band × cycle → one `TrainSpec` per train.
 *
 * The rule is exactly the one a timetable planner would write on paper: repeat
 * the cycle from the start of the band until the next departure would fall
 * outside it. A slot late in the cycle therefore drops out one cycle earlier
 * than a slot at offset 0, which is why the last 青各停 of the night leaves
 * before the last 緑各停.
 */

import type { StopPatternId, TrainId, TrainTypeId } from '@/domain/ids';
import type { Direction } from '@/domain/model';
import type { StationId } from '@/domain/ids';
import type { Sec } from '@/domain/units';
import { SeedError } from '../errors';
import type { PatternSlot, ServicePattern, TimeBand } from './patternTypes';

export interface TrainSpec {
  /** `${bandId}:${slotId}:${cycleIndex}` — the join key for declared overtakes. */
  key: string;
  trainId: TrainId;
  bandId: string;
  bandName: string;
  slotId: string;
  cycleIndex: number;
  /** Absolute clock time at which this train's cycle begins. */
  cycleStartSec: Sec;
  slot: PatternSlot;
  cycleSec: number;
  /** Departure from the origin. */
  departureSec: Sec;
  number: string;
  direction: Direction;
  trainTypeId: TrainTypeId;
  stopPatternId: StopPatternId;
  originStationId: StationId;
  terminusStationId: StationId;
  cars: number;
}

export function specKey(bandId: string, slotId: string, cycleIndex: number): string {
  return `${bandId}:${slotId}:${cycleIndex}`;
}

export function expandBands(
  bands: readonly TimeBand[],
  patterns: readonly ServicePattern[],
  nextTrainId: () => TrainId,
): TrainSpec[] {
  const byId = new Map(patterns.map((p) => [p.id, p]));
  const out: TrainSpec[] = [];

  for (const band of bands) {
    const pattern = byId.get(band.patternId);
    if (pattern === undefined) {
      throw new SeedError('band references an unknown pattern', {
        band: band.id,
        pattern: band.patternId,
      });
    }
    if (pattern.cycleSec <= 0) {
      throw new SeedError('cycleSec must be positive', { pattern: pattern.id });
    }

    const maxCycles = Math.ceil((band.toSec - band.fromSec) / pattern.cycleSec) + 1;
    for (let k = 0; k < maxCycles; k++) {
      const cycleStart = band.fromSec + k * pattern.cycleSec;
      if (cycleStart >= band.toSec) break;
      for (const slot of pattern.slots) {
        const departureSec = cycleStart + slot.offsetSec;
        // The band window is tested against the slot's position in the CYCLE,
        // which is not always where it leaves its origin — see
        // `PatternSlot.windowOffsetSec`.
        if (cycleStart + (slot.windowOffsetSec ?? slot.offsetSec) >= band.toSec) continue;
        out.push({
          key: specKey(band.id, slot.id, k),
          trainId: nextTrainId(),
          bandId: band.id,
          bandName: band.name,
          slotId: slot.id,
          cycleIndex: k,
          cycleStartSec: cycleStart,
          slot,
          cycleSec: pattern.cycleSec,
          departureSec,
          number: `${slot.numbering.prefix ?? ''}${slot.numbering.base + k * slot.numbering.step}`,
          direction: slot.direction,
          trainTypeId: slot.trainTypeId,
          stopPatternId: slot.stopPatternId,
          originStationId: slot.originStationId,
          terminusStationId: slot.terminusStationId,
          cars: slot.cars,
        });
      }
    }
  }

  const seen = new Set<string>();
  for (const spec of out) {
    if (seen.has(spec.number)) {
      throw new SeedError('duplicate 列車番号 produced by the numbering blocks', {
        number: spec.number,
        key: spec.key,
      });
    }
    seen.add(spec.number);
  }

  return out;
}
