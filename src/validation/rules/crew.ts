/**
 * 乗務員行路 — the checks that make a crew plan a plan rather than a wish.
 *
 * Two of these are structural and mirror the vehicle side exactly: a person
 * cannot teleport (`crew.continuityBreak`), and a person cannot work two
 * 行路 on the same day (`crew.doubleBooked`). The rest are the working rules,
 * and every threshold they use is a number in `ValidationConfig` rather than a
 * constant here — how long a driver may work before a break is an agreement
 * between an operator and a union, not a fact about railways.
 *
 * The one judgement call worth stating: when a document has no crew plan at
 * all for the day, `crew.trainNotCovered` says nothing. "Nobody has written
 * the crew diagram yet" and "548 trains have no driver" are the same data and
 * very different situations, and reporting the second would bury every other
 * issue in the panel.
 */

import type { CrewDuty, CrewLeg } from '@/domain/model';
import { CREW_ROLE_LABEL } from '@/domain/model';
import type { CrewDutyId, CrewId, StationId } from '@/domain/ids';
import {
  crewDutiesForDayType,
  crewDutySpan,
  crewDutySpread,
  crewLegEndpoints,
  crewLegSpan,
  crewRolesOfTrain,
  crewWorkingSec,
  isReliefPoint,
  trainsForDayType,
} from '@/domain/project';
import { formatDuration } from '@/domain/time';
import type { Sec } from '@/domain/units';
import { entityList } from '@/domain/units';
import { dayTypeIdFor } from '@/engine/buildIndex';
import { atProps, crewDutyName, crewName, hhmm, hhmmss, stationName, trainName } from '../helpers';
import { issueId, type Issue, type Rule, type ValidationContext } from '../types';

/** A leg whose time and place could both be resolved. */
interface Piece {
  leg: CrewLeg;
  index: number;
  from: Sec;
  to: Sec;
  fromStationId: StationId;
  toStationId: StationId;
}

function piecesOf(ctx: ValidationContext, duty: CrewDuty): Piece[] {
  const out: Piece[] = [];
  for (const [index, leg] of duty.legs.entries()) {
    const span = crewLegSpan(ctx.doc, leg);
    const ends = crewLegEndpoints(ctx.doc, leg);
    if (span === undefined || ends === undefined) continue;
    out.push({ leg, index, ...span, ...ends });
  }
  return out;
}

function dutiesOfDay(ctx: ValidationContext): CrewDuty[] {
  return crewDutiesForDayType(ctx.doc, dayTypeIdFor(ctx.doc, ctx.idx.date));
}

// ---------------------------------------------------------------------------

export const crewContinuityBreak: Rule = {
  id: 'crew.continuityBreak',
  name: '乗務員行路がつながっていない',
  defaultSeverity: 'error',
  scope: ['crew'],
  run(ctx) {
    const out: Issue[] = [];
    for (const duty of dutiesOfDay(ctx)) {
      const pieces = piecesOf(ctx, duty);
      for (let i = 1; i < pieces.length; i++) {
        const prev = pieces[i - 1]!;
        const cur = pieces[i]!;
        if (prev.toStationId !== cur.fromStationId) {
          out.push({
            id: issueId('crew.continuityBreak', duty.id, cur.index, 'place'),
            ruleId: 'crew.continuityBreak',
            severity: 'error',
            title: '乗務員の場所がつながっていません',
            detail: `${crewDutyName(ctx.doc, duty.id)} ${cur.index + 1}行: 前は ${stationName(ctx.doc, prev.toStationId)} で終わりますが、次は ${stationName(ctx.doc, cur.fromStationId)} から始まります。`,
            refs: [
              { kind: 'crewDuty', crewDutyId: duty.id, legIndex: cur.index },
              { kind: 'station', stationId: cur.fromStationId },
            ],
            at: cur.from,
          });
        }
        if (cur.from < prev.to) {
          out.push({
            id: issueId('crew.continuityBreak', duty.id, cur.index, 'time'),
            ruleId: 'crew.continuityBreak',
            severity: 'error',
            title: '乗務員の時刻が重複しています',
            detail: `${crewDutyName(ctx.doc, duty.id)} ${cur.index + 1}行: 前が ${hhmmss(prev.to)} に終わる前の ${hhmmss(cur.from)} に次が始まります。`,
            refs: [{ kind: 'crewDuty', crewDutyId: duty.id, legIndex: cur.index }],
            at: cur.from,
          });
        }
      }
    }
    return out;
  },
};

