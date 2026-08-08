/**
 * 時刻 — rules that look at one train in isolation.
 */

import { formatDuration } from '@/domain/time';
import type { TrainEvent } from '@/engine/types';
import { hhmmss, orderedTimelines, sectionInfo, stationName, trainName } from '../helpers';
import { issueId, type Issue, type Rule } from '../types';

/** Section time may be this many times the minimum before it looks padded. */
export const RUN_SLOW_FACTOR = 1.5;

function eventsByStopIndex(events: TrainEvent[]): Map<number, TrainEvent> {
  const map = new Map<number, TrainEvent>();
  for (const e of events) map.set(e.stopIndex, e);
  return map;
}

export const timeNonMonotonic: Rule = {
  id: 'time.nonMonotonic',
  name: '時刻の前後関係',
  defaultSeverity: 'error',
  scope: ['trains'],
  run(ctx) {
    const out: Issue[] = [];
    for (const tl of orderedTimelines(ctx)) {
      const stops = tl.train.stops;
      const last = stops.length - 1;
      stops.forEach((stop, i) => {
        const where = stationName(ctx.doc, stop.stationId);
        if (stop.arr !== undefined && stop.dep !== undefined && stop.arr > stop.dep) {
          out.push({
            id: issueId('time.nonMonotonic', tl.trainId, i, 'arrAfterDep'),
            ruleId: 'time.nonMonotonic',
            severity: 'error',
            title: '到着が発車より後です',
            detail: `${trainName(ctx.doc, tl.trainId)} ${where}: 着 ${hhmmss(stop.arr)} が 発 ${hhmmss(stop.dep)} より後になっています。`,
            refs: [
              { kind: 'train', trainId: tl.trainId, stopIndex: i },
              { kind: 'station', stationId: stop.stationId },
            ],
            at: stop.arr,
            km: ctx.idx.kmOfStation.get(stop.stationId) ?? 0,
          });
        }
        if (i === 0 && stop.arr !== undefined) {
          out.push({
            id: issueId('time.nonMonotonic', tl.trainId, i, 'originHasArr'),
            ruleId: 'time.nonMonotonic',
            severity: 'error',
            title: '始発駅に到着時刻があります',
            detail: `${trainName(ctx.doc, tl.trainId)} の始発駅 ${where} に到着時刻 ${hhmmss(stop.arr)} が入力されています。`,
            refs: [{ kind: 'train', trainId: tl.trainId, stopIndex: i }],
            at: stop.arr,
          });
        }
        if (i === last && i > 0 && stop.dep !== undefined) {
          out.push({
            id: issueId('time.nonMonotonic', tl.trainId, i, 'terminusHasDep'),
            ruleId: 'time.nonMonotonic',
            severity: 'error',
            title: '終着駅に発車時刻があります',
            detail: `${trainName(ctx.doc, tl.trainId)} の終着駅 ${where} に発車時刻 ${hhmmss(stop.dep)} が入力されています。`,
            refs: [{ kind: 'train', trainId: tl.trainId, stopIndex: i }],
            at: stop.dep,
          });
        }
        if (i < last) {
          const next = stops[i + 1]!;
          const dep = stop.dep ?? stop.arr;
          const arr = next.arr ?? next.dep;
          if (dep !== undefined && arr !== undefined && dep >= arr) {
            out.push({
              id: issueId('time.nonMonotonic', tl.trainId, i, 'notAdvancing'),
              ruleId: 'time.nonMonotonic',
              severity: 'error',
              title: '次駅の時刻が前後しています',
              detail: `${trainName(ctx.doc, tl.trainId)}: ${where} 発 ${hhmmss(dep)} が 次の ${stationName(ctx.doc, next.stationId)} 着 ${hhmmss(arr)} 以降になっています。`,
              refs: [
                { kind: 'train', trainId: tl.trainId, stopIndex: i },
                { kind: 'train', trainId: tl.trainId, stopIndex: i + 1 },
              ],
              at: dep,
            });
          }
        }
      });
    }
    return out;
  },
};

export const timeRunTooFast: Rule = {
  id: 'time.runTooFast',
  name: '走行時分が最小値を下回る',
  defaultSeverity: 'error',
  scope: ['trains'],
  run(ctx) {
    const out: Issue[] = [];
    for (const tl of orderedTimelines(ctx)) {
      const profileId = ctx.doc.trainTypes.byId[tl.typeId]?.perfProfileId;
      if (profileId === undefined) continue;
      for (let i = 1; i < tl.train.stops.length; i++) {
        const info = sectionInfo(ctx, tl, i, profileId);
        if (!info) continue;
        if (info.actualSec < 0) continue;
        if (info.actualSec >= info.minSec) continue;
        const prev = tl.train.stops[i - 1]!;
        const cur = tl.train.stops[i]!;
        out.push({
          id: issueId('time.runTooFast', tl.trainId, i),
          ruleId: 'time.runTooFast',
          severity: 'error',
          title: '走行時分が最小所要時間を下回っています',
          detail: `${trainName(ctx.doc, tl.trainId)} ${stationName(ctx.doc, prev.stationId)}→${stationName(ctx.doc, cur.stationId)}: 実際 ${formatDuration(info.actualSec)} に対し最小 ${formatDuration(info.minSec)}、${info.minSec - info.actualSec}秒 不足しています。`,
          refs: [
            { kind: 'train', trainId: tl.trainId, stopIndex: i },
            { kind: 'link', linkId: info.linkId },
          ],
          at: info.depSec,
          km: ctx.idx.kmOfStation.get(prev.stationId) ?? 0,
        });
      }
    }
    return out;
  },
};

