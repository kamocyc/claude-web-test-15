/**
 * The odometer is DERIVED: `Formation.odometerKm` is a baseline as of
 * `odometerAsOf`, and current km adds the distance of every duty the
 * formation has been assigned since. The simulation must never write it — if
 * playing the clock mutated the document, save/reload would not round-trip
 * and undo would become unsound.
 */

import type { FormationId, SeriesId } from '@/domain/ids';
import type { InspectionRecord, InspectionRule, ProjectDocument } from '@/domain/model';
import { dutyDistance } from '@/domain/project';
import { addDays, daysBetween } from '@/domain/time';
import { entityList, metersToKm, type IsoDate } from '@/domain/units';
import type { InspectionState, InspectionStatus } from './types';

export function currentOdometerKm(
  doc: ProjectDocument,
  formationId: FormationId,
  asOf: IsoDate,
): number {
  const formation = doc.formations.byId[formationId];
  if (!formation) return 0;
  let km = formation.odometerKm;
  for (const assignment of entityList(doc.assignments)) {
    if (assignment.formationId !== formationId) continue;
    if (!(assignment.date > formation.odometerAsOf && assignment.date <= asOf)) continue;
    const duty = doc.duties.byId[assignment.dutyId];
    if (!duty) continue;
    km += metersToKm(dutyDistance(doc, duty));
  }
  return km;
}

function ruleApplies(rule: InspectionRule, seriesId: SeriesId): boolean {
  return rule.appliesTo === 'all' || rule.appliesTo.seriesIds.includes(seriesId);
}

/** The most recent completed record for this formation/rule at or before `asOf`. */
function latestCompleted(
  doc: ProjectDocument,
  formationId: FormationId,
  ruleId: string,
  asOf: IsoDate,
): InspectionRecord | undefined {
  let best: InspectionRecord | undefined;
  for (const record of entityList(doc.inspectionRecords)) {
    if (record.formationId !== formationId) continue;
    if (record.ruleId !== ruleId) continue;
    if (record.status !== 'completed') continue;
    if (record.to > asOf) continue;
    if (best === undefined || record.to > best.to) best = record;
  }
  return best;
}

export function computeInspectionStatus(
  doc: ProjectDocument,
  asOf?: IsoDate,
): InspectionStatus[] {
  const date = asOf ?? doc.settings.activeDate;
  const ratio = doc.validationConfig.inspectionWarnRatio;
  const rules = entityList(doc.inspectionRules).sort(
    (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
  );
  const out: InspectionStatus[] = [];

  for (const formation of entityList(doc.formations)) {
    if (formation.status === 'retired') continue;
    const currentKm = currentOdometerKm(doc, formation.id, date);

    for (const rule of rules) {
      if (!ruleApplies(rule, formation.seriesId)) continue;
      const record = latestCompleted(doc, formation.id, rule.id, date);

      const status: InspectionStatus = {
        formationId: formation.id,
        ruleId: rule.id,
        kind: rule.kind,
        label: rule.name,
        state: 'unknown',
        currentKm,
      };

      if (record === undefined) {
        out.push(status);
        continue;
      }

      status.lastDate = record.to;
      if (record.odometerKmAt !== undefined) status.lastOdometerKm = record.odometerKmAt;

      let daysRemaining: number | undefined;
      if (rule.intervalDays !== undefined) {
        const dueDate = addDays(record.to, rule.intervalDays);
        status.dueDate = dueDate;
        daysRemaining = daysBetween(date, dueDate);
        status.daysRemaining = daysRemaining;
      }

      let kmRemaining: number | undefined;
      if (rule.intervalKm !== undefined && record.odometerKmAt !== undefined) {
        const dueAtKm = record.odometerKmAt + rule.intervalKm;
        status.dueAtKm = dueAtKm;
        kmRemaining = dueAtKm - currentKm;
        status.kmRemaining = kmRemaining;
      }

      // `interval - interval * ratio` rather than `interval * (1 - ratio)`:
      // the latter loses the exact integer for the common 0.9 case.
      const warnDays =
        rule.warnBeforeDays ??
        (rule.intervalDays !== undefined
          ? rule.intervalDays - rule.intervalDays * ratio
          : undefined);
      const warnKm =
        rule.warnBeforeKm ??
        (rule.intervalKm !== undefined ? rule.intervalKm - rule.intervalKm * ratio : undefined);

      let state: InspectionState = 'ok';
      if ((daysRemaining !== undefined && daysRemaining < 0) || (kmRemaining !== undefined && kmRemaining < 0)) {
        state = 'overdue';
      } else if (
        (daysRemaining !== undefined && warnDays !== undefined && daysRemaining <= warnDays) ||
        (kmRemaining !== undefined && warnKm !== undefined && kmRemaining <= warnKm)
      ) {
        state = 'dueSoon';
      } else if (daysRemaining === undefined && kmRemaining === undefined) {
        // A rule with neither interval can never come due.
        state = 'ok';
      }
      status.state = state;
      out.push(status);
    }
  }

  return out;
}
