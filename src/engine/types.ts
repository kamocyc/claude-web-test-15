/**
 * Simulation engine contract.
 *
 * The engine is a **pure function of (project, t)**. A train's position is
 * entirely determined by its own stop list, so there is nothing to step:
 * `snapshotAt(index, t)` is O(active trains) and can seek anywhere instantly.
 * Conflicts between trains are findings about the *plan* (see validation), not
 * emergent physics.
 *
 * The only stateful object in the system is the clock.
 */

import type {
  DepotId,
  DutyId,
  FormationId,
  LinkId,
  PerfProfileId,
  StationId,
  StationTrackId,
  TrainId,
  TrainTypeId,
} from '@/domain/ids';
import type {
  Direction,
  LinkRunTime,
  PerfProfile,
  ProjectDocument,
  StopKind,
  Train,
  TrainCategory,
} from '@/domain/model';
import type { IsoDate, Meters, Sec } from '@/domain/units';

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export interface TrainEvent {
  stopIndex: number;
  stationId: StationId;
  km: Meters;
  trackId?: StationTrackId;
  arr?: Sec;
  dep?: Sec;
  kind: StopKind;
  /** The moment the train is at this station: `arr ?? dep`. */
  at: Sec;
  /** True when this dwell exists so another train can overtake. */
  isOvertakeWait: boolean;
}

export interface TrainTimeline {
  trainId: TrainId;
  train: Train;
  typeId: TrainTypeId;
  direction: Direction;
  category: TrainCategory;
  events: TrainEvent[];
  startSec: Sec;
  endSec: Sec;
  profile: PerfProfile;
  /** '急 1701' */
  label: string;
  dutyId?: DutyId;
  formationId?: FormationId;
  /** Total distance covered, metres. */
  distance: Meters;
}

export interface OccupancyInterval {
  trackId: StationTrackId;
  stationId: StationId;
  trainId: TrainId;
  /** Booked arrival minus the track's approach margin. */
  from: Sec;
  /** Booked departure plus the track's clear margin. */
  to: Sec;
  /** The timetabled window, without margins — used for display. */
  bookedFrom: Sec;
  bookedTo: Sec;
}

export interface OvertakeEvent {
  stationId: StationId;
  direction: Direction;
  waitingTrainId: TrainId;
  passingTrainId: TrainId;
  waitArr: Sec;
  passAt: Sec;
  waitDep: Sec;
  /** Was this declared via `TrainStop.overtakenBy`? */
  declared: boolean;
  legal: boolean;
  reason?: 'noPassingTrack' | 'trackNotOvertakeCapable';
}

export interface ConnectionEvent {
  stationId: StationId;
  direction: Direction;
  /** The train passengers alight from (typically the 各停). */
  fromTrainId: TrainId;
  /** The train they board (typically the 急行). */
  toTrainId: TrainId;
  /** Seconds between `fromTrainId` arriving and `toTrainId` departing. */
  transferSec: number;
  declared: boolean;
  /** Within [connectionMinTransferSec, connectionMaxWaitSec]. */
  viable: boolean;
}

export interface TimetableIndex {
  readonly doc: ProjectDocument;
  readonly date: IsoDate;
  timelines: Map<TrainId, TrainTimeline>;
  /** Ordered by start time — a stable iteration order for rendering. */
  orderedTrainIds: TrainId[];
  /** Bucket i covers [bucketStartSec + i*60, bucketStartSec + (i+1)*60). */
  activeByMinute: TrainId[][];
  bucketStartSec: Sec;
  kmOfStation: Map<StationId, Meters>;
  runTimeOf: (linkId: LinkId, profileId: PerfProfileId) => LinkRunTime | undefined;
  trackIntervals: Map<StationTrackId, OccupancyInterval[]>;
  dutyOfTrain: Map<TrainId, DutyId>;
  formationOfTrain: Map<TrainId, FormationId>;
  overtakes: OvertakeEvent[];
  connections: ConnectionEvent[];
}

