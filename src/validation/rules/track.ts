/**
 * 番線・構内 — which platform road each train uses, and whether two trains
 * are booked onto the same one at the same time.
 */

import { tracksOfStation } from '@/domain/project';
import { overlapSeconds } from '@/domain/time';
import {
  atProps,
  hhmmss,
  orderedTimelines,
  stationName,
  trackFullName,
  trainName,
} from '../helpers';
import { issueId, type Issue, type Rule } from '../types';

export const trackDoubleOccupancy: Rule = {
  id: 'track.doubleOccupancy',
  name: '番線の二重使用',
  defaultSeverity: 'error',
  scope: ['tracks'],
  run(ctx) {
    const out: Issue[] = [];
    for (const [trackId, intervals] of ctx.idx.trackIntervals) {
      for (let i = 0; i < intervals.length; i++) {
        for (let j = i + 1; j < intervals.length; j++) {
          const a = intervals[i]!;
          const b = intervals[j]!;
          if (b.from >= a.to) break;
          // One duty is one physical formation: it cannot conflict with
          // itself. A broken hand-over is duty.continuityBreak's job.
          const dutyA = ctx.idx.dutyOfTrain.get(a.trainId);
          const dutyB = ctx.idx.dutyOfTrain.get(b.trainId);
          if (dutyA !== undefined && dutyA === dutyB) continue;
          const overlap = overlapSeconds(a.from, a.to, b.from, b.to);
          if (overlap <= 0) continue;
          out.push({
            id: issueId('track.doubleOccupancy', trackId, a.trainId, b.trainId, a.from),
            ruleId: 'track.doubleOccupancy',
            severity: 'error',
            title: '番線が二重使用されています',
            detail: `${trackFullName(ctx.doc, trackId)}: ${trainName(ctx.doc, a.trainId)} (${hhmmss(a.bookedFrom)}–${hhmmss(a.bookedTo)}) と ${trainName(ctx.doc, b.trainId)} (${hhmmss(b.bookedFrom)}–${hhmmss(b.bookedTo)}) が ${overlap}秒 重複しています。`,
            refs: [
              { kind: 'stationTrack', stationTrackId: trackId },
              { kind: 'train', trainId: a.trainId },
              { kind: 'train', trainId: b.trainId },
              { kind: 'station', stationId: a.stationId },
            ],
            at: Math.max(a.from, b.from),
            km: ctx.idx.kmOfStation.get(a.stationId) ?? 0,
          });
        }
      }
    }
    return out;
  },
};

export const trackUnassigned: Rule = {
  id: 'track.unassigned',
  name: '番線が未設定',
  defaultSeverity: 'warning',
  scope: ['tracks', 'trains'],
  run(ctx) {
    const out: Issue[] = [];
    for (const tl of orderedTimelines(ctx)) {
      tl.train.stops.forEach((stop, i) => {
        if (stop.trackId !== undefined) return;
        if (tracksOfStation(ctx.doc, stop.stationId).length === 0) return;
        out.push({
          id: issueId('track.unassigned', tl.trainId, i),
          ruleId: 'track.unassigned',
          severity: 'warning',
          title: '番線が割り当てられていません',
          detail: `${trainName(ctx.doc, tl.trainId)} ${stationName(ctx.doc, stop.stationId)}: 番線が未設定です。`,
          refs: [
            { kind: 'train', trainId: tl.trainId, stopIndex: i },
            { kind: 'station', stationId: stop.stationId },
          ],
          ...atProps(stop.arr ?? stop.dep),
          km: ctx.idx.kmOfStation.get(stop.stationId) ?? 0,
        });
      });
    }
    return out;
  },
};