/**
 * A crew may join or leave a train part-way only where there is a relief
 * arrangement. Taking a train from its origin to its terminus needs nothing —
 * the constraint is about swapping over mid-run, not about being on board.
 */
export const crewReliefPointInvalid: Rule = {
  id: 'crew.reliefPointInvalid',
  name: '交代できない駅で乗り降りしている',
  defaultSeverity: 'error',
  scope: ['crew'],
  run(ctx) {
    const out: Issue[] = [];
    for (const duty of dutiesOfDay(ctx)) {
      for (const [index, leg] of duty.legs.entries()) {
        if (leg.kind === 'break' || leg.kind === 'standby') continue;
        const train = ctx.doc.trains.byId[leg.trainId];
        if (train === undefined) continue;
        const ends = crewLegEndpoints(ctx.doc, leg);
        const span = crewLegSpan(ctx.doc, leg);
        if (ends === undefined) continue;

        const checks: Array<{ at: 'board' | 'alight'; stationId: StationId; mid: boolean }> = [
          { at: 'board', stationId: ends.fromStationId, mid: leg.fromIndex > 0 },
          {
            at: 'alight',
            stationId: ends.toStationId,
            mid: leg.toIndex < train.stops.length - 1,
          },
        ];
        for (const check of checks) {
          if (!check.mid) continue;
          if (isReliefPoint(ctx.doc, check.stationId)) continue;
          out.push({
            id: issueId('crew.reliefPointInvalid', duty.id, index, check.at),
            ruleId: 'crew.reliefPointInvalid',
            severity: 'error',
            title: '交代できない駅で乗り降りしています',
            detail: `${crewDutyName(ctx.doc, duty.id)} ${index + 1}行: ${trainName(ctx.doc, leg.trainId)} に ${stationName(ctx.doc, check.stationId)} で${check.at === 'board' ? '乗り継いで' : '乗り換えて'}いますが、この駅は乗務員交代可能駅ではありません。`,
            refs: [
              { kind: 'crewDuty', crewDutyId: duty.id, legIndex: index },
              { kind: 'station', stationId: check.stationId },
            ],
            ...atProps(check.at === 'board' ? span?.from : span?.to),
          });
        }
      }
    }
    return out;
  },
};

export const crewHandoverTight: Rule = {
  id: 'crew.handoverTight',
  name: '乗り継ぎ時間が短い',
  defaultSeverity: 'warning',
  scope: ['crew'],
  run(ctx) {
    const out: Issue[] = [];
    const required = ctx.cfg.crewMinHandoverSec;
    for (const duty of dutiesOfDay(ctx)) {
      const pieces = piecesOf(ctx, duty);
      for (let i = 1; i < pieces.length; i++) {
        const prev = pieces[i - 1]!;
        const cur = pieces[i]!;
        // Only a train-to-train change needs the margin: a 休憩 or 待機 runs
        // right up to the next departure by construction.
        if (prev.leg.kind === 'break' || prev.leg.kind === 'standby') continue;
        if (cur.leg.kind === 'break' || cur.leg.kind === 'standby') continue;
        const gap = cur.from - prev.to;
        if (gap < 0 || gap >= required) continue;
        out.push({
          id: issueId('crew.handoverTight', duty.id, cur.index),
          ruleId: 'crew.handoverTight',
          severity: 'warning',
          title: '乗り継ぎ時間が短すぎます',
          detail: `${crewDutyName(ctx.doc, duty.id)}: ${stationName(ctx.doc, cur.fromStationId)} で ${formatDuration(gap)} しかありません (最低 ${formatDuration(required)})。`,
          refs: [
            { kind: 'crewDuty', crewDutyId: duty.id, legIndex: cur.index },
            { kind: 'station', stationId: cur.fromStationId },
          ],
          at: prev.to,
        });
      }
    }
    return out;
  },
};