export type BuildIndex = (doc: ProjectDocument, date?: IsoDate) => TimetableIndex;

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

export type DwellReason =
  | 'passenger'
  | 'turnback'
  | 'operational'
  | 'overtakeWait'
  | 'depot';

export type TrainPhase =
  /** 未出庫 / 運行前 */
  | { phase: 'pending' }
  /** 走行中 */
  | {
      phase: 'running';
      fromStationId: StationId;
      toStationId: StationId;
      km: Meters;
      progress: number;
      speedKmh: number;
    }
  /** 停車中 (incl. 待避中) */
  | {
      phase: 'dwelling';
      stationId: StationId;
      trackId?: StationTrackId;
      km: Meters;
      since: Sec;
      until: Sec;
      reason: DwellReason;
    }
  /** 通過 */
  | { phase: 'passing'; stationId: StationId; trackId?: StationTrackId; km: Meters }
  /** 入庫済 / 運行終了 */
  | { phase: 'finished' };

export type TrainPhaseName = TrainPhase['phase'];

export interface TrainRuntime {
  trainId: TrainId;
  label: string;
  number: string;
  typeId: TrainTypeId;
  direction: Direction;
  category: TrainCategory;
  phase: TrainPhase;
  km: Meters;
  delaySec: number;
  dutyId?: DutyId;
  formationId?: FormationId;
  formationCode?: string;
  cars?: number;
  destinationStationId?: StationId;
  nextStationId?: StationId;
  nextArrSec?: Sec;
}

export type FormationPhase =
  | 'inDepot'
  | 'deadheadOut'
  | 'inService'
  | 'stabled'
  | 'deadheadIn'
  | 'underInspection'
  | 'unassigned';

export interface FormationRuntime {
  formationId: FormationId;
  code: string;
  cars: number;
  phase: FormationPhase;
  dutyId?: DutyId;
  currentTrainId?: TrainId;
  stationId?: StationId;
  trackId?: StationTrackId;
  depotId?: DepotId;
  /** Total distance this formation's duty covers today. */
  kmToday: Meters;
  /** Distance covered so far at time t. */
  kmSoFarToday: Meters;
}

export interface SimSnapshot {
  t: Sec;
  /** Active trains only, plus a short tail of just-finished ones. */
  trains: TrainRuntime[];
  formations: Map<FormationId, FormationRuntime>;
  trackOccupancy: Map<StationTrackId, TrainId>;
  depotOccupancy: Map<DepotId, FormationId[]>;
}

/**
 * Delay overlay. v1 ships only `NO_DELAY`; the parameter exists so that a
 * later disruption feature does not require rewriting position.ts and every
 * caller. Cost today: one argument.
 */
export interface TimeOverlay {
  delaySec(trainId: TrainId, stopIndex: number): number;
  readonly isEmpty: boolean;
}

export const NO_DELAY: TimeOverlay = {
  delaySec: () => 0,
  isEmpty: true,
};

// ---------------------------------------------------------------------------
// Inspection projection
// ---------------------------------------------------------------------------

export type InspectionState = 'ok' | 'dueSoon' | 'overdue' | 'unknown';

export interface InspectionStatus {
  formationId: FormationId;
  ruleId: string;
  kind: string;
  label: string;
  state: InspectionState;
  lastDate?: IsoDate;
  lastOdometerKm?: number;
  dueDate?: IsoDate;
  daysRemaining?: number;
  dueAtKm?: number;
  kmRemaining?: number;
  /** Odometer at the evaluation date, derived — never stored. */
  currentKm: number;
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export const CLOCK_SPEEDS = [1, 5, 10, 30, 60, 120, 300, 600] as const;
export type ClockSpeed = (typeof CLOCK_SPEEDS)[number];

export interface ClockState {
  tSec: Sec;
  playing: boolean;
  speed: number;
  loopRange?: { from: Sec; to: Sec };
}
