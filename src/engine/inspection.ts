/**
 * STUB — owned by the engine stream. Replace the bodies, keep the signatures.
 *
 * The odometer is DERIVED: `Formation.odometerKm` is a baseline as of
 * `odometerAsOf`, and current km adds the distance of every duty the
 * formation has been assigned since. The simulation must never write it — if
 * playing the clock mutated the document, save/reload would not round-trip
 * and undo would become unsound.
 */

import type { FormationId } from '@/domain/ids';
import type { ProjectDocument } from '@/domain/model';
import type { IsoDate } from '@/domain/units';
import type { InspectionStatus } from './types';

export function currentOdometerKm(
  doc: ProjectDocument,
  formationId: FormationId,
  _asOf: IsoDate,
): number {
  return doc.formations.byId[formationId]?.odometerKm ?? 0;
}

export function computeInspectionStatus(
  _doc: ProjectDocument,
  _asOf?: IsoDate,
): InspectionStatus[] {
  return [];
}
