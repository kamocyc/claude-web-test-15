/**
 * Small shared helpers for the rule catalogue: Japanese entity labels, the
 * minimum-run-time formula, and a couple of sweep-line utilities.
 *
 * Every rule renders entity *names* rather than ids — an issue that says
 * `列車 1701` is actionable, one that says `trn-42` is not.
 */

import type {
  CrewDutyId,
  CrewId,
  DepotId,
  DutyId,
  FormationId,
  LinkId,
  PerfProfileId,
  StationId,
  StationTrackId,
  TrainId,
} from '@/domain/ids';
import type { ProjectDocument, TrainStop } from '@/domain/model';
import { buildLinkLookup } from '@/domain/project';
import { formatTime } from '@/domain/time';
import type { Sec } from '@/domain/units';
import type { TrainTimeline } from '@/engine/types';
import type { ValidationContext } from './types';

export function stationName(doc: ProjectDocument, id: StationId | undefined): string {
  return (id !== undefined ? doc.stations.byId[id]?.name : undefined) ?? String(id ?? '不明駅');
}

export function trackName(doc: ProjectDocument, id: StationTrackId | undefined): string {
  return (id !== undefined ? doc.stationTracks.byId[id]?.name : undefined) ?? '番線未設定';
}

/** '大井町 1番線' */
export function trackFullName(doc: ProjectDocument, id: StationTrackId): string {
  const track = doc.stationTracks.byId[id];
  if (!track) return String(id);
  return `${stationName(doc, track.stationId)} ${track.name}`;
}

export function trainName(doc: ProjectDocument, id: TrainId | undefined): string {
  const train = id !== undefined ? doc.trains.byId[id] : undefined;
  return train ? `列車 ${train.number}` : `列車 ${String(id ?? '不明')}`;
}

export function dutyName(doc: ProjectDocument, id: DutyId | undefined): string {
  const duty = id !== undefined ? doc.duties.byId[id] : undefined;
  return duty ? `運用 ${duty.code}` : `運用 ${String(id ?? '不明')}`;
}

export function crewDutyName(doc: ProjectDocument, id: CrewDutyId | undefined): string {
  const duty = id !== undefined ? doc.crewDuties.byId[id] : undefined;
  return duty ? `乗務員行路 ${duty.code}` : `乗務員行路 ${String(id ?? '不明')}`;
}

export function crewName(doc: ProjectDocument, id: CrewId | undefined): string {
  const person = id !== undefined ? doc.crew.byId[id] : undefined;
  return person ? `乗務員 ${person.code} ${person.name}` : `乗務員 ${String(id ?? '不明')}`;
}

export function formationName(doc: ProjectDocument, id: FormationId | undefined): string {
  const formation = id !== undefined ? doc.formations.byId[id] : undefined;
  return formation ? `編成 ${formation.code}` : `編成 ${String(id ?? '不明')}`;
}

export function depotName(doc: ProjectDocument, id: DepotId | undefined): string {
  const depot = id !== undefined ? doc.depots.byId[id] : undefined;
  return depot ? `車庫 ${depot.name}` : `車庫 ${String(id ?? '不明')}`;
}

/** Timetable time with seconds — validation details need the precision. */
export function hhmmss(t: Sec): string {
  return formatTime(t, { seconds: true });
}

export function hhmm(t: Sec): string {
  return formatTime(t);
}

/** Spreadable `at:` focus, omitted entirely when the time is unknown. */
export function atProps(t: Sec | undefined): { at?: Sec } {
  return t === undefined ? {} : { at: t };
}

/** Timelines in the index's stable render order. */
export function orderedTimelines(ctx: ValidationContext): TrainTimeline[] {
  const out: TrainTimeline[] = [];
  for (const id of ctx.idx.orderedTrainIds) {
    const tl = ctx.idx.timelines.get(id);
    if (tl) out.push(tl);
  }
  return out;
}

export interface SectionInfo {
  linkId: LinkId;
  /** Booked seconds from the previous departure to this arrival. */
  actualSec: number;
  /** `baseRunSec` plus whichever start/stop penalties apply. */
  minSec: number;
  depSec: Sec;
  arrSec: Sec;
}

/**
 * `buildLinkLookup` walks every link and allocates a Map. `sectionInfo` is
 * called once per section of every train — of the order of 10,000 times for a
 * full-day timetable — so it is memoized per document here.
 */
const linkLookupCache = new WeakMap<ProjectDocument, ReturnType<typeof buildLinkLookup>>();

function linkLookupFor(doc: ProjectDocument): ReturnType<typeof buildLinkLookup> {
  let cached = linkLookupCache.get(doc);
  if (cached === undefined) {
    cached = buildLinkLookup(doc);
    linkLookupCache.set(doc, cached);
  }
  return cached;
}

/**
 * Minimum booked time for the section leading into stop `index`.
 *
 * The start penalty models accelerating away from a stand, so it applies
 * whenever the previous stop was a stand — including the origin, where the
 * train is stationary before it departs. The stop penalty models braking to a
 * stand at the far end. A train that passes through a station pays neither.
 *
 * This must match the forward pass in the seed generator exactly; if the two
 * disagree, generated timetables either trip `time.runTooFast` spuriously or
 * slip real violations past the validator.
 */
export function sectionInfo(
  ctx: ValidationContext,
  tl: TrainTimeline,
  index: number,
  profileId: PerfProfileId,
): SectionInfo | undefined {
  const prev: TrainStop | undefined = tl.train.stops[index - 1];
  const cur: TrainStop | undefined = tl.train.stops[index];
  if (!prev || !cur) return undefined;
  const dep = prev.dep ?? prev.arr;
  const arr = cur.arr ?? cur.dep;
  if (dep === undefined || arr === undefined) return undefined;

  const link = linkLookupFor(ctx.doc).between(prev.stationId, cur.stationId);
  if (!link) return undefined;
  const rt = ctx.idx.runTimeOf(link.id, profileId);
  if (!rt) return undefined;

  const startsFromStand = prev.kind === 'stop';
  const comesToStand = cur.kind === 'stop';
  return {
    linkId: link.id,
    actualSec: arr - dep,
    minSec:
      rt.baseRunSec +
      (startsFromStand ? rt.startPenaltySec : 0) +
      (comesToStand ? rt.stopPenaltySec : 0),
    depSec: dep,
    arrSec: arr,
  };
}

export interface Span {
  from: Sec;
  to: Sec;
  id: string;
}

/** Peak number of simultaneously-open spans, and the time it is reached. */
export function peakConcurrency(spans: Span[]): { peak: number; at: Sec; ids: string[] } {
  const events: Array<{ t: Sec; delta: number; id: string }> = [];
  for (const s of spans) {
    events.push({ t: s.from, delta: 1, id: s.id });
    events.push({ t: s.to, delta: -1, id: s.id });
  }
  // Closures before openings at the same instant: back-to-back spans do not
  // count as concurrent.
  events.sort((a, b) => a.t - b.t || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  let at: Sec = 0;
  const open = new Set<string>();
  let ids: string[] = [];
  for (const e of events) {
    current += e.delta;
    if (e.delta > 0) open.add(e.id);
    else open.delete(e.id);
    if (current > peak) {
      peak = current;
      at = e.t;
      ids = [...open];
    }
  }
  return { peak, at, ids };
}
