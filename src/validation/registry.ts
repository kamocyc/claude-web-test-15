/**
 * The rule catalogue.
 *
 * `RULES` is typed `Record<RuleId, Rule>` on purpose: the RuleId union is
 * closed, so forgetting to register a rule — or registering one under a typo'd
 * id — is a compile error rather than a silently missing check.
 */

import {
  connectionDeclaredFails,
  connectionDiscovered,
  connectionQualityGap,
} from './rules/connection';
import { depotAccessTimeViolated, depotCapacityExceeded } from './rules/depot';
import {
  dutyCarCountMismatch,
  dutyContinuityBreak,
  dutyEmptyOrUnassigned,
  dutyNotStartingFromDepot,
  trainDuplicateNumber,
  trainNotCovered,
} from './rules/duty';
import { formationDoubleBooked, formationInsufficientFleet } from './rules/formation';
import { headwayOvertakeMidSection, headwaySection } from './rules/headway';
import {
  inspectionConflictsWithDuty,
  inspectionDepotNotCapable,
  inspectionDueSoon,
  inspectionOverdue,
} from './rules/inspection';
import {
  overtakeDeclaredButAbsent,
  overtakeNoPassingTrack,
  overtakeUndeclared,
} from './rules/overtake';
import { refDangling } from './rules/ref';
import {
  timeDwellTooShort,
  timeNonMonotonic,
  timeOffGrain,
  timeOutsideServiceDay,
  timeRunSlow,
  timeRunTooFast,
} from './rules/time';
import {
  trackDirectionNotAllowed,
  trackDoubleOccupancy,
  trackLengthExceeded,
  trackNoPlatform,
  trackUnassigned,
} from './rules/track';
import {
  turnbackInsufficient,
  turnbackTight,
  turnbackTrackChanged,
  turnbackTrackNotCapable,
} from './rules/turnback';
import type { Rule, RuleId } from './types';

export const RULES: Record<RuleId, Rule> = {
  'ref.dangling': refDangling,

  'time.nonMonotonic': timeNonMonotonic,
  'time.runTooFast': timeRunTooFast,
  'time.runSlow': timeRunSlow,
  'time.dwellTooShort': timeDwellTooShort,
  'time.offGrain': timeOffGrain,
  'time.outsideServiceDay': timeOutsideServiceDay,

  'headway.section': headwaySection,
  'headway.overtakeMidSection': headwayOvertakeMidSection,

  'track.doubleOccupancy': trackDoubleOccupancy,
  'track.unassigned': trackUnassigned,
  'track.directionNotAllowed': trackDirectionNotAllowed,
  'track.noPlatform': trackNoPlatform,
  'track.lengthExceeded': trackLengthExceeded,

  'turnback.insufficient': turnbackInsufficient,
  'turnback.tight': turnbackTight,
  'turnback.trackNotCapable': turnbackTrackNotCapable,
  'turnback.trackChanged': turnbackTrackChanged,

  'duty.continuityBreak': dutyContinuityBreak,
  'duty.emptyOrUnassigned': dutyEmptyOrUnassigned,
  'duty.notStartingFromDepot': dutyNotStartingFromDepot,
  'duty.carCountMismatch': dutyCarCountMismatch,
  'train.notCovered': trainNotCovered,
  'train.duplicateNumber': trainDuplicateNumber,

  'overtake.noPassingTrack': overtakeNoPassingTrack,
  'overtake.undeclared': overtakeUndeclared,
  'overtake.declaredButAbsent': overtakeDeclaredButAbsent,
  'connection.declaredFails': connectionDeclaredFails,
  'connection.qualityGap': connectionQualityGap,
  'connection.discovered': connectionDiscovered,

  'depot.capacityExceeded': depotCapacityExceeded,
  'depot.accessTimeViolated': depotAccessTimeViolated,

  'formation.doubleBooked': formationDoubleBooked,
  'formation.insufficientFleet': formationInsufficientFleet,

  'inspection.overdue': inspectionOverdue,
  'inspection.dueSoon': inspectionDueSoon,
  'inspection.depotNotCapable': inspectionDepotNotCapable,
  'inspection.conflictsWithDuty': inspectionConflictsWithDuty,
};

/** Catalogue order — the order the problem panel lists rules in. */
export const ALL_RULES: Rule[] = Object.values(RULES);

export function ruleById(id: RuleId): Rule {
  return RULES[id];
}