/**
 * A stretch runs from the end of one qualifying 休憩 to the start of the next.
 * 待機 does not end a stretch — standing on a platform waiting for the next
 * train is not a rest.
 */
export const crewContinuousWorkExceeded: Rule = {
  id: 'crew.continuousWorkExceeded',
  name: '連続乗務時間が上限を超えている',
  defaultSeverity: 'warning',
  scope: ['crew'],
  run(ctx) {
    const out: Issue[] = [];
    const limit = ctx.cfg.crewMaxContinuousWorkSec;
    for (const duty of dutiesOfDay(ctx)) {
      const pieces = piecesOf(ctx, duty);
      const first = pieces[0];
      const last = pieces[pieces.length - 1];
      if (first === undefined || last === undefined) continue;

      const stretches: Array<{ from: Sec; to: Sec; index: number }> = [];
      let from = first.from;
      let index = first.index;
      for (const p of pieces) {
        if (p.leg.kind !== 'break') continue;
        if (p.to - p.from < ctx.cfg.crewMinBreakSec) continue;
        stretches.push({ from, to: p.from, index });
        from = p.to;
        index = p.index + 1;
      }
      stretches.push({ from, to: last.to, index });

      for (const stretch of stretches) {
        const sec = stretch.to - stretch.from;
        if (sec <= limit) continue;
        out.push({
          id: issueId('crew.continuousWorkExceeded', duty.id, stretch.index),
          ruleId: 'crew.continuousWorkExceeded',
          severity: 'warning',
          title: '休憩なしで乗務し続けています',
          detail: `${crewDutyName(ctx.doc, duty.id)}: ${hhmm(stretch.from)}–${hhmm(stretch.to)} の ${formatDuration(sec)} 続けて乗務しています (上限 ${formatDuration(limit)})。`,
          refs: [{ kind: 'crewDuty', crewDutyId: duty.id, legIndex: stretch.index }],
          at: stretch.from + limit,
        });
      }
    }
    return out;
  },
};

export const crewBreakInsufficient: Rule = {
  id: 'crew.breakInsufficient',
  name: '休憩が足りない',
  defaultSeverity: 'warning',
  scope: ['crew'],
  run(ctx) {
    const out: Issue[] = [];
    for (const duty of dutiesOfDay(ctx)) {
      let total = 0;
      for (const [index, leg] of duty.legs.entries()) {
        if (leg.kind !== 'break') continue;
        const sec = leg.to - leg.from;
        if (sec >= ctx.cfg.crewMinBreakSec) total += sec;
        else {
          out.push({
            id: issueId('crew.breakInsufficient', duty.id, index, 'short'),
            ruleId: 'crew.breakInsufficient',
            severity: 'warning',
            title: '休憩が短すぎます',
            detail: `${crewDutyName(ctx.doc, duty.id)} ${index + 1}行: ${formatDuration(sec)} は休憩として数えられません (最低 ${formatDuration(ctx.cfg.crewMinBreakSec)})。`,
            refs: [{ kind: 'crewDuty', crewDutyId: duty.id, legIndex: index }],
            at: leg.from,
          });
        }
        if (ctx.doc.stations.byId[leg.stationId]?.crewBase !== true) {
          out.push({
            id: issueId('crew.breakInsufficient', duty.id, index, 'place'),
            ruleId: 'crew.breakInsufficient',
            severity: 'warning',
            title: '休憩できない場所で休憩しています',
            detail: `${crewDutyName(ctx.doc, duty.id)} ${index + 1}行: ${stationName(ctx.doc, leg.stationId)} は乗務員基地ではありません。`,
            refs: [
              { kind: 'crewDuty', crewDutyId: duty.id, legIndex: index },
              { kind: 'station', stationId: leg.stationId },
            ],
            at: leg.from,
          });
        }
      }

      // A duty too short to need a break is not short of one.
      const working = crewWorkingSec(ctx.doc, duty);
      if (working < ctx.cfg.crewMaxContinuousWorkSec) continue;
      if (total >= ctx.cfg.crewMinTotalBreakSec) continue;
      const span = crewDutySpan(ctx.doc, duty);
      out.push({
        id: issueId('crew.breakInsufficient', duty.id, 'total'),
        ruleId: 'crew.breakInsufficient',
        severity: 'warning',
        title: '休憩の合計が足りません',
        detail: `${crewDutyName(ctx.doc, duty.id)}: 実乗務 ${formatDuration(working)} に対して休憩は ${formatDuration(total)} しかありません (最低 ${formatDuration(ctx.cfg.crewMinTotalBreakSec)})。`,
        refs: [{ kind: 'crewDuty', crewDutyId: duty.id }],
        ...atProps(span?.from),
      });
    }
    return out;
  },
};

