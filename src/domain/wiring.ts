/**
 * 構内配線 — the throats of a station, and which moves through one foul which.
 *
 * ## What is modelled
 *
 * A station has two **throats**: the `down` end (higher km) and the `up` end.
 * Every road is switched into one, both or neither of them, and sits at a
 * **lateral position** across the throat — its 分岐位置. Both facts come from
 * `StationTrack.wiring` when the document states them, and are derived the way
 * they always were when it does not, so nothing has to be re-authored.
 *
 * ## What connects to what
 *
 * Reaching a throat is not the same as being connected to everything in it. A
 * road is switched onto a set of **leads** there — `'down'` and `'up'` are the
 * running lines themselves, any other name is a lead that is not a running line
 * — and two things can work stock between them exactly when they share a lead,
 * or when a 渡り線 in that throat bridges the leads they are on.
 *
 * That is the whole of `ThroatRouting`, and it is what lets the model state the
 * two facts a per-direction flag cannot:
 *
 * - 自由が丘's 引上線 is on the 下り線 and nothing else, so stock at the up
 *   platform — which at a 相対式 station *is* the 上り線 — reaches it only over
 *   the 片渡り線 beyond the tail track's own points, and the move fouls the
 *   whole throat on the way.
 * - 溝の口's 大井町線 faces are on a lead of their own that carries the two
 *   引上線 and stops there, while the 引上線 are also on both 田園都市線 running
 *   lines. So a 回送 off the 鷺沼 line can reach a tail track, cannot reach a
 *   platform, and gets to one by shunting out of the other — which is exactly
 *   what happens on the ground.
 *
 * The line tracks outside a throat are given lateral positions too: they are
 * the roads their through movements run onto, so 下り本線 sits where the down
 * through road sits. That puts the whole throat — pointwork, platform roads and
 * open line — on one axis.
 *
 * ## 平面交差支障
 *
 * A movement through a throat joins two positions on that axis: an arrival
 * joins the line track to the road, a departure the road to the line track, and
 * an 入換 joins two roads. Between them it crosses **every road whose position
 * lies in between** — that is what a flat junction is, and it is why a shunt
 * out of a tail track that sits beyond the up platform fouls the 上り本線 while
 * the identical shunt at a station whose tail track is in line with the
 * platform fouls nothing.
 *
 * So two moves in the same throat foul each other when their spans intersect.
 * `spansFoul` is that test, and it is the whole geometry: no interlocking
 * tables, no signal aspects, no route locking. Two moves that share a road are
 * `track.doubleOccupancy`'s business and two that share a line track are
 * `headway.section`'s, so `track.crossingConflict` reports neither — what it
 * reports is exactly the pairs nothing else can see.
 *
 * The one thing this deliberately does not model is the *order* of the
 * turnouts along the throat. Two moves that cross in the schematic always share
 * pointwork in the real ladder, which is what makes the test sound; two that do
 * not cross can still share a point if the ladder is built as one chain rather
 * than a fan, which is what makes it optimistic. A planning tool that reported
 * the pessimistic reading would flag every parallel arrival on the line.
 */

import type { StationId, StationTrackId } from './ids';
import type {
  Direction,
  ProjectDocument,
  Station,
  StationCrossover,
  StationEnd,
  StationTrack,
  ThroatLead,
} from './model';
import { DIRECTIONS, STATION_ENDS } from './model';
import { orderedStations, tracksOfStation } from './project';
import type { Meters } from './units';

export type { StationEnd } from './model';

/** A road that dead-ends rather than running through the station. */
export function isStubUsage(usage: StationTrack['usage']): boolean {
  return usage === 'stabling';
}

/**
 * Which end a stub hangs off when the document does not say.
 *
 * A tail track points at the end of the line its station is nearest, which is
 * exactly right at a terminal — where tail tracks live — and is the best
 * available guess anywhere else. It is only a guess, which is why
 * `TrackWiring.ends` exists: 自由が丘 is in the 大井町 half of the line and its
 * 引上線 is on the 溝の口 side, and no amount of km arithmetic will find that
 * out.
 */
