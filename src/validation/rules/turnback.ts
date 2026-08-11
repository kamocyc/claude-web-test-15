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
  /**
   * True when the formation actually reverses. A hand-over between two legs
   * running the SAME way — a 回送 arriving from beyond the terminus and then
   * departing onward, for instance — is not a reversal and so is not held to
   * the station's 折り返し time. It still has to be standing on the road it
   * departs from, though, which is why `turnback.trackChanged` looks at every
   * pair and the timing rules look only at reversals.
   */
  isReversal: boolean;
}

/**
 * Consecutive *train* legs of one duty that meet at the same station.
 *
 * Most are reversals, and those are held to the station's minimum turnback
 * time. A pair running the same way is not a reversal — a 回送 arriving from
 * beyond the terminus and continuing onward, say — but the formation still has
 * to be standing on the road it departs from, so the pair is returned with
 * `isReversal: false` and only the track-continuity rule looks at it. Skipping
 * these entirely, as this function used to, left same-direction hand-overs
 * changing road with nothing to catch them.
 *
 * Intervening `stable` legs are skipped: the reversal still has to happen.
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
      const isReversal = arriving.direction !== departing.direction;
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
        isReversal,
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
      if (!p.isReversal) continue;
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
      if (!p.isReversal) continue;
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
 * issue is raised. So is a `stable` leg on a 引上線 / 留置線 of the same station:
 * that is the canonical 頭端 turnback — 溝の口 arrives at 2番線 (降車専用), shunts
 * out to a 引上線 for the layover and comes back into 3番線 (大井町方面) to load.
 * The plan is not claiming the stock teleported; it is naming the tail track the
 * two shunt moves run over, which is precisely what the rule asks for. Only the
 * duration of the two moves is idealised away, and that is the documented v1
 * model for every shunt, including the one to the departure road itself.
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

      const shuntRoads = new Set(
        tracksOfStation(ctx.doc, p.stationId)
          .filter((t) => t.usage === 'stabling' || t.usage === 'depot')
          .map((t) => t.id),
      );
      // …and so is a berth on a tail track of the same station: platform →
      // 引上線 → platform is one modelled move, not a teleport.
      if (p.viaTrackIds.some((id) => shuntRoads.has(id))) continue;

      const shuntable = shuntRoads.size > 0;
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
      // Only a reversal needs a road that can actually turn a train.
      if (!p.isReversal) continue;
      const arrivingTrackId = p.arriving.stops[p.arriving.stops.length - 1]?.trackId;
      const departingTrackId = p.departing.stops[0]?.trackId;
      // A reversal shunted into a 引上線 turns *there*. The platform roads are
      // entered from one end and left from the other, which any road can do —
      // demanding 折り返し可 of them as well is asking a 相対式 platform to be
      // something it never has to be, and would make the tail track useless
      // for the one job it exists to do.
      const viaTurn = p.viaTrackIds
        .map((id) => ctx.doc.stationTracks.byId[id])
        .find((t) => t !== undefined && (t.usage === 'stabling' || t.usage === 'depot'));
      const checked =
        viaTurn === undefined
          ? ([
              [arrivingTrackId, p.arriving],
              [departingTrackId, p.departing],
            ] as const)
          : ([[viaTurn.id, p.arriving]] as const);
      for (const [trackId, who] of checked) {
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
