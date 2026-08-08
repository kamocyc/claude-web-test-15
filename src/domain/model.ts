/**
 * The project document — every entity that is persisted.
 *
 * Two conventions run through the whole model:
 *
 * 1. **Depots are Stations.** A `Depot` points at a `Station` with
 *    `kind: 'depot'` sitting on the km axis just off the attached passenger
 *    station. A 出庫/入庫 回送 is therefore an ordinary `Train` whose first or
 *    last stop happens to be that station, and position interpolation,
 *    occupancy, string-diagram drawing, duty continuity and validation all
 *    work on it unmodified. There is no parallel "depot movement" code path.
 *
 * 2. **Stop patterns are templates, not runtime data.** A `Train` carries its
 *    own materialized `stops[]`. Real timetables are full of one-off
 *    exceptions, and editing a pattern must never silently rewrite times a
 *    human authored. `Train.patternId` records provenance only.
 */

import type {
  AssignmentId,
  DayTypeId,
  DepotId,
  DutyId,
  FormationId,
  InspectionRecordId,
  InspectionRuleId,
  LineId,
  LinkId,
  PerfProfileId,
  SeriesId,
  StationId,
  StationTrackId,
  StopPatternId,
  TrainId,
  TrainTypeId,
} from './ids';
import type { Entities, IsoDate, Meters, Sec } from './units';

export const SCHEMA_VERSION = 1;

/** `down` = increasing km. For the Oimachi Line that is 大井町 → 溝の口. */
export type Direction = 'down' | 'up';

export const DIRECTIONS: readonly Direction[] = ['down', 'up'];

export function oppositeDirection(d: Direction): Direction {
  return d === 'down' ? 'up' : 'down';
}

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

export interface Line {
  id: LineId;
  name: string;
  nameKana?: string;
  /** Label for travel in the `down` sense, e.g. '溝の口方面'. */
  downDirectionLabel: string;
  upDirectionLabel: string;
  color: string;
}

export type StationKind = 'passenger' | 'signal' | 'depot';

export interface Station {
  id: StationId;
  name: string;
  nameKana?: string;
  /** Operator station code, e.g. 'OM16'. */
  code?: string;
  kind: StationKind;
  kmFromOrigin: Meters;
  /** Authored order = top-to-bottom display order of 番線. */
  trackIds: StationTrackId[];
  /** Minimum time doors must be open at a passenger stop. */
  minDwellSec: number;
  /** Minimum time to reverse direction here. */
  minTurnbackSec: number;
  /** Fallback platform per direction when nothing else forces a choice. */
  defaultTrackId: Partial<Record<Direction, StationTrackId>>;
  /** Marks a station where 緩急接続 is intended. Drives connection checks. */
  isConnectionPoint: boolean;
  /** Display only — '東急目黒線', 'JR京浜東北線'. */
  transfers?: string[];
}

export type TrackUsage = 'main' | 'passing' | 'through' | 'depot' | 'stabling';

export interface StationTrack {
  id: StationTrackId;
  stationId: StationId;
  name: string;
  number?: number;
  usage: TrackUsage;
  /** false for 通過線 — a passenger stop here is an error. */
  hasPlatform: boolean;
  /** Which directions may use this track. */
  directions: Direction[];
  /** 折り返し可 */
  canTurnBack: boolean;
  /** 待避可 — a train standing here can be passed by another. */
  canBeOvertaken: boolean;
  /** 有効長, in cars. */
  maxCars: number;
  /** Occupancy starts this many seconds before the booked arrival. */
  approachSec: number;
  /** Occupancy ends this many seconds after the booked departure. */
  clearSec: number;
  depotId?: DepotId;
}

/** Always oriented in the `down` sense: from lower km to higher km. */
export interface Link {
  id: LinkId;
  fromStationId: StationId;
  toStationId: StationId;
  distance: Meters;
  /** 1 = 単線, 2 = 複線. Quad-track sections are modelled as parallel Links. */
  trackCount: 1 | 2;
  /** 続行時隔 — minimum spacing between successive same-direction trains. */
  minHeadwaySec: number;
  maxSpeedKmh: number;
}

/** Vehicle performance, deliberately decoupled from TrainType. */
export interface PerfProfile {
  id: PerfProfileId;
  name: string;
  accelKmhps: number;
  decelKmhps: number;
  maxSpeedKmh: number;
}

/**
 * Minimum running time over one link for one performance profile:
 *
 *   total = baseRunSec
 *         + (departing from a stand at `from` ? startPenaltySec : 0)
 *         + (coming to a stand at `to`        ? stopPenaltySec  : 0)
 *
 * This is why 急行 and 各停 need no separate run-time tables: their difference
 * is entirely start/stop penalties, which follow from the stopping pattern.
 */
