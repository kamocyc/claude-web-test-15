/**
 * Branded id types.
 *
 * Ids are branded strings so that a StationId can never be passed where a
 * TrainId is expected. Numbers (Sec, Meters) are deliberately NOT branded —
 * arithmetic ergonomics matter more there than the extra safety.
 */

declare const __brand: unique symbol;
export type Id<K extends string> = string & { readonly [__brand]: K };

export type LineId = Id<'Line'>;
export type StationId = Id<'Station'>;
export type StationTrackId = Id<'StationTrack'>;
export type LinkId = Id<'Link'>;
export type DepotId = Id<'Depot'>;
export type PerfProfileId = Id<'PerfProfile'>;
export type TrainTypeId = Id<'TrainType'>;
export type StopPatternId = Id<'StopPattern'>;
export type TrainId = Id<'Train'>;
export type DutyId = Id<'Duty'>;
export type FormationId = Id<'Formation'>;
export type SeriesId = Id<'FormationSeries'>;
export type InspectionRuleId = Id<'InspectionRule'>;
export type InspectionRecordId = Id<'InspectionRecord'>;
export type AssignmentId = Id<'Assignment'>;
export type DayTypeId = Id<'DayType'>;
export type CrewId = Id<'Crew'>;
export type CrewDutyId = Id<'CrewDuty'>;
export type CrewAssignmentId = Id<'CrewAssignment'>;

/** Cast a raw string to a branded id. Use at parse/seed boundaries only. */
export function asId<K extends string>(raw: string): Id<K> {
  return raw as Id<K>;
}

/**
 * Monotonic id factory. Deterministic by construction — no randomness, no
 * clock — so that seed output and E2E test ids are byte-stable across runs.
 */
export function makeIdFactory(prefix: string, start = 1): <K extends string>() => Id<K> {
  let n = start;
  return <K extends string>(): Id<K> => `${prefix}-${n++}` as Id<K>;
}

/**
 * A shared counter pool keyed by prefix. Used by the UI so that ids created
 * interactively are also deterministic under `?e2e=1`.
 */
export class IdPool {
  private counters = new Map<string, number>();

  next<K extends string>(prefix: string): Id<K> {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${n}` as Id<K>;
  }

  /** Ensure future ids don't collide with ids already present in a document. */
  observe(id: string): void {
    const m = /^([a-z]+)-(\d+)$/.exec(id);
    if (!m) return;
    const [, prefix, num] = m;
    if (prefix === undefined || num === undefined) return;
    const n = Number(num);
    if (n > (this.counters.get(prefix) ?? 0)) this.counters.set(prefix, n);
  }

  reset(): void {
    this.counters.clear();
  }
}

export const ID_PREFIX = {
  line: 'lin',
  station: 'stn',
  stationTrack: 'trk',
  link: 'lnk',
  depot: 'dep',
  perfProfile: 'prf',
  trainType: 'typ',
  stopPattern: 'pat',
  train: 'trn',
  duty: 'dut',
  formation: 'frm',
  series: 'ser',
  inspectionRule: 'irl',
  inspectionRecord: 'irc',
  assignment: 'asg',
  dayType: 'day',
  crew: 'crw',
  crewDuty: 'cdt',
  crewAssignment: 'cas',
} as const;
