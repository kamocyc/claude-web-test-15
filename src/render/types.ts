/**
 * The render stream's public surface.
 *
 * The UI stream imports only these props types and the three components. The
 * render stream never imports from `src/ui` — the only shared state is the
 * read-only store slices passed in as props or read imperatively inside the
 * animation frame.
 */

import type { StationId, StationTrackId, TrainId } from '@/domain/ids';
import type { Meters, Sec } from '@/domain/units';
import type { EntityRef } from '@/validation/types';

export interface ViewSelection {
  selected: EntityRef[];
  hovered?: EntityRef;
}

export interface CanvasViewProps {
  /** Called when the user clicks something in the canvas. */
  onSelect?: (ref: EntityRef | undefined, additive: boolean) => void;
  /** Called when the user drags the diagram's time cursor. */
  onSeek?: (t: Sec) => void;
  className?: string;
}

export interface LineViewProps extends CanvasViewProps {
  /** Filter to a single duty; everything else is desaturated. */
  highlightDutyId?: string;
  showDeadhead?: boolean;
}

export interface StringDiagramProps extends CanvasViewProps {
  highlightDutyId?: string;
  showDeadhead?: boolean;
  /** 'km' spaces stations by distance; 'index' spaces them evenly. */
  verticalScale?: 'km' | 'index';
}

export interface StationYardProps {
  stationId: StationId;
  onSelect?: (ref: EntityRef | undefined, additive: boolean) => void;
}

/** What `window.__render.digest(view)` returns — asserted by E2E. */
export interface RenderDigest {
  view: string;
  width: number;
  height: number;
  trains: Array<{ id: string; sx: number; sy: number }>;
  stations: Array<{ id: string; sx: number; sy: number }>;
}

/** One row of the hidden DOM shadow the line view publishes. */
export interface TrainMarkerShadow {
  trainId: TrainId;
  number: string;
  typeName: string;
  phase: string;
  reason?: string;
  km: Meters;
  stationId?: StationId;
  trackId?: StationTrackId;
  formationCode?: string;
}
