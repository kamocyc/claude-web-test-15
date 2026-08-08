/**
 * Cross-reference checks that a Zod schema cannot express: every id mentioned
 * somewhere in the document must point at an entity that exists.
 *
 * This runs first in validation. If it finds anything, the remaining rules are
 * skipped — they would only produce cascading noise from the same root cause.
 */

import type { ProjectDocument } from './model';
import { entityList } from './units';

export interface DanglingRef {
  /** Human-readable path to the offending field. */
  path: string;
  /** The kind of entity the id was supposed to name. */
  expected: string;
  id: string;
}

export function checkReferentialIntegrity(doc: ProjectDocument): DanglingRef[] {
  const out: DanglingRef[] = [];
  const has = (e: { byId: Record<string, unknown> }, id: string | undefined): boolean =>
    id === undefined || e.byId[id] !== undefined;

  const need = (
    ok: boolean,
    path: string,
    expected: string,
    id: string | undefined,
  ): void => {
    if (!ok && id !== undefined) out.push({ path, expected, id });
  };

  for (const s of entityList(doc.stations)) {
    for (const [i, trackId] of s.trackIds.entries()) {
      need(has(doc.stationTracks, trackId), `stations.${s.id}.trackIds[${i}]`, 'StationTrack', trackId);
    }
    for (const dir of ['down', 'up'] as const) {
      const t = s.defaultTrackId[dir];
      need(has(doc.stationTracks, t), `stations.${s.id}.defaultTrackId.${dir}`, 'StationTrack', t);
    }
  }

  for (const t of entityList(doc.stationTracks)) {
    need(has(doc.stations, t.stationId), `stationTracks.${t.id}.stationId`, 'Station', t.stationId);
    need(has(doc.depots, t.depotId), `stationTracks.${t.id}.depotId`, 'Depot', t.depotId);
  }

  for (const l of entityList(doc.links)) {
    need(has(doc.stations, l.fromStationId), `links.${l.id}.fromStationId`, 'Station', l.fromStationId);
    need(has(doc.stations, l.toStationId), `links.${l.id}.toStationId`, 'Station', l.toStationId);
  }

  for (const [i, rt] of doc.linkRunTimes.entries()) {
    need(has(doc.links, rt.linkId), `linkRunTimes[${i}].linkId`, 'Link', rt.linkId);
    need(has(doc.perfProfiles, rt.profileId), `linkRunTimes[${i}].profileId`, 'PerfProfile', rt.profileId);
  }

  for (const d of entityList(doc.depots)) {
    need(has(doc.stations, d.stationId), `depots.${d.id}.stationId`, 'Station', d.stationId);
    need(
      has(doc.stations, d.attachedStationId),
      `depots.${d.id}.attachedStationId`,
      'Station',
      d.attachedStationId,
    );
  }

  for (const tt of entityList(doc.trainTypes)) {
    need(has(doc.perfProfiles, tt.perfProfileId), `trainTypes.${tt.id}.perfProfileId`, 'PerfProfile', tt.perfProfileId);
    need(
      has(doc.stopPatterns, tt.defaultStopPatternId),
      `trainTypes.${tt.id}.defaultStopPatternId`,
      'StopPattern',
      tt.defaultStopPatternId,
    );
  }

  for (const p of entityList(doc.stopPatterns)) {
    need(has(doc.trainTypes, p.trainTypeId), `stopPatterns.${p.id}.trainTypeId`, 'TrainType', p.trainTypeId);
    need(has(doc.stations, p.originStationId), `stopPatterns.${p.id}.originStationId`, 'Station', p.originStationId);
    need(
      has(doc.stations, p.terminusStationId),
      `stopPatterns.${p.id}.terminusStationId`,
      'Station',
      p.terminusStationId,
    );
    for (const stationId of Object.keys(p.entries)) {
      need(has(doc.stations, stationId), `stopPatterns.${p.id}.entries.${stationId}`, 'Station', stationId);
    }
  }

  for (const tr of entityList(doc.trains)) {
    need(has(doc.trainTypes, tr.typeId), `trains.${tr.id}.typeId`, 'TrainType', tr.typeId);
    need(has(doc.stopPatterns, tr.patternId), `trains.${tr.id}.patternId`, 'StopPattern', tr.patternId);
    for (const dt of tr.dayTypeIds) {
      need(has(doc.dayTypes, dt), `trains.${tr.id}.dayTypeIds`, 'DayType', dt);
    }
    for (const sid of tr.allowedSeriesIds ?? []) {
      need(has(doc.formationSeries, sid), `trains.${tr.id}.allowedSeriesIds`, 'FormationSeries', sid);
    }
    for (const [i, stop] of tr.stops.entries()) {
      need(has(doc.stations, stop.stationId), `trains.${tr.id}.stops[${i}].stationId`, 'Station', stop.stationId);
      need(has(doc.stationTracks, stop.trackId), `trains.${tr.id}.stops[${i}].trackId`, 'StationTrack', stop.trackId);
      for (const other of stop.overtakenBy ?? []) {
        need(has(doc.trains, other), `trains.${tr.id}.stops[${i}].overtakenBy`, 'Train', other);
      }
      for (const other of stop.connectsTo ?? []) {
        need(has(doc.trains, other), `trains.${tr.id}.stops[${i}].connectsTo`, 'Train', other);
      }
    }
  }

  for (const duty of entityList(doc.duties)) {
    for (const dt of duty.dayTypeIds) {
      need(has(doc.dayTypes, dt), `duties.${duty.id}.dayTypeIds`, 'DayType', dt);
    }
    for (const sid of duty.requiredSeriesIds ?? []) {
      need(has(doc.formationSeries, sid), `duties.${duty.id}.requiredSeriesIds`, 'FormationSeries', sid);
    }
    for (const [i, leg] of duty.legs.entries()) {
      if (leg.kind === 'train') {
        need(has(doc.trains, leg.trainId), `duties.${duty.id}.legs[${i}].trainId`, 'Train', leg.trainId);
      } else if (leg.kind === 'stable') {
        need(has(doc.stations, leg.stationId), `duties.${duty.id}.legs[${i}].stationId`, 'Station', leg.stationId);
        need(has(doc.stationTracks, leg.trackId), `duties.${duty.id}.legs[${i}].trackId`, 'StationTrack', leg.trackId);
      } else {
        need(has(doc.depots, leg.depotId), `duties.${duty.id}.legs[${i}].depotId`, 'Depot', leg.depotId);
      }
    }
  }

  for (const s of entityList(doc.formationSeries)) {
    need(has(doc.perfProfiles, s.perfProfileId), `formationSeries.${s.id}.perfProfileId`, 'PerfProfile', s.perfProfileId);
  }

  for (const f of entityList(doc.formations)) {
    need(has(doc.formationSeries, f.seriesId), `formations.${f.id}.seriesId`, 'FormationSeries', f.seriesId);
    need(has(doc.depots, f.homeDepotId), `formations.${f.id}.homeDepotId`, 'Depot', f.homeDepotId);
  }

  for (const r of entityList(doc.inspectionRules)) {
    if (r.appliesTo !== 'all') {
      for (const sid of r.appliesTo.seriesIds) {
        need(has(doc.formationSeries, sid), `inspectionRules.${r.id}.appliesTo`, 'FormationSeries', sid);
      }
    }
    for (const did of r.depotIds) {
      need(has(doc.depots, did), `inspectionRules.${r.id}.depotIds`, 'Depot', did);
    }
  }

  for (const rec of entityList(doc.inspectionRecords)) {
    need(has(doc.formations, rec.formationId), `inspectionRecords.${rec.id}.formationId`, 'Formation', rec.formationId);
    need(has(doc.inspectionRules, rec.ruleId), `inspectionRecords.${rec.id}.ruleId`, 'InspectionRule', rec.ruleId);
    need(has(doc.depots, rec.depotId), `inspectionRecords.${rec.id}.depotId`, 'Depot', rec.depotId);
  }

  for (const a of entityList(doc.assignments)) {
    need(has(doc.duties, a.dutyId), `assignments.${a.id}.dutyId`, 'Duty', a.dutyId);
    need(has(doc.formations, a.formationId), `assignments.${a.id}.formationId`, 'Formation', a.formationId);
  }

  for (const [i, c] of doc.calendar.entries()) {
    need(has(doc.dayTypes, c.dayTypeId), `calendar[${i}].dayTypeId`, 'DayType', c.dayTypeId);
  }

  need(has(doc.dayTypes, doc.settings.activeDayTypeId), 'settings.activeDayTypeId', 'DayType', doc.settings.activeDayTypeId);

  return out;
}

