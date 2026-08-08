/**
 * Every mutation to the project document goes through one of these commands.
 * Nothing writes `doc` directly.
 *
 * Commands exist so that undo/redo can be built on Immer patches, so that
 * validation can re-run only the rules whose `RuleScope` was touched, and so
 * that a bulk operation (seed load, auto duty assignment) is a single
 * undoable step rather than hundreds.
 */

import type {
  AssignmentId,
  DayTypeId,
  DepotId,
  DutyId,
  FormationId,
  InspectionRecordId,
  InspectionRuleId,
  LinkId,
  PerfProfileId,
  SeriesId,
  StationId,
  StationTrackId,
  StopPatternId,
  TrainId,
  TrainTypeId,
} from '@/domain/ids';
import type {
  Depot,
  Duty,
  DutyLeg,
  Formation,
  FormationSeries,
  InspectionRecord,
  InspectionRule,
  Line,
  Link,
  PerfProfile,
  ProjectDocument,
  ProjectSettings,
  Station,
  StationTrack,
  StopKind,
  StopPattern,
  Train,
  TrainType,
  ValidationConfig,
} from '@/domain/model';
import type { IsoDate, Meters, Sec } from '@/domain/units';

export type Command =
  // whole-document -------------------------------------------------------
  | { type: 'project/replace'; doc: ProjectDocument; label: string }
  | { type: 'project/setMeta'; patch: Partial<ProjectDocument['meta']> }
  | { type: 'settings/update'; patch: Partial<ProjectSettings> }
  | { type: 'validationConfig/update'; patch: Partial<ValidationConfig> }
  | { type: 'line/update'; patch: Partial<Line> }

  // infrastructure -------------------------------------------------------
  | { type: 'station/add'; station: Station; tracks?: StationTrack[] }
  | { type: 'station/update'; id: StationId; patch: Partial<Station> }
  | { type: 'station/remove'; id: StationId }
  | { type: 'station/reorderByKm' }
  | { type: 'track/add'; track: StationTrack; atIndex?: number }
  | { type: 'track/update'; id: StationTrackId; patch: Partial<StationTrack> }
  | { type: 'track/remove'; id: StationTrackId }
  | { type: 'link/update'; id: LinkId; patch: Partial<Link> }
  | { type: 'link/rebuild' }
  | { type: 'runTime/set'; linkId: LinkId; profileId: PerfProfileId; baseRunSec: number; startPenaltySec: number; stopPenaltySec: number }
  | { type: 'perfProfile/add'; profile: PerfProfile }
  | { type: 'perfProfile/update'; id: PerfProfileId; patch: Partial<PerfProfile> }
  | { type: 'perfProfile/remove'; id: PerfProfileId }
  | { type: 'depot/add'; depot: Depot; station: Station; tracks: StationTrack[] }
  | { type: 'depot/update'; id: DepotId; patch: Partial<Depot> }
  | { type: 'depot/remove'; id: DepotId }

  // service definition ---------------------------------------------------
  | { type: 'trainType/add'; trainType: TrainType }
  | { type: 'trainType/update'; id: TrainTypeId; patch: Partial<TrainType> }
  | { type: 'trainType/remove'; id: TrainTypeId }
  | { type: 'stopPattern/add'; pattern: StopPattern }
  | { type: 'stopPattern/update'; id: StopPatternId; patch: Partial<StopPattern> }
  | { type: 'stopPattern/setEntry'; patternId: StopPatternId; stationId: StationId; kind: StopKind | 'none' }
  | { type: 'stopPattern/remove'; id: StopPatternId }

  // trains ---------------------------------------------------------------
  | { type: 'train/add'; train: Train }
  | { type: 'train/addMany'; trains: Train[] }
  | { type: 'train/update'; id: TrainId; patch: Partial<Omit<Train, 'stops'>> }
  | { type: 'train/setStopTime'; trainId: TrainId; stopIndex: number; field: 'arr' | 'dep'; value: Sec | undefined }
  | { type: 'train/setStopTrack'; trainId: TrainId; stopIndex: number; trackId: StationTrackId | undefined }
  | { type: 'train/setStopKind'; trainId: TrainId; stopIndex: number; kind: StopKind }
  | { type: 'train/setStopFlags'; trainId: TrainId; stopIndex: number; operational?: boolean; note?: string }
  | { type: 'train/setOvertakenBy'; trainId: TrainId; stopIndex: number; trainIds: TrainId[] }
  | { type: 'train/setConnectsTo'; trainId: TrainId; stopIndex: number; trainIds: TrainId[] }
  | { type: 'train/shift'; trainIds: TrainId[]; deltaSec: number }
  | { type: 'train/recomputeTimes'; trainId: TrainId }
  | { type: 'train/remove'; trainIds: TrainId[] }
  | { type: 'train/autoAssignTracks'; trainIds?: TrainId[] }

  // duties ---------------------------------------------------------------
  | { type: 'duty/add'; duty: Duty }
  | { type: 'duty/addMany'; duties: Duty[] }
  | { type: 'duty/update'; id: DutyId; patch: Partial<Omit<Duty, 'legs'>> }
  | { type: 'duty/insertLeg'; dutyId: DutyId; leg: DutyLeg; atIndex?: number }
  | { type: 'duty/removeLeg'; dutyId: DutyId; legIndex: number }
  | { type: 'duty/reorderLegs'; dutyId: DutyId; order: number[] }
  | { type: 'duty/sortLegsByTime'; dutyId: DutyId }
  | { type: 'duty/remove'; dutyIds: DutyId[] }
  | { type: 'duty/autoAssign'; dayTypeId: DayTypeId }

  // rolling stock --------------------------------------------------------
  | { type: 'series/add'; series: FormationSeries }
  | { type: 'series/update'; id: SeriesId; patch: Partial<FormationSeries> }
  | { type: 'series/remove'; id: SeriesId }
  | { type: 'formation/add'; formation: Formation }
  | { type: 'formation/update'; id: FormationId; patch: Partial<Formation> }
  | { type: 'formation/remove'; id: FormationId }
  | { type: 'assignment/set'; id: AssignmentId; date: IsoDate; dutyId: DutyId; formationId: FormationId }
  | { type: 'assignment/clear'; date: IsoDate; dutyId: DutyId }
  | { type: 'assignment/autoFill'; date: IsoDate }

  // inspections ----------------------------------------------------------
  | { type: 'inspectionRule/add'; rule: InspectionRule }
  | { type: 'inspectionRule/update'; id: InspectionRuleId; patch: Partial<InspectionRule> }
  | { type: 'inspectionRule/remove'; id: InspectionRuleId }
  | { type: 'inspectionRecord/add'; record: InspectionRecord }
  | { type: 'inspectionRecord/update'; id: InspectionRecordId; patch: Partial<InspectionRecord> }
  | { type: 'inspectionRecord/remove'; id: InspectionRecordId }

  // calendar -------------------------------------------------------------
  | { type: 'dayType/add'; dayType: { id: DayTypeId; name: string; kind: 'weekday' | 'holiday' | 'special'; color: string } }
  | { type: 'dayType/update'; id: DayTypeId; patch: { name?: string; color?: string } }
  | { type: 'dayType/remove'; id: DayTypeId }
  | { type: 'calendar/set'; date: IsoDate; dayTypeId: DayTypeId };

