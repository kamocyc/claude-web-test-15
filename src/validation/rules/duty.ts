/**
 * 運用 — whether a vehicle-day plan is physically walkable, and whether every
 * train in the timetable has a vehicle to work it.
 */

import type { FormationId } from '@/domain/ids';
import {
  dutiesForDayType,
  dutyLegEndpoints,
  dutyLegSpan,
  isDepotStation,
  trainsForDayType,
} from '@/domain/project';
import { entityList } from '@/domain/units';
import { dayTypeIdFor } from '@/engine/buildIndex';
import { atProps, dutyName, formationName, hhmmss, stationName, trainName } from '../helpers';
import { issueId, type Issue, type Rule } from '../types';

export const dutyContinuityBreak: Rule = {
  id: 'duty.continuityBreak',
  name: '運用がつながっていない',
  defaultSeverity: 'error',
  scope: ['duties'],
  run(ctx) {
    const dayTypeId = dayTypeIdFor(ctx.doc, ctx.idx.date);
    const out: Issue[] = [];
    for (const duty of dutiesForDayType(ctx.doc, dayTypeId)) {
      for (let i = 1; i < duty.legs.length; i++) {
        const prev = duty.legs[i - 1]!;
        const cur = duty.legs[i]!;
        const prevEnds = dutyLegEndpoints(ctx.doc, prev);
        const curStarts = dutyLegEndpoints(ctx.doc, cur);
        const prevSpan = dutyLegSpan(ctx.doc, prev);
        const curSpan = dutyLegSpan(ctx.doc, cur);

        if (prevEnds && curStarts && prevEnds.toStationId !== curStarts.fromStationId) {
          out.push({
            id: issueId('duty.continuityBreak', duty.id, i, 'place'),
            ruleId: 'duty.continuityBreak',
            severity: 'error',
            title: '運用の場所がつながっていません',
            detail: `${dutyName(ctx.doc, duty.id)} 行路${i}: 前の行路は ${stationName(ctx.doc, prevEnds.toStationId)} で終わりますが、次の行路は ${stationName(ctx.doc, curStarts.fromStationId)} から始まります。`,
            refs: [
              { kind: 'duty', dutyId: duty.id, legIndex: i },
              { kind: 'station', stationId: curStarts.fromStationId },
            ],
            ...atProps(curSpan?.from),
          });
        }
        if (prevSpan && curSpan && curSpan.from < prevSpan.to) {
          out.push({
            id: issueId('duty.continuityBreak', duty.id, i, 'time'),
            ruleId: 'duty.continuityBreak',
            severity: 'error',
            title: '運用の時刻が重複しています',
            detail: `${dutyName(ctx.doc, duty.id)} 行路${i}: 前の行路が ${hhmmss(prevSpan.to)} に終わる前の ${hhmmss(curSpan.from)} に次の行路が始まります。`,
            refs: [{ kind: 'duty', dutyId: duty.id, legIndex: i }],
            at: curSpan.from,
          });
        }
      }
    }
    return out;
  },
};

export const dutyEmptyOrUnassigned: Rule = {
  id: 'duty.emptyOrUnassigned',
  name: '運用が空・未充当',
  defaultSeverity: 'warning',
  scope: ['duties', 'formations'],
  run(ctx) {
    const dayTypeId = dayTypeIdFor(ctx.doc, ctx.idx.date);
    const assignedDuties = new Set<string>();
    for (const assignment of entityList(ctx.doc.assignments)) {
      if (assignment.date === ctx.idx.date) assignedDuties.add(assignment.dutyId);
    }
    const out: Issue[] = [];
    for (const duty of dutiesForDayType(ctx.doc, dayTypeId)) {
      if (duty.legs.length === 0) {
        out.push({
          id: issueId('duty.emptyOrUnassigned', duty.id, 'empty'),
          ruleId: 'duty.emptyOrUnassigned',
          severity: 'warning',
          title: '運用に行路がありません',
          detail: `${dutyName(ctx.doc, duty.id)} には行路が1つも登録されていません。`,
          refs: [{ kind: 'duty', dutyId: duty.id }],
        });
        continue;
      }
      if (!assignedDuties.has(duty.id)) {
        out.push({
          id: issueId('duty.emptyOrUnassigned', duty.id, 'unassigned'),
          ruleId: 'duty.emptyOrUnassigned',
          severity: 'warning',
          title: '運用に編成が充当されていません',
          detail: `${dutyName(ctx.doc, duty.id)} は ${ctx.idx.date} に編成が充当されていません。`,
          refs: [{ kind: 'duty', dutyId: duty.id }],
          date: ctx.idx.date,
        });
      }
    }
    return out;
  },
};