export function defaultStubEnd(km: Meters, lineFromKm: Meters, lineToKm: Meters): StationEnd {
  return km - lineFromKm >= lineToKm - km ? 'down' : 'up';
}

/** Ends a road is switched into, wiring first and the derivation second. */
export function endsOfTrack(
  track: Pick<StationTrack, 'usage' | 'wiring'>,
  fallbackStubEnd: StationEnd,
): StationEnd[] {
  if (track.wiring !== undefined) return track.wiring.ends;
  return isStubUsage(track.usage) ? [fallbackStubEnd] : [...STATION_ENDS];
}

/** 分岐位置 — stated, or the road's authored order among the station's 番線. */
export function ladderOfTrack(track: StationTrack, authoredIndex: number): number {
  return track.wiring?.ladder ?? authoredIndex;
}

/**
 * 接続先 — the leads a road is switched onto in one throat.
 *
 * Defaults to the running lines of the directions the road serves, which is
 * the plain two-road station. An empty result means the road does not reach
 * this throat at all; a result naming no running line means it reaches it and
 * meets only other roads there, which is what the 大井町線 faces at 溝の口 are.
 */
export function leadsOfTrack(
  track: Pick<StationTrack, 'usage' | 'directions' | 'wiring'>,
  end: StationEnd,
  fallbackStubEnd: StationEnd,
): ThroatLead[] {
  if (!endsOfTrack(track, fallbackStubEnd).includes(end)) return [];
  return track.wiring?.connects?.[end] ?? track.directions;
}

/** 渡り線 in one throat. */
export function crossoversAt(
  station: Pick<Station, 'crossovers'> | undefined,
  end: StationEnd,
): StationCrossover[] {
  return (station?.crossovers ?? []).filter((c) => c.end === end);
}

/**
 * Every lead stock standing on `from` can reach in this throat, 渡り線 included.
 *
 * Transitive, because two crossovers in one throat make a chain, and closed
 * over the seeds so a road on two leads carries both.
 */
export function leadsReachable(
  station: Pick<Station, 'crossovers'> | undefined,
  end: StationEnd,
  from: readonly ThroatLead[],
): Set<ThroatLead> {
  const reached = new Set<ThroatLead>(from);
  const links = crossoversAt(station, end);
  for (;;) {
    const before = reached.size;
    for (const link of links) {
      if (reached.has(link.from)) reached.add(link.to);
      if (reached.has(link.to)) reached.add(link.from);
    }
    if (reached.size === before) return reached;
  }
}

/** Is `lead` a running line rather than a named yard lead? */
export function isLineLead(lead: ThroatLead): lead is Direction {
  return DIRECTIONS.includes(lead as Direction);
}

/**
 * Can stock on `direction`'s 本線 get into this road through this throat?
 *
 * The question a 進路 asks. The 番線 generator and `track.routeMissing` both go
 * through here rather than each having their own reading, because a generator
 * that books a road the validator then calls unreachable produces a plan that
 * looks broken and is not — the same mistake the 続行時隔 check made once.
 */
export function canEnterFrom(
  station: Pick<Station, 'crossovers'> | undefined,
  track: Pick<StationTrack, 'usage' | 'directions' | 'wiring'>,
  end: StationEnd,
  direction: Direction,
  fallbackStubEnd: StationEnd,
): boolean {
  const leads = leadsOfTrack(track, end, fallbackStubEnd);
  if (leads.length === 0) return false;
  const reach = leadsReachable(station, end, [direction]);
  return leads.some((lead) => reach.has(lead));
}

// ---------------------------------------------------------------------------
// Station wiring
// ---------------------------------------------------------------------------

export interface RoadWiring {
  trackId: StationTrackId;
  name: string;
  ends: StationEnd[];
  ladder: number;
  directions: Direction[];
  /** Directions whose 本線 continues straight into this road. */
  line: Direction[];
  /** The leads each throat switches this road onto; see `leadsOfTrack`. */
  connects: Record<StationEnd, ThroatLead[]>;
  usage: StationTrack['usage'];
  /** A stub is open at one end only; this is that end. */
  stubEnd?: StationEnd;
}

