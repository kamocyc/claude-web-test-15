/**
 * 編成 — one physical trainset cannot be in two places, and the fleet has to
 * be big enough for the peak of the roster.
 */

import type { FormationId } from '@/domain/ids';
import { dutiesForDayType, dutySpan } from '@/domain/project';
import { entityList } from '@/domain/units';
import { dayTypeIdFor } from '@/engine/buildIndex';
import { dutyName, formationName, hhmmss, peakConcurrency, type Span } from '../helpers';
import { issueId, type Issue, type Rule } from '../types';

export const formationDoubleBooked: Rule = {
  id: 'formation.doubleBooked',
  name: '編成の二重充当',
  defaultSeverity: 'error',
  scope: ['formations', 'duties'],
  run(ctx) {
    const byKey = new Map<string, Array<{ dutyId: string; formationId: FormationId; date: string }>>();
    for (const assignment of entityList(ctx.doc.assignments)) {
      const key = `${assignment.date}|${assignment.formationId}`;
      const list = byKey.get(key) ?? [];
      list.push({
        dutyId: assignment.dutyId,
        formationId: assignment.formationId,
        date: assignment.date,
      });
      byKey.set(key, list);
    }

    const out: Issue[] = [];
    for (const list of byKey.values()) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i]!;
          const b = list[j]!;
          const dutyA = ctx.doc.duties.byId[a.dutyId];
          const dutyB = ctx.doc.duties.byId[b.dutyId];
          if (!dutyA || !dutyB) continue;
          const spanA = dutySpan(ctx.doc, dutyA);
          const spanB = dutySpan(ctx.doc, dutyB);
          if (!spanA || !spanB) continue;
          if (!(spanA.from < spanB.to && spanB.from < spanA.to)) continue;
          out.push({
            id: issueId('formation.doubleBooked', a.date, a.formationId, dutyA.id, dutyB.id),
            ruleId: 'formation.doubleBooked',
            severity: 'error',
            title: '編成が二重に充当されています',
            detail: `${a.date}: ${formationName(ctx.doc, a.formationId)} が ${dutyName(ctx.doc, dutyA.id)} (${hhmmss(spanA.from)}–${hhmmss(spanA.to)}) と ${dutyName(ctx.doc, dutyB.id)} (${hhmmss(spanB.from)}–${hhmmss(spanB.to)}) に同時に充当されています。`,
            refs: [
              { kind: 'formation', formationId: a.formationId },
              { kind: 'duty', dutyId: dutyA.id },
              { kind: 'duty', dutyId: dutyB.id },
            ],
            at: Math.max(spanA.from, spanB.from),
            date: a.date,
          });
        }
      }
    }
    return out;
  },
};

export const formationInsufficientFleet: Rule = {
  id: 'formation.insufficientFleet',
  name: '在籍編成数が足りない',
  defaultSeverity: 'warning',
  scope: ['formations', 'duties'],
  run(ctx) {
    const dayTypeId = dayTypeIdFor(ctx.doc, ctx.idx.date);
    const duties = dutiesForDayType(ctx.doc, dayTypeId);

    // Group by required car count — a 6-car duty cannot be worked by a 4-car
    // set, but a longer set is acceptable.
    const byCars = new Map<number, Span[]>();
    for (const duty of duties) {
      const span = dutySpan(ctx.doc, duty);
      if (!span) continue;
      let cars = duty.requiredCars ?? 0;
      for (const leg of duty.legs) {
        if (leg.kind !== 'train') continue;
        const min = ctx.doc.trains.byId[leg.trainId]?.minCars;
        if (min !== undefined && min > cars) cars = min;
      }
      const list = byCars.get(cars) ?? [];
      list.push({ from: span.from, to: span.to, id: duty.id });
      byCars.set(cars, list);
    }

    const out: Issue[] = [];
    for (const [cars, spans] of byCars) {
      const available = entityList(ctx.doc.formations).filter(
        (f) => f.status === 'active' && f.cars >= cars,
      ).length;
      const { peak, at, ids } = peakConcurrency(spans);
      if (peak <= available) continue;
      out.push({
        id: issueId('formation.insufficientFleet', cars),
        ruleId: 'formation.insufficientFleet',
        severity: 'warning',
        title: '在籍編成数が運用数に足りません',
        detail: `${cars > 0 ? `${cars}両以上の運用` : '両数指定のない運用'}: ${hhmmss(at)} に ${peak}運用 が同時に動きますが、充当可能な稼働編成は ${available}本 しかありません (${ids
          .map((id) => dutyName(ctx.doc, ctx.doc.duties.byId[id]?.id))
          .join('・')})。`,
        refs: ids.flatMap((id) => {
          const duty = ctx.doc.duties.byId[id];
          return duty ? [{ kind: 'duty' as const, dutyId: duty.id }] : [];
        }),
        at,
        date: ctx.idx.date,
      });
    }
    return out;
  },
};
