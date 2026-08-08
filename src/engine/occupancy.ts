/**
 * A train occupies exactly one StationTrack over
 * `[arr - approachSec, dep + clearSec]`. That deliberately simple model is
 * the v1 構内ダイヤ: route and point conflicts are explicitly out of scope.
 */

import type { StationTrackId, TrainId } from '@/domain/ids';
import type { ProjectDocument } from '@/domain/model';
import { dutyOfTrainMap, trainStartSec } from '@/domain/project';
import { entityList } from '@/domain/units';
import type { OccupancyInterval, TrainTimeline } from './types';

/**
 * For a terminus that turns back, the formation physically stays on the track
 * until the next train of the same duty leaves. `nextDepartureOfDuty` finds
 * that departure so the interval can be extended; anything more elaborate
 * (release/re-occupation, shunting moves) is out of scope for v1.
 */
function nextDepartureOfDuty(
  doc: ProjectDocument,
  trainId: TrainId,
): { stationId: string; dep: number } | undefined {
  const dutyId = dutyOfTrainMap(doc).get(trainId);
  if (dutyId === undefined) return undefined;
  const duty = doc.duties.byId[dutyId];
  if (!duty) return undefined;
  const trainLegs = duty.legs.filter((l) => l.kind === 'train');
  const at = trainLegs.findIndex((l) => l.kind === 'train' && l.trainId === trainId);
  if (at < 0 || at + 1 >= trainLegs.length) return undefined;
  const nextLeg = trainLegs[at + 1]!;
  if (nextLeg.kind !== 'train') return undefined;
  const next = doc.trains.byId[nextLeg.trainId];
  if (!next) return undefined;
  const origin = next.stops[0];
  const dep = trainStartSec(next);
  if (origin === undefined || dep === undefined) return undefined;
  return { stationId: origin.stationId, dep };
}

export function buildTrackIntervals(
  doc: ProjectDocument,
  timelines: Map<TrainId, TrainTimeline>,
): Map<StationTrackId, OccupancyInterval[]> {
  const out = new Map<StationTrackId, OccupancyInterval[]>();
  // Pre-seed so that every known track has a (possibly empty) list.
  for (const track of entityList(doc.stationTracks)) out.set(track.id, []);

  for (const tl of timelines.values()) {
    const lastIndex = tl.train.stops.length - 1;
    for (const event of tl.events) {
      const trackId = event.trackId;
      if (trackId === undefined) continue;
      const track = doc.stationTracks.byId[trackId];
      if (!track) continue;

      // `dep` at the origin, `arr` at the terminus — whichever exists.
      const bookedFrom = event.arr ?? event.dep;
      let bookedTo = event.dep ?? event.arr;
      if (bookedFrom === undefined || bookedTo === undefined) continue;

      const stop = tl.train.stops[event.stopIndex];
      if (event.stopIndex === lastIndex && stop?.operation === 'turnback') {
        const next = nextDepartureOfDuty(doc, tl.trainId);
        if (next && next.stationId === event.stationId && next.dep > bookedTo) {
          bookedTo = next.dep;
        }
      }

      const list = out.get(trackId) ?? [];
      list.push({
        trackId,
        stationId: event.stationId,
        trainId: tl.trainId,
        from: bookedFrom - track.approachSec,
        to: bookedTo + track.clearSec,
        bookedFrom,
        bookedTo,
      });
      out.set(trackId, list);
    }
  }

  for (const list of out.values()) {
    list.sort((a, b) => a.from - b.from || a.to - b.to || a.trainId.localeCompare(b.trainId));
  }
  return out;
}