export const crewWorkTimeExceeded: Rule = {
  id: 'crew.workTimeExceeded',
  name: '拘束時間・実乗務時間が上限を超えている',
  defaultSeverity: 'warning',
  scope: ['crew'],
  run(ctx) {
    const out: Issue[] = [];
    for (const duty of dutiesOfDay(ctx)) {
      const spread = crewDutySpread(ctx.doc, duty);
      if (spread === undefined) continue;
      if (spread.sec > ctx.cfg.crewMaxSpreadSec) {
        out.push({
          id: issueId('crew.workTimeExceeded', duty.id, 'spread'),
          ruleId: 'crew.workTimeExceeded',
          severity: 'warning',
          title: '拘束時間が上限を超えています',
          detail: `${crewDutyName(ctx.doc, duty.id)}: 出勤 ${hhmm(spread.from)} から退勤 ${hhmm(spread.to)} まで ${formatDuration(spread.sec)} (上限 ${formatDuration(ctx.cfg.crewMaxSpreadSec)})。`,
          refs: [{ kind: 'crewDuty', crewDutyId: duty.id }],
          at: spread.from,
        });
      }
      const working = crewWorkingSec(ctx.doc, duty);
      if (working > ctx.cfg.crewMaxWorkSec) {
        out.push({
          id: issueId('crew.workTimeExceeded', duty.id, 'work'),
          ruleId: 'crew.workTimeExceeded',
          severity: 'warning',
          title: '実乗務時間が上限を超えています',
          detail: `${crewDutyName(ctx.doc, duty.id)}: 実乗務 ${formatDuration(working)} (上限 ${formatDuration(ctx.cfg.crewMaxWorkSec)})。`,
          refs: [{ kind: 'crewDuty', crewDutyId: duty.id }],
          at: spread.from,
        });
      }
    }
    return out;
  },
};

export const crewDoubleBooked: Rule = {
  id: 'crew.doubleBooked',
  name: '乗務員が同時に2つの行路に入っている',
  defaultSeverity: 'error',
  scope: ['crew'],
  run(ctx) {
    const out: Issue[] = [];
    const byCrew = new Map<CrewId, Array<{ dutyId: CrewDutyId; from: Sec; to: Sec }>>();
    for (const a of entityList(ctx.doc.crewAssignments)) {
      if (a.date !== ctx.idx.date) continue;
      const duty = ctx.doc.crewDuties.byId[a.crewDutyId];
      if (duty === undefined) continue;
      const spread = crewDutySpread(ctx.doc, duty);
      if (spread === undefined) continue;
      const list = byCrew.get(a.crewId) ?? [];
      list.push({ dutyId: duty.id, from: spread.from, to: spread.to });
      byCrew.set(a.crewId, list);
    }

    for (const [crewId, list] of [...byCrew.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      list.sort((a, b) => a.from - b.from || a.dutyId.localeCompare(b.dutyId));
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1]!;
        const cur = list[i]!;
        if (cur.from >= prev.to) continue;
        out.push({
          id: issueId('crew.doubleBooked', crewId, prev.dutyId, cur.dutyId),
          ruleId: 'crew.doubleBooked',
          severity: 'error',
          title: '乗務員が重複して割り当てられています',
          detail: `${crewName(ctx.doc, crewId)}: ${crewDutyName(ctx.doc, prev.dutyId)} が ${hhmm(prev.to)} に終わる前の ${hhmm(cur.from)} に ${crewDutyName(ctx.doc, cur.dutyId)} が始まります。`,
          refs: [
            { kind: 'crew', crewId },
            { kind: 'crewDuty', crewDutyId: cur.dutyId },
          ],
          at: cur.from,
          date: ctx.idx.date,
        });
      }
    }
    return out;
  },
};

