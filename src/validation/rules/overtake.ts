/**
 * 待避・追い抜き — the detected `OvertakeEvent`s, compared against what the
 * author declared via `TrainStop.overtakenBy`.
 */

import { formatDuration } from '@/domain/time';
import { hhmmss, orderedTimelines, stationName, trackFullName, trainName } from '../helpers';
import { issueId, type Issue, type Rule } from '../types';

export const overtakeNoPassingTrack: Rule = {
  id: 'overtake.noPassingTrack',
  name: '待避できない駅での追い抜き',
  defaultSeverity: 'error',
  scope: ['tracks', 'trains'],
  run(ctx) {
    const out: Issue[] = [];
    for (const ot of ctx.idx.overtakes) {
      if (ot.legal) continue;
      const waitingTrackId = ctx.idx.timelines
        .get(ot.waitingTrainId)
        ?.events.find((e) => e.stationId === ot.stationId)?.trackId;
      const why =
        ot.reason === 'trackNotOvertakeCapable' && waitingTrackId !== undefined
          ? `${trackFullName(ctx.doc, waitingTrackId)} は待避不可です`
          : `${stationName(ctx.doc, ot.stationId)} には待避可能な番線がありません`;
      out.push({
        id: issueId(
          'overtake.noPassingTrack',
          ot.stationId,
          ot.waitingTrainId,
          ot.passingTrainId,
        ),
        ruleId: 'overtake.noPassingTrack',
        severity: 'error',
        title: '待避できない場所で追い抜いています',
        detail: `${stationName(ctx.doc, ot.stationId)}: ${trainName(ctx.doc, ot.waitingTrainId)} (${hhmmss(ot.waitArr)}–${hhmmss(ot.waitDep)}) を ${trainName(ctx.doc, ot.passingTrainId)} が ${hhmmss(ot.passAt)} に追い抜いていますが、${why}。`,
        refs: [
          { kind: 'train', trainId: ot.waitingTrainId },
          { kind: 'train', trainId: ot.passingTrainId },
          { kind: 'station', stationId: ot.stationId },
          ...(waitingTrackId !== undefined
            ? [{ kind: 'stationTrack' as const, stationTrackId: waitingTrackId }]
            : []),
        ],
        at: ot.passAt,
        km: ctx.idx.kmOfStation.get(ot.stationId) ?? 0,
      });
    }
    return out;
  },
};

export const overtakeUndeclared: Rule = {
  id: 'overtake.undeclared',
  name: '未申告の追い抜き',
  defaultSeverity: 'info',
  scope: ['trains'],
  run(ctx) {
    const out: Issue[] = [];
    for (const ot of ctx.idx.overtakes) {
      if (ot.declared) continue;
      out.push({
        id: issueId('overtake.undeclared', ot.stationId, ot.waitingTrainId, ot.passingTrainId),
        ruleId: 'overtake.undeclared',
        severity: 'info',
        title: '追い抜きが検出されました (未申告)',
        detail: `${stationName(ctx.doc, ot.stationId)}: ${trainName(ctx.doc, ot.waitingTrainId)} が ${formatDuration(ot.waitDep - ot.waitArr)} 停車する間に ${trainName(ctx.doc, ot.passingTrainId)} が ${hhmmss(ot.passAt)} に追い抜いていますが、待避列車として指定されていません。`,
        refs: [
          { kind: 'train', trainId: ot.waitingTrainId },
          { kind: 'train', trainId: ot.passingTrainId },
          { kind: 'station', stationId: ot.stationId },
        ],
        at: ot.passAt,
        km: ctx.idx.kmOfStation.get(ot.stationId) ?? 0,
      });
    }
    return out;
  },
};

export const overtakeDeclaredButAbsent: Rule = {
  id: 'overtake.declaredButAbsent',
  name: '申告された追い抜きが存在しない',
  defaultSeverity: 'warning',
  scope: ['trains'],
  run(ctx) {
    const detected = new Set(
      ctx.idx.overtakes.map((o) => `${o.stationId}|${o.waitingTrainId}|${o.passingTrainId}`),
    );
    const out: Issue[] = [];
    for (const tl of orderedTimelines(ctx)) {
      tl.train.stops.forEach((stop, i) => {
        for (const passingTrainId of stop.overtakenBy ?? []) {
          if (detected.has(`${stop.stationId}|${tl.trainId}|${passingTrainId}`)) continue;
          out.push({
            id: issueId('overtake.declaredButAbsent', tl.trainId, i, passingTrainId),
            ruleId: 'overtake.declaredButAbsent',
            severity: 'warning',
            title: '指定した追い抜きが成立していません',
            detail: `${trainName(ctx.doc, tl.trainId)} は ${stationName(ctx.doc, stop.stationId)} で ${trainName(ctx.doc, passingTrainId)} に追い抜かれる設定ですが、時刻上そうなっていません。`,
            refs: [
              { kind: 'train', trainId: tl.trainId, stopIndex: i },
              { kind: 'train', trainId: passingTrainId },
              { kind: 'station', stationId: stop.stationId },
            ],
            at: stop.arr ?? stop.dep ?? 0,
            km: ctx.idx.kmOfStation.get(stop.stationId) ?? 0,
          });
        }
      });
    }
    return out;
  },
};
