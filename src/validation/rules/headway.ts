/**
 * 時隔 — spacing between trains on the open line.
 *
 * Checking entry times alone is not enough: an express that enters a section
 * a safe two minutes behind a local can still be right behind it at the far
 * end, so exit times are checked with the same threshold.
 */

import type { LinkId, StationId, TrainId } from '@/domain/ids';
import type { Direction } from '@/domain/model';
import { buildLinkLookup, directionBetween } from '@/domain/project';
import { formatDuration, overlapSeconds } from '@/domain/time';
import type { Sec } from '@/domain/units';
import { hhmmss, orderedTimelines, stationName, trainName } from '../helpers';
import { issueId, type Issue, type Rule, type ValidationContext } from '../types';

export interface Traversal {
  trainId: TrainId;
  stopIndex: number;
  enter: Sec;
  exit: Sec;
  fromStationId: StationId;
  toStationId: StationId;
}

/** Every (link, direction) a train traverses, in booked order. */
export function traversalsByLink(
  ctx: ValidationContext,
): Map<string, { linkId: LinkId; direction: Direction; list: Traversal[] }> {
  const lookup = buildLinkLookup(ctx.doc);
  const map = new Map<string, { linkId: LinkId; direction: Direction; list: Traversal[] }>();
  for (const tl of orderedTimelines(ctx)) {
    for (let i = 1; i < tl.train.stops.length; i++) {
      const prev = tl.train.stops[i - 1]!;
      const cur = tl.train.stops[i]!;
      const link = lookup.between(prev.stationId, cur.stationId);
      if (!link) continue;
      const direction = directionBetween(ctx.doc, prev.stationId, cur.stationId);
      if (direction === undefined) continue;
      const enter = prev.dep ?? prev.arr;
      const exit = cur.arr ?? cur.dep;
      if (enter === undefined || exit === undefined) continue;
      const key = `${link.id}|${direction}`;
      const bucket = map.get(key) ?? { linkId: link.id, direction, list: [] };
      bucket.list.push({
        trainId: tl.trainId,
        stopIndex: i,
        enter,
        exit,
        fromStationId: prev.stationId,
        toStationId: cur.stationId,
      });
      map.set(key, bucket);
    }
  }
  return map;
}

export const headwaySection: Rule = {
  id: 'headway.section',
  name: '続行時隔',
  defaultSeverity: 'error',
  scope: ['trains', 'infrastructure'],
  run(ctx) {
    const out: Issue[] = [];
    for (const { linkId, direction, list } of traversalsByLink(ctx).values()) {
      const link = ctx.doc.links.byId[linkId];
      const min = link?.minHeadwaySec ?? ctx.cfg.defaultMinHeadwaySec;
      const sectionLabel = link
        ? `${stationName(ctx.doc, link.fromStationId)}〜${stationName(ctx.doc, link.toStationId)}`
        : String(linkId);
      const dirLabel = direction === 'down' ? '下り' : '上り';

      for (const [field, label] of [
        ['enter', '進入'],
        ['exit', '進出'],
      ] as const) {
        const sorted = [...list].sort(
          (a, b) => a[field] - b[field] || a.trainId.localeCompare(b.trainId),
        );
        for (let i = 1; i < sorted.length; i++) {
          const a = sorted[i - 1]!;
          const b = sorted[i]!;
          const gap = b[field] - a[field];
          if (gap >= min) continue;
          out.push({
            id: issueId('headway.section', linkId, direction, field, a.trainId, b.trainId),
            ruleId: 'headway.section',
            severity: 'error',
            title: '続行時隔が不足しています',
            detail: `${sectionLabel} (${dirLabel}) ${label}時隔: ${trainName(ctx.doc, a.trainId)} ${hhmmss(a[field])} と ${trainName(ctx.doc, b.trainId)} ${hhmmss(b[field])} の間隔は ${formatDuration(gap)} で、最小時隔 ${formatDuration(min)} を下回っています。`,
            refs: [
              { kind: 'train', trainId: b.trainId, stopIndex: b.stopIndex },
              { kind: 'train', trainId: a.trainId, stopIndex: a.stopIndex },
              { kind: 'link', linkId },
            ],
            at: b[field],
            km: ctx.idx.kmOfStation.get(a.fromStationId) ?? 0,
          });
        }
      }
    }
    return out;
  },
};

