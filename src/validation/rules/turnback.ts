/**
 * 折り返し — a duty reversing direction at the same station.
 *
 * Depots are ordinary stations here: a 回送 arriving from the depot and a
 * service train leaving in the other direction is exactly the same check.
 */

import type { StationTrackId } from '@/domain/ids';
import type { Duty, Train } from '@/domain/model';
import { dutiesForDayType, tracksOfStation, trainEndSec, trainStartSec } from '@/domain/project';
import { formatDuration } from '@/domain/time';
import { dayTypeIdFor } from '@/engine/buildIndex';
import { dutyName, hhmmss, stationName, trackFullName, trainName } from '../helpers';
import { issueId, type Issue, type Rule, type ValidationContext } from '../types';

export interface TurnbackPair {
  duty: Duty;
  legIndex: number;
  arriving: Train;
  departing: Train;
  stationId: Train['stops'][number]['stationId'];
  arrSec: number;
  depSec: number;
  availableSec: number;
  requiredSec: number;
  /** Roads named by `stable` legs sitting between the two train legs. */
  viaTrackIds: StationTrackId[];
}

/**
 * Consecutive *train* legs of one duty that meet at the same station facing
 * opposite ways. Intervening `stable` legs are skipped: the reversal still has
 * to happen, and it still needs the station's minimum turnback time.
 */
export function turnbackPairs(ctx: ValidationContext): TurnbackPair[] {
  const dayTypeId = dayTypeIdFor(ctx.doc, ctx.idx.date);
  const out: TurnbackPair[] = [];
  for (const duty of dutiesForDayType(ctx.doc, dayTypeId)) {
    const legs = duty.legs
      .map((leg, legIndex) => ({ leg, legIndex }))
      .filter((e) => e.leg.kind === 'train');
    for (let i = 1; i < legs.length; i++) {
      const prev = legs[i - 1]!;
      const cur = legs[i]!;
      if (prev.leg.kind !== 'train' || cur.leg.kind !== 'train') continue;
      const arriving = ctx.doc.trains.byId[prev.leg.trainId];
      const departing = ctx.doc.trains.byId[cur.leg.trainId];
      if (!arriving || !departing) continue;
      const last = arriving.stops[arriving.stops.length - 1];
      const first = departing.stops[0];
      if (!last || !first) continue;
      if (last.stationId !== first.stationId) continue;
      if (arriving.direction === departing.direction) continue;
      const arrSec = trainEndSec(arriving);
      const depSec = trainStartSec(departing);
      if (arrSec === undefined || depSec === undefined) continue;
      const station = ctx.doc.stations.byId[last.stationId];
      const viaTrackIds: StationTrackId[] = [];
      for (let k = prev.legIndex + 1; k < cur.legIndex; k++) {
        const between = duty.legs[k];
        if (between?.kind === 'stable' && between.trackId !== undefined) {
          viaTrackIds.push(between.trackId);
        }
      }
      out.push({
        duty,
        legIndex: cur.legIndex,
        viaTrackIds,
        arriving,
        departing,
        stationId: last.stationId,
        arrSec,
        depSec,
        availableSec: depSec - arrSec,
        requiredSec: station?.minTurnbackSec ?? ctx.cfg.defaultMinTurnbackSec,
      });
    }
  }
  return out;
}

export const turnbackInsufficient: Rule = {
  id: 'turnback.insufficient',
  name: '折り返し時分が不足',
  defaultSeverity: 'error',
  scope: ['duties', 'trains'],
  run(ctx) {
    const out: Issue[] = [];
    for (const p of turnbackPairs(ctx)) {
      if (p.availableSec >= p.requiredSec) continue;
      out.push({
        id: issueId('turnback.insufficient', p.duty.id, p.arriving.id, p.departing.id),
        ruleId: 'turnback.insufficient',
        severity: 'error',
        title: '折り返し時分が不足しています',
        detail: `${dutyName(ctx.doc, p.duty.id)} ${stationName(ctx.doc, p.stationId)}: ${trainName(ctx.doc, p.arriving.id)} 着 ${hhmmss(p.arrSec)} から ${trainName(ctx.doc, p.departing.id)} 発 ${hhmmss(p.depSec)} まで ${formatDuration(p.availableSec)} しかなく、最小折り返し時分 ${formatDuration(p.requiredSec)} を満たしません。`,
        refs: [
          { kind: 'duty', dutyId: p.duty.id, legIndex: p.legIndex },
          { kind: 'train', trainId: p.arriving.id },
          { kind: 'train', trainId: p.departing.id },
          { kind: 'station', stationId: p.stationId },
        ],
        at: p.arrSec,
        km: ctx.idx.kmOfStation.get(p.stationId) ?? 0,
      });
    }
    return out;
  },
};

export const turnbackTight: Rule = {
  id: 'turnback.tight',
  name: '折り返し時分が短い',
  defaultSeverity: 'warning',
  scope: ['duties', 'trains'],
  run(ctx) {
    const out: Issue[] = [];
    for (const p of turnbackPairs(ctx)) {
      if (p.availableSec < p.requiredSec) continue; // insufficient covers it
      if (p.availableSec >= ctx.cfg.preferredTurnbackSec) continue;
      out.push({
        id: issueId('turnback.tight', p.duty.id, p.arriving.id, p.departing.id),
        ruleId: 'turnback.tight',
        severity: 'warning',
        title: '折り返し時分に余裕がありません',
        detail: `${dutyName(ctx.doc, p.duty.id)} ${stationName(ctx.doc, p.stationId)}: 折り返し ${formatDuration(p.availableSec)} は推奨 ${formatDuration(ctx.cfg.preferredTurnbackSec)} を下回っています (最小 ${formatDuration(p.requiredSec)} は満たしています)。`,
        refs: [
          { kind: 'duty', dutyId: p.duty.id, legIndex: p.legIndex },
          { kind: 'train', trainId: p.arriving.id },
          { kind: 'train', trainId: p.departing.id },
        ],
        at: p.arrSec,
        km: ctx.idx.kmOfStation.get(p.stationId) ?? 0,
      });
    }
    return out;
  },
};

