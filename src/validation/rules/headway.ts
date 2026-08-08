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
import { formatDuration } from '@/domain/time';
import type { Sec } from '@/domain/units';
import { hhmmss, orderedTimelines, stationName, trainName } from '../helpers';
import { issueId, type Issue, type Rule, type ValidationContext } from '../types';

interface Traversal {
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
