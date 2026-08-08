/**
 * STUB — owned by the engine stream. Replace the bodies, keep the signatures.
 */

import type { PerfProfile } from '@/domain/model';
import type { Meters, Sec } from '@/domain/units';
import { NO_DELAY, type TimeOverlay, type TrainRuntime, type TrainTimeline } from './types';

/**
 * Distance covered `tau` seconds into a segment of length `d` scheduled to
 * take `T` seconds, using a trapezoidal speed profile. Linear interpolation
 * makes trains move at constant speed and stop dead at platforms, which looks
 * wrong enough to make the line view untrustworthy.
 */
export function interpolateKm(
  d: Meters,
  T: number,
  tau: number,
  _profile: PerfProfile,
  _startsFromStop: boolean,
  _endsAtStop: boolean,
): Meters {
  if (T <= 0) return d;
  const f = Math.max(0, Math.min(1, tau / T));
  return d * f;
}

export function trainRuntimeAt(
  tl: TrainTimeline,
  t: Sec,
  _overlay: TimeOverlay = NO_DELAY,
): TrainRuntime {
  return {
    trainId: tl.trainId,
    label: tl.label,
    number: tl.train.number,
    typeId: tl.typeId,
    direction: tl.direction,
    category: tl.category,
    phase: t < tl.startSec ? { phase: 'pending' } : { phase: 'finished' },
    km: 0,
    delaySec: 0,
  };
}