export const dutyNotStartingFromDepot: Rule = {
  id: 'duty.notStartingFromDepot',
  name: '出庫・入庫が揃っていない',
  defaultSeverity: 'warning',
  scope: ['duties'],
  run(ctx) {
    const dayTypeId = dayTypeIdFor(ctx.doc, ctx.idx.date);
    const out: Issue[] = [];
    for (const duty of dutiesForDayType(ctx.doc, dayTypeId)) {
      const first = duty.legs[0];
      const last = duty.legs[duty.legs.length - 1];
      if (!first || !last) continue;
      const start = dutyLegEndpoints(ctx.doc, first);
      const end = dutyLegEndpoints(ctx.doc, last);
      if (!start || !end) continue;
      const startsAtDepot = isDepotStation(ctx.doc, start.fromStationId);
      const endsAtDepot = isDepotStation(ctx.doc, end.toStationId);
      // A duty that never touches a depot is a fragment (a 間合い運用 or a
      // partially authored plan) — flagging it would fire on every duty in a
      // half-built timetable. What is worth reporting is a duty that leaves
      // the depot and never returns, or returns without ever leaving.
      if (startsAtDepot === endsAtDepot) continue;
      out.push({
        id: issueId('duty.notStartingFromDepot', duty.id, startsAtDepot ? 'noIn' : 'noOut'),
        ruleId: 'duty.notStartingFromDepot',
        severity: 'warning',
        title: startsAtDepot ? '入庫がありません' : '出庫がありません',
        detail: startsAtDepot
          ? `${dutyName(ctx.doc, duty.id)} は ${stationName(ctx.doc, start.fromStationId)} を出庫しますが、${stationName(ctx.doc, end.toStationId)} で終わり入庫していません。`
          : `${dutyName(ctx.doc, duty.id)} は ${stationName(ctx.doc, end.toStationId)} に入庫しますが、${stationName(ctx.doc, start.fromStationId)} 始まりで出庫がありません。`,
        refs: [
          { kind: 'duty', dutyId: duty.id, legIndex: startsAtDepot ? duty.legs.length - 1 : 0 },
        ],
        ...atProps(dutyLegSpan(ctx.doc, startsAtDepot ? last : first)?.from),
      });
    }
    return out;
  },
};

export const dutyCarCountMismatch: Rule = {
  id: 'duty.carCountMismatch',
  name: '両数・形式が合わない',
  defaultSeverity: 'error',
  scope: ['duties', 'formations'],
  run(ctx) {
    const dayTypeId = dayTypeIdFor(ctx.doc, ctx.idx.date);
    const formationOfDuty = new Map<string, FormationId>();
    for (const assignment of entityList(ctx.doc.assignments)) {
      if (assignment.date === ctx.idx.date) {
        formationOfDuty.set(assignment.dutyId, assignment.formationId);
      }
    }
    const out: Issue[] = [];
    for (const duty of dutiesForDayType(ctx.doc, dayTypeId)) {
      const formationId = formationOfDuty.get(duty.id);
      if (formationId === undefined) continue;
      const formation = ctx.doc.formations.byId[formationId];
      if (!formation) continue;

      if (duty.requiredCars !== undefined && formation.cars < duty.requiredCars) {
        out.push({
          id: issueId('duty.carCountMismatch', duty.id, formationId, 'dutyCars'),
          ruleId: 'duty.carCountMismatch',
          severity: 'error',
          title: '両数が運用の要求を満たしていません',
          detail: `${dutyName(ctx.doc, duty.id)} は ${duty.requiredCars}両 を要求していますが、充当された ${formationName(ctx.doc, formationId)} は ${formation.cars}両 です。`,
          refs: [
            { kind: 'duty', dutyId: duty.id },
            { kind: 'formation', formationId },
          ],
          date: ctx.idx.date,
        });
      }
      if (
        duty.requiredSeriesIds !== undefined &&
        duty.requiredSeriesIds.length > 0 &&
        !duty.requiredSeriesIds.includes(formation.seriesId)
      ) {
        out.push({
          id: issueId('duty.carCountMismatch', duty.id, formationId, 'dutySeries'),
          ruleId: 'duty.carCountMismatch',
          severity: 'error',
          title: '形式が運用の指定と合いません',
          detail: `${dutyName(ctx.doc, duty.id)} は指定形式のみ充当できますが、${formationName(ctx.doc, formationId)} の形式 ${ctx.doc.formationSeries.byId[formation.seriesId]?.name ?? formation.seriesId} は指定に含まれていません。`,
          refs: [
            { kind: 'duty', dutyId: duty.id },
            { kind: 'formation', formationId },
          ],
          date: ctx.idx.date,
        });
      }

      for (const leg of duty.legs) {
        if (leg.kind !== 'train') continue;
        const train = ctx.doc.trains.byId[leg.trainId];
        if (!train) continue;
        if (train.minCars !== undefined && formation.cars < train.minCars) {
          out.push({
            id: issueId('duty.carCountMismatch', duty.id, formationId, 'trainCars', train.id),
            ruleId: 'duty.carCountMismatch',
            severity: 'error',
            title: '両数が列車の要求を満たしていません',
            detail: `${trainName(ctx.doc, train.id)} は ${train.minCars}両 以上を要求していますが、${dutyName(ctx.doc, duty.id)} に充当された ${formationName(ctx.doc, formationId)} は ${formation.cars}両 です。`,
            refs: [
              { kind: 'train', trainId: train.id },
              { kind: 'duty', dutyId: duty.id },
              { kind: 'formation', formationId },
            ],
            date: ctx.idx.date,
          });
        }
        if (
          train.allowedSeriesIds !== undefined &&
          train.allowedSeriesIds.length > 0 &&
          !train.allowedSeriesIds.includes(formation.seriesId)
        ) {
          out.push({
            id: issueId('duty.carCountMismatch', duty.id, formationId, 'trainSeries', train.id),
            ruleId: 'duty.carCountMismatch',
            severity: 'error',
            title: '形式が列車の指定と合いません',
            detail: `${trainName(ctx.doc, train.id)} に充当できない形式です: ${formationName(ctx.doc, formationId)} の形式 ${ctx.doc.formationSeries.byId[formation.seriesId]?.name ?? formation.seriesId} は許可されていません。`,
            refs: [
              { kind: 'train', trainId: train.id },
              { kind: 'formation', formationId },
            ],
            date: ctx.idx.date,
          });
        }
      }
    }
    return out;
  },
};

