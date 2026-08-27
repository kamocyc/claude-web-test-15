/**
 * 交換(行き違い)の検出 — the single-track mirror of `detectOvertakes`.
 *
 * Two trains going opposite ways cannot pass each other between stations when
 * only one track runs between them, so on a single-track line they have to do
 * it standing still, at a place with two roads. That standing-still is the
 * whole of what this module finds: a station where a down train and an up
 * train are both present at once, with single track on at least one side.
 *
 * Why the adjacency test matters. Two opposing trains at the same platform on
 * a double-track line are not a 交換 — they are simply two trains at a
 * station, and calling every such coincidence a meet would report hundreds of
 * them on the Oimachi Line and mean nothing. A meet is defined by the
 * constraint that forces it, so the constraint is what is looked for.
 *
 * Deliberately *descriptive*: it reports meets, it does not judge them. A meet
 * at a station with one road is caught by `track.doubleOccupancy`, which knows
 * the approach and clearing margins and says so with the numbers. See the note
 * on `MeetEvent`.
 */

import type { StationId, TrainId } from '@/domain/ids';
import type { ProjectDocument } from '@/domain/model';
import { buildLinkLookup, orderedStations } from '@/domain/project';
import { overlapSeconds } from '@/domain/time';
import type { MeetEvent, TrainEvent, TrainTimeline } from './types';

interface StationVisit {
  tl: TrainTimeline;
  event: TrainEvent;
}

/**
 * Stations with single track on at least one side.
 *
 * Built from the running order rather than from every link, so the stub into a
 * yard — single track by its nature — never makes the station it hangs off
 * look like a passing place on a single-track line.
 */
function singleTrackStations(doc: ProjectDocument): Set<StationId> {
  const lookup = buildLinkLookup(doc);
  const ordered = orderedStations(doc);
  const out = new Set<StationId>();
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1]!;
    const b = ordered[i]!;
    const link = lookup.between(a.id, b.id);
    if (link?.trackCount !== 1) continue;
    out.add(a.id);
    out.add(b.id);
  }
  return out;
}

export function detectMeets(
  doc: ProjectDocument,
  timelines: Map<TrainId, TrainTimeline>,
): MeetEvent[] {
  const single = singleTrackStations(doc);
  if (single.size === 0) return [];

  const byStation = new Map<StationId, StationVisit[]>();
  for (const tl of timelines.values()) {
    for (const event of tl.events) {
      if (!single.has(event.stationId)) continue;
      // Only a train that stands can be met: a 通過 is past before the
      // opposing train can be alongside it, and on single track it could not
      // be there at all.
      if (event.arr === undefined || event.dep === undefined) continue;
      const list = byStation.get(event.stationId);
      if (list) list.push({ tl, event });
      else byStation.set(event.stationId, [{ tl, event }]);
    }
  }

  const out: MeetEvent[] = [];
  for (const [stationId, visits] of byStation) {
    for (const a of visits) {
      if (a.tl.direction !== 'down') continue;
      for (const b of visits) {
        if (b.tl.direction !== 'up') continue;
        const overlap = overlapSeconds(a.event.arr!, a.event.dep!, b.event.arr!, b.event.dep!);
        if (overlap <= 0) continue;
        out.push({
          stationId,
          downTrainId: a.tl.trainId,
          upTrainId: b.tl.trainId,
          at: Math.max(a.event.arr!, b.event.arr!),
          overlapSec: overlap,
        });
      }
    }
  }

  out.sort(
    (x, y) =>
      x.at - y.at ||
      x.downTrainId.localeCompare(y.downTrainId) ||
      x.upTrainId.localeCompare(y.upTrainId),
  );
  return out;
}