export const headwayOvertakeMidSection: Rule = {
  id: 'headway.overtakeMidSection',
  name: '駅間での追い抜き',
  defaultSeverity: 'error',
  scope: ['trains', 'infrastructure'],
  run(ctx) {
    const out: Issue[] = [];
    for (const { linkId, direction, list } of traversalsByLink(ctx).values()) {
      const link = ctx.doc.links.byId[linkId];
      const sectionLabel = link
        ? `${stationName(ctx.doc, link.fromStationId)}〜${stationName(ctx.doc, link.toStationId)}`
        : String(linkId);
      const dirLabel = direction === 'down' ? '下り' : '上り';
      for (let i = 0; i < list.length; i++) {
        for (let j = 0; j < list.length; j++) {
          if (i === j) continue;
          const a = list[i]!;
          const b = list[j]!;
          if (!(a.enter < b.enter && b.exit < a.exit)) continue;
          out.push({
            id: issueId('headway.overtakeMidSection', linkId, direction, a.trainId, b.trainId),
            ruleId: 'headway.overtakeMidSection',
            severity: 'error',
            title: '駅間で追い抜きが発生しています',
            detail: `${sectionLabel} (${dirLabel}): ${trainName(ctx.doc, b.trainId)} が ${trainName(ctx.doc, a.trainId)} より後に進入 (${hhmmss(b.enter)} > ${hhmmss(a.enter)}) しながら先に進出 (${hhmmss(b.exit)} < ${hhmmss(a.exit)}) しています。駅間では追い抜けません。`,
            refs: [
              { kind: 'train', trainId: b.trainId, stopIndex: b.stopIndex },
              { kind: 'train', trainId: a.trainId, stopIndex: a.stopIndex },
              { kind: 'link', linkId },
            ],
            at: b.enter,
          });
        }
      }
    }
    return out;
  },
};

/**
 * 単線での行き違い — two trains in the same section at once, going opposite ways.
 *
 * This is the check that makes `Link.trackCount` mean something. The field has
 * always been in the model and has always been editable, but nothing read it,
 * so a document could state that a section was 単線 and then run a down train
 * and an up train through it at the same moment without a word of complaint.
 *
 * The question is asked per link rather than per line, because "this section
 * is single track" is a local fact and a real railway mixes the two freely.
 * (The line *view* cannot: see `isSingleTrackLine`.)
 *
 * ## What this rule does NOT report
 *
 * **A meet at a station with only one road.** `track.doubleOccupancy` already
 * owns that: both trains end up on the same 番線 and it says so, with the
 * approach and clearing margins and the exact overlap. A second rule phrased
 * as "there is no loop here" would say less, later, and about the same fact.
 * Two trains standing at one station is a station problem; two trains *in a
 * section* is this one.
 *
 * **Following moves.** Two trains the same way down a single-track section are
 * spacing, not opposition, and `headway.section` measures it on both the entry
 * and the exit.
 *
 * ## Why `overlapSeconds` and not a margin
 *
 * The test is bare occupancy: the section is clear, or it is not. Touching
 * intervals — one train's exit exactly at the other's entry — do not fire,
 * because a meet where one train arrives as the other departs is ordinary
 * working and not a near miss.
 *
 * What is deliberately absent is a **交換余裕**: the seconds a real single line
 * demands between one train clearing a section and the opposing one being
 * given it. That number comes from the block system — タブレット, スタフ,
 * 特殊自動 — and the model has no block system, so there is no honest place to
 * get it from. `Link.minHeadwaySec` is not it; that is the following interval,
 * which is a different quantity that happens to be measured in seconds.
 */
export const headwaySingleTrackOpposing: Rule = {
  id: 'headway.singleTrackOpposing',
  name: '単線での行き違い',
  defaultSeverity: 'error',
  scope: ['trains', 'infrastructure'],
  run(ctx) {
    const out: Issue[] = [];

    // Regroup by link. `traversalsByLink` keys on `${linkId}|${direction}`,
    // and reconstructing that string here would make this rule depend on the
    // shape of a key rather than on the data.
    const byLink = new Map<LinkId, { down: Traversal[]; up: Traversal[] }>();
    for (const { linkId, direction, list } of traversalsByLink(ctx).values()) {
      if (ctx.doc.links.byId[linkId]?.trackCount !== 1) continue;
      const bucket = byLink.get(linkId) ?? { down: [], up: [] };
      bucket[direction] = list;
      byLink.set(linkId, bucket);
    }

    for (const [linkId, { down, up }] of byLink) {
      const link = ctx.doc.links.byId[linkId];
      const sectionLabel = link
        ? `${stationName(ctx.doc, link.fromStationId)}〜${stationName(ctx.doc, link.toStationId)}`
        : String(linkId);

      for (const d of down) {
        for (const u of up) {
          const overlap = overlapSeconds(d.enter, d.exit, u.enter, u.exit);
          if (overlap <= 0) continue;
          out.push({
            id: issueId('headway.singleTrackOpposing', linkId, d.trainId, u.trainId),
            ruleId: 'headway.singleTrackOpposing',
            severity: 'error',
            title: '単線区間で行き違いが発生しています',
            detail: `${sectionLabel} は単線です: ${trainName(ctx.doc, d.trainId)} (下り ${hhmmss(d.enter)}–${hhmmss(d.exit)}) と ${trainName(ctx.doc, u.trainId)} (上り ${hhmmss(u.enter)}–${hhmmss(u.exit)}) が ${formatDuration(overlap)} 重なっています。行き違いは駅で行ってください。`,
            refs: [
              { kind: 'train', trainId: d.trainId, stopIndex: d.stopIndex },
              { kind: 'train', trainId: u.trainId, stopIndex: u.stopIndex },
              { kind: 'link', linkId },
            ],
            at: Math.max(d.enter, u.enter),
            km: ctx.idx.kmOfStation.get(d.fromStationId) ?? 0,
          });
        }
      }
    }
    return out;
  },
};