export const trainNotCovered: Rule = {
  id: 'train.notCovered',
  name: '運用に組み込まれていない列車',
  defaultSeverity: 'warning',
  scope: ['duties', 'trains'],
  run(ctx) {
    const dayTypeId = dayTypeIdFor(ctx.doc, ctx.idx.date);
    const covered = new Set<string>();
    for (const duty of dutiesForDayType(ctx.doc, dayTypeId)) {
      for (const leg of duty.legs) if (leg.kind === 'train') covered.add(leg.trainId);
    }
    const out: Issue[] = [];
    for (const train of trainsForDayType(ctx.doc, dayTypeId)) {
      if (train.category !== 'service') continue;
      if (covered.has(train.id)) continue;
      out.push({
        id: issueId('train.notCovered', train.id, dayTypeId),
        ruleId: 'train.notCovered',
        severity: 'warning',
        title: '運用に組み込まれていません',
        detail: `${trainName(ctx.doc, train.id)} は ${ctx.doc.dayTypes.byId[dayTypeId]?.name ?? dayTypeId} のどの運用にも含まれていません。`,
        refs: [{ kind: 'train', trainId: train.id }],
        ...atProps(train.stops[0]?.dep ?? train.stops[0]?.arr),
      });
    }
    return out;
  },
};

export const trainDuplicateNumber: Rule = {
  id: 'train.duplicateNumber',
  name: '列車番号の重複',
  defaultSeverity: 'error',
  scope: ['trains'],
  run(ctx) {
    const groups = new Map<string, string[]>();
    for (const train of entityList(ctx.doc.trains)) {
      for (const dayTypeId of train.dayTypeIds) {
        const key = `${dayTypeId}|${train.number}`;
        const list = groups.get(key);
        if (list) list.push(train.id);
        else groups.set(key, [train.id]);
      }
    }
    const out: Issue[] = [];
    for (const [key, ids] of groups) {
      if (ids.length < 2) continue;
      const [dayTypeId = '', number = ''] = key.split('|');
      const dayTypeName = ctx.doc.dayTypes.byId[dayTypeId]?.name ?? dayTypeId;
      out.push({
        id: issueId('train.duplicateNumber', dayTypeId, number),
        ruleId: 'train.duplicateNumber',
        severity: 'error',
        title: '列車番号が重複しています',
        detail: `${dayTypeName}: 列車番号 ${number} が ${ids.length}本 の列車に使われています (${ids
          .map((id) => {
            const t = ctx.doc.trains.byId[id];
            const origin = t?.stops[0];
            const dep = origin?.dep ?? origin?.arr;
            return `${stationName(ctx.doc, origin?.stationId)} ${dep === undefined ? '時刻未設定' : `${hhmmss(dep)}発`}`;
          })
          .join('、')})。`,
        refs: ids.map((id) => ({ kind: 'train' as const, trainId: ctx.doc.trains.byId[id]!.id })),
      });
    }
    return out;
  },
};
