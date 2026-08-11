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
  CrewAssignmentId,
  CrewDutyId,
  CrewId,
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

export const SCHEMA_VERSION = 2;

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
  /** 渡り線 in either throat. Absent = none; see `StationCrossover`. */
  crossovers?: StationCrossover[];
  /**
   * 乗務員交代可能駅. A crew may board or leave a train here. Absent = false:
   * a place with no relief arrangement is the common case, and a crew that
   * could change anywhere would make the check vacuous.
   */
  crewChange?: boolean;
  /**
   * 乗務員基地 — where a duty signs on and off and where a 休憩 can be taken.
   * A base is a relief point by construction; `crewChange` need not be
   * repeated. Absent = false.
   */
  crewBase?: boolean;
  /** Display only — '東急目黒線', 'JR京浜東北線'. */
  transfers?: string[];
}

export type TrackUsage = 'main' | 'passing' | 'through' | 'depot' | 'stabling';

/**
 * Which throat of a station. `down` is the end 下り trains leave by — the
 * higher-km end — and `up` the lower-km one. 溝の口's 引上線 are at its `down`
 * end (梶が谷方); 大井町's two roads are open at the `down` end only, because
 * the other end is the buffer stops.
 */
export type StationEnd = 'down' | 'up';

export const STATION_ENDS: readonly StationEnd[] = ['down', 'up'];

export const STATION_END_LABEL: Record<StationEnd, string> = {
  down: '下り方',
  up: '上り方',
};

/**
 * 構内配線 — how one road is wired into the station.
 *
 * Everything here used to be guessed from `usage` and `directions`, and the
 * guess is wrong wherever the real place is interesting: a 引上線 was assumed
 * to hang off whichever end of the line the station is nearest, which puts
 * 自由が丘's on the 大井町 side when it is on the 溝の口 side. Both fields are
 * optional and the derivation is unchanged when they are absent, so a document
 * only has to describe the wiring where the wiring matters.
 */
export interface TrackWiring {
  /**
   * Throats this road is switched into. Two ends = a road through the station;
   * one = a stub (引上線, 頭端式のホーム) reachable only from that end; none = a
   * siding nothing can reach, which is a fact worth being able to state.
   */
  ends: StationEnd[];
  /**
   * 分岐位置 — where the road sits *across* the throat, counted from the 下り
   * side. Defaults to the road's authored order among the station's 番線.
   *
   * It is a lateral coordinate, not an ordinal: two roads may share a position
   * (a 引上線 that is the continuation of the platform road beyond the buffer
   * is at the same place across the throat as that road), and a move fouls
   * every road whose position lies between the two it joins. That is the whole
   * of the 平面交差支障 model — see `src/domain/wiring.ts`.
   */
  ladder?: number;
  /**
   * Directions whose 本線 runs *straight into* this road, so a train taking it
   * diverges nowhere and fouls nothing.
   *
   * Not the same as `directions`, which says who is allowed on the road. 溝の口
   * 2番線 is signalled both ways because trains turn back on it, but only the
   * 大井町線下り本線 continues into it: an up train leaving it has to cross to
   * the up line, over the road 3番線 arrivals use, and that crossing is the
   * reason the terminal cannot turn round more trains than it does.
   *
   * Defaults to the directions this road is the station's default for.
   */
  line?: Direction[];
  /**
   * What each throat switches this road onto — its 接続先.
   *
   * `ends` says the road reaches the throat; this says what it meets there,
   * and the difference is what makes a layout a layout rather than a list.
   * Two roads can work stock between them exactly when they share a lead, and
   * a train can enter off a 本線 exactly when the road is on that line's lead.
   *
   * - 自由が丘's 引上線 reaches the 溝の口 throat on the 下り線 alone
   *   (`{ down: ['down'] }`), so stock standing on the up platform — which at a
   *   相対式 station *is* the 上り線 — cannot reach it without crossing over.
   * - 溝の口 2・3番線 reach their 梶が谷 throat on the 大井町線 lead and nothing
   *   else (`{ down: ['om'] }`): the 大井町線 ends at 溝の口 and the rails beyond
   *   are the 田園都市線's. The two 引上線 are on that lead *and* on both running
   *   lines, so a 回送 off the 鷺沼 line can reach a tail track and only a tail
   *   track — which is exactly the way in.
   *
   * Keyed by throat. An end left out defaults to the running lines of every
   * direction the road serves, which is the plain two-road station.
   */
  connects?: Partial<Record<StationEnd, ThroatLead[]>>;
}

/**
 * What a road is switched onto in a throat.
 *
 * `'down'` and `'up'` are the running lines themselves. Any other string names
 * a lead that is *not* a running line — the rails the 大井町線 faces at 溝の口
 * fan into beyond the platform ends, which reach the two 引上線 and stop there.
 * Naming those is what lets the model say "connected to each other but not to
 * the line", which no per-direction flag can.
 */
export type ThroatLead = string;

/**
 * 渡り線 — pointwork joining two leads out beyond the roads' own turnouts.
 *
 * It belongs to the station rather than to any road because it joins no road:
 * it is out on the open line, past everything else in the throat, and its whole
 * purpose is to let stock change lines where no road can.
 *
 * What is modelled is the connection and the throat it is in. What is not is
 * facing versus trailing — a 片渡り線 read the "wrong" way is worked by
 * reversing over it, and every move that uses one of these reverses anyway.
 * `from`/`to` therefore name the crossover rather than restricting it.
 */
