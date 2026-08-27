/**
 * A duty that exists to stand still: out of the depot, into a 引上線, back.
 *
 * Every other duty in the plan is a chain of service trains with an empty move
 * bolted on either end. This one is the other thing a roster does with a tail
 * track — hold a formation at an outlying station between the peaks, so that
 * the evening 出庫 is a five-minute run rather than a half-hour one from 鷺沼.
 *
 * It is also the one duty in the document that exercises a 引上線 the way the
 * 構内配線 model describes it: the stock arrives on a platform road, is shunted
 * across the throat into the tail track, and is shunted back out onto the other
 * platform road hours later. At 自由が丘 the tail track lies beyond the up
 * platform, so both of those moves cross the 上り本線 — which is precisely what
 * `track.crossingConflict` reports if the times are chosen badly, and precisely
 * why the times are not.
 */

import type { DutyId, StationId } from '@/domain/ids';
import type { DayTypeId } from '@/domain/ids';
import type { Duty, DutyLeg, Train } from '@/domain/model';
import type { Sec } from '@/domain/units';
import { SeedError } from '../errors';
import { buildEmptyMove, type DepotRunContext } from './depotRuns';

export interface HoldDutySpec {
  /** Where the formation is held. Must have a 引上線 or a 留置線. */
  stationId: StationId;
  cars: number;
  /** Latest arrival of the 出庫回送. */
  arriveBy: Sec;
  /** Earliest departure of the 入庫回送. */
  departAfter: Sec;
  code: string;
  dutyId: DutyId;
  dayTypeId: DayTypeId;
}

export interface HoldDutyResult {
  trains: Train[];
  duty: Duty;
  from: Sec;
  to: Sec;
  stationId: StationId;
  berthTrackId: string;
}

export function buildHoldDuty(ctx: DepotRunContext, spec: HoldDutySpec): HoldDutyResult {
  const { depot } = ctx;
  const stationId = spec.stationId;

  // Out first, because the berth cannot be claimed until both ends of the hold
  // are known, and the arrival is the end that moves.
  const out = buildEmptyMove(ctx, {
    fromStationId: depot.stationId,
    toStationId: stationId,
    cars: spec.cars,
    anchor: { kind: 'arriveBy', at: spec.arriveBy },
    markFirst: 'depotOut',
    markLast: 'turnback',
    note: '出庫回送',
    // The platform road, not the tail track: the shunt across the throat is
    // the point of the duty, and berthing straight into the 引上線 would hide
    // it. The tail track is claimed below, for the hold itself.
    preferStablingAtTerminus: false,
  });
  const inbound = buildEmptyMove(ctx, {
    fromStationId: stationId,
    toStationId: depot.stationId,
    cars: spec.cars,
    anchor: { kind: 'departAfter', at: spec.departAfter },
    markFirst: 'turnback',
    markLast: 'depotIn',
    note: '入庫回送',
    preferStablingAtOrigin: false,
  });

  const arrive = out.train.stops[out.train.stops.length - 1]!;
  const depart = inbound.train.stops[0]!;
  const from = arrive.arr ?? arrive.dep;
  const to = depart.dep ?? depart.arr;
  if (from === undefined || to === undefined || !(to > from)) {
    throw new SeedError('留置運用の在線時間が求まりません', { code: spec.code });
  }

  const berthTrackId = ctx.booking.placeBerth(
    stationId,
    out.train.id,
    spec.cars,
    'om',
    from,
    to,
    { sidingOnly: true },
  );
  if (berthTrackId === undefined) {
    throw new SeedError('留置運用の引上線を確保できません', { code: spec.code, from, to });
  }

  const legs: DutyLeg[] = [
    { kind: 'train', trainId: out.train.id },
    { kind: 'stable', stationId, trackId: berthTrackId, from, to },
    { kind: 'train', trainId: inbound.train.id },
  ];

  return {
    trains: [out.train, inbound.train],
    duty: {
      id: spec.dutyId,
      code: spec.code,
      dayTypeIds: [spec.dayTypeId],
      legs,
      requiredCars: spec.cars,
    },
    from: out.train.stops[0]!.dep!,
    to: inbound.train.stops[inbound.train.stops.length - 1]!.arr!,
    stationId,
    berthTrackId,
  };
}