export type EntityKind =
  | 'station'
  | 'stationTrack'
  | 'link'
  | 'depot'
  | 'trainType'
  | 'stopPattern'
  | 'train'
  | 'duty'
  | 'formation'
  | 'formationSeries'
  | 'perfProfile'
  | 'inspectionRule'
  | 'dayType';

export interface Dependant {
  kind: EntityKind;
  id: string;
  label: string;
}

/**
 * What would break if this entity were deleted. The UI shows this list in a
 * confirmation dialog; there is deliberately no silent cascade delete, because
 * in a timetable app that destroys hours of work in one keystroke.
 */
export function findDependants(
  doc: ProjectDocument,
  kind: EntityKind,
  id: string,
): Dependant[] {
  const out: Dependant[] = [];

  if (kind === 'station') {
    for (const t of entityList(doc.trains)) {
      if (t.stops.some((s) => s.stationId === id)) {
        out.push({ kind: 'train', id: t.id, label: `列車 ${t.number}` });
      }
    }
    for (const l of entityList(doc.links)) {
      if (l.fromStationId === id || l.toStationId === id) {
        out.push({ kind: 'link', id: l.id, label: '駅間' });
      }
    }
    for (const d of entityList(doc.depots)) {
      if (d.stationId === id || d.attachedStationId === id) {
        out.push({ kind: 'depot', id: d.id, label: `車庫 ${d.name}` });
      }
    }
    for (const p of entityList(doc.stopPatterns)) {
      if (p.entries[id] !== undefined) {
        out.push({ kind: 'stopPattern', id: p.id, label: `停車パターン ${p.name}` });
      }
    }
  }

  if (kind === 'stationTrack') {
    for (const t of entityList(doc.trains)) {
      if (t.stops.some((s) => s.trackId === id)) {
        out.push({ kind: 'train', id: t.id, label: `列車 ${t.number}` });
      }
    }
  }

  if (kind === 'trainType') {
    for (const t of entityList(doc.trains)) {
      if (t.typeId === id) out.push({ kind: 'train', id: t.id, label: `列車 ${t.number}` });
    }
    for (const p of entityList(doc.stopPatterns)) {
      if (p.trainTypeId === id) out.push({ kind: 'stopPattern', id: p.id, label: `停車パターン ${p.name}` });
    }
  }

  if (kind === 'train') {
    for (const d of entityList(doc.duties)) {
      if (d.legs.some((l) => l.kind === 'train' && l.trainId === id)) {
        out.push({ kind: 'duty', id: d.id, label: `運用 ${d.code}` });
      }
    }
  }

  if (kind === 'duty') {
    for (const a of entityList(doc.assignments)) {
      if (a.dutyId === id) out.push({ kind: 'duty', id: a.id, label: `充当 ${a.date}` });
    }
  }

  if (kind === 'formation') {
    for (const a of entityList(doc.assignments)) {
      if (a.formationId === id) out.push({ kind: 'duty', id: a.id, label: `充当 ${a.date}` });
    }
  }

  if (kind === 'depot') {
    for (const f of entityList(doc.formations)) {
      if (f.homeDepotId === id) out.push({ kind: 'formation', id: f.id, label: `編成 ${f.code}` });
    }
  }

  if (kind === 'perfProfile') {
    for (const t of entityList(doc.trainTypes)) {
      if (t.perfProfileId === id) out.push({ kind: 'trainType', id: t.id, label: `種別 ${t.name}` });
    }
  }

  if (kind === 'formationSeries') {
    for (const f of entityList(doc.formations)) {
      if (f.seriesId === id) out.push({ kind: 'formation', id: f.id, label: `編成 ${f.code}` });
    }
  }

  return out;
}
