/**
 * 緩急接続 — does the transfer the timetable implies actually work?
 *
 * The interesting rule here is `connection.qualityGap`: a local held at a
 * connection station is only worth holding if a faster train leaves within the
 * transfer window. A wait with no usable connection is pure lost time for
 * every passenger on board.
 */

import type { StationId } from '@/domain/ids';
import { formatDuration } from '@/domain/time';
import { hhmmss, orderedTimelines, stationName, trainName } from '../helpers';
import { issueId, type Issue, type Rule } from '../types';

export const connectionDeclaredFails: Rule = {
  id: 'connection.declaredFails',
  name: '指定した接続が成立しない',
  defaultSeverity: 'error',
  scope: ['trains'],
  run(ctx) {
    const byKey = new Map(
      ctx.idx.connections.map((c) => [`${c.stationId}|${c.fromTrainId}|${c.toTrainId}`, c]),
    );
    const out: Issue[] = [];
    for (const tl of orderedTimelines(ctx)) {
      tl.train.stops.forEach((stop, i) => {
        for (const toTrainId of stop.connectsTo ?? []) {
          const found = byKey.get(`${stop.stationId}|${tl.trainId}|${toTrainId}`);
          const refs = [
            { kind: 'train' as const, trainId: tl.trainId, stopIndex: i },
            { kind: 'train' as const, trainId: toTrainId },
            { kind: 'station' as const, stationId: stop.stationId },
          ];
          if (found === undefined) {
            out.push({
              id: issueId('connection.declaredFails', tl.trainId, i, toTrainId, 'absent'),
              ruleId: 'connection.declaredFails',
              severity: 'error',
              title: '指定した接続が成立していません',
              detail: `${trainName(ctx.doc, tl.trainId)} は ${stationName(ctx.doc, stop.stationId)} で ${trainName(ctx.doc, toTrainId)} と接続する設定ですが、両列車がこの駅に居合わせていません。`,
              refs,
              at: stop.arr ?? stop.dep ?? 0,
              km: ctx.idx.kmOfStation.get(stop.stationId) ?? 0,
            });
            continue;
          }
          if (found.viable) continue;
          if (found.blockedReason !== undefined) {
            const why =
              found.blockedReason === 'targetDoesNotStop'
                ? `${trainName(ctx.doc, toTrainId)} はこの駅を通過するため乗り換えられません`
                : `${trainName(ctx.doc, toTrainId)} はこの駅から先が ${trainName(ctx.doc, tl.trainId)} より速くないため、緩急接続になりません`;
            out.push({
              id: issueId('connection.declaredFails', tl.trainId, i, toTrainId, 'blocked'),
              ruleId: 'connection.declaredFails',
              severity: 'error',
              title: '接続先の列車に乗り換えられません',
              detail: `${stationName(ctx.doc, stop.stationId)}: ${why}。`,
              refs,
              at: stop.arr ?? stop.dep ?? 0,
              km: ctx.idx.kmOfStation.get(stop.stationId) ?? 0,
            });
            continue;
          }
          const tooShort = found.transferSec < ctx.cfg.connectionMinTransferSec;
          out.push({
            id: issueId('connection.declaredFails', tl.trainId, i, toTrainId, 'window'),
            ruleId: 'connection.declaredFails',
            severity: 'error',
            title: '接続の乗り換え時分が範囲外です',
            detail: `${stationName(ctx.doc, stop.stationId)}: ${trainName(ctx.doc, tl.trainId)} 着から ${trainName(ctx.doc, toTrainId)} 発まで ${formatDuration(found.transferSec)} は、${tooShort ? `最小乗り換え時分 ${formatDuration(ctx.cfg.connectionMinTransferSec)} を下回っています` : `最大待ち時間 ${formatDuration(ctx.cfg.connectionMaxWaitSec)} を超えています`}。`,
            refs,
            at: stop.arr ?? stop.dep ?? 0,
            km: ctx.idx.kmOfStation.get(stop.stationId) ?? 0,
          });
        }
      });
    }
    return out;
  },
};