export type CommandType = Command['type'];

/** Japanese label shown in the undo tooltip and history list. */
export const COMMAND_LABEL: Record<string, string> = {
  'project/replace': 'プロジェクトを読み込み',
  'project/setMeta': 'プロジェクト情報を変更',
  'settings/update': '設定を変更',
  'validationConfig/update': '検証設定を変更',
  'line/update': '路線を変更',
  'station/add': '駅を追加',
  'station/update': '駅を変更',
  'station/remove': '駅を削除',
  'station/reorderByKm': '駅順を並べ替え',
  'track/add': '番線を追加',
  'track/update': '番線を変更',
  'track/remove': '番線を削除',
  'link/update': '駅間を変更',
  'link/rebuild': '駅間を再構築',
  'runTime/set': '所要時間を変更',
  'perfProfile/add': '性能を追加',
  'perfProfile/update': '性能を変更',
  'perfProfile/remove': '性能を削除',
  'depot/add': '車庫を追加',
  'depot/update': '車庫を変更',
  'depot/remove': '車庫を削除',
  'trainType/add': '種別を追加',
  'trainType/update': '種別を変更',
  'trainType/remove': '種別を削除',
  'stopPattern/add': '停車パターンを追加',
  'stopPattern/update': '停車パターンを変更',
  'stopPattern/setEntry': '停車駅を変更',
  'stopPattern/remove': '停車パターンを削除',
  'train/add': '列車を追加',
  'train/addMany': '列車を一括追加',
  'train/update': '列車を変更',
  'train/setStopTime': '時刻を変更',
  'train/setStopTrack': '番線を変更',
  'train/setStopKind': '停車/通過を変更',
  'train/setStopFlags': '停車設定を変更',
  'train/setOvertakenBy': '待避設定を変更',
  'train/setConnectsTo': '接続設定を変更',
  'train/shift': '列車を時刻移動',
  'train/recomputeTimes': '時刻を再計算',
  'train/remove': '列車を削除',
  'train/autoAssignTracks': '番線を自動割付',
  'duty/add': '運用を追加',
  'duty/addMany': '運用を一括追加',
  'duty/update': '運用を変更',
  'duty/insertLeg': '運用に追加',
  'duty/removeLeg': '運用から削除',
  'duty/reorderLegs': '運用を並べ替え',
  'duty/sortLegsByTime': '運用を時刻順に整列',
  'duty/remove': '運用を削除',
  'duty/autoAssign': '運用を自動組成',
  'series/add': '形式を追加',
  'series/update': '形式を変更',
  'series/remove': '形式を削除',
  'formation/add': '編成を追加',
  'formation/update': '編成を変更',
  'formation/remove': '編成を削除',
  'assignment/set': '充当を設定',
  'assignment/clear': '充当を解除',
  'assignment/autoFill': '充当を自動設定',
  'inspectionRule/add': '検査規程を追加',
  'inspectionRule/update': '検査規程を変更',
  'inspectionRule/remove': '検査規程を削除',
  'inspectionRecord/add': '検査履歴を追加',
  'inspectionRecord/update': '検査履歴を変更',
  'inspectionRecord/remove': '検査履歴を削除',
  'dayType/add': '曜日種別を追加',
  'dayType/update': '曜日種別を変更',
  'dayType/remove': '曜日種別を削除',
  'calendar/set': 'カレンダーを設定',
};