export const trackDirectionNotAllowed: Rule = {
  id: 'track.directionNotAllowed',
  name: '進行方向が許可されていない番線',
  defaultSeverity: 'error',
  scope: ['tracks', 'trains'],
  run(ctx) {
    const out: Issue[] = [];
    for (const tl of orderedTimelines(ctx)) {
      const dirLabel = tl.direction === 'down' ? '下り' : '上り';
      tl.train.stops.forEach((stop, i) => {
        if (stop.trackId === undefined) return;
        const track = ctx.doc.stationTracks.byId[stop.trackId];
        if (!track || track.directions.includes(tl.direction)) return;
        out.push({
          id: issueId('track.directionNotAllowed', tl.trainId, i),
          ruleId: 'track.directionNotAllowed',
          severity: 'error',
          title: 'この番線はこの方向に使用できません',
          detail: `${trainName(ctx.doc, tl.trainId)} (${dirLabel}) が ${trackFullName(ctx.doc, stop.trackId)} を使用していますが、この番線は ${track.directions.map((d) => (d === 'down' ? '下り' : '上り')).join('・') || '(なし)'} 専用です。`,
          refs: [
            { kind: 'train', trainId: tl.trainId, stopIndex: i },
            { kind: 'stationTrack', stationTrackId: stop.trackId },
          ],
          ...atProps(stop.arr ?? stop.dep),
          km: ctx.idx.kmOfStation.get(stop.stationId) ?? 0,
        });
      });
    }
    return out;
  },
};

export const trackNoPlatform: Rule = {
  id: 'track.noPlatform',
  name: 'ホームのない番線での客扱い',
  defaultSeverity: 'error',
  scope: ['tracks', 'trains'],
  run(ctx) {
    const out: Issue[] = [];
    for (const tl of orderedTimelines(ctx)) {
      const type = ctx.doc.trainTypes.byId[tl.typeId];
      if (type?.isPassengerService !== true) continue;
      tl.train.stops.forEach((stop, i) => {
        if (stop.kind !== 'stop' || stop.operational === true) return;
        if (stop.trackId === undefined) return;
        const track = ctx.doc.stationTracks.byId[stop.trackId];
        if (!track || track.hasPlatform) return;
        out.push({
          id: issueId('track.noPlatform', tl.trainId, i),
          ruleId: 'track.noPlatform',
          severity: 'error',
          title: 'ホームのない番線に客扱い停車しています',
          detail: `${trainName(ctx.doc, tl.trainId)} が ${trackFullName(ctx.doc, stop.trackId)} (通過線・ホームなし) に旅客扱いで停車しています。`,
          refs: [
            { kind: 'train', trainId: tl.trainId, stopIndex: i },
            { kind: 'stationTrack', stationTrackId: stop.trackId },
          ],
          ...atProps(stop.arr ?? stop.dep),
          km: ctx.idx.kmOfStation.get(stop.stationId) ?? 0,
        });
      });
    }
    return out;
  },
};

export const trackLengthExceeded: Rule = {
  id: 'track.lengthExceeded',
  name: '有効長を超える編成',
  defaultSeverity: 'error',
  scope: ['tracks', 'formations'],
  run(ctx) {
    const out: Issue[] = [];
    for (const tl of orderedTimelines(ctx)) {
      const formationId = ctx.idx.formationOfTrain.get(tl.trainId);
      if (formationId === undefined) continue;
      const formation = ctx.doc.formations.byId[formationId];
      if (!formation) continue;
      tl.train.stops.forEach((stop, i) => {
        if (stop.trackId === undefined) return;
        const track = ctx.doc.stationTracks.byId[stop.trackId];
        if (!track || formation.cars <= track.maxCars) return;
        out.push({
          id: issueId('track.lengthExceeded', tl.trainId, i, formationId),
          ruleId: 'track.lengthExceeded',
          severity: 'error',
          title: '番線の有効長を超えています',
          detail: `${trainName(ctx.doc, tl.trainId)} に充当された 編成 ${formation.code} (${formation.cars}両) は ${trackFullName(ctx.doc, stop.trackId)} の有効長 ${track.maxCars}両 を超えています。`,
          refs: [
            { kind: 'stationTrack', stationTrackId: stop.trackId },
            { kind: 'train', trainId: tl.trainId, stopIndex: i },
            { kind: 'formation', formationId },
          ],
          ...atProps(stop.arr ?? stop.dep),
          km: ctx.idx.kmOfStation.get(stop.stationId) ?? 0,
        });
      });
    }
    return out;
  },
};
