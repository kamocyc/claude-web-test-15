/**
 * A train occupies exactly one StationTrack over
 * `[arr - approachSec, dep + clearSec]`. That deliberately simple model is
 * the v1 構内ダイヤ: route and point conflicts are explicitly out of scope.
 *
 * Two things extend a booking beyond one train's own stop list, and both of
 * them are properties of the **duty**, not of the train:
 *
 * 1. **折り返し.** A formation that arrives at a terminus and works the next
 *    train out of the same station is standing on that road the whole time in
 *    between. The booking therefore runs from the arrival to the next
 *    departure of the same duty, not to the arrival plus a clearance.
 *
 * 2. **留置.** A `stable` leg is a formation standing somewhere for a long
 *    layover. When it names a `trackId` that road is booked for the whole leg
 *    and the arrival road is released at the start of it (the shunt between
 *    the two is instantaneous in v1 — see `turnback.trackChanged`, which is the
 *    rule that reports the unmodelled move). When it names none, the honest
 *    reading is that the formation never moved, so the arrival road stays
 *    booked for the whole layover.
 *
 * The extension is derived from the duty rather than gated on
 * `TrainStop.operation === 'turnback'` on purpose. Whether the platform is
 * still occupied is a physical consequence of the roster; a flag that a human
 * editor forgot to set must not be able to make a conflict disappear. The
 * generator does set `operation: 'turnback'` — it is authored intent, and it
 * drives the 折り返し dwell reason and the yard view — but nothing here depends
 * on it.
 */

import type { StationId, StationTrackId, TrainId } from '@/domain/ids';
import type { ProjectDocument } from '@/domain/model';
import { trainEndSec, trainStartSec } from '@/domain/project';
import { entityList, type Sec } from '@/domain/units';
import type { OccupancyInterval, TrainTimeline } from './types';

interface StableBooking {
  trackId: StationTrackId;
  stationId: StationId;
  /** The train the stock came in on — occupancy has to be attributable. */
  trainId: TrainId;
  from: Sec;
  to: Sec;
}

interface DutyOccupancy {
  /** trainId -> the moment its formation finally vacates the terminus road. */
  holdUntil: Map<TrainId, Sec>;
  stableBookings: StableBooking[];
}

function dutyOccupancy(doc: ProjectDocument): DutyOccupancy {
  const holdUntil = new Map<TrainId, Sec>();
  const stableBookings: StableBooking[] = [];

  for (const duty of entityList(doc.duties)) {
    /** The train whose terminus road the formation is still standing on. */
    let holder: TrainId | undefined;
    let holderStationId: StationId | undefined;
    let holderEnd: Sec | undefined;

    for (const leg of duty.legs) {
      if (leg.kind === 'train') {
        const train = doc.trains.byId[leg.trainId];
        if (train === undefined) continue;
        const origin = train.stops[0];
        const dep = trainStartSec(train);
        if (
          holder !== undefined &&
          holderEnd !== undefined &&
          dep !== undefined &&
          origin?.stationId === holderStationId &&
          dep > holderEnd
        ) {
          const prev = holdUntil.get(holder);
          if (prev === undefined || dep > prev) holdUntil.set(holder, dep);
        }
        const terminus = train.stops[train.stops.length - 1];
        holder = train.id;
        holderStationId = terminus?.stationId;
        holderEnd = trainEndSec(train);
        continue;
      }

      if (leg.kind === 'stable') {
        if (leg.trackId !== undefined) {
          if (holder !== undefined) {
            stableBookings.push({
              trackId: leg.trackId,
              stationId: leg.stationId,
              trainId: holder,
              from: leg.from,
              to: leg.to,
            });
          }
          // The stock has moved to the named road; the arrival road is free.
          holder = undefined;
        } else if (holder !== undefined && leg.stationId === holderStationId) {
          // No berth named: the formation is still where it arrived.
          const prev = holdUntil.get(holder);
          if (prev === undefined || leg.to > prev) holdUntil.set(holder, leg.to);
        } else {
          holder = undefined;
        }
        holderStationId = leg.stationId;
        holderEnd = leg.to;
        continue;
      }

      // An inspection leg happens inside the depot, not on a station road.
      holder = undefined;
      holderStationId = undefined;
      holderEnd = undefined;
    }
  }

  return { holdUntil, stableBookings };
}

export function buildTrackIntervals(
  doc: ProjectDocument,
  timelines: Map<TrainId, TrainTimeline>,
): Map<StationTrackId, OccupancyInterval[]> {
  const out = new Map<StationTrackId, OccupancyInterval[]>();
  // Pre-seed so that every known track has a (possibly empty) list.
  for (const track of entityList(doc.stationTracks)) out.set(track.id, []);

  const { holdUntil, stableBookings } = dutyOccupancy(doc);

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

      if (event.stopIndex === lastIndex) {
        const held = holdUntil.get(tl.trainId);
        if (held !== undefined && held > bookedTo) bookedTo = held;
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

  for (const booking of stableBookings) {
    const track = doc.stationTracks.byId[booking.trackId];
    if (!track) continue;
    // Only count a stabled formation that the day's timelines actually run.
    if (!timelines.has(booking.trainId)) continue;
    const list = out.get(booking.trackId) ?? [];
    list.push({
      trackId: booking.trackId,
      stationId: booking.stationId,
      trainId: booking.trainId,
      from: booking.from - track.approachSec,
      to: booking.to + track.clearSec,
      bookedFrom: booking.from,
      bookedTo: booking.to,
    });
    out.set(booking.trackId, list);
  }

  for (const list of out.values()) {
    list.sort((a, b) => a.from - b.from || a.to - b.to || a.trainId.localeCompare(b.trainId));
  }
  return out;
}