/**
 * Which validation scopes a command can invalidate. Used to re-run only the
 * affected rules instead of the whole catalogue.
 */
export function scopesOf(cmd: Command): readonly import('@/validation/types').RuleScope[] {
  switch (cmd.type) {
    case 'project/replace':
      return ['infrastructure', 'types', 'trains', 'tracks', 'duties', 'formations', 'inspections', 'calendar'];
    case 'station/add':
    case 'station/update':
    case 'station/remove':
    case 'station/reorderByKm':
    case 'link/update':
    case 'link/rebuild':
    case 'runTime/set':
    case 'perfProfile/add':
    case 'perfProfile/update':
    case 'perfProfile/remove':
    case 'depot/add':
    case 'depot/update':
    case 'depot/remove':
      return ['infrastructure', 'trains', 'tracks', 'duties'];
    case 'track/add':
    case 'track/update':
    case 'track/remove':
    case 'train/setStopTrack':
    case 'train/autoAssignTracks':
      return ['tracks', 'trains'];
    case 'trainType/add':
    case 'trainType/update':
    case 'trainType/remove':
    case 'stopPattern/add':
    case 'stopPattern/update':
    case 'stopPattern/setEntry':
    case 'stopPattern/remove':
      return ['types', 'trains'];
    case 'duty/add':
    case 'duty/addMany':
    case 'duty/update':
    case 'duty/insertLeg':
    case 'duty/removeLeg':
    case 'duty/reorderLegs':
    case 'duty/sortLegsByTime':
    case 'duty/remove':
    case 'duty/autoAssign':
      return ['duties', 'formations', 'inspections'];
    case 'series/add':
    case 'series/update':
    case 'series/remove':
    case 'formation/add':
    case 'formation/update':
    case 'formation/remove':
    case 'assignment/set':
    case 'assignment/clear':
    case 'assignment/autoFill':
      return ['formations', 'inspections', 'duties'];
    case 'inspectionRule/add':
    case 'inspectionRule/update':
    case 'inspectionRule/remove':
    case 'inspectionRecord/add':
    case 'inspectionRecord/update':
    case 'inspectionRecord/remove':
      return ['inspections'];
    case 'dayType/add':
    case 'dayType/update':
    case 'dayType/remove':
    case 'calendar/set':
      return ['calendar', 'trains', 'duties', 'formations'];
    default:
      return ['trains', 'tracks', 'duties'];
  }
}

/**
 * Commands with the same merge key issued within a short window collapse into
 * one history entry — typing in a text box should not fill the undo stack.
 */
export function mergeKeyOf(cmd: Command): string | undefined {
  switch (cmd.type) {
    case 'train/setStopTime':
      return `${cmd.type}:${cmd.trainId}:${cmd.stopIndex}:${cmd.field}`;
    case 'station/update':
      return `${cmd.type}:${cmd.id}`;
    case 'track/update':
      return `${cmd.type}:${cmd.id}`;
    case 'link/update':
      return `${cmd.type}:${cmd.id}`;
    case 'trainType/update':
      return `${cmd.type}:${cmd.id}`;
    case 'formation/update':
      return `${cmd.type}:${cmd.id}`;
    case 'train/shift':
      return `${cmd.type}:${cmd.trainIds.join(',')}`;
    case 'settings/update':
      return cmd.type;
    default:
      return undefined;
  }
}

export interface EntityRefLike {
  kind: string;
  [k: string]: unknown;
}

/** Distance helper re-exported so command reducers don't reach into domain. */
export type { Meters };