export interface StationCrossover {
  end: StationEnd;
  from: ThroatLead;
  to: ThroatLead;
  name?: string;
}

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
  /** 構内配線. Absent = derived; see `TrackWiring`. */
  wiring?: TrackWiring;
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
  /**
   * Which crew this type of train needs. Absent = `['driver']`, i.e. ワンマン
   * 運転, because that is what the bundled line does and because a driver is
   * the one member no train can run without. Add `'conductor'` to make the
   * type ツーマン — the checks and the auto-composer then want a 車掌行路 for
   * every train of that type as well.
   */
  crewRoles?: CrewRole[];
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

// ---------------------------------------------------------------------------
// 乗務員
// ---------------------------------------------------------------------------

/**
 * 乗務員行路 is a second, independent covering of the same trains.
 *
 * A `Duty` follows the *stock*: its legs are whole trains, because a formation
 * that starts a train finishes it. A `CrewDuty` follows a *person*, and a
 * person is not tied to the vehicle — they get off at a relief point and the
 * set carries on with somebody else, or they stay on board across a turnback
 * the stock makes without them. So the two coverings genuinely differ, and a
 * crew leg has to be able to name part of a train rather than all of it.
 *
 * Everything else is deliberately the same shape as `Duty`: an ordered leg
 * list, day types, and a separate join table saying who works it on a date.
 * The continuity check, the Gantt and the auto-composer are all the same idea
 * applied to a different resource.
 */
export type CrewRole = 'driver' | 'conductor';

export const CREW_ROLES: readonly CrewRole[] = ['driver', 'conductor'];

export const CREW_ROLE_LABEL: Record<CrewRole, string> = {
  driver: '運転士',
  conductor: '車掌',
};

/**
 * `fromIndex`/`toIndex` are indices into `Train.stops`, so a leg can cover
 * part of a train. `fromIndex < toIndex` always; the crew boards at the
 * departure of `fromIndex` and leaves at the arrival of `toIndex`.
 *
 * `deadhead` is 添乗 — riding someone else's train as a passenger to get back
 * to where the next piece of work is, or home to the base. It occupies the
 * person but is not乗務, so the working-time check counts it as 拘束 and not
 * as 実乗務.
 */
export type CrewLeg =
  | { kind: 'train'; trainId: TrainId; fromIndex: number; toIndex: number }
  | { kind: 'deadhead'; trainId: TrainId; fromIndex: number; toIndex: number }
  | { kind: 'break'; stationId: StationId; from: Sec; to: Sec }
  | { kind: 'standby'; stationId: StationId; from: Sec; to: Sec };

export const CREW_LEG_KIND_LABEL: Record<CrewLeg['kind'], string> = {
  train: '乗務',
  deadhead: '添乗',
  break: '休憩',
  standby: '待機',
};

/** 乗務員行路 — a *plan* for one person-day. Not a person. */
export interface CrewDuty {
  id: CrewDutyId;
  /** 行路番号 — '11仕'. */
  code: string;
  role: CrewRole;
  /** Where this duty signs on and off. */
  baseStationId: StationId;
  dayTypeIds: DayTypeId[];
  /** Ordered by time. */
  legs: CrewLeg[];
  color?: string;
}

/** 乗務員 — a person. */
export interface Crew {
  id: CrewId;
  /** 乗務員番号. */
  code: string;
  name: string;
  role: CrewRole;
  /** 所属 — the base whose duties this person can be given. */
  baseStationId: StationId;
  note?: string;
}

/** Who works which 乗務員行路 on which date. */
export interface CrewAssignment {
  id: CrewAssignmentId;
  date: IsoDate;
  crewDutyId: CrewDutyId;
  crewId: CrewId;
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

  // -- 乗務員 --------------------------------------------------------------
  // Working rules are an operator's agreement, not a law of physics, so every
  // one of them is a number here rather than a constant in a rule.
  /** 連続乗務時間の上限 — how long a crew may work without a 休憩. */
  crewMaxContinuousWorkSec: number;
  /** A gap shorter than this is 待機, not 休憩, and does not reset the clock. */
  crewMinBreakSec: number;
  /**
   * Total 休憩 a duty must contain — required only of a duty whose 実乗務時間
   * reaches `crewMaxContinuousWorkSec`, since a shorter duty never needs one.
   */
  crewMinTotalBreakSec: number;
  /** 拘束時間の上限 — sign-on to sign-off. */
  crewMaxSpreadSec: number;
  /** 実乗務時間の上限 — the 乗務 legs only; 添乗 and 待機 do not count. */
  crewMaxWorkSec: number;
  /** Minimum time between leaving one train and boarding the next. */
  crewMinHandoverSec: number;
  /** 出勤点呼 — time before the first leg that the duty already occupies. */
  crewSignOnSec: number;
  /** 退勤点呼 — time after the last leg. */
  crewSignOffSec: number;
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
  crew: Entities<Crew>;
  crewDuties: Entities<CrewDuty>;
  crewAssignments: Entities<CrewAssignment>;
}