export interface LinkRunTime {
  linkId: LinkId;
  profileId: PerfProfileId;
  baseRunSec: number;
  startPenaltySec: number;
  stopPenaltySec: number;
}

export interface Depot {
  id: DepotId;
  name: string;
  /** The synthetic `Station` (kind: 'depot') representing this depot. */
  stationId: StationId;
  /** The passenger station the depot connects to. */
  attachedStationId: StationId;
  /** One-way 回送 running time between depot and attached station. */
  accessRunSec: number;
  /** 出庫準備 — time a formation needs before it can leave. */
  prepSec: number;
  capacityFormations: number;
  capacityCars?: number;
  /** Which inspection kinds can be performed here. */
  inspectionKinds: InspectionKind[];
  /** Signed km offset used to draw the depot stub off the main axis. */
  stubOffsetMeters: Meters;
}

// ---------------------------------------------------------------------------
// Service definition
// ---------------------------------------------------------------------------

export interface TrainType {
  id: TrainTypeId;
  name: string;
  shortName: string;
  color: string;
  lineStyle: 'solid' | 'dashed' | 'dotted';
  lineWidth: number;
  /** false for 回送 / 試運転. */
  isPassengerService: boolean;
  perfProfileId: PerfProfileId;
  defaultStopPatternId?: StopPatternId;
  sortOrder: number;
}

export type StopKind = 'stop' | 'pass';

/** A template. Never read during simulation — see the file header. */
export interface StopPattern {
  id: StopPatternId;
  name: string;
  trainTypeId: TrainTypeId;
  direction: Direction | 'both';
  originStationId: StationId;
  terminusStationId: StationId;
  /** StationId -> stop or pass. Stations absent from the map are not served. */
  entries: Record<string, StopKind>;
  dwellOverrideSec?: Record<string, number>;
}

export type StopOperation =
  | 'turnback'
  | 'crewChange'
  | 'couple'
  | 'uncouple'
  | 'depotIn'
  | 'depotOut';

export interface TrainStop {
  stationId: StationId;
  /** 番線. undefined = not yet assigned (a warning, not an error). */
  trackId?: StationTrackId;
  /** undefined at the origin. */
  arr?: Sec;
  /** undefined at the terminus. */
  dep?: Sec;
  kind: StopKind;
  /** 運転停車 — stops, but no passenger handling. */
  operational?: boolean;
  operation?: StopOperation;
  /** Authored intent: this train waits here to be passed by these trains. */
  overtakenBy?: TrainId[];
  /** Authored intent: 緩急接続 with these trains here. */
  connectsTo?: TrainId[];
  note?: string;
}

export type TrainCategory = 'service' | 'deadhead' | 'test' | 'shunt';

export interface Train {
  id: TrainId;
  /** 列車番号 — '1701', '回5001'. */
  number: string;
  typeId: TrainTypeId;
  direction: Direction;
  category: TrainCategory;
  /** Provenance only; compared against `stops` to detect pattern deviation. */
  patternId?: StopPatternId;
  /** Ordered in the direction of travel. First has no `arr`, last no `dep`. */
  stops: TrainStop[];
  dayTypeIds: DayTypeId[];
  minCars?: number;
  allowedSeriesIds?: SeriesId[];
  /** Seed provenance — lets the generator regenerate a band selectively. */
  origin?: { generator: 'seed'; bandId: string; slotId: string; cycleIndex: number };
  note?: string;
}

// ---------------------------------------------------------------------------
// Duties, formations, inspection
// ---------------------------------------------------------------------------

export type DutyLeg =
  | { kind: 'train'; trainId: TrainId }
  | { kind: 'stable'; stationId: StationId; trackId?: StationTrackId; from: Sec; to: Sec }
  | {
      kind: 'inspection';
      depotId: DepotId;
      inspectionKind: InspectionKind;
      from: Sec;
      to: Sec;
    };

/** 運用 — a *plan* for one vehicle-day. Not a physical vehicle. */
export interface Duty {
  id: DutyId;
  /** 運用番号 — '01K'. */
  code: string;
  dayTypeIds: DayTypeId[];
  /** Ordered by time. */
  legs: DutyLeg[];
  requiredCars?: number;
  requiredSeriesIds?: SeriesId[];
  color?: string;
}

/** Which physical formation works which duty on which date. */
export interface Assignment {
  id: AssignmentId;
  date: IsoDate;
  dutyId: DutyId;
  formationId: FormationId;
}