export const crewRoleMismatch: Rule = {
  id: 'crew.roleMismatch',
  name: '乗務員と行路の職種・所属が合わない',
  defaultSeverity: 'error',
  scope: ['crew'],
  run(ctx) {
    const out: Issue[] = [];
    for (const a of entityList(ctx.doc.crewAssignments)) {
      if (a.date !== ctx.idx.date) continue;
      const duty = ctx.doc.crewDuties.byId[a.crewDutyId];
      const person = ctx.doc.crew.byId[a.crewId];
      if (duty === undefined || person === undefined) continue;
      const span = crewDutySpan(ctx.doc, duty);
      if (person.role !== duty.role) {
        out.push({
          id: issueId('crew.roleMismatch', a.id, 'role'),
          ruleId: 'crew.roleMismatch',
          severity: 'error',
          title: '職種が違う乗務員が割り当てられています',
          detail: `${crewDutyName(ctx.doc, duty.id)} は${CREW_ROLE_LABEL[duty.role]}の行路ですが、${crewName(ctx.doc, person.id)} は${CREW_ROLE_LABEL[person.role]}です。`,
          refs: [
            { kind: 'crewDuty', crewDutyId: duty.id },
            { kind: 'crew', crewId: person.id },
          ],
          ...atProps(span?.from),
          date: ctx.idx.date,
        });
      } else if (person.baseStationId !== duty.baseStationId) {
        out.push({
          id: issueId('crew.roleMismatch', a.id, 'base'),
          ruleId: 'crew.roleMismatch',
          severity: 'warning',
          title: '所属が違う乗務員が割り当てられています',
          detail: `${crewDutyName(ctx.doc, duty.id)} は ${stationName(ctx.doc, duty.baseStationId)} の行路ですが、${crewName(ctx.doc, person.id)} の所属は ${stationName(ctx.doc, person.baseStationId)} です。`,
          refs: [
            { kind: 'crewDuty', crewDutyId: duty.id },
            { kind: 'crew', crewId: person.id },
          ],
          ...atProps(span?.from),
          date: ctx.idx.date,
        });
      }
    }
    return out;
  },
};

/**
 * Every train needs the roles its type calls for, and needs them for its whole
 * length. Silent when there is no crew plan at all — see the file header.
 */