export const connectionQualityGap: Rule = {
  id: 'connection.qualityGap',
  name: '待避しているのに接続がない',
  defaultSeverity: 'warning',
  scope: ['trains'],
  run(ctx) {
    const out: Issue[] = [];
    for (const ot of ctx.idx.overtakes) {
      const station = ctx.doc.stations.byId[ot.stationId];
      if (!station?.isConnectionPoint) continue;
      const waiting = ctx.idx.timelines.get(ot.waitingTrainId);
      if (!waiting) continue;
      if (ctx.doc.trainTypes.byId[waiting.typeId]?.isPassengerService !== true) continue;
      const hasViable = ctx.idx.connections.some(
        (c) => c.stationId === ot.stationId && c.fromTrainId === ot.waitingTrainId && c.viable,
      );
      if (hasViable) continue;
      out.push({
        id: issueId('connection.qualityGap', ot.stationId, ot.waitingTrainId, ot.passingTrainId),
        ruleId: 'connection.qualityGap',
        severity: 'warning',
        title: '待避が接続に結びついていません',
        detail: `${station.name}: ${trainName(ctx.doc, ot.waitingTrainId)} が ${hhmmss(ot.waitArr)}–${hhmmss(ot.waitDep)} の ${formatDuration(ot.waitDep - ot.waitArr)} 待避していますが、乗り換え可能時分 ${formatDuration(ctx.cfg.connectionMinTransferSec)}〜${formatDuration(ctx.cfg.connectionMaxWaitSec)} の範囲に接続できる優等列車の発車がありません。`,
        refs: [
          { kind: 'train', trainId: ot.waitingTrainId },
          { kind: 'station', stationId: ot.stationId },
          { kind: 'train', trainId: ot.passingTrainId },
        ],
        at: ot.waitArr,
        km: ctx.idx.kmOfStation.get(ot.stationId) ?? 0,
      });
    }
    return out;
  },
};

/**
 * One info per **station**, not per connection.
 *
 * A whole-day timetable at a 緩急接続 station produces one viable transfer per
 * 各停/急行 pair inside the wait window — on this line about a thousand of
 * them. Listing each one individually is technically true and practically
 * useless: it buries every real error under a wall of info rows and makes the
 * problem panel unusable for review, which is the opposite of what a validator
 * is for. The panel wants the answer to "does 緩急接続 work here, and is it
 * declared?", and that is a per-station question.
 */
export const connectionDiscovered: Rule = {
  id: 'connection.discovered',
  name: '接続を検出',
  defaultSeverity: 'info',
  scope: ['trains'],
  run(ctx) {
    interface Tally {
      total: number;
      declared: number;
      minSec: number;
      maxSec: number;
    }
    const byStation = new Map<StationId, Tally>();
    for (const c of ctx.idx.connections) {
      if (!c.viable) continue;
      const tally = byStation.get(c.stationId);
      if (tally === undefined) {
        byStation.set(c.stationId, {
          total: 1,
          declared: c.declared ? 1 : 0,
          minSec: c.transferSec,
          maxSec: c.transferSec,
        });
        continue;
      }
      tally.total++;
      if (c.declared) tally.declared++;
      tally.minSec = Math.min(tally.minSec, c.transferSec);
      tally.maxSec = Math.max(tally.maxSec, c.transferSec);
    }

    const out: Issue[] = [];
    for (const [stationId, t] of [...byStation].sort((a, b) => a[0].localeCompare(b[0]))) {
      const undeclared = t.total - t.declared;
      out.push({
        id: issueId('connection.discovered', stationId),
        ruleId: 'connection.discovered',
        severity: 'info',
        title: '緩急接続を検出しました',
        detail: `${stationName(ctx.doc, stationId)}: 成立する緩急接続 ${t.total} 件 (申告済 ${t.declared} / 未申告 ${undeclared})、乗り換え ${formatDuration(t.minSec)}〜${formatDuration(t.maxSec)}。`,
        refs: [{ kind: 'station', stationId }],
        km: ctx.idx.kmOfStation.get(stationId) ?? 0,
      });
    }
    return out;
  },
};