/**
 * 折り返しで番線が変わっている — the formation arrives on one road and the next
 * train of the same duty leaves from another, with no move between them.
 *
 * The plan is asserting that the stock teleported. Whether that is a mistake or
 * merely an omission depends on the station:
 *
 * - Where a 引上線 / 留置線 exists the move is physically possible; the yard
 *   just is not in the document. That is a **warning**, and the fix is to model
 *   the shunt as a `stable` leg on that road so the occupancy is booked.
 * - Where none exists — 大井町 is 頭端式1面2線 with no tail track — there is no
 *   way to get from one platform road to the other without occupying the
 *   running line, so the plan is simply not executable. That is an **error**.
 *
 * A `stable` leg between the two train legs that names the road the formation
 * moved to *is* the model of the move, so it makes the change legitimate and no
 * issue is raised.
 */
export const turnbackTrackChanged: Rule = {
  id: 'turnback.trackChanged',
  name: '折り返しで番線が変わる',
  defaultSeverity: 'error',
  scope: ['duties', 'tracks'],
  run(ctx) {
    const out: Issue[] = [];
    for (const p of turnbackPairs(ctx)) {
      const arrivingTrackId = p.arriving.stops[p.arriving.stops.length - 1]?.trackId;
      const departingTrackId = p.departing.stops[0]?.trackId;
      if (arrivingTrackId === undefined || departingTrackId === undefined) continue;
      if (arrivingTrackId === departingTrackId) continue;
      // A modelled berth between the two legs is the move: nothing to report.
      if (p.viaTrackIds.includes(departingTrackId)) continue;

      const shuntable = tracksOfStation(ctx.doc, p.stationId).some(
        (t) => t.usage === 'stabling' || t.usage === 'depot',
      );
      out.push({
        id: issueId('turnback.trackChanged', p.duty.id, p.arriving.id, p.departing.id),
        ruleId: 'turnback.trackChanged',
        severity: shuntable ? 'warning' : 'error',
        title: shuntable
          ? '折り返しで番線が変わりますが入換が組まれていません'
          : '折り返しで番線が変わりますが移動できません',
        detail:
          `${dutyName(ctx.doc, p.duty.id)} ${stationName(ctx.doc, p.stationId)}: ` +
          `${trainName(ctx.doc, p.arriving.id)} は ${trackFullName(ctx.doc, arrivingTrackId)} に到着し、` +
          `${trainName(ctx.doc, p.departing.id)} は ${trackFullName(ctx.doc, departingTrackId)} から出発しますが、` +
          `その間の入換が計画にありません。` +
          (shuntable
            ? '引上線・留置線があるので移動自体は可能です。留置レグで番線を指定してください。'
            : 'この駅には引上線も留置線もなく、本線を支障せずにホーム間を移動することはできません。'),
        refs: [
          { kind: 'duty', dutyId: p.duty.id, legIndex: p.legIndex },
          { kind: 'stationTrack', stationTrackId: arrivingTrackId },
          { kind: 'stationTrack', stationTrackId: departingTrackId },
          { kind: 'station', stationId: p.stationId },
        ],
        at: p.arrSec,
        km: ctx.idx.kmOfStation.get(p.stationId) ?? 0,
      });
    }
    return out;
  },
};

export const turnbackTrackNotCapable: Rule = {
  id: 'turnback.trackNotCapable',
  name: '折り返しできない番線',
  defaultSeverity: 'error',
  scope: ['duties', 'tracks'],
  run(ctx) {
    const out: Issue[] = [];
    for (const p of turnbackPairs(ctx)) {
      const arrivingTrackId = p.arriving.stops[p.arriving.stops.length - 1]?.trackId;
      const departingTrackId = p.departing.stops[0]?.trackId;
      for (const [trackId, who] of [
        [arrivingTrackId, p.arriving],
        [departingTrackId, p.departing],
      ] as const) {
        if (trackId === undefined) continue;
        const track = ctx.doc.stationTracks.byId[trackId];
        if (!track || track.canTurnBack) continue;
        out.push({
          id: issueId('turnback.trackNotCapable', p.duty.id, who.id, trackId),
          ruleId: 'turnback.trackNotCapable',
          severity: 'error',
          title: '折り返しできない番線です',
          detail: `${dutyName(ctx.doc, p.duty.id)}: ${trainName(ctx.doc, who.id)} が ${trackFullName(ctx.doc, trackId)} で折り返そうとしていますが、この番線は折り返し不可です。`,
          refs: [
            { kind: 'stationTrack', stationTrackId: trackId },
            { kind: 'duty', dutyId: p.duty.id, legIndex: p.legIndex },
            { kind: 'train', trainId: who.id },
          ],
          at: p.arrSec,
          km: ctx.idx.kmOfStation.get(p.stationId) ?? 0,
        });
      }
    }
    return out;
  },
};
