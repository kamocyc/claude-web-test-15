/**
 * STUB — owned by the engine stream. Replace the bodies, keep the signatures.
 *
 * `snapshotAt` allocates and is what React and tests call. `snapshotInto`
 * reuses a pooled object and is what the 60fps render loop calls — the render
 * loop must not allocate.
 */

import type { Sec } from '@/domain/units';
import { NO_DELAY, type SimSnapshot, type TimeOverlay, type TimetableIndex } from './types';

export function createEmptySnapshot(): SimSnapshot {
  return {
    t: 0,
    trains: [],
    formations: new Map(),
    trackOccupancy: new Map(),
    depotOccupancy: new Map(),
  };
}

export function snapshotAt(
  idx: TimetableIndex,
  t: Sec,
  overlay: TimeOverlay = NO_DELAY,
): SimSnapshot {
  return snapshotInto(idx, t, createEmptySnapshot(), overlay);
}

export function snapshotInto(
  _idx: TimetableIndex,
  t: Sec,
  out: SimSnapshot,
  _overlay: TimeOverlay = NO_DELAY,
): SimSnapshot {
  out.t = t;
  out.trains.length = 0;
  out.formations.clear();
  out.trackOccupancy.clear();
  out.depotOccupancy.clear();
  return out;
}
