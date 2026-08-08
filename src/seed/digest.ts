/**
 * A small, stable summary of a generated project.
 *
 * Snapshot tests take the *digest*, never the whole document: ids churn every
 * time a station or a slot is added, and a whole-document snapshot would go red
 * on changes that alter nothing anyone cares about. Counts, totals and the
 * per-band breakdown do change meaningfully, so they make a useful baseline.
 */

import { entityList } from '@/domain/units';
import type { ProjectDocument } from '@/domain/model';
import { dutySpan, trainDistance } from '@/domain/project';

export interface SeedDigest {
  stations: number;
  stationTracks: number;
  links: number;
  trains: number;
  serviceTrains: number;
  deadheadTrains: number;
  trainsByType: Record<string, number>;
  trainsByBand: Record<string, number>;
  trainsByDirection: Record<string, number>;
  overtakenStops: number;
  connectionStops: number;
  duties: number;
  dutiesByCars: Record<string, number>;
  formations: number;
  formationsByCars: Record<string, number>;
  assignments: number;
  inspectionRecords: number;
  totalKm: number;
  peakConcurrentDuties: number;
}

export function projectDigest(doc: ProjectDocument): SeedDigest {
  const trains = entityList(doc.trains);
  const duties = entityList(doc.duties);
  const formations = entityList(doc.formations);

  const trainsByType: Record<string, number> = {};
  const trainsByBand: Record<string, number> = {};
  const trainsByDirection: Record<string, number> = { down: 0, up: 0 };
  let overtakenStops = 0;
  let connectionStops = 0;
  let totalMeters = 0;

  for (const train of trains) {
    const typeName = doc.trainTypes.byId[train.typeId]?.name ?? train.typeId;
    trainsByType[typeName] = (trainsByType[typeName] ?? 0) + 1;
    const band = train.origin?.bandId ?? '(回送)';
    trainsByBand[band] = (trainsByBand[band] ?? 0) + 1;
    trainsByDirection[train.direction] = (trainsByDirection[train.direction] ?? 0) + 1;
    for (const stop of train.stops) {
      if ((stop.overtakenBy ?? []).length > 0) overtakenStops++;
      if ((stop.connectsTo ?? []).length > 0) connectionStops++;
    }
    totalMeters += trainDistance(doc, train);
  }

  const dutiesByCars: Record<string, number> = {};
  const spans: Array<{ from: number; to: number }> = [];
  for (const duty of duties) {
    const cars = String(duty.requiredCars ?? '?');
    dutiesByCars[cars] = (dutiesByCars[cars] ?? 0) + 1;
    const span = dutySpan(doc, duty);
    if (span !== undefined) spans.push(span);
  }

  const formationsByCars: Record<string, number> = {};
  for (const f of formations) {
    const cars = String(f.cars);
    formationsByCars[cars] = (formationsByCars[cars] ?? 0) + 1;
  }

  return {
    stations: doc.stations.allIds.length,
    stationTracks: doc.stationTracks.allIds.length,
    links: doc.links.allIds.length,
    trains: trains.length,
    serviceTrains: trains.filter((t) => t.category === 'service').length,
    deadheadTrains: trains.filter((t) => t.category === 'deadhead').length,
    trainsByType,
    trainsByBand,
    trainsByDirection,
    overtakenStops,
    connectionStops,
    duties: duties.length,
    dutiesByCars,
    formations: formations.length,
    formationsByCars,
    assignments: doc.assignments.allIds.length,
    inspectionRecords: doc.inspectionRecords.allIds.length,
    totalKm: Math.round(totalMeters / 1000),
    peakConcurrentDuties: peakOverlap(spans),
  };
}

export function peakOverlap(spans: ReadonlyArray<{ from: number; to: number }>): number {
  const events: Array<[number, number]> = [];
  for (const s of spans) {
    events.push([s.from, 1]);
    events.push([s.to, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  for (const [, delta] of events) {
    cur += delta;
    if (cur > peak) peak = cur;
  }
  return peak;
}