export interface StationWiring {
  stationId: StationId;
  roads: RoadWiring[];
  byTrack: Map<StationTrackId, RoadWiring>;
  /** 渡り線, as authored. */
  crossovers: StationCrossover[];
  /**
   * Lateral position of the 本線 for each direction — where a train running
   * through without diverging sits. A 方向別複々線 station has more than one
   * road per direction, so this is the station's *nominated* one and
   * `lineLadder` picks the nearest to the road actually being used.
   */
  linePosition: Record<Direction, number>;
}

/** The end of `station` that faces `otherKm`. */
export function endTowards(station: Pick<Station, 'kmFromOrigin'>, otherKm: Meters): StationEnd {
  return otherKm >= station.kmFromOrigin ? 'down' : 'up';
}

/**
 * The road a direction's 本線 runs into, when the document does not say.
 *
 * The station's own default road for the direction, which is the road a train
 * that diverges nowhere ends up on — and failing that the outermost road that
 * serves the direction, which keeps a stub terminal sane: 大井町 has no through
 * road at all, and its two dead-end faces still fan off two line tracks lying
 * one either side of them.
 */
function derivedLineRoad(
  station: Station,
  roads: readonly RoadWiring[],
  direction: Direction,
): RoadWiring | undefined {
  const serving = roads.filter((r) => r.directions.includes(direction) && r.stubEnd === undefined);
  const pool = serving.length > 0 ? serving : roads.filter((r) => r.stubEnd === undefined);
  if (pool.length === 0) return undefined;
  const nominated = station.defaultTrackId[direction];
  const named = nominated === undefined ? undefined : pool.find((r) => r.trackId === nominated);
  if (named !== undefined) return named;
  let best = pool[0]!;
  for (const road of pool) {
    if (direction === 'down' ? road.ladder < best.ladder : road.ladder > best.ladder) best = road;
  }
  return best;
}

/**
 * Where the 本線 for `direction` meets the throat, as seen from `nearLadder`.
 *
 * One number is not enough on a 方向別複々線: 溝の口 has a 下り本線 on the
 * 田園都市線 pair and another on the 大井町線 pair, and a train coming in on one
 * of them crosses nothing to reach its own face. So the line road nearest the
 * road being used wins, with the station's nominated one breaking a tie —
 * which is what makes an up train leaving 溝の口 2番線 cross towards 3番線
 * rather than towards 1番線.
 */
