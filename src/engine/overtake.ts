/**
 * STUB — owned by the engine stream. Replace the bodies, keep the signatures.
 *
 * Overtake detection is the backbone of the 緩急接続 feature: it sets
 * `TrainEvent.isOvertakeWait` (which produces the 待避中 phase in the line
 * view) and feeds three validation rules.
 */

import type { ProjectDocument } from '@/domain/model';
import type { ConnectionEvent, OvertakeEvent, TrainTimeline } from './types';
import type { TrainId } from '@/domain/ids';

export function detectOvertakes(
  _doc: ProjectDocument,
  _timelines: Map<TrainId, TrainTimeline>,
): OvertakeEvent[] {
  return [];
}

export function detectConnections(
  _doc: ProjectDocument,
  _timelines: Map<TrainId, TrainTimeline>,
  _overtakes: OvertakeEvent[],
): ConnectionEvent[] {
  return [];
}
