/**
 * Validation contract.
 *
 * Every issue carries `refs` so the problem panel can jump straight to the
 * offending entity, plus optional `at` / `km` so the clock and both canvas
 * cameras can focus on it. `refs[0]` is the primary target.
 */

import type {
  CrewDutyId,
  CrewId,
  DepotId,
  DutyId,
  FormationId,
  InspectionRuleId,
  LinkId,
  StationId,
  StationTrackId,
  TrainId,
} from '@/domain/ids';
import type { ProjectDocument } from '@/domain/model';
import type { IsoDate, Meters, Sec } from '@/domain/units';
import type { TimetableIndex } from '@/engine/types';

export type Severity = 'error' | 'warning' | 'info';

export type EntityRef =
  | { kind: 'train'; trainId: TrainId; stopIndex?: number }
  | { kind: 'station'; stationId: StationId }
  | { kind: 'stationTrack'; stationTrackId: StationTrackId }
  | { kind: 'link'; linkId: LinkId }
  | { kind: 'duty'; dutyId: DutyId; legIndex?: number }
  | { kind: 'formation'; formationId: FormationId }
  | { kind: 'depot'; depotId: DepotId }
  | { kind: 'inspection'; formationId: FormationId; ruleId: InspectionRuleId }
  | { kind: 'crewDuty'; crewDutyId: CrewDutyId; legIndex?: number }
  | { kind: 'crew'; crewId: CrewId };

export interface Issue {
  /**
   * Stable across re-runs — a hash of ruleId plus the primary refs plus the
   * discriminating fields. Lets the panel keep list position, and lets a user
   * mute a specific issue.
   */
  id: string;
  ruleId: RuleId;
  severity: Severity;
  /** Short Japanese title: '番線が二重使用されています'. */
  title: string;
  /** Specifics, with names and numbers. */
  detail: string;
  refs: EntityRef[];
  /** Time focus — seeks the clock and the diagram cursor. */
  at?: Sec;
  /** Space focus — pans the line view and the diagram's other axis. */
  km?: Meters;
  date?: IsoDate;
}

export interface ValidationResult {
  issues: Issue[];
  byRule: Record<string, number>;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  durationMs: number;
  /** Set when the issue cap was hit. */
  truncated: boolean;
}

export const MAX_ISSUES = 2000;

export type RuleScope =
  | 'infrastructure'
  | 'types'
  | 'trains'
  | 'tracks'
  | 'duties'
  | 'formations'
  | 'inspections'
  | 'calendar'
  | 'crew';

export interface ValidationContext {
  doc: ProjectDocument;
  idx: TimetableIndex;
  cfg: ProjectDocument['validationConfig'];
}

export interface Rule {
  id: RuleId;
  name: string;
  defaultSeverity: Severity;
  scope: RuleScope[];
  run(ctx: ValidationContext): Issue[];
}

/**
 * The full rule catalogue. Keeping this a closed union means a typo in a rule
 * id is a compile error, and the problem panel can render a complete filter
 * list without runtime discovery.
 */
export type RuleId =
  // referential
  | 'ref.dangling'
  // times within one train
  | 'time.nonMonotonic'
  | 'time.runTooFast'
  | 'time.runSlow'
  | 'time.dwellTooShort'
  | 'time.offGrain'
  | 'time.outsideServiceDay'
  // between trains on the open line
  | 'headway.section'
  | 'headway.overtakeMidSection'
  | 'headway.singleTrackOpposing'
  // station tracks / 構内ダイヤ
  | 'track.doubleOccupancy'
  | 'track.unassigned'
  | 'track.directionNotAllowed'
  | 'track.noPlatform'
  | 'track.lengthExceeded'
  | 'track.crossingConflict'
  | 'track.routeMissing'
  // turnbacks
  | 'turnback.insufficient'
  | 'turnback.tight'
  | 'turnback.trackNotCapable'
  | 'turnback.trackChanged'
  // duties
  | 'duty.continuityBreak'
  | 'duty.emptyOrUnassigned'
  | 'duty.notStartingFromDepot'
  | 'duty.carCountMismatch'
  | 'train.notCovered'
  | 'train.duplicateNumber'
  // 緩急接続 / 待避
  | 'overtake.noPassingTrack'
  | 'overtake.undeclared'
  | 'overtake.declaredButAbsent'
  | 'connection.declaredFails'
  | 'connection.qualityGap'
  | 'connection.discovered'
  // depots
  | 'depot.capacityExceeded'
  | 'depot.accessTimeViolated'
  // formations
  | 'formation.doubleBooked'
  | 'formation.insufficientFleet'
  // inspections
  | 'inspection.overdue'
  | 'inspection.dueSoon'
  | 'inspection.depotNotCapable'
  | 'inspection.conflictsWithDuty'
  // 乗務員
  | 'crew.continuityBreak'
  | 'crew.reliefPointInvalid'
  | 'crew.handoverTight'
  | 'crew.continuousWorkExceeded'
  | 'crew.breakInsufficient'
  | 'crew.workTimeExceeded'
  | 'crew.doubleBooked'
  | 'crew.roleMismatch'
  | 'crew.trainNotCovered'
  | 'crew.notAtBase';

export const RULE_GROUP_LABEL: Record<string, string> = {
  ref: '参照整合性',
  time: '時刻',
  headway: '時隔',
  track: '番線・構内',
  turnback: '折り返し',
  duty: '運用',
  train: '列車',
  overtake: '待避・追い抜き',
  connection: '緩急接続',
  depot: '車庫',
  formation: '編成',
  inspection: '検査',
  crew: '乗務員',
};

export interface RunValidationOptions {
  ruleIds?: RuleId[];
  date?: IsoDate;
  /** Pass a prebuilt index to avoid rebuilding it. */
  index?: TimetableIndex;
}

/** Deterministic issue id — same inputs always produce the same string. */
export function issueId(ruleId: RuleId, ...parts: Array<string | number | undefined>): string {
  return `${ruleId}#${parts.filter((p) => p !== undefined).join('|')}`;
}
