/**
 * STUB — owned by the engine stream. Replace the body, keep the signature.
 *
 * A train occupies exactly one StationTrack over
 * `[arr - approachSec, dep + clearSec]`. That deliberately simple model is
 * the v1 構内ダイヤ: route and point conflicts are explicitly out of scope.
 */

import type { StationTrackId, TrainId } from '@/domain/ids';
import type { ProjectDocument } from '@/domain/model';
import type { OccupancyInterval, TrainTimeline } from './types';

export function buildTrackIntervals(
  _doc: ProjectDocument,
  _timelines: Map<TrainId, TrainTimeline>,
): Map<StationTrackId, OccupancyInterval[]> {
  return new Map();
}
