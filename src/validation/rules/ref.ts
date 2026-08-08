/**
 * 参照整合性 — every id mentioned in the document must resolve.
 *
 * This rule short-circuits the whole run (see `run.ts`): a dangling id makes
 * every downstream rule produce cascading noise from one root cause.
 */

import { asId } from '@/domain/ids';
import { checkReferentialIntegrity } from '@/domain/integrity';
import { issueId, type EntityRef, type Issue, type Rule } from '../types';

/** `trains.trn-1.stops[0].trackId` -> a jump target for the problem panel. */
function refFromPath(path: string): EntityRef | undefined {
  const m = /^([A-Za-z]+)\.([^.[\]]+)/.exec(path);
  if (!m) return undefined;
  const [, collection, id] = m;
  if (id === undefined) return undefined;
  switch (collection) {
    case 'stations':
      return { kind: 'station', stationId: asId<'Station'>(id) };
    case 'stationTracks':
      return { kind: 'stationTrack', stationTrackId: asId<'StationTrack'>(id) };
    case 'links':
      return { kind: 'link', linkId: asId<'Link'>(id) };
    case 'depots':
      return { kind: 'depot', depotId: asId<'Depot'>(id) };
    case 'trains':
      return { kind: 'train', trainId: asId<'Train'>(id) };
    case 'duties':
      return { kind: 'duty', dutyId: asId<'Duty'>(id) };
    case 'formations':
      return { kind: 'formation', formationId: asId<'Formation'>(id) };
    default:
      return undefined;
  }
}

export const refDangling: Rule = {
  id: 'ref.dangling',
  name: '参照先が存在しない',
  defaultSeverity: 'error',
  scope: ['infrastructure', 'trains', 'duties', 'formations', 'inspections', 'calendar'],
  run(ctx) {
    const out: Issue[] = [];
    for (const dangling of checkReferentialIntegrity(ctx.doc)) {
      const primary = refFromPath(dangling.path);
      out.push({
        id: issueId('ref.dangling', dangling.path, dangling.id),
        ruleId: 'ref.dangling',
        severity: 'error',
        title: '参照先が存在しません',
        detail: `${dangling.path} が参照する ${dangling.expected} 「${dangling.id}」 は存在しません。`,
        refs: primary ? [primary] : [],
      });
    }
    return out;
  },
};