export interface FormationSeries {
  id: SeriesId;
  name: string;
  perfProfileId: PerfProfileId;
  allowedCarCounts: number[];
  color?: string;
}

/** 編成 — a physical trainset. */
export interface Formation {
  id: FormationId;
  /** '6121F' */
  code: string;
  seriesId: SeriesId;
  cars: number;
  homeDepotId: DepotId;
  status: 'active' | 'inInspection' | 'stored' | 'retired';
  /**
   * Baseline odometer as of `odometerAsOf`. Current km is DERIVED as
   * `odometerKm + Σ(assigned duty km since odometerAsOf)`.
   *
   * The simulation must never write this. If playing the clock mutated the
   * odometer, loading a document and re-saving it would produce a different
   * document, and undo/redo would become unsound.
   */
  odometerKm: number;
  odometerAsOf: IsoDate;
  commissionedOn: IsoDate;
  note?: string;
}

/** 列車検査 / 月(交番)検査 / 重要部検査 / 全般検査 */
export type InspectionKind = 'train' | 'monthly' | 'bogie' | 'general';

export const INSPECTION_KINDS: readonly InspectionKind[] = ['train', 'monthly', 'bogie', 'general'];

export const INSPECTION_KIND_LABEL: Record<InspectionKind, string> = {
  train: '列車検査',
  monthly: '月検査',
  bogie: '重要部検査',
  general: '全般検査',
};

export interface InspectionRule {
  id: InspectionRuleId;
  kind: InspectionKind;
  name: string;
  appliesTo: { seriesIds: SeriesId[] } | 'all';
  intervalDays?: number;
  intervalKm?: number;
  warnBeforeDays?: number;
  warnBeforeKm?: number;
  /** How long the formation is out of service. */
  outOfServiceDays: number;
  depotIds: DepotId[];
  sortOrder: number;
}

export interface InspectionRecord {
  id: InspectionRecordId;
  formationId: FormationId;
  ruleId: InspectionRuleId;
  kind: InspectionKind;
  status: 'completed' | 'planned';
  from: IsoDate;
  to: IsoDate;
  /** Required when `status === 'completed'`. */
  odometerKmAt?: number;
  depotId: DepotId;
  note?: string;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface DayType {
  id: DayTypeId;
  name: string;
  kind: 'weekday' | 'holiday' | 'special';
  color: string;
}

export interface CalendarEntry {
  date: IsoDate;
  dayTypeId: DayTypeId;
}

// ---------------------------------------------------------------------------
// Settings & the document
// ---------------------------------------------------------------------------

export interface ValidationConfig {
  /** Per-rule severity override; 'off' disables the rule entirely. */
  severityOverrides: Record<string, 'error' | 'warning' | 'info' | 'off'>;
  defaultMinHeadwaySec: number;
  defaultMinTurnbackSec: number;
  preferredTurnbackSec: number;
  connectionMinTransferSec: number;
  connectionMaxWaitSec: number;
  /** Clearance required between a waiting train and the train passing it. */
  overtakeClearanceSec: number;
  /** Fraction of an inspection interval after which a warning is raised. */
  inspectionWarnRatio: number;
}

export interface ProjectSettings {
  serviceDayStartSec: Sec;
  serviceDayEndSec: Sec;
  timeGrainSec: 1 | 5 | 10 | 15 | 30 | 60;
  /** The roster date used by assignment and inspection views. */
  activeDate: IsoDate;
  activeDayTypeId: DayTypeId;
}

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  appVersion: string;
}

export interface ProjectDocument {
  schemaVersion: number;
  meta: ProjectMeta;
  settings: ProjectSettings;
  validationConfig: ValidationConfig;

  /** v1 models exactly one line. The entity exists so multi-line is additive. */
  line: Line;
  stations: Entities<Station>;
  stationTracks: Entities<StationTrack>;
  links: Entities<Link>;
  perfProfiles: Entities<PerfProfile>;
  /** Sparse table; a keyed lookup is built in the simulation index. */
  linkRunTimes: LinkRunTime[];
  depots: Entities<Depot>;
  trainTypes: Entities<TrainType>;
  stopPatterns: Entities<StopPattern>;
  trains: Entities<Train>;
  duties: Entities<Duty>;
  formationSeries: Entities<FormationSeries>;
  formations: Entities<Formation>;
  inspectionRules: Entities<InspectionRule>;
  inspectionRecords: Entities<InspectionRecord>;
  dayTypes: Entities<DayType>;
  calendar: CalendarEntry[];
  assignments: Entities<Assignment>;
}
