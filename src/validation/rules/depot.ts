/**
 * 車庫 — stabling capacity and depot access.
 *
 * A depot is a Station with `kind: 'depot'`, so the movements in and out are
 * ordinary trains and are found by walking their stop lists.
 */

import type { DepotId, FormationId } from '@/domain/ids';
import { formatDuration } from '@/domain/time';
import { entityList } from '@/domain/units';
import { depotName, hhmmss, orderedTimelines, stationName, trainName } from '../helpers';
import { issueId, type Issue, type Rule } from '../types';

export const depotCapacityExceeded: Rule = {
  id: 'depot.capacityExceeded',
  name: '車庫の収容能力超過',
  defaultSeverity: 'error',
  scope: ['duties', 'formations'],
  run(ctx) {
    const out: Issue[] = [];
    for (const depot of entityList(ctx.doc.depots)) {
      // Everything homed here is in the shed when the service day begins…
      const resident = new Set<FormationId>();
      for (const formation of entityList(ctx.doc.formations)) {
        if (formation.homeDepotId !== depot.id) continue;
        if (formation.status === 'retired') continue;
        resident.add(formation.id);
      }
      // …and each depot movement of an assigned formation shifts the count.
      const deltas: Array<{ t: number; delta: number; trainId: string }> = [];
      for (const tl of orderedTimelines(ctx)) {
        if (tl.formationId === undefined) continue;
        for (const event of tl.events) {
          if (event.stationId !== depot.stationId) continue;
          const isDeparture = event.stopIndex === 0;
          const isArrival = event.stopIndex === tl.train.stops.length - 1;
          if (isDeparture && !isArrival) {
            deltas.push({ t: event.dep ?? event.at, delta: -1, trainId: tl.trainId });
          } else if (isArrival) {
            deltas.push({ t: event.arr ?? event.at, delta: +1, trainId: tl.trainId });
          }
        }
      }
      deltas.sort((a, b) => a.t - b.t || a.delta - b.delta);

      let current = resident.size;
      let peak = current;
      let peakAt = ctx.doc.settings.serviceDayStartSec;
      for (const d of deltas) {
        current += d.delta;
        if (current > peak) {
          peak = current;
          peakAt = d.t;
        }
      }
      if (peak <= depot.capacityFormations) continue;
      out.push({
        id: issueId('depot.capacityExceeded', depot.id),
        ruleId: 'depot.capacityExceeded',
        severity: 'error',
        title: '車庫の収容能力を超えています',
        detail: `${depotName(ctx.doc, depot.id)}: ${hhmmss(peakAt)} に ${peak}編成 が在庫し、収容能力 ${depot.capacityFormations}編成 を超えています。`,
        refs: [
          { kind: 'depot', depotId: depot.id },
          { kind: 'station', stationId: depot.stationId },
        ],
        at: peakAt,
        km: ctx.idx.kmOfStation.get(depot.stationId) ?? 0,
      });
    }
    return out;
  },
};

export const depotAccessTimeViolated: Rule = {
  id: 'depot.accessTimeViolated',
  name: '入出庫の所要時間が不足',
  defaultSeverity: 'error',
  scope: ['duties', 'trains'],
  run(ctx) {
    // depot station -> depot, and attached station -> depot.
    const depotOfStation = new Map<string, DepotId>();
    for (const depot of entityList(ctx.doc.depots)) depotOfStation.set(depot.stationId, depot.id);

    const out: Issue[] = [];
    for (const tl of orderedTimelines(ctx)) {
      for (let i = 1; i < tl.train.stops.length; i++) {
        const prev = tl.train.stops[i - 1]!;
        const cur = tl.train.stops[i]!;
        const depotId =
          depotOfStation.get(prev.stationId) ?? depotOfStation.get(cur.stationId);
        if (depotId === undefined) continue;
        const depot = ctx.doc.depots.byId[depotId];
        if (!depot) continue;
        const pair = new Set([prev.stationId, cur.stationId]);
        if (!pair.has(depot.stationId) || !pair.has(depot.attachedStationId)) continue;
        const dep = prev.dep ?? prev.arr;
        const arr = cur.arr ?? cur.dep;
        if (dep === undefined || arr === undefined) continue;
        const elapsed = arr - dep;
        if (elapsed >= depot.accessRunSec) continue;
        out.push({
          id: issueId('depot.accessTimeViolated', tl.trainId, i, depotId),
          ruleId: 'depot.accessTimeViolated',
          severity: 'error',
          title: '入出庫の所要時間が不足しています',
          detail: `${trainName(ctx.doc, tl.trainId)} ${stationName(ctx.doc, prev.stationId)}→${stationName(ctx.doc, cur.stationId)}: ${formatDuration(elapsed)} は ${depotName(ctx.doc, depotId)} の入出庫所要時間 ${formatDuration(depot.accessRunSec)} を下回っています。`,
          refs: [
            { kind: 'train', trainId: tl.trainId, stopIndex: i },
            { kind: 'depot', depotId },
          ],
          at: dep,
          km: ctx.idx.kmOfStation.get(prev.stationId) ?? 0,
        });
      }
    }
    return out;
  },
};
