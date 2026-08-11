/**
 * 平面交差支障 — two moves through one throat that cross each other.
 *
 * Every other 構内 rule looks at where a train *stands*. This one looks at how
 * it gets there: an arrival, a departure or an 入換 sweeps across a band of the
 * throat, and two moves whose bands intersect cannot both be made at once even
 * though neither uses the other's road. That is the conflict a 番線 table
 * cannot show and a 構内配線図 exists to show — a 引上線 beyond the up platform
 * turns every shunt in and out of it into a move across the 上り本線.
 *
 * The geometry, and what the rule deliberately leaves to other rules, is in
 * `src/domain/wiring.ts`. What is here is only the timetable half: which moves
 * exist, when each occupies the throat, and which pairs overlap.
 */

import type { StationId } from '@/domain/ids';
import { movesCross, endTowards, stationWiring, shuntMove, trainMove } from '@/domain/wiring';
import type { ThroatMove } from '@/domain/wiring';
import type { StationEnd } from '@/domain/model';
import { STATION_END_LABEL } from '@/domain/model';
import { overlapSeconds } from '@/domain/time';
import type { Sec } from '@/domain/units';
import { LAYOVER_SHUNT_SEC } from '@/engine/position';
import type { TrainId } from '@/domain/ids';
import { hhmmss, orderedTimelines, stationName, trackName, trainName } from '../helpers';
import { issueId, type Issue, type Rule, type ValidationContext } from '../types';

/**
 * How long a move holds the throat when the roads it joins say nothing useful.
 *
 * A train's own 進入/開通 margins are the right numbers — they are already the
 * time the road is held for it — but an 入換 belongs to no arrival or
 * departure, so it takes the time the engine draws it moving for.
 */
const SHUNT_HOLD_SEC = LAYOVER_SHUNT_SEC;

interface TimedMove extends ThroatMove {
  stationId: StationId;
  trainId: TrainId;
  dutyId?: string | undefined;
  /** The instant the move is booked at — what the issue focuses the clock on. */
  at: Sec;
  from0: Sec;
  to0: Sec;
  what: string;
}

function label(ctx: ValidationContext, move: TimedMove): string {
  const doc = ctx.doc;
  if (move.kind === 'shunt') {
    return `${trainName(doc, move.trainId)} の入換 ${trackName(doc, move.fromTrackId)}→${trackName(doc, move.trackId)}`;
  }
  const verb = move.kind === 'arrive' ? '進入' : '進出';
  return `${trainName(doc, move.trainId)} ${trackName(doc, move.trackId)} ${verb}`;
}

/** Every move through every throat, grouped by station and end. */
function collectMoves(ctx: ValidationContext): Map<string, TimedMove[]> {
  const out = new Map<string, TimedMove[]>();
  const push = (stationId: StationId, end: StationEnd, move: TimedMove): void => {
    const key = `${stationId}|${end}`;
    const list = out.get(key);
    if (list === undefined) out.set(key, [move]);
    else list.push(move);
  };

  const kmOf = (id: StationId): number => ctx.idx.kmOfStation.get(id) ?? 0;

  for (const tl of orderedTimelines(ctx)) {
    const wiringOf = (id: StationId) => stationWiring(ctx.doc, id);
    const dutyId = ctx.idx.dutyOfTrain.get(tl.trainId);

    tl.events.forEach((event, i) => {
      const station = ctx.doc.stations.byId[event.stationId];
      // A yard has a throat too, and a much busier one — but its ladder is not
      // in the document (every road is simply a road off the same lead), so
      // there is nothing here to be right about. 出入庫 through the yard lead is
      // what `depot.capacityExceeded` and the 構内ダイヤ cover.
      if (station === undefined || station.kind === 'depot') return;
      const wiring = wiringOf(event.stationId);
      const track =
        event.trackId === undefined ? undefined : ctx.doc.stationTracks.byId[event.trackId];
      const prev = tl.events[i - 1];
      const next = tl.events[i + 1];

      if (prev !== undefined) {
        const at = event.arr ?? event.at;
        const move = trainMove(wiring, {
          kind: 'arrive',
          trackId: event.trackId,
          direction: tl.direction,
          end: endTowards(station, kmOf(prev.stationId)),
        });
        if (move !== undefined) {
          push(event.stationId, move.end, {
            ...move,
            stationId: event.stationId,
            trainId: tl.trainId,
            dutyId,
            at,
            from0: at - (track?.approachSec ?? 30),
            to0: at,
            what: 'arrive',
          });
        }
      }

      if (next !== undefined) {
        const at = event.dep ?? event.at;
        const move = trainMove(wiring, {
          kind: 'depart',
          trackId: event.trackId,
          direction: tl.direction,
          end: endTowards(station, kmOf(next.stationId)),
        });
        if (move !== undefined) {
          push(event.stationId, move.end, {
            ...move,
            stationId: event.stationId,
            trainId: tl.trainId,
            dutyId,
            at,
            from0: at,
            to0: at + (track?.clearSec ?? 20),
            what: 'depart',
          });
        }
      }
    });

    // 入換 — the stock crossing the station between two roads during a layover.
    const layover = tl.layover;
    if (layover === undefined) continue;
    if (ctx.doc.stations.byId[layover.stationId]?.kind === 'depot') continue;
    const wiring = wiringOf(layover.stationId);
    for (let k = 1; k < layover.berths.length; k++) {
      const a = layover.berths[k - 1]!;
      const b = layover.berths[k]!;
      if (a.trackId === undefined || b.trackId === undefined) continue;
      const move = shuntMove(wiring, a.trackId, b.trackId);
      if (move === undefined) continue;
      push(layover.stationId, move.end, {
        ...move,
        stationId: layover.stationId,
        trainId: tl.trainId,
        dutyId,
        at: b.from,
        from0: b.from,
        to0: b.from + SHUNT_HOLD_SEC,
        what: 'shunt',
      });
    }
  }
  return out;
}

