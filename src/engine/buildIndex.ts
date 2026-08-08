/**
 * STUB — owned by the engine stream. Replace the body, keep the signature.
 *
 * Builds the derived, memoizable view of a project that everything else reads:
 * per-train timelines with km attached, per-minute activity buckets, track
 * occupancy intervals, and the detected overtake / connection events.
 */

import type { ProjectDocument } from '@/domain/model';
import type { IsoDate } from '@/domain/units';
import type { TimetableIndex } from './types';

export function buildIndex(doc: ProjectDocument, date?: IsoDate): TimetableIndex {
  return {
    doc,
    date: date ?? doc.settings.activeDate,
    timelines: new Map(),
    orderedTrainIds: [],
    activeByMinute: [],
    bucketStartSec: doc.settings.serviceDayStartSec,
    kmOfStation: new Map(),
    runTimeOf: () => undefined,
    trackIntervals: new Map(),
    dutyOfTrain: new Map(),
    formationOfTrain: new Map(),
    overtakes: [],
    connections: [],
  };
}
