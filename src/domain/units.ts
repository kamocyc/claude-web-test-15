/** Scalar units shared across the domain. Deliberately unbranded numbers. */

/**
 * Seconds from 00:00:00 of the service day. May exceed 86400 — see time.ts.
 */
export type Sec = number;

/**
 * Integer metres. Distances are stored in metres rather than kilometres so
 * that summing a 12 km line of 0.6 km hops cannot accumulate float drift.
 */
export type Meters = number;

/** Calendar date, `YYYY-MM-DD`. No time, no timezone. */
export type IsoDate = string;

export const M_PER_KM = 1000;

export function kmToMeters(km: number): Meters {
  return Math.round(km * M_PER_KM);
}

export function metersToKm(m: Meters): number {
  return m / M_PER_KM;
}

export function formatKm(m: Meters, digits = 1): string {
  return `${metersToKm(m).toFixed(digits)}km`;
}

/** km/h to m/s. */
export function kmhToMps(kmh: number): number {
  return (kmh * M_PER_KM) / 3600;
}

/** m/s to km/h. */
export function mpsToKmh(mps: number): number {
  return (mps * 3600) / M_PER_KM;
}

/** An ordered collection with O(1) lookup. `allIds` carries authored order. */
export interface Entities<T> {
  byId: Record<string, T>;
  allIds: string[];
}

export function emptyEntities<T>(): Entities<T> {
  return { byId: {}, allIds: [] };
}

export function entitiesFrom<T extends { id: string }>(items: readonly T[]): Entities<T> {
  const byId: Record<string, T> = {};
  const allIds: string[] = [];
  for (const item of items) {
    byId[item.id] = item;
    allIds.push(item.id);
  }
  return { byId, allIds };
}

/** Iterate in authored order, skipping ids with no backing object. */
export function entityList<T>(e: Entities<T>): T[] {
  const out: T[] = [];
  for (const id of e.allIds) {
    const v = e.byId[id];
    if (v !== undefined) out.push(v);
  }
  return out;
}

export function entityCount<T>(e: Entities<T>): number {
  return e.allIds.length;
}

export function getEntity<T>(e: Entities<T>, id: string | undefined): T | undefined {
  return id === undefined ? undefined : e.byId[id];
}

/** Insert or replace, preserving position when replacing. */
export function putEntity<T extends { id: string }>(e: Entities<T>, item: T, atIndex?: number): void {
  const exists = e.byId[item.id] !== undefined;
  e.byId[item.id] = item;
  if (!exists) {
    if (atIndex === undefined || atIndex < 0 || atIndex >= e.allIds.length) e.allIds.push(item.id);
    else e.allIds.splice(atIndex, 0, item.id);
  }
}

export function removeEntity<T>(e: Entities<T>, id: string): void {
  delete e.byId[id];
  const i = e.allIds.indexOf(id);
  if (i >= 0) e.allIds.splice(i, 1);
}