/**
 * 進路がない — a move the wiring does not join up.
 *
 * The companion to 平面交差支障, and the stricter of the two: that one says two
 * moves cannot be made *at once*, this one says one of them cannot be made at
 * all. A 回送 booked into 溝の口 2番線 off the 鷺沼 line is the case it exists
 * for — the 大井町線 ends at the platform ends and the rails beyond belong to
 * the 田園都市線, so the stock has to terminate in a 引上線 and shunt across.
 *
 * One issue per booked move rather than one per wiring fault, because a plan
 * with the same impossible move at 06:00 and at 22:00 has two things to fix and
 * the times are how you find them.
 */
export const trackRouteMissing: Rule = {
  id: 'track.routeMissing',
  name: '進路なし',
  defaultSeverity: 'error',
  scope: ['tracks'],
  run(ctx) {
    const out: Issue[] = [];
    for (const [key, moves] of collectMoves(ctx)) {
      const end = key.slice(key.indexOf('|') + 1) as StationEnd;
      for (const move of moves) {
        if (move.routing !== 'none') continue;
        const how =
          move.kind === 'shunt'
            ? `${trackName(ctx.doc, move.fromTrackId)} と ${trackName(ctx.doc, move.trackId)} は${STATION_END_LABEL[end]}でつながっていません`
            : `${trackName(ctx.doc, move.trackId)} は${STATION_END_LABEL[end]}で${move.lineDirection === 'down' ? '下り' : '上り'}本線とつながっていません`;
        out.push({
          id: issueId(
            'track.routeMissing',
            move.stationId,
            end,
            move.trainId,
            move.kind,
            move.at,
          ),
          ruleId: 'track.routeMissing',
          severity: 'error',
          title: '構内に進路がありません',
          detail: `${stationName(ctx.doc, move.stationId)}: ${label(ctx, move)} (${hhmmss(move.at)}) — ${how}。`,
          refs: [
            { kind: 'station', stationId: move.stationId },
            { kind: 'train', trainId: move.trainId },
            ...(move.trackId === undefined
              ? []
              : [{ kind: 'stationTrack' as const, stationTrackId: move.trackId }]),
          ],
          at: move.at,
          km: ctx.idx.kmOfStation.get(move.stationId) ?? 0,
        });
      }
    }
    return out;
  },
};

export const trackCrossingConflict: Rule = {
  id: 'track.crossingConflict',
  name: '平面交差支障',
  defaultSeverity: 'warning',
  scope: ['tracks'],
  run(ctx) {
    const out: Issue[] = [];
    for (const [key, moves] of collectMoves(ctx)) {
      moves.sort((a, b) => a.from0 - b.from0 || a.trainId.localeCompare(b.trainId));
      const end = key.slice(key.indexOf('|') + 1) as StationEnd;
      for (let i = 0; i < moves.length; i++) {
        for (let j = i + 1; j < moves.length; j++) {
          const a = moves[i]!;
          const b = moves[j]!;
          if (b.from0 >= a.to0) break;
          // One duty is one formation: it cannot cross in front of itself.
          if (a.dutyId !== undefined && a.dutyId === b.dutyId) continue;
          if (a.trainId === b.trainId) continue;
          if (!movesCross(a, b)) continue;
          const overlap = overlapSeconds(a.from0, a.to0, b.from0, b.to0);
          if (overlap <= 0) continue;
          out.push({
            id: issueId('track.crossingConflict', a.stationId, end, a.trainId, b.trainId, a.at),
            ruleId: 'track.crossingConflict',
            severity: 'warning',
            title: '構内で進路が平面交差しています',
            detail: `${stationName(ctx.doc, a.stationId)} ${STATION_END_LABEL[end]}: ${label(ctx, a)} (${hhmmss(a.from0)}–${hhmmss(a.to0)}) と ${label(ctx, b)} (${hhmmss(b.from0)}–${hhmmss(b.to0)}) の進路が交差し、${overlap}秒 重なっています。`,
            refs: [
              { kind: 'station', stationId: a.stationId },
              { kind: 'train', trainId: a.trainId },
              { kind: 'train', trainId: b.trainId },
              ...(a.trackId === undefined
                ? []
                : [{ kind: 'stationTrack' as const, stationTrackId: a.trackId }]),
            ],
            at: Math.max(a.from0, b.from0),
            km: ctx.idx.kmOfStation.get(a.stationId) ?? 0,
          });
        }
      }
    }
    return out;
  },
};
