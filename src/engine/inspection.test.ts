import { describe, expect, it } from 'vitest';

import { asId } from '@/domain/ids';
import type { InspectionRecord } from '@/domain/model';
import { entitiesFrom, entityList } from '@/domain/units';
import { TOY, toyProject, toyProjectCopy } from '@/testing/toyProject';
import { computeInspectionStatus, currentOdometerKm } from './inspection';

/** Duty 01 covers 出庫 0.5 km + 各停 3 km + 入庫 3.5 km. */
const DUTY_LOCAL_KM = 7;

function statusOf(
  doc: ReturnType<typeof toyProject>,
  formationId: string,
  ruleId: string,
  asOf?: string,
): ReturnType<typeof computeInspectionStatus>[number] {
  const found = computeInspectionStatus(doc, asOf).find(
    (s) => s.formationId === formationId && s.ruleId === ruleId,
  );
  if (!found) throw new Error(`no status for ${formationId}/${ruleId}`);
  return found;
}

describe('currentOdometerKm', () => {
  it('returns the stored baseline on the baseline date', () => {
    const doc = toyProject();
    expect(currentOdometerKm(doc, TOY.formation1, '2026-04-06')).toBe(100_000);
  });

  it('adds the km of every duty assigned after the baseline date', () => {
    const doc = toyProjectCopy();
    doc.assignments = entitiesFrom([
      ...entityList(doc.assignments),
      {
        id: asId<'Assignment'>('asg-3'),
        date: '2026-04-07',
        dutyId: TOY.dutyLocal,
        formationId: TOY.formation1,
      },
      {
        id: asId<'Assignment'>('asg-4'),
        date: '2026-04-08',
        dutyId: TOY.dutyLocal,
        formationId: TOY.formation1,
      },
    ]);
    expect(currentOdometerKm(doc, TOY.formation1, '2026-04-06')).toBe(100_000);
    expect(currentOdometerKm(doc, TOY.formation1, '2026-04-07')).toBe(100_000 + DUTY_LOCAL_KM);
    expect(currentOdometerKm(doc, TOY.formation1, '2026-04-09')).toBe(100_000 + 2 * DUTY_LOCAL_KM);
  });

  it('never mutates the document', () => {
    const doc = toyProjectCopy();
    const before = structuredClone(doc);
    currentOdometerKm(doc, TOY.formation1, '2026-12-31');
    computeInspectionStatus(doc, '2026-12-31');
    expect(doc).toEqual(before);
  });
});

describe('computeInspectionStatus', () => {
  it('projects the due date in days', () => {
    const s = statusOf(toyProject(), TOY.formation1, TOY.ruleTrain);
    expect(s.lastDate).toBe('2026-04-02');
    expect(s.dueDate).toBe('2026-04-12'); // +10 days
    expect(s.daysRemaining).toBe(6);
    expect(s.state).toBe('ok');
  });

  it('warns inside warnBeforeDays and errors past the due date', () => {
    const doc = toyProjectCopy();
    expect(statusOf(doc, TOY.formation1, TOY.ruleTrain, '2026-04-10').state).toBe('dueSoon');
    expect(statusOf(doc, TOY.formation1, TOY.ruleTrain, '2026-04-12').state).toBe('dueSoon');
    expect(statusOf(doc, TOY.formation1, TOY.ruleTrain, '2026-04-13').state).toBe('overdue');
    expect(statusOf(doc, TOY.formation1, TOY.ruleTrain, '2026-04-13').daysRemaining).toBe(-1);
  });

  it('projects the due odometer in km', () => {
    const doc = toyProjectCopy();
    const record: InspectionRecord = {
      id: asId<'InspectionRecord'>('irc-3'),
      formationId: TOY.formation1,
      ruleId: TOY.ruleMonthly,
      kind: 'monthly',
      status: 'completed',
      from: '2026-04-01',
      to: '2026-04-01',
      odometerKmAt: 95_000,
      depotId: TOY.depot,
    };
    doc.inspectionRecords = entitiesFrom([...entityList(doc.inspectionRecords), record]);
    const s = statusOf(doc, TOY.formation1, TOY.ruleMonthly);
    expect(s.lastOdometerKm).toBe(95_000);
    expect(s.dueAtKm).toBe(125_000); // +30,000 km
    expect(s.currentKm).toBe(100_000);
    expect(s.kmRemaining).toBe(25_000);
    expect(s.dueDate).toBe('2026-06-30'); // +90 days
    expect(s.state).toBe('ok');
  });

  it('goes overdue on km even when the date is fine', () => {
    const doc = toyProjectCopy();
    doc.inspectionRecords = entitiesFrom([
      ...entityList(doc.inspectionRecords),
      {
        id: asId<'InspectionRecord'>('irc-3'),
        formationId: TOY.formation1,
        ruleId: TOY.ruleMonthly,
        kind: 'monthly' as const,
        status: 'completed' as const,
        from: '2026-04-01',
        to: '2026-04-01',
        odometerKmAt: 60_000,
        depotId: TOY.depot,
      },
    ]);
    const s = statusOf(doc, TOY.formation1, TOY.ruleMonthly);
    expect(s.kmRemaining).toBe(-10_000);
    expect(s.daysRemaining).toBeGreaterThan(0);
    expect(s.state).toBe('overdue');
  });

  it('warns inside warnBeforeKm', () => {
    const doc = toyProjectCopy();
    doc.inspectionRecords = entitiesFrom([
      ...entityList(doc.inspectionRecords),
      {
        id: asId<'InspectionRecord'>('irc-3'),
        formationId: TOY.formation1,
        ruleId: TOY.ruleMonthly,
        kind: 'monthly' as const,
        status: 'completed' as const,
        from: '2026-04-01',
        to: '2026-04-01',
        odometerKmAt: 71_000, // due at 101,000 — 1,000 km away
        depotId: TOY.depot,
      },
    ]);
    expect(statusOf(doc, TOY.formation1, TOY.ruleMonthly).state).toBe('dueSoon');
  });

  it('falls back to inspectionWarnRatio when no explicit warning margin is set', () => {
    const doc = toyProjectCopy();
    const rule = doc.inspectionRules.byId[TOY.ruleTrain]!;
    delete rule.warnBeforeDays;
    // 10-day interval, ratio 0.9 -> warn with 1 day or less remaining.
    expect(statusOf(doc, TOY.formation1, TOY.ruleTrain, '2026-04-10').state).toBe('ok');
    expect(statusOf(doc, TOY.formation1, TOY.ruleTrain, '2026-04-11').state).toBe('dueSoon');
  });

  it('is unknown when the formation has never had the inspection', () => {
    expect(statusOf(toyProject(), TOY.formation1, TOY.ruleMonthly).state).toBe('unknown');
    expect(statusOf(toyProject(), TOY.formation1, TOY.ruleMonthly).dueDate).toBeUndefined();
  });

  it('ignores records dated after the evaluation date', () => {
    const doc = toyProjectCopy();
    doc.inspectionRecords.byId['irc-1']!.to = '2026-05-01';
    doc.inspectionRecords.byId['irc-1']!.from = '2026-05-01';
    expect(statusOf(doc, TOY.formation1, TOY.ruleTrain).state).toBe('unknown');
  });

  it('skips retired formations', () => {
    const doc = toyProjectCopy();
    doc.formations.byId[TOY.formation2]!.status = 'retired';
    const ids = computeInspectionStatus(doc).map((s) => s.formationId);
    expect(ids).not.toContain(TOY.formation2);
  });
});
