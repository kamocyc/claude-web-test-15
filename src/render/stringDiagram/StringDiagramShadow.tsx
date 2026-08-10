/**
 * The string diagram's hidden DOM shadow.
 *
 * Same contract as the line view's: a visually-hidden list of exactly what was
 * drawn, so Playwright can assert on 500 polylines, every 待避 marker and every
 * 緩急接続 bracket without a single pixel comparison.
 *
 * Unlike the line view this list is a function of the *layout*, not the
 * snapshot, so it changes only when the timetable changes — which is also why
 * a 500-row list costs nothing at 4 Hz.
 *
 * Attribute names are a contract with the E2E suite.
 */

import { memo } from 'react';
import { TID } from '@e2e/testids';
import type { DiagramLayout } from './layout';

export interface StringDiagramShadowProps {
  layout: DiagramLayout | undefined;
}

export const StringDiagramShadow = memo(function StringDiagramShadow({
  layout,
}: StringDiagramShadowProps) {
  const trains = layout?.trains ?? [];
  const overtakes = layout?.overtakes ?? [];
  const connections = layout?.connections ?? [];

  return (
    <ul className="visually-hidden" data-testid={TID.diagramTrains} aria-label="運行図表">
      {trains.map((train) => (
        <li
          key={train.trainId}
          data-testid={TID.diagramTrainLine}
          data-train-id={train.trainId}
          data-type={train.typeName}
          data-direction={train.direction}
          data-duty={train.dutyId ?? ''}
          data-point-count={train.points.length}
        >
          {train.label}
        </li>
      ))}
      {overtakes.map((o, i) => (
        <li
          key={`ot-${o.stationId}-${o.waitingTrainId ?? i}-${o.passingTrainId ?? i}`}
          data-testid={TID.overtakeMarker}
          data-station-id={o.stationId}
          data-waiting-train={o.waitingTrainId ?? ''}
          data-passing-train={o.passingTrainId ?? ''}
          data-legal={o.ok ? '1' : '0'}
        >
          待避
        </li>
      ))}
      {connections.map((c, i) => (
        <li
          key={`cx-${c.stationId}-${c.fromTrainId ?? i}-${c.toTrainId ?? i}`}
          data-testid={TID.connectionMarker}
          data-station-id={c.stationId}
          data-waiting-train={c.fromTrainId ?? ''}
          data-passing-train={c.toTrainId ?? ''}
          data-transfer-sec={c.transferSec ?? ''}
        >
          接続
        </li>
      ))}
    </ul>
  );
});