export const crewTrainNotCovered: Rule = {
  id: 'crew.trainNotCovered',
  name: '乗務員のいない列車',
  defaultSeverity: 'warning',
  scope: ['crew', 'trains'],
  run(ctx) {
    const duties = dutiesOfDay(ctx);
    if (duties.length === 0) return [];

    /** `${trainId}|${role}` -> the stop ranges worked, merged. */
    const worked = new Map<string, Array<{ from: number; to: number; dutyId: string }>>();
    for (const duty of duties) {
      for (const leg of duty.legs) {
        if (leg.kind !== 'train') continue;
        const key = `${leg.trainId}|${duty.role}`;
        const list = worked.get(key) ?? [];
        list.push({ from: leg.fromIndex, to: leg.toIndex, dutyId: duty.id });
        worked.set(key, list);
      }
    }

    const rolesPresent = new Set(duties.map((d) => d.role));
    const out: Issue[] = [];
    for (const train of trainsForDayType(ctx.doc, dayTypeIdFor(ctx.doc, ctx.idx.date))) {
      const lastIndex = train.stops.length - 1;
      if (lastIndex <= 0) continue;
      for (const role of crewRolesOfTrain(ctx.doc, train)) {
        // A role nobody has a 行路 for is a plan that has not been written
        // yet, not 548 uncrewed trains.
        if (!rolesPresent.has(role)) continue;
        const ranges = (worked.get(`${train.id}|${role}`) ?? []).sort((a, b) => a.from - b.from);
        const first = ranges[0];
        if (first === undefined) {
          out.push({
            id: issueId('crew.trainNotCovered', train.id, role),
            ruleId: 'crew.trainNotCovered',
            severity: 'warning',
            title: '乗務員のいない列車があります',
            detail: `${trainName(ctx.doc, train.id)} に${CREW_ROLE_LABEL[role]}の行路がありません。`,
            refs: [{ kind: 'train', trainId: train.id }],
            ...atProps(train.stops[0]?.dep ?? train.stops[0]?.arr),
          });
          continue;
        }
        let reach = first.from === 0 ? first.to : -1;
        for (const range of ranges.slice(1)) {
          if (range.from > reach) break;
          if (range.to > reach) reach = range.to;
        }
        if (reach >= lastIndex) continue;
        const gapStop = train.stops[Math.max(reach, 0)];
        out.push({
          id: issueId('crew.trainNotCovered', train.id, role, 'partial'),
          ruleId: 'crew.trainNotCovered',
          severity: 'warning',
          title: '乗務員が途中までしかいません',
          detail: `${trainName(ctx.doc, train.id)}: ${CREW_ROLE_LABEL[role]}は ${stationName(ctx.doc, gapStop?.stationId)} から先が空いています。`,
          refs: [{ kind: 'train', trainId: train.id, stopIndex: Math.max(reach, 0) }],
          ...atProps(gapStop?.arr ?? gapStop?.dep),
        });
      }
    }
    return out;
  },
};

/**
 * 出勤と退勤は乗務員基地で。Which base is not checked: this model has no
 * 泊まり勤務 and no way for a person to move between bases off-duty, so
 * requiring a return to the exact building it started at would reject plans
 * that are perfectly workable. What it does require is that both ends are
 * somewhere a person can sign on, and that the duty's own 所属 is one too.
 */
export const crewNotAtBase: Rule = {
  id: 'crew.notAtBase',
  name: '基地で始まって基地で終わっていない行路',
  defaultSeverity: 'warning',
  scope: ['crew'],
  run(ctx) {
    const out: Issue[] = [];
    const isBase = (id: StationId): boolean => ctx.doc.stations.byId[id]?.crewBase === true;
    for (const duty of dutiesOfDay(ctx)) {
      if (!isBase(duty.baseStationId)) {
        out.push({
          id: issueId('crew.notAtBase', duty.id, 'station'),
          ruleId: 'crew.notAtBase',
          severity: 'warning',
          title: '所属が乗務員基地ではありません',
          detail: `${crewDutyName(ctx.doc, duty.id)}: 所属の ${stationName(ctx.doc, duty.baseStationId)} は乗務員基地ではありません。`,
          refs: [
            { kind: 'crewDuty', crewDutyId: duty.id },
            { kind: 'station', stationId: duty.baseStationId },
          ],
        });
      }
      const pieces = piecesOf(ctx, duty);
      const first = pieces[0];
      const last = pieces[pieces.length - 1];
      if (first === undefined || last === undefined) continue;
      const ends: Array<{ what: 'start' | 'end'; stationId: StationId; at: Sec }> = [
        { what: 'start', stationId: first.fromStationId, at: first.from },
        { what: 'end', stationId: last.toStationId, at: last.to },
      ];
      for (const end of ends) {
        if (isBase(end.stationId)) continue;
        out.push({
          id: issueId('crew.notAtBase', duty.id, end.what),
          ruleId: 'crew.notAtBase',
          severity: 'warning',
          title: end.what === 'start' ? '基地以外で出勤しています' : '基地以外で退勤しています',
          detail: `${crewDutyName(ctx.doc, duty.id)}: ${end.what === 'start' ? '出勤' : '退勤'}が ${stationName(ctx.doc, end.stationId)} ですが、ここは乗務員基地ではありません。`,
          refs: [
            { kind: 'crewDuty', crewDutyId: duty.id },
            { kind: 'station', stationId: end.stationId },
          ],
          at: end.at,
        });
      }
    }
    return out;
  },
};
