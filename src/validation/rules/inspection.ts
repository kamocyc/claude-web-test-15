/**
 * 検査 — inspection cycles, projected against the DERIVED odometer.
 */

import type { InspectionRuleId } from '@/domain/ids';
import { INSPECTION_KIND_LABEL } from '@/domain/model';
import { computeInspectionStatus } from '@/engine/inspection';
import { entityList } from '@/domain/units';
import { depotName, dutyName, formationName } from '../helpers';
import { issueId, type Issue, type Rule, type ValidationContext } from '../types';

function statuses(ctx: ValidationContext): ReturnType<typeof computeInspectionStatus> {
  return computeInspectionStatus(ctx.doc, ctx.idx.date);
}

function remainingText(s: {
  daysRemaining?: number;
  kmRemaining?: number;
  dueDate?: string;
  dueAtKm?: number;
}): string {
  const parts: string[] = [];
  if (s.daysRemaining !== undefined) {
    parts.push(`期限 ${s.dueDate ?? '不明'} (残り ${s.daysRemaining}日)`);
  }
  if (s.kmRemaining !== undefined) {
    parts.push(`走行 ${Math.round(s.dueAtKm ?? 0).toLocaleString('ja-JP')}km 到達 (残り ${Math.round(s.kmRemaining).toLocaleString('ja-JP')}km)`);
  }
  return parts.join('、');
}

export const inspectionOverdue: Rule = {
  id: 'inspection.overdue',
  name: '検査期限超過',
  defaultSeverity: 'error',
  scope: ['inspections', 'formations'],
  run(ctx) {
    const out: Issue[] = [];
    for (const s of statuses(ctx)) {
      if (s.state !== 'overdue') continue;
      out.push({
        id: issueId('inspection.overdue', s.formationId, s.ruleId, ctx.idx.date),
        ruleId: 'inspection.overdue',
        severity: 'error',
        title: '検査期限を超過しています',
        detail: `${formationName(ctx.doc, s.formationId)} の ${s.label}: ${ctx.idx.date} 時点で期限超過です。前回 ${s.lastDate ?? '不明'}、${remainingText(s)}。現在走行距離 ${Math.round(s.currentKm).toLocaleString('ja-JP')}km。`,
        refs: [
          {
            kind: 'inspection',
            formationId: s.formationId,
            ruleId: s.ruleId as InspectionRuleId,
          },
          { kind: 'formation', formationId: s.formationId },
        ],
        date: ctx.idx.date,
      });
    }
    return out;
  },
};

export const inspectionDueSoon: Rule = {
  id: 'inspection.dueSoon',
  name: '検査期限が近い',
  defaultSeverity: 'warning',
  scope: ['inspections', 'formations'],
  run(ctx) {
    const out: Issue[] = [];
    for (const s of statuses(ctx)) {
      if (s.state !== 'dueSoon') continue;
      out.push({
        id: issueId('inspection.dueSoon', s.formationId, s.ruleId, ctx.idx.date),
        ruleId: 'inspection.dueSoon',
        severity: 'warning',
        title: '検査期限が近づいています',
        detail: `${formationName(ctx.doc, s.formationId)} の ${s.label}: ${remainingText(s)}。前回 ${s.lastDate ?? '不明'}。`,
        refs: [
          {
            kind: 'inspection',
            formationId: s.formationId,
            ruleId: s.ruleId as InspectionRuleId,
          },
          { kind: 'formation', formationId: s.formationId },
        ],
        date: ctx.idx.date,
      });
    }
    return out;
  },
};

