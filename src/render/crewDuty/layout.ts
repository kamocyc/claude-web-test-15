/**
 * 行路表 (crew duty chart) layout — pure.
 *
 * Rows are 乗務員行路, x is time, and each leg is one bar. The shape is the
 * 構内ダイヤ's, because the question is the same shape: what is this resource
 * doing, and where does it clash. The differences are that the resource is a
 * person, so the row also carries the day's totals — 拘束, 実乗務, 休憩 — and
 * that the 点呼 at either end is drawn as a shoulder rather than a bar,
 * because it is derived from the configuration and cannot be edited here.
 *
 * Conflicts are computed here rather than read from the validator so that the
 * picture cannot disagree with the check: both say "this leg starts before the
 * one before it finished".
 */

import type { CrewDutyId, DayTypeId, StationId } from '@/domain/ids';
import type { CrewLeg, CrewRole, ProjectDocument } from '@/domain/model';
import { CREW_ROLE_LABEL } from '@/domain/model';
import {
  crewDutiesForDayType,
  crewDutySpread,
  crewLegEndpoints,
  crewLegSpan,
  crewWorkingSec,
} from '@/domain/project';
import { entityList, type Sec } from '@/domain/units';

export const CREW_LANE_H = 24;

export interface CrewChartRow {
  crewDutyId: CrewDutyId;
  index: number;
  code: string;
  role: CrewRole;
  roleLabel: string;
  baseStationName: string;
  /** The person booked on the active date, if anyone is. */
  crewLabel?: string;
  signOn: Sec;
  signOff: Sec;
  /** 実乗務 — the 乗務 legs only. */
  workSec: number;
  breakSec: number;
  spreadSec: number;
}

export interface CrewChartBar {
  crewDutyId: CrewDutyId;
  rowIndex: number;
  legIndex: number;
  kind: CrewLeg['kind'];
  from: Sec;
  to: Sec;
  label: string;
  fromStationId: StationId;
  toStationId: StationId;
  /** Overlaps the bar before it — what `crew.continuityBreak` reports. */
  conflict: boolean;
}

export interface CrewChartLayout {
  rows: CrewChartRow[];
  bars: CrewChartBar[];
  from: Sec;
  to: Sec;
  conflictCount: number;
}

export interface CrewChartOptions {
  dayTypeId: DayTypeId;
  date: string;
  /** Absent = every role on one sheet. */
  role?: CrewRole;
}

export function computeCrewChartLayout(
  doc: ProjectDocument,
  opts: CrewChartOptions,
): CrewChartLayout {
  const personOf = new Map<string, string>();
  for (const a of entityList(doc.crewAssignments)) {
    if (a.date !== opts.date) continue;
    const person = doc.crew.byId[a.crewId];
    if (person !== undefined) personOf.set(a.crewDutyId, `${person.code} ${person.name}`);
  }

  const duties = crewDutiesForDayType(doc, opts.dayTypeId)
    .filter((d) => opts.role === undefined || d.role === opts.role)
    .sort((a, b) => {
      const sa = crewDutySpread(doc, a)?.from ?? Number.POSITIVE_INFINITY;
      const sb = crewDutySpread(doc, b)?.from ?? Number.POSITIVE_INFINITY;
      return sa - sb || a.code.localeCompare(b.code);
    });

  const rows: CrewChartRow[] = [];
  const bars: CrewChartBar[] = [];
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  let conflictCount = 0;

  for (const [index, duty] of duties.entries()) {
    const spread = crewDutySpread(doc, duty);
    if (spread === undefined) continue;

    let breakSec = 0;
    let prevTo: Sec | undefined;
    for (const [legIndex, leg] of duty.legs.entries()) {
      const span = crewLegSpan(doc, leg);
      const ends = crewLegEndpoints(doc, leg);
      if (span === undefined || ends === undefined) continue;
      if (leg.kind === 'break') breakSec += span.to - span.from;
      const conflict = prevTo !== undefined && span.from < prevTo;
      if (conflict) conflictCount++;
      bars.push({
        crewDutyId: duty.id,
        rowIndex: index,
        legIndex,
        kind: leg.kind,
        from: span.from,
        to: span.to,
        label: labelOf(doc, leg),
        fromStationId: ends.fromStationId,
        toStationId: ends.toStationId,
        conflict,
      });
      prevTo = span.to;
    }

    const person = personOf.get(duty.id);
    rows.push({
      crewDutyId: duty.id,
      index,
      code: duty.code,
      role: duty.role,
      roleLabel: CREW_ROLE_LABEL[duty.role],
      baseStationName: doc.stations.byId[duty.baseStationId]?.name ?? '',
      ...(person === undefined ? {} : { crewLabel: person }),
      signOn: spread.from,
      signOff: spread.to,
      workSec: crewWorkingSec(doc, duty),
      breakSec,
      spreadSec: spread.sec,
    });
    if (spread.from < from) from = spread.from;
    if (spread.to > to) to = spread.to;
  }

  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    from = doc.settings.serviceDayStartSec;
    to = doc.settings.serviceDayEndSec;
  }
  return { rows, bars, from, to, conflictCount };
}

function labelOf(doc: ProjectDocument, leg: CrewLeg): string {
  if (leg.kind === 'break') return '休憩';
  if (leg.kind === 'standby') return '待機';
  const number = doc.trains.byId[leg.trainId]?.number ?? '';
  return leg.kind === 'deadhead' ? `添乗 ${number}` : number;
}

/** Which row a y offset inside the plot falls on. */
export function rowAtY(y: number, laneHeight: number, rowCount: number): number {
  if (rowCount <= 0) return 0;
  const index = Math.floor(y / laneHeight);
  return Math.min(Math.max(index, 0), rowCount - 1);
}