export const timeRunSlow: Rule = {
  id: 'time.runSlow',
  name: '走行時分が過大',
  defaultSeverity: 'info',
  scope: ['trains'],
  run(ctx) {
    const out: Issue[] = [];
    for (const tl of orderedTimelines(ctx)) {
      const profileId = ctx.doc.trainTypes.byId[tl.typeId]?.perfProfileId;
      if (profileId === undefined) continue;
      const byIndex = eventsByStopIndex(tl.events);
      for (let i = 1; i < tl.train.stops.length; i++) {
        const info = sectionInfo(ctx, tl, i, profileId);
        if (!info || info.minSec <= 0) continue;
        if (info.actualSec <= info.minSec * RUN_SLOW_FACTOR) continue;
        // A train held for an overtake is not running slowly; it is waiting.
        if (byIndex.get(i - 1)?.isOvertakeWait === true) continue;
        if (byIndex.get(i)?.isOvertakeWait === true) continue;
        const prev = tl.train.stops[i - 1]!;
        const cur = tl.train.stops[i]!;
        out.push({
          id: issueId('time.runSlow', tl.trainId, i),
          ruleId: 'time.runSlow',
          severity: 'info',
          title: '走行時分に余裕がありすぎます',
          detail: `${trainName(ctx.doc, tl.trainId)} ${stationName(ctx.doc, prev.stationId)}→${stationName(ctx.doc, cur.stationId)}: 実際 ${formatDuration(info.actualSec)} は最小 ${formatDuration(info.minSec)} の ${(info.actualSec / info.minSec).toFixed(2)} 倍です。`,
          refs: [{ kind: 'train', trainId: tl.trainId, stopIndex: i }],
          at: info.depSec,
          km: ctx.idx.kmOfStation.get(prev.stationId) ?? 0,
        });
      }
    }
    return out;
  },
};

export const timeDwellTooShort: Rule = {
  id: 'time.dwellTooShort',
  name: '停車時分が不足',
  defaultSeverity: 'warning',
  scope: ['trains'],
  run(ctx) {
    const out: Issue[] = [];
    for (const tl of orderedTimelines(ctx)) {
      const type = ctx.doc.trainTypes.byId[tl.typeId];
      if (type?.isPassengerService !== true) continue;
      tl.train.stops.forEach((stop, i) => {
        if (stop.kind !== 'stop' || stop.operational === true) return;
        if (stop.arr === undefined || stop.dep === undefined) return;
        const station = ctx.doc.stations.byId[stop.stationId];
        if (!station) return;
        const dwell = stop.dep - stop.arr;
        if (dwell >= station.minDwellSec) return;
        out.push({
          id: issueId('time.dwellTooShort', tl.trainId, i),
          ruleId: 'time.dwellTooShort',
          severity: 'warning',
          title: '停車時分が最小値を下回っています',
          detail: `${trainName(ctx.doc, tl.trainId)} ${station.name}: 停車 ${dwell}秒 は最小停車時分 ${station.minDwellSec}秒 を下回っています。`,
          refs: [
            { kind: 'train', trainId: tl.trainId, stopIndex: i },
            { kind: 'station', stationId: stop.stationId },
          ],
          at: stop.arr,
          km: station.kmFromOrigin,
        });
      });
    }
    return out;
  },
};

export const timeOffGrain: Rule = {
  id: 'time.offGrain',
  name: '時刻が刻み幅に乗っていない',
  defaultSeverity: 'info',
  scope: ['trains'],
  run(ctx) {
    const grain = ctx.doc.settings.timeGrainSec;
    const out: Issue[] = [];
    if (grain <= 1) return out;
    for (const tl of orderedTimelines(ctx)) {
      tl.train.stops.forEach((stop, i) => {
        for (const [field, label, value] of [
          ['arr', '着', stop.arr],
          ['dep', '発', stop.dep],
        ] as const) {
          if (value === undefined || value % grain === 0) continue;
          out.push({
            id: issueId('time.offGrain', tl.trainId, i, field),
            ruleId: 'time.offGrain',
            severity: 'info',
            title: '時刻が刻み幅に乗っていません',
            detail: `${trainName(ctx.doc, tl.trainId)} ${stationName(ctx.doc, stop.stationId)} ${label} ${hhmmss(value)} は刻み幅 ${grain}秒 の倍数ではありません。`,
            refs: [{ kind: 'train', trainId: tl.trainId, stopIndex: i }],
            at: value,
          });
        }
      });
    }
    return out;
  },
};

export const timeOutsideServiceDay: Rule = {
  id: 'time.outsideServiceDay',
  name: '営業日の範囲外',
  defaultSeverity: 'warning',
  scope: ['trains', 'calendar'],
  run(ctx) {
    const { serviceDayStartSec: from, serviceDayEndSec: to } = ctx.doc.settings;
    const out: Issue[] = [];
    for (const tl of orderedTimelines(ctx)) {
      tl.train.stops.forEach((stop, i) => {
        for (const [field, label, value] of [
          ['arr', '着', stop.arr],
          ['dep', '発', stop.dep],
        ] as const) {
          if (value === undefined || (value >= from && value <= to)) continue;
          out.push({
            id: issueId('time.outsideServiceDay', tl.trainId, i, field),
            ruleId: 'time.outsideServiceDay',
            severity: 'warning',
            title: '営業日の時間帯から外れています',
            detail: `${trainName(ctx.doc, tl.trainId)} ${stationName(ctx.doc, stop.stationId)} ${label} ${hhmmss(value)} は営業日 ${hhmmss(from)}〜${hhmmss(to)} の範囲外です。`,
            refs: [{ kind: 'train', trainId: tl.trainId, stopIndex: i }],
            at: value,
          });
        }
      });
    }
    return out;
  },
};
