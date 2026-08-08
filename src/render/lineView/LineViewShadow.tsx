/**
 * The line view's hidden DOM shadow.
 *
 * A canvas is opaque to Playwright: `getByTestId(TID.trainMarker)` finds
 * nothing, and pixel comparison is both slow and flaky. So every view mirrors
 * exactly what it drew into a visually-hidden list, which is the primary E2E
 * assertion target and simultaneously the accessibility affordance — a screen
 * reader gets the same list of trains a sighted user sees.
 *
 * It is fed from the same `SimSnapshot` the canvas draws, refreshed at 4 Hz
 * (synchronously under `?e2e=1`). The 60 Hz canvas path never touches the DOM.
 *
 * The attribute names below are a contract with the E2E suite — do not rename
 * them without updating the page objects.
 */

import { memo } from 'react';
import { TID } from '@e2e/testids';
import type { StationTrackId, TrainTypeId } from '@/domain/ids';
import type { ProjectDocument } from '@/domain/model';
import { entityList, metersToKm } from '@/domain/units';
import type { SimSnapshot, TrainRuntime } from '@/engine/types';

export interface LineViewShadowProps {
  doc: ProjectDocument | undefined;
  snapshot: SimSnapshot | undefined;
  showDeadhead: boolean;
}

function phaseDetails(train: TrainRuntime): {
  stationId?: string;
  trackId?: StationTrackId;
  reason?: string;
} {
  const phase = train.phase;
  if (phase.phase === 'dwelling') {
    const out: { stationId?: string; trackId?: StationTrackId; reason?: string } = {
      stationId: phase.stationId,
      reason: phase.reason,
    };
    if (phase.trackId !== undefined) out.trackId = phase.trackId;
    return out;
  }
  if (phase.phase === 'passing') {
    const out: { stationId?: string; trackId?: StationTrackId } = { stationId: phase.stationId };
    if (phase.trackId !== undefined) out.trackId = phase.trackId;
    return out;
  }
  if (phase.phase === 'running') {
    return { stationId: phase.toStationId };
  }
  return {};
}

function typeNameOf(doc: ProjectDocument | undefined, typeId: TrainTypeId): string {
  return doc?.trainTypes.byId[typeId]?.name ?? '';
}

export const LineViewShadow = memo(function LineViewShadow({
  doc,
  snapshot,
  showDeadhead,
}: LineViewShadowProps) {
  const trains = (snapshot?.trains ?? []).filter(
    (t) =>
      t.phase.phase !== 'pending' &&
      t.phase.phase !== 'finished' &&
      (showDeadhead || t.category === 'service'),
  );

  // Depot contents are drawn on the canvas too, so they belong in the shadow:
  // "did 回8002 actually go into the depot" is a question E2E should be able to
  // ask without reading pixels.
  const depots = doc ? entityList(doc.depots) : [];

  return (
    <ul className="visually-hidden" data-testid={TID.lineViewTrains} aria-label="列車位置">
      {depots.map((depot) => {
        const ids = snapshot?.depotOccupancy.get(depot.id) ?? [];
        const codes = ids.map((id) => doc?.formations.byId[id]?.code ?? id);
        return (
          <li
            key={depot.id}
            data-testid={TID.lineViewDepot(depot.id)}
            data-depot-id={depot.id}
            data-formation-count={codes.length}
            data-formations={codes.join(' ')}
          >
            {depot.name}
          </li>
        );
      })}
      {trains.map((train) => {
        const d = phaseDetails(train);
        return (
          <li
            key={train.trainId}
            data-testid={TID.trainMarker}
            data-train-id={train.trainId}
            data-train-number={train.number}
            data-type={typeNameOf(doc, train.typeId)}
            data-phase={train.phase.phase}
            data-reason={d.reason ?? ''}
            data-km={metersToKm(train.km).toFixed(3)}
            data-station={d.stationId ?? ''}
            data-track={d.trackId ?? ''}
            data-formation={train.formationCode ?? ''}
          >
            {train.label}
            {d.reason === 'overtakeWait' ? ' 待避中' : ''}
          </li>
        );
      })}
    </ul>
  );
});
