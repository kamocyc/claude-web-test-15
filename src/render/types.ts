/**
 * The render stream's public surface.
 *
 * The UI stream imports only these props types and the three components. The
 * render stream never imports from `src/ui` — the only shared state is the
 * read-only store slices passed in as props or read imperatively inside the
 * animation frame.
 */

import type { CrewDutyId, StationId, StationTrackId, TrainId } from '@/domain/ids';
import type { CrewRole } from '@/domain/model';
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
  /** Draw one direction on its own; defaults to both. */
  direction?: 'both' | 'down' | 'up';
  /** Trains drawn thicker because they are selected elsewhere in the app. */
  selectedTrainIds?: readonly TrainId[];
}

export interface CrewDutyChartProps {
  /** Absent = every role on one sheet. */
  role?: CrewRole;
  selectedCrewDutyId?: CrewDutyId;
  /** A click on a row or a bar. `legIndex` is absent for the row itself. */
  onSelect?: (crewDutyId: CrewDutyId, legIndex?: number) => void;
  className?: string;
}

export interface StationYardProps {
  stationId: StationId;
  onSelect?: (ref: EntityRef | undefined, additive: boolean) => void;
  /**
   * Dragging a bar onto another lane reassigns that stop's 番線.
   *
   * The chart is a *view*: it reports the intent and never mutates the
   * document itself. The UI stream turns this into a `train/setStopTrack`
   * command so the change is validated and undoable like any other edit.
   * Without a handler the bars are still draggable-looking but inert.
   */
  onReassignTrack?: (trainId: TrainId, stopIndex: number, trackId: StationTrackId) => void;
  /** Highlight one train's bars — used when the inspector has a train open. */
  highlightTrainId?: TrainId;
  className?: string;
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

/**
 * One row of the string diagram's hidden shadow.
 *
 * `pointCount` is the assertable proof that the dwell stubs were generated:
 * a train with three timed dwells has more vertices than one with none, so an
 * E2E test can catch a regression that drops them without looking at pixels.
 */
export interface DiagramLineShadow {
  trainId: TrainId;
  typeName: string;
  pointCount: number;
}