export function lineLadder(
  wiring: StationWiring,
  direction: Direction,
  nearLadder: number,
): number {
  const nominated = wiring.linePosition[direction];
  let best = nominated;
  let bestDist = Infinity;
  for (const road of wiring.roads) {
    if (!road.line.includes(direction)) continue;
    const dist = Math.abs(road.ladder - nearLadder);
    if (dist < bestDist || (dist === bestDist && road.ladder === nominated)) {
      best = road.ladder;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * `computeStationWiring` for every station, keyed by id.
 *
 * Memoized per document: the validator asks for a station's wiring once per
 * movement, and a full day is tens of thousands of movements.
 */
const cache = new WeakMap<ProjectDocument, Map<StationId, StationWiring>>();

export function stationWiring(doc: ProjectDocument, stationId: StationId): StationWiring {
  let byStation = cache.get(doc);
  if (byStation === undefined) {
    byStation = new Map();
    cache.set(doc, byStation);
  }
  const hit = byStation.get(stationId);
  if (hit !== undefined) return hit;
  const built = computeStationWiring(doc, stationId);
  byStation.set(stationId, built);
  return built;
}

export function computeStationWiring(doc: ProjectDocument, stationId: StationId): StationWiring {
  const station = doc.stations.byId[stationId];
  const tracks = tracksOfStation(doc, stationId);
  const ordered = orderedStations(doc);
  const fromKm = ordered[0]?.kmFromOrigin ?? 0;
  const toKm = ordered[ordered.length - 1]?.kmFromOrigin ?? 0;
  const fallback: StationEnd =
    station === undefined ? 'down' : defaultStubEnd(station.kmFromOrigin, fromKm, toKm);

  const roads: RoadWiring[] = tracks.map((track, i) => {
    const ends = endsOfTrack(track, fallback);
    const road: RoadWiring = {
      trackId: track.id,
      name: track.name,
      ends,
      ladder: ladderOfTrack(track, i),
      directions: track.directions,
      line: track.wiring?.line ?? [],
      connects: {
        down: leadsOfTrack(track, 'down', fallback),
        up: leadsOfTrack(track, 'up', fallback),
      },
      usage: track.usage,
    };
    if (ends.length === 1) road.stubEnd = ends[0]!;
    return road;
  });

  const byTrack = new Map(roads.map((r) => [r.trackId, r]));
  const linePosition: Record<Direction, number> = { down: 0, up: 0 };
  if (station !== undefined) {
    for (const direction of ['down', 'up'] as const) {
      const derived = derivedLineRoad(station, roads, direction);
      if (derived !== undefined) linePosition[direction] = derived.ladder;
      // A road that says nothing about the 本線 still carries it when it is the
      // one the station falls back to, or the whole station would read as a
      // yard of sidings with the running line somewhere off to the side.
      const declared = roads.some((r) => r.line.includes(direction));
      if (!declared && derived !== undefined) derived.line = [...derived.line, direction];
    }
  }
  return {
    stationId,
    roads,
    byTrack,
    crossovers: station?.crossovers ?? [],
    linePosition,
  };
}

// ---------------------------------------------------------------------------
// Moves through a throat
// ---------------------------------------------------------------------------

export type ThroatMoveKind = 'arrive' | 'depart' | 'shunt';

/**
 * How the wiring lets a move be made.
 *
 * `direct` — the two ends share a lead. `crossover` — they do not, and a 渡り線
 * bridges them, so the move runs out past every road turnout and back, fouling
 * both running lines on the way. `none` — the wiring simply does not join them,
 * and the move is in the plan anyway; `track.routeMissing` is what says so.
 */
export type ThroatRouting = 'direct' | 'crossover' | 'none';

/** One movement across one throat, as the band of the throat it sweeps. */
export interface ThroatMove {
  end: StationEnd;
  kind: ThroatMoveKind;
  /** Lateral positions the move joins. */
  from: number;
  to: number;
  /** The road involved; both roads, for an 入換. */
  trackId?: StationTrackId | undefined;
  fromTrackId?: StationTrackId | undefined;
  /** The line track used, as a direction. Absent on an 入換. */
  lineDirection?: Direction | undefined;
  routing: ThroatRouting;
}

/** Does a move from `a` to `b` sweep across `p`? Endpoints count. */
export function spanContains(a: number, b: number, p: number): boolean {
  return p >= Math.min(a, b) && p <= Math.max(a, b);
}

/** Do two moves through one throat share any of it? */
export function spansFoul(
  a: Pick<ThroatMove, 'from' | 'to'>,
  b: Pick<ThroatMove, 'from' | 'to'>,
): boolean {
  return (
    Math.max(a.from, a.to) >= Math.min(b.from, b.to) &&
    Math.max(b.from, b.to) >= Math.min(a.from, a.to)
  );
}

/**
 * Is this pair a 平面交差 rather than something another rule already owns?
 *
 * Two moves onto the same road are a 二重使用 and two onto the same line track
 * are a 時隔 problem; both are reported elsewhere and with better detail, so
 * they are not repeated here. What is left is the pair that share no rails at
 * either end and still cannot both be made: they cross in between.
 */
export function movesCross(a: ThroatMove, b: ThroatMove): boolean {
  if (a.end !== b.end) return false;
  if (!spansFoul(a, b)) return false;
  const roadsA = [a.trackId, a.fromTrackId].filter((id) => id !== undefined);
  const roadsB = [b.trackId, b.fromTrackId].filter((id) => id !== undefined);
  if (roadsA.some((id) => roadsB.includes(id))) return false;
  if (
    a.lineDirection !== undefined &&
    b.lineDirection !== undefined &&
    a.lineDirection === b.lineDirection
  ) {
    return false;
  }
  return true;
}

/** Leads reachable from `seed` in this throat, following 渡り線. */
function reachIn(
  wiring: StationWiring,
  end: StationEnd,
  seed: readonly ThroatLead[],
): Set<ThroatLead> {
  return leadsReachable({ crossovers: wiring.crossovers }, end, seed);
}

/**
 * How a move between two sets of leads is made, and the extra ground it covers.
 *
 * A crossover lies beyond every road turnout in the throat, so working through
 * one takes the stock out onto both running lines involved and back — which is
 * why the span is widened to include them. That widening is the difference
 * between "the shunt fouls the tail track's own points" and "the shunt fouls
 * the whole throat", and at 自由が丘 it is the latter.
 */
function routeBetweenLeads(
  wiring: StationWiring,
  end: StationEnd,
  a: readonly ThroatLead[],
  b: readonly ThroatLead[],
  near: number,
): { routing: ThroatRouting; extra: number[] } {
  if (a.length === 0 || b.length === 0) return { routing: 'none', extra: [] };
  if (a.some((lead) => b.includes(lead))) return { routing: 'direct', extra: [] };
  const reach = reachIn(wiring, end, a);
  if (!b.some((lead) => reach.has(lead))) return { routing: 'none', extra: [] };
  const lines = [...a, ...b].filter(isLineLead);
  return {
    routing: 'crossover',
    extra: lines.map((d) => lineLadder(wiring, d, near)),
  };
}

/** The span from → to, stretched over `extra`, keeping the sense of travel. */
function widen(from: number, to: number, extra: readonly number[]): { from: number; to: number } {
  const points = [from, to, ...extra];
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  return from <= to ? { from: lo, to: hi } : { from: hi, to: lo };
}

/** The throat move a train makes arriving at / leaving `trackId`. */
export function trainMove(
  wiring: StationWiring,
  args: {
    kind: 'arrive' | 'depart';
    trackId: StationTrackId | undefined;
    /** Direction of travel — which line track the move uses. */
    direction: Direction;
    /** The end the train enters or leaves by. */
    end: StationEnd;
  },
): ThroatMove | undefined {
  const road = args.trackId === undefined ? undefined : wiring.byTrack.get(args.trackId);
  if (road === undefined) return undefined;
  // A road the 本線 runs into is not a divergence: the train stays where it is.
  const line = road.line.includes(args.direction)
    ? road.ladder
    : lineLadder(wiring, args.direction, road.ladder);
  const route = routeBetweenLeads(
    wiring,
    args.end,
    [args.direction],
    road.connects[args.end],
    road.ladder,
  );
  const span = widen(
    args.kind === 'arrive' ? line : road.ladder,
    args.kind === 'arrive' ? road.ladder : line,
    route.extra,
  );
  return {
    end: args.end,
    kind: args.kind,
    ...span,
    trackId: road.trackId,
    lineDirection: args.direction,
    routing: route.routing,
  };
}

/**
 * The 入換 between two roads, and the throat it is worked through.
 *
 * A shunt uses whichever end both roads are open at. Where both ends would do —
 * two through roads — the move can be worked at either, and the plan does not
 * say which; the end nearest the road being *entered* is the one a yard would
 * pick, and for the case this exists for, a stub, there is only one end anyway.
 */
export function shuntMove(
  wiring: StationWiring,
  fromTrackId: StationTrackId,
  toTrackId: StationTrackId,
): ThroatMove | undefined {
  const from = wiring.byTrack.get(fromTrackId);
  const to = wiring.byTrack.get(toTrackId);
  if (from === undefined || to === undefined || from === to) return undefined;
  const shared = to.ends.filter((e) => from.ends.includes(e));
  const end = to.stubEnd ?? from.stubEnd ?? shared[0];
  if (end === undefined || !shared.includes(end)) return undefined;
  const route = routeBetweenLeads(
    wiring,
    end,
    from.connects[end],
    to.connects[end],
    to.ladder,
  );
  return {
    end,
    kind: 'shunt',
    ...widen(from.ladder, to.ladder, route.extra),
    fromTrackId,
    trackId: toTrackId,
    routing: route.routing,
  };
}