export const inspectionDepotNotCapable: Rule = {
  id: 'inspection.depotNotCapable',
  name: '施行できない車庫',
  defaultSeverity: 'warning',
  scope: ['inspections'],
  run(ctx) {
    const out: Issue[] = [];

    for (const rule of entityList(ctx.doc.inspectionRules)) {
      for (const depotId of rule.depotIds) {
        const depot = ctx.doc.depots.byId[depotId];
        if (!depot || depot.inspectionKinds.includes(rule.kind)) continue;
        out.push({
          id: issueId('inspection.depotNotCapable', rule.id, depotId),
          ruleId: 'inspection.depotNotCapable',
          severity: 'warning',
          title: 'この車庫では施行できない検査です',
          detail: `${rule.name} (${INSPECTION_KIND_LABEL[rule.kind]}) は ${depotName(ctx.doc, depotId)} で施行する設定ですが、この車庫は ${INSPECTION_KIND_LABEL[rule.kind]} に対応していません。`,
          refs: [{ kind: 'depot', depotId }],
        });
      }
    }

    for (const record of entityList(ctx.doc.inspectionRecords)) {
      const depot = ctx.doc.depots.byId[record.depotId];
      if (!depot || depot.inspectionKinds.includes(record.kind)) continue;
      out.push({
        id: issueId('inspection.depotNotCapable', record.id, record.depotId),
        ruleId: 'inspection.depotNotCapable',
        severity: 'warning',
        title: 'この車庫では施行できない検査です',
        detail: `${formationName(ctx.doc, record.formationId)} の ${INSPECTION_KIND_LABEL[record.kind]} (${record.from}〜${record.to}) は ${depotName(ctx.doc, record.depotId)} で施行されていますが、この車庫は対応していません。`,
        refs: [
          { kind: 'depot', depotId: record.depotId },
          { kind: 'formation', formationId: record.formationId },
        ],
        date: record.from,
      });
    }

    for (const duty of entityList(ctx.doc.duties)) {
      duty.legs.forEach((leg, legIndex) => {
        if (leg.kind !== 'inspection') return;
        const depot = ctx.doc.depots.byId[leg.depotId];
        if (!depot || depot.inspectionKinds.includes(leg.inspectionKind)) return;
        out.push({
          id: issueId('inspection.depotNotCapable', duty.id, legIndex),
          ruleId: 'inspection.depotNotCapable',
          severity: 'warning',
          title: 'この車庫では施行できない検査です',
          detail: `${dutyName(ctx.doc, duty.id)} 行路${legIndex} は ${depotName(ctx.doc, leg.depotId)} で ${INSPECTION_KIND_LABEL[leg.inspectionKind]} を行いますが、この車庫は対応していません。`,
          refs: [
            { kind: 'duty', dutyId: duty.id, legIndex },
            { kind: 'depot', depotId: leg.depotId },
          ],
        });
      });
    }

    return out;
  },
};

export const inspectionConflictsWithDuty: Rule = {
  id: 'inspection.conflictsWithDuty',
  name: '検査と運用の重複',
  defaultSeverity: 'error',
  scope: ['inspections', 'formations'],
  run(ctx) {
    const out: Issue[] = [];
    for (const record of entityList(ctx.doc.inspectionRecords)) {
      for (const assignment of entityList(ctx.doc.assignments)) {
        if (assignment.formationId !== record.formationId) continue;
        if (assignment.date < record.from || assignment.date > record.to) continue;
        out.push({
          id: issueId('inspection.conflictsWithDuty', record.id, assignment.id),
          ruleId: 'inspection.conflictsWithDuty',
          severity: 'error',
          title: '検査期間中に運用が組まれています',
          detail: `${formationName(ctx.doc, record.formationId)} は ${record.from}〜${record.to} に ${INSPECTION_KIND_LABEL[record.kind]} で入場中ですが、${assignment.date} に ${dutyName(ctx.doc, assignment.dutyId)} が充当されています。`,
          refs: [
            { kind: 'formation', formationId: record.formationId },
            { kind: 'duty', dutyId: assignment.dutyId },
            { kind: 'depot', depotId: record.depotId },
          ],
          date: assignment.date,
        });
      }
    }
    return out;
  },
};
