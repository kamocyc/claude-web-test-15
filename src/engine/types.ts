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
  /** True when this dwell exists so an opposing train can pass — 交換. */
  isMeetWait: boolean;
}

/** One road a formation stands on during a layover, from `from` onwards. */
export interface LayoverBerth {
  from: Sec;
  trackId?: StationTrackId;
}

/**
 * What the stock does between arriving as one train and leaving as the next.
 *
 * A train that terminates does not evaporate: its formation stands at the
 * platform (or is shunted to a 引上線 and back) until the next train of the
 * same duty departs. Without this the line view blanks the train out at the
 * arrival and pops the successor into existence minutes later, which reads as
 * a vehicle disappearing and another teleporting in.
 */
export interface LayoverPlan {
  /** The successor's booked departure — the instant this train stops being drawn. */
  untilSec: Sec;
  stationId: StationId;
  km: Meters;
  /** Roads in time order. The first begins at this train's own arrival. */
  berths: LayoverBerth[];
  nextTrainId: TrainId;
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
  /** Set when the duty runs straight on into another train from here. */
  layover?: LayoverPlan;
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

/**
 * 交換(行き違い) — two opposing trains standing at the same station at the
 * same time because the section beyond is single track.
 *
 * The mirror image of `OvertakeEvent`: a 待避 is a faster train passing a
 * slower one going the *same* way, a 交換 is two trains going *opposite* ways
 * getting past each other. On a double-track line the second never has to
 * happen; on a single-track line it is the only way two trains can coexist.
 *
 * Deliberately descriptive rather than judgemental — there is no `legal` flag
 * here, unlike `OvertakeEvent`. Whether the meet is possible is a question
 * about roads, and `track.doubleOccupancy` already answers it: give a station
 * one road and put two trains on it and the occupancy check fires, with the
 * margins and the timings spelled out. A second opinion phrased as
 * "there is no loop here" would say less, later.
 */
export interface MeetEvent {
  stationId: StationId;
  downTrainId: TrainId;
  upTrainId: TrainId;
  /** The moment both are standing here — the later of the two arrivals. */
  at: Sec;
  /** How long the two stand here together. */
  overlapSec: number;
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
  /** Within [connectionMinTransferSec, connectionMaxWaitSec], and boardable. */
  viable: boolean;
  /**
   * Why a *declared* pair is not a connection at all, as opposed to one whose
   * transfer time is merely out of range. Only ever set on declared pairs: the
   * discovery passes reject these before they become events.
   */
  blockedReason?: 'targetDoesNotStop' | 'targetNotFaster';
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
  meets: MeetEvent[];
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
  /** 交換待ち — held for an opposing train on a single-track line. */
  | 'meetWait'
  | 'depot';

export type TrainPhase =
  /** 未出庫 / 運行前 */
  | { phase: 'pending' }
  /** 走行中 */
  | {
      phase: 'running';
      fromStationId: StationId;
      toStationId: StationId;
      /**
       * The roads the leg leaves from and arrives at. The line view needs them
       * to swing the train out of its 番線 and back in along the drawn leads
       * instead of jumping a lane at the departure instant.
       */
      fromTrackId?: StationTrackId;
      toTrackId?: StationTrackId;
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
  /**
   * 通過 — an annotation on a leg, not a stop.
   *
   * `km` is the train's true interpolated position: it does NOT snap to the
   * station, because a marker that jumps forward onto the station, freezes and
   * jumps again is exactly the artefact the trapezoidal profile exists to
   * avoid. `fromStationId`/`toStationId` describe the leg being run so the
   * view places it the same way it places a running train.
   */
  | {
      phase: 'passing';
      stationId: StationId;
      trackId?: StationTrackId;
      km: Meters;
      fromStationId?: StationId;
      toStationId?: StationId;
      fromTrackId?: StationTrackId;
      toTrackId?: StationTrackId;
    }
  /** 折返待機 — arrived, but the stock is still here forming the next train. */
  | {
      phase: 'layover';
      stationId: StationId;
      trackId?: StationTrackId;
      km: Meters;
      since: Sec;
      until: Sec;
      nextTrainId: TrainId;
      /** Mid-shunt: the road being left, and how far across the move is. */
      fromTrackId?: StationTrackId;
      shunt?: number;
    }
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
