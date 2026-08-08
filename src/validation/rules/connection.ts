/**
 * 緩急接続 — does the transfer the timetable implies actually work?
 *
 * The interesting rule here is `connection.qualityGap`: a local held at a
 * connection station is only worth holding if a faster train leaves within the
 * transfer window. A wait with no usable connection is pure lost time for
 * every passenger on board.
 */

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

export const connectionDiscovered: Rule = {
  id: 'connection.discovered',
  name: '接続を検出',
  defaultSeverity: 'info',
  scope: ['trains'],
  run(ctx) {
    const out: Issue[] = [];
    for (const c of ctx.idx.connections) {
      if (!c.viable) continue;
      out.push({
        id: issueId('connection.discovered', c.stationId, c.fromTrainId, c.toTrainId),
        ruleId: 'connection.discovered',
        severity: 'info',
        title: '緩急接続を検出しました',
        detail: `${stationName(ctx.doc, c.stationId)}: ${trainName(ctx.doc, c.fromTrainId)} から ${trainName(ctx.doc, c.toTrainId)} へ 乗り換え ${formatDuration(c.transferSec)}${c.declared ? '' : ' (未申告)'}。`,
        refs: [
          { kind: 'train', trainId: c.fromTrainId },
          { kind: 'train', trainId: c.toTrainId },
          { kind: 'station', stationId: c.stationId },
        ],
        km: ctx.idx.kmOfStation.get(c.stationId) ?? 0,
      });
    }
    return out;
  },
};
