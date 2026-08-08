/**
 * Line view layout — pure, no canvas, no React.
 *
 * World space:
 *   x = metres along the line (`Station.kmFromOrigin`)
 *   y = **integer lane index**, top to bottom
 *
 * Lane height is fixed in CSS pixels (`LANE_HEIGHT`): only x zooms with the
 * timetable, because a taller lane conveys nothing and a train marker that
 * grows with zoom is unreadable.
 *
 * ## Lane assignment
 *
 * Lane indices are shared between stations and the open line, which is what
 * makes the view worth looking at. Down trains run on lane 0 and up trains on
 * the bottom lane; a station's 番線 are aligned to those lanes by the
 * directions they serve. The consequence is the whole point of this view:
 *
 *   - a down train that stops at 1番線 stays on lane 0 and draws a straight
 *     horizontal line,
 *   - a down train sent into the 待避線 (2番線) visibly **drops a lane** at
 *     that station and climbs back afterwards, with the express sailing past
 *     on the lane above it.
 *
 * The assignment is deterministic and provably collision-free (see
 * `assignStationLanes`), which is why it can be pinned down in unit tests
 * rather than eyeballed.
 *
 * ## Label and marker placement
 *
 * The other half of this module is the *screen-space* geometry that keeps the
 * view readable when the line is dense: which station names survive at the
 * current zoom (`StationLabelPlacer`), where a train's marker box may sit when
 * its neighbours are closer together than a marker is wide (`MarkerSlots`),
 * and how big a depot box can be (`depotBoxLayout`). All three are pure
 * number-crunching with no canvas, and all three are allocation-free after
 * warm-up so the render loop can call them every frame.
 */

import type { DepotId, StationId, StationTrackId } from '@/domain/ids';
import type { Direction, ProjectDocument, Station, StationTrack } from '@/domain/model';
import { orderedStations, tracksOfStation } from '@/domain/project';
import type { Meters } from '@/domain/units';
import { entityList } from '@/domain/units';

/** CSS pixels per lane at the minimum zoom. Only x zooms freely; see the header. */
export const LANE_HEIGHT = 26;

/**
 * Blank world reserved above lane 0 for the station-name band, measured in
 * lanes so it scales with the lane pitch and participates in the camera fit.
 * Two rows of 11 px names need ~30 px, which 1.5 lanes covers at any pitch the
 * view allows.
 */
export const LABEL_BAND_LANES = 1.5;
/** Blank world below the last lane, so a depot box is not flush with the edge. */
export const BOTTOM_PAD_LANES = 0.6;

export interface LaneCommon {
  index: number;
  /** World x range this lane occupies. */
  x0: Meters;
  x1: Meters;
  label: string;
}

export interface StationTrackLane extends LaneCommon {
  kind: 'stationTrack';
  stationId: StationId;
  trackId: StationTrackId;
  hasPlatform: boolean;
  /** 待避可 — drawn in a distinct tint. */
  canBeOvertaken: boolean;
  usage: StationTrack['usage'];
  directions: Direction[];
}

export interface SectionLane extends LaneCommon {
  kind: 'section';
  fromStationId: StationId;
  toStationId: StationId;
  direction: Direction;
  /** Index of the section: between ordered stations `i` and `i + 1`. */
  sectionIndex: number;
}

export interface DepotLane extends LaneCommon {
  kind: 'depot';
  depotId: DepotId;
  stationId: StationId;
  attachedStationId: StationId;
  trackIds: StationTrackId[];
  /** Where the stub meets the main line. */
  junctionX: Meters;
  junctionLane: number;
}

export type Lane = StationTrackLane | SectionLane | DepotLane;

export interface StationLayout {
  stationId: StationId;
  name: string;
  code?: string;
  km: Meters;
  /** World x of the station centreline. */
  x: Meters;
  x0: Meters;
  x1: Meters;
  isConnectionPoint: boolean;
  trackLanes: StationTrackLane[];
  /** Topmost and bottommost lane this station occupies. */
  laneFrom: number;
  laneTo: number;
  /** How many stop patterns call here — the 急行/各停 signal. */
  stopCount: number;
  /**
   * A stop the reader orients by: a terminus, a junction, or a station served
   * by most of the line's patterns (which on a line with a 急行 means a 急行
   * stop). Drawn in the emphatic style and never dropped from the name band
   * while an intermediate station is still shown.
   */
  isMajorStop: boolean;
  /** Higher labels win a collision. See `stationLabelPriority`. */
  labelPriority: number;
}

export interface LineLayout {
  laneHeight: number;
  /** Lanes of the running line plus every station's 番線. */
  mainLaneCount: number;
  /** Including depot stub lanes. */
  totalLaneCount: number;
  laneDown: number;
  laneUp: number;
  lanes: Lane[];
  stations: StationLayout[];
  stationOf: Map<StationId, StationLayout>;
  laneOfTrack: Map<StationTrackId, number>;
  depots: DepotLane[];
  depotLaneOfStation: Map<StationId, DepotLane>;
  /** Half the world width of a station block. */
  stationHalfWidth: Meters;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

export interface LineLayoutOptions {
  laneHeight?: number;
  /** Override the computed station block width, for tests. */
  stationHalfWidth?: Meters;
}

// ---------------------------------------------------------------------------
// Lane assignment
// ---------------------------------------------------------------------------

/**
 * Place a station's 番線 into `[0, laneCount)`.
 *
 * - down-only tracks fill from the top, in authored order;
 * - up-only tracks fill from the bottom, keeping authored top-to-bottom order;
 * - bidirectional tracks take the free lanes nearest the middle;
 * - within a direction, a **待避線 always yields the running lane** to the
 *   through road it parallels, whatever order the tracks were authored in.
 *
 * That last rule is what makes the view work. 旗の台 authors its down roads as
 * 3番線 (待避) then 4番線 (through), so naive authored order hands the
 * through lane to the passing loop: the 各停 standing in the loop is drawn
 * dead straight and the 急行 sailing past it is the one that appears to swerve
 * — precisely backwards. Sorting the loops away from the running lane makes a
 * 待避 read as a dip out of the through road and back, in both directions.
 *
 * Collision-free because `downOnly + upOnly <= trackCount <= laneCount`.
 * Returns lane index per track id.
 */
/**
 * The order tracks claim lanes in, nearest the running lane first.
 *
 * Through roads always come before 待避線; `reversed` flips the authored order
 * within each class, which is what the up side needs because it fills from the
 * bottom of the stack upwards.
 */
function fillOrder(tracks: readonly StationTrack[], reversed: boolean): StationTrack[] {
  const through: StationTrack[] = [];
  const loop: StationTrack[] = [];
  for (const t of tracks) (t.canBeOvertaken ? loop : through).push(t);
  if (reversed) {
    through.reverse();
    loop.reverse();
  }
  return through.concat(loop);
}

export function assignStationLanes(
  tracks: readonly StationTrack[],
  laneCount: number,
): Map<StationTrackId, number> {
  const out = new Map<StationTrackId, number>();
  const lanes = Math.max(laneCount, tracks.length, 1);
  const taken = new Array<boolean>(lanes).fill(false);

  const downOnly: StationTrack[] = [];
  const upOnly: StationTrack[] = [];
  const both: StationTrack[] = [];
  for (const t of tracks) {
    const d = t.directions;
    if (d.length === 1 && d[0] === 'down') downOnly.push(t);
    else if (d.length === 1 && d[0] === 'up') upOnly.push(t);
    else both.push(t);
  }

  fillOrder(downOnly, false).forEach((t, i) => {
    const lane = Math.min(i, lanes - 1);
    out.set(t.id, lane);
    taken[lane] = true;
  });

  // Filled from the bottom, and reversed within each class so that authored
  // order still reads downwards.
  fillOrder(upOnly, true).forEach((t, i) => {
    const lane = Math.max(0, lanes - 1 - i);
    out.set(t.id, lane);
    taken[lane] = true;
  });

  const free: number[] = [];
  for (let i = 0; i < lanes; i++) if (!taken[i]) free.push(i);
  const start = Math.max(0, Math.floor((free.length - both.length) / 2));
  both.forEach((t, i) => {
    const lane = free[Math.min(start + i, free.length - 1)] ?? 0;
    out.set(t.id, lane);
  });

  return out;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * How wide a station block is, given the tightest section on the line.
 *
 * Takes only the km field so it can be exercised directly with a list of
 * distances rather than a set of fully-built stations.
 */
export function computeStationHalfWidth(
  stations: ReadonlyArray<Pick<Station, 'kmFromOrigin'>>,
): Meters {
  let minGap = Infinity;
  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1];
    const b = stations[i];
    if (!a || !b) continue;
    const gap = b.kmFromOrigin - a.kmFromOrigin;
    if (gap > 0 && gap < minGap) minGap = gap;
  }
  if (!Number.isFinite(minGap)) minGap = 1000;
  return Math.max(25, Math.min(250, Math.round(minGap * 0.15)));
}

/**
 * How far a depot stub may reach, in metres.
 *
 * A depot node's `kmFromOrigin` is a routing fact, not a drawing instruction:
 * 長津田車両工場 sits at km 30 off a 16.9 km line purely so that 重要部検査
 * moves have somewhere to go. Fitting the camera to that squeezes the entire
 * line into half the canvas for the sake of a node no train ever reaches, so
 * the drawn stub is capped. The cap is generous enough that a genuinely short
 * stub (a yard just beyond the terminus) is still drawn at its true length.
 */
export function depotStubCap(lineSpan: Meters, halfWidth: Meters): Meters {
  return Math.max(halfWidth * 6, lineSpan * 0.06, 200);
}

/**
 * Ranking used when two station names cannot both be drawn.
 *
 * A 急行 stop must never lose to an intermediate one, and the two ends of the
 * line must never be dropped at all — losing "大井町" tells the reader nothing
 * about where they are looking.
 */
export function stationLabelPriority(s: {
  isTerminal: boolean;
  isConnectionPoint: boolean;
  stopCount: number;
}): number {
  return (
    (s.isTerminal ? 1_000_000 : 0) + (s.isConnectionPoint ? 10_000 : 0) + Math.max(0, s.stopCount)
  );
}

/**
 * Is this one of the stops a reader orients by?
 *
 * "Served by at least three quarters of the busiest station's patterns" is a
 * document-independent way of saying 急行停車駅 without hard-coding a train
 * type: on 大井町線 the 急行 stops are called at by 10 patterns and the
 * intermediate stations by 6, so the line falls exactly where it should.
 */
export function isMajorStop(s: {
  isTerminal: boolean;
  isConnectionPoint: boolean;
  stopCount: number;
  maxStopCount: number;
}): boolean {
  if (s.isTerminal || s.isConnectionPoint) return true;
  return s.maxStopCount > 0 && s.stopCount * 4 >= s.maxStopCount * 3;
}

/** stationId -> number of stop patterns that actually stop there. */
function stopCounts(doc: ProjectDocument): Map<string, number> {
  const out = new Map<string, number>();
  for (const pattern of entityList(doc.stopPatterns)) {
    for (const [stationId, kind] of Object.entries(pattern.entries)) {
      if (kind !== 'stop') continue;
      out.set(stationId, (out.get(stationId) ?? 0) + 1);
    }
  }
  return out;
}

export function computeLineLayout(
  doc: ProjectDocument,
  opts: LineLayoutOptions = {},
): LineLayout {
  const laneHeight = opts.laneHeight ?? LANE_HEIGHT;
  const ordered = orderedStations(doc);
  const halfWidth = opts.stationHalfWidth ?? computeStationHalfWidth(ordered);

  let maxTracks = 0;
  for (const s of ordered) maxTracks = Math.max(maxTracks, s.trackIds.length);
  const mainLaneCount = Math.max(2, maxTracks);
  const laneDown = 0;
  const laneUp = mainLaneCount - 1;

  const lanes: Lane[] = [];
  const stations: StationLayout[] = [];
  const stationOf = new Map<StationId, StationLayout>();
  const laneOfTrack = new Map<StationTrackId, number>();
  const counts = stopCounts(doc);

  // -- station blocks -------------------------------------------------------
  for (const station of ordered) {
    const tracks = tracksOfStation(doc, station.id);
    const assignment = assignStationLanes(tracks, mainLaneCount);
    const x0 = station.kmFromOrigin - halfWidth;
    const x1 = station.kmFromOrigin + halfWidth;

    const trackLanes: StationTrackLane[] = [];
    for (const t of tracks) {
      const index = assignment.get(t.id) ?? 0;
      laneOfTrack.set(t.id, index);
      const lane: StationTrackLane = {
        kind: 'stationTrack',
        index,
        x0,
        x1,
        label: t.name,
        stationId: station.id,
        trackId: t.id,
        hasPlatform: t.hasPlatform,
        canBeOvertaken: t.canBeOvertaken,
        usage: t.usage,
        directions: t.directions,
      };
      trackLanes.push(lane);
      lanes.push(lane);
    }
    trackLanes.sort((a, b) => a.index - b.index);

    const laneFrom = trackLanes.length > 0 ? trackLanes[0]!.index : laneDown;
    const laneTo = trackLanes.length > 0 ? trackLanes[trackLanes.length - 1]!.index : laneUp;
    const isTerminal = station === ordered[0] || station === ordered[ordered.length - 1];
    const stopCount = counts.get(station.id) ?? 0;
    const layout: StationLayout = {
      stationId: station.id,
      name: station.name,
      km: station.kmFromOrigin,
      x: station.kmFromOrigin,
      x0,
      x1,
      isConnectionPoint: station.isConnectionPoint,
      trackLanes,
      laneFrom,
      laneTo,
      stopCount,
      // Settled below, once the busiest station on the line is known.
      isMajorStop: false,
      labelPriority: stationLabelPriority({
        isTerminal,
        isConnectionPoint: station.isConnectionPoint,
        stopCount,
      }),
    };
    if (station.code !== undefined) layout.code = station.code;
    stations.push(layout);
    stationOf.set(station.id, layout);
  }

  // -- open-line sections ---------------------------------------------------
  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1]!;
    const b = stations[i]!;
    const x0 = a.x1;
    const x1 = b.x0;
    lanes.push({
      kind: 'section',
      index: laneDown,
      x0,
      x1,
      label: `${a.name}→${b.name}`,
      fromStationId: a.stationId,
      toStationId: b.stationId,
      direction: 'down',
      sectionIndex: i - 1,
    });
    lanes.push({
      kind: 'section',
      index: laneUp,
      x0,
      x1,
      label: `${b.name}→${a.name}`,
      fromStationId: b.stationId,
      toStationId: a.stationId,
      direction: 'up',
      sectionIndex: i - 1,
    });
  }

  // Emphasis is relative to the busiest station, so it can only be settled
  // once every station has been counted.
  let maxStopCount = 0;
  for (const s of stations) maxStopCount = Math.max(maxStopCount, s.stopCount);
  stations.forEach((s, i) => {
    s.isMajorStop = isMajorStop({
      isTerminal: i === 0 || i === stations.length - 1,
      isConnectionPoint: s.isConnectionPoint,
      stopCount: s.stopCount,
      maxStopCount,
    });
  });

  // -- line extent (before the depots get a say) ----------------------------
  let minX = Infinity;
  let maxX = -Infinity;
  for (const s of ordered) {
    minX = Math.min(minX, s.kmFromOrigin - halfWidth);
    maxX = Math.max(maxX, s.kmFromOrigin + halfWidth);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    maxX = 1000;
  }
  const stubCap = depotStubCap(maxX - minX, halfWidth);

  // -- depot stubs ----------------------------------------------------------
  const depots: DepotLane[] = [];
  const depotLaneOfStation = new Map<StationId, DepotLane>();
  const depotEntities = entityList(doc.depots);
  depotEntities.forEach((depot, i) => {
    const depotStation = doc.stations.byId[depot.stationId];
    const attached = stationOf.get(depot.attachedStationId);
    const junctionX = attached?.x ?? 0;
    const trueX = depotStation?.kmFromOrigin ?? junctionX + (depot.stubOffsetMeters || -500);
    const outward = trueX < junctionX ? -1 : 1;
    // Capped, but never shorter than the true stub: a 500 m yard stays 500 m.
    const reach = Math.min(Math.abs(trueX - junctionX), stubCap);
    const depotX = junctionX + outward * reach;
    const trackIds = depotStation?.trackIds ?? [];
    const index = mainLaneCount + i;
    const lane: DepotLane = {
      kind: 'depot',
      index,
      x0: Math.min(depotX, junctionX),
      x1: Math.max(depotX, junctionX),
      label: depot.name,
      depotId: depot.id,
      stationId: depot.stationId,
      attachedStationId: depot.attachedStationId,
      trackIds: [...trackIds],
      junctionX,
      junctionLane: outward < 0 ? laneDown : laneUp,
    };
    for (const tid of trackIds) laneOfTrack.set(tid, index);
    depots.push(lane);
    lanes.push(lane);
    depotLaneOfStation.set(depot.stationId, lane);
    minX = Math.min(minX, lane.x0);
    maxX = Math.max(maxX, lane.x1);
  });

  const totalLaneCount = mainLaneCount + depots.length;

  return {
    laneHeight,
    mainLaneCount,
    totalLaneCount,
    laneDown,
    laneUp,
    lanes,
    stations,
    stationOf,
    laneOfTrack,
    depots,
    depotLaneOfStation,
    stationHalfWidth: halfWidth,
    // The label band and the bottom gutter are part of the world, so the
    // camera fit reserves room for station names instead of the draw code
    // having to sneak them into a margin the camera does not know about.
    bounds: {
      minX,
      maxX,
      minY: -LABEL_BAND_LANES,
      maxY: totalLaneCount + BOTTOM_PAD_LANES,
    },
  };
}

// ---------------------------------------------------------------------------
// Placing a train
// ---------------------------------------------------------------------------

export interface TrainPlacement {
  /** World x — metres along the line. */
  x: Meters;
  /** World y — lane index (the marker is centred on `lane + 0.5`). */
  lane: number;
}

/** The lane a train uses while running in the open, by direction. */
export function runningLane(layout: LineLayout, direction: Direction): number {
  return direction === 'down' ? layout.laneDown : layout.laneUp;
}

/**
 * Where to draw a train.
 *
 * A train standing on an assigned 番線 uses that track's lane — which is how a
 * 待避 becomes visible as a vertical displacement. Everything else falls back
 * to the running lane for its direction, and anything touching a depot station
 * falls onto that depot's stub lane.
 */
export interface PlaceTrainArgs {
  km: Meters;
  direction: Direction;
  trackId?: StationTrackId | undefined;
  stationId?: StationId | undefined;
  fromStationId?: StationId | undefined;
  toStationId?: StationId | undefined;
}

export function placeTrain(layout: LineLayout, args: PlaceTrainArgs): TrainPlacement {
  return placeTrainInto(layout, args, { x: 0, lane: 0 });
}

/**
 * `placeTrain` writing into a caller-owned result.
 *
 * The dynamic layer places every train every frame; returning a fresh object
 * per train per frame is exactly the allocation the render loop is not allowed
 * to make.
 */
export function placeTrainInto(
  layout: LineLayout,
  args: PlaceTrainArgs,
  out: TrainPlacement,
): TrainPlacement {
  const { km, direction, trackId, stationId, fromStationId, toStationId } = args;
  out.x = km;

  if (trackId !== undefined) {
    const lane = layout.laneOfTrack.get(trackId);
    if (lane !== undefined) {
      out.lane = lane;
      return out;
    }
  }

  const depotLane =
    (stationId !== undefined ? layout.depotLaneOfStation.get(stationId) : undefined) ??
    (fromStationId !== undefined ? layout.depotLaneOfStation.get(fromStationId) : undefined) ??
    (toStationId !== undefined ? layout.depotLaneOfStation.get(toStationId) : undefined);
  if (depotLane) {
    out.lane = depotLane.index;
    return out;
  }

  if (stationId !== undefined) {
    const station = layout.stationOf.get(stationId);
    if (station && station.trackLanes.length > 0) {
      for (const l of station.trackLanes) {
        if (l.directions.includes(direction)) {
          out.lane = l.index;
          return out;
        }
      }
    }
  }

  out.lane = runningLane(layout, direction);
  return out;
}

/** Screen y of the centre of a lane, given the camera's y scale and origin. */
export function laneCenterY(lane: number, camY: number, scaleY: number): number {
  return (lane + 0.5 - camY) * scaleY;
}

// ---------------------------------------------------------------------------
// Station label collision resolution
// ---------------------------------------------------------------------------

/** Vertical pitch of the station-name rows, CSS pixels. */
export const LABEL_ROW_PITCH = 14;
/** Horizontal breathing room required between two names on the same row. */
export const LABEL_GAP = 5;

export interface LabelCandidate {
  /** Screen x of the station centreline; the name is centred on it. */
  x: number;
  /** Measured width of the name, CSS pixels. */
  width: number;
  /** Higher wins a collision. See `stationLabelPriority`. */
  priority: number;
}

/** Row assigned to a candidate, or `DROPPED` when it did not fit anywhere. */
export const DROPPED = -1;

/**
 * Which station names can be drawn, and on which row.
 *
 * The line has 23 stations in 16.9 km and the first eight are inside the first
 * two kilometres, so at the fitted zoom their names simply cannot all be
 * drawn. Shrinking the font until they fit trades one unreadable picture for
 * another, so instead:
 *
 *   1. names are placed most-important-first (so a 急行 stop can never be
 *      crowded out by the 各停 stop next to it),
 *   2. each name takes the topmost row it fits on — two rows roughly doubles
 *      the density the view survives,
 *   3. a name with no free row is dropped, and reappears on its own as the
 *      user zooms in and its neighbours move apart.
 *
 * The result is overlap-free **by construction**: a row only ever accepts an
 * interval that misses everything already on it.
 *
 * Reusable and allocation-free after the first `push` of a given size, because
 * this runs on every static redraw — which means every frame of a pan.
 */
export class StationLabelPlacer {
  private xs = new Float64Array(0);
  private widths = new Float64Array(0);
  private priorities = new Float64Array(0);
  private rows = new Int32Array(0);
  private order = new Int32Array(0);
  /** Per row: parallel interval lists, `rowCap` entries each. */
  private rowLeft = new Float64Array(0);
  private rowRight = new Float64Array(0);
  private rowCount = new Int32Array(0);
  private n = 0;
  private rowLimit = 2;
  private gap = LABEL_GAP;

  get count(): number {
    return this.n;
  }

  get rowsUsed(): number {
    return this.rowLimit;
  }

  /** Begin a new placement pass. `rows` is clamped to at least one. */
  reset(rows = 2, gap = LABEL_GAP): void {
    this.n = 0;
    this.rowLimit = Math.max(1, Math.floor(rows));
    this.gap = gap;
    this.ensureRows();
    this.rowCount.fill(0);
  }

  /** Register a candidate; returns its slot index. */
  push(x: number, width: number, priority: number): number {
    if (this.n === this.xs.length) this.grow();
    const i = this.n++;
    this.xs[i] = x;
    this.widths[i] = width;
    this.priorities[i] = priority;
    this.rows[i] = DROPPED;
    return i;
  }

  /** Assign rows. Call once after all candidates are pushed. */
  solve(): void {
    const n = this.n;
    this.ensureRows();
    this.rowCount.fill(0);
    for (let i = 0; i < n; i++) {
      this.order[i] = i;
      this.rows[i] = DROPPED;
    }
    // Insertion sort by (priority desc, x asc, index asc). n is the station
    // count — tens, not thousands — and this allocates nothing.
    for (let i = 1; i < n; i++) {
      const v = this.order[i]!;
      let j = i - 1;
      while (j >= 0 && this.before(v, this.order[j]!)) {
        this.order[j + 1] = this.order[j]!;
        j--;
      }
      this.order[j + 1] = v;
    }

    for (let k = 0; k < n; k++) {
      const i = this.order[k]!;
      const half = this.widths[i]! / 2;
      const left = this.xs[i]! - half - this.gap;
      const right = this.xs[i]! + half + this.gap;
      for (let r = 0; r < this.rowLimit; r++) {
        if (!this.free(r, left, right)) continue;
        const base = r * this.xs.length;
        const c = this.rowCount[r]!;
        this.rowLeft[base + c] = left;
        this.rowRight[base + c] = right;
        this.rowCount[r] = c + 1;
        this.rows[i] = r;
        break;
      }
    }
  }

  /** Row of slot `i`, or `DROPPED`. */
  rowAt(i: number): number {
    return this.rows[i] ?? DROPPED;
  }

  private before(a: number, b: number): boolean {
    const pa = this.priorities[a]!;
    const pb = this.priorities[b]!;
    if (pa !== pb) return pa > pb;
    const xa = this.xs[a]!;
    const xb = this.xs[b]!;
    if (xa !== xb) return xa < xb;
    return a < b;
  }

  private free(row: number, left: number, right: number): boolean {
    const base = row * this.xs.length;
    const c = this.rowCount[row]!;
    for (let i = 0; i < c; i++) {
      if (left < this.rowRight[base + i]! && right > this.rowLeft[base + i]!) return false;
    }
    return true;
  }

  private ensureRows(): void {
    const need = this.rowLimit * Math.max(this.xs.length, 1);
    if (this.rowLeft.length >= need && this.rowCount.length >= this.rowLimit) return;
    this.rowLeft = new Float64Array(need);
    this.rowRight = new Float64Array(need);
    this.rowCount = new Int32Array(Math.max(this.rowLimit, this.rowCount.length));
  }

  private grow(): void {
    const cap = Math.max(32, this.xs.length * 2);
    const xs = new Float64Array(cap);
    xs.set(this.xs);
    const widths = new Float64Array(cap);
    widths.set(this.widths);
    const priorities = new Float64Array(cap);
    priorities.set(this.priorities);
    this.xs = xs;
    this.widths = widths;
    this.priorities = priorities;
    this.rows = new Int32Array(cap);
    this.order = new Int32Array(cap);
    this.rowLeft = new Float64Array(0);
    this.ensureRows();
  }
}

/** Convenience wrapper over `StationLabelPlacer` for tests and one-off calls. */
export function resolveStationLabels(
  candidates: readonly LabelCandidate[],
  opts: { rows?: number; gap?: number } = {},
): number[] {
  const placer = new StationLabelPlacer();
  placer.reset(opts.rows ?? 2, opts.gap ?? LABEL_GAP);
  for (const c of candidates) placer.push(c.x, c.width, c.priority);
  placer.solve();
  return candidates.map((_, i) => placer.rowAt(i));
}

// ---------------------------------------------------------------------------
// Train marker de-overlap
// ---------------------------------------------------------------------------

/**
 * Where each train's marker box may sit, given that markers are a fixed 92 px
 * wide and the fitted zoom puts adjacent stations 45 px apart.
 *
 * The box is allowed to slide *along its lane*; the train's true position is
 * kept separately and is what the tick and the leader line point at, so the
 * km reading stays unambiguous while the label stays readable. Trains never
 * change lane here — the lane carries meaning (待避線 vs through line) and is
 * not negotiable.
 *
 * The slide is the exact least-squares answer, not a greedy push: minimise
 * `Σ (placed_i − desired_i)²` subject to `placed_{i+1} ≥ placed_i + step`.
 * Substituting `u_i = placed_i − i·step` turns that into isotonic regression
 * on `u`, which pool-adjacent-violators solves in one pass. The practical
 * difference from a greedy left-to-right push is that a cluster ends up
 * *centred* on the trains in it rather than smeared to the right.
 */
export class MarkerSlots {
  private lanes = new Float64Array(0);
  private desired = new Float64Array(0);
  private placed = new Float64Array(0);
  private order = new Int32Array(0);
  private blockSum = new Float64Array(0);
  private blockCount = new Int32Array(0);
  private n = 0;

  get count(): number {
    return this.n;
  }

  reset(): void {
    this.n = 0;
  }

  /** Register a marker centre; returns its slot index. */
  push(lane: number, x: number): number {
    if (this.n === this.lanes.length) this.grow();
    const i = this.n++;
    this.lanes[i] = lane;
    this.desired[i] = x;
    this.placed[i] = x;
    return i;
  }

  solve(width: number, gap: number): void {
    const n = this.n;
    const step = width + gap;
    for (let i = 0; i < n; i++) {
      this.order[i] = i;
      this.placed[i] = this.desired[i]!;
    }
    for (let i = 1; i < n; i++) {
      const v = this.order[i]!;
      let j = i - 1;
      while (j >= 0 && this.before(v, this.order[j]!)) {
        this.order[j + 1] = this.order[j]!;
        j--;
      }
      this.order[j + 1] = v;
    }

    let s = 0;
    while (s < n) {
      const lane = this.lanes[this.order[s]!]!;
      let e = s + 1;
      while (e < n && this.lanes[this.order[e]!] === lane) e++;
      this.solveRun(s, e, step);
      s = e;
    }
  }

  /** Isotonic regression over `order[s..e)`, all on one lane. */
  private solveRun(s: number, e: number, step: number): void {
    let m = 0;
    for (let k = s; k < e; k++) {
      const v = this.desired[this.order[k]!]! - (k - s) * step;
      this.blockSum[m] = v;
      this.blockCount[m] = 1;
      m++;
      while (
        m > 1 &&
        this.blockSum[m - 1]! / this.blockCount[m - 1]! <
          this.blockSum[m - 2]! / this.blockCount[m - 2]!
      ) {
        this.blockSum[m - 2] = this.blockSum[m - 2]! + this.blockSum[m - 1]!;
        this.blockCount[m - 2] = this.blockCount[m - 2]! + this.blockCount[m - 1]!;
        m--;
      }
    }
    let k = s;
    for (let b = 0; b < m; b++) {
      const avg = this.blockSum[b]! / this.blockCount[b]!;
      for (let j = 0; j < this.blockCount[b]!; j++) {
        this.placed[this.order[k]!] = avg + (k - s) * step;
        k++;
      }
    }
  }

  /** Resolved marker centre for slot `i`. */
  xAt(i: number): number {
    return this.placed[i] ?? 0;
  }

  /** True screen position of slot `i` — what the tick points at. */
  anchorAt(i: number): number {
    return this.desired[i] ?? 0;
  }

  /** How far slot `i` had to move to stop overlapping its neighbours. */
  shiftAt(i: number): number {
    return (this.placed[i] ?? 0) - (this.desired[i] ?? 0);
  }

  private before(a: number, b: number): boolean {
    const la = this.lanes[a]!;
    const lb = this.lanes[b]!;
    if (la !== lb) return la < lb;
    const xa = this.desired[a]!;
    const xb = this.desired[b]!;
    if (xa !== xb) return xa < xb;
    return a < b;
  }

  private grow(): void {
    const cap = Math.max(64, this.lanes.length * 2);
    const lanes = new Float64Array(cap);
    lanes.set(this.lanes);
    const desired = new Float64Array(cap);
    desired.set(this.desired);
    this.lanes = lanes;
    this.desired = desired;
    this.placed = new Float64Array(cap);
    this.order = new Int32Array(cap);
    this.blockSum = new Float64Array(cap);
    this.blockCount = new Int32Array(cap);
  }
}

export interface ResolvedMarker {
  /** Where the box is drawn. */
  x: number;
  /** Where the train actually is. */
  anchorX: number;
  lane: number;
}

/** Convenience wrapper over `MarkerSlots` for tests and one-off calls. */
export function resolveMarkerSlots(
  items: ReadonlyArray<{ lane: number; x: number }>,
  width: number,
  gap: number,
): ResolvedMarker[] {
  const slots = new MarkerSlots();
  slots.reset();
  for (const it of items) slots.push(it.lane, it.x);
  slots.solve(width, gap);
  return items.map((it, i) => ({ x: slots.xAt(i), anchorX: it.x, lane: it.lane }));
}

// ---------------------------------------------------------------------------
// Depot box
// ---------------------------------------------------------------------------

export const DEPOT_BOX_MIN_W = 112;
export const DEPOT_BOX_MAX_W = 248;
/** Below this width the box only has room for the name and the count. */
export const DEPOT_BOX_CODES_W = 176;

export interface DepotBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** +1 when the depot lies beyond the junction, -1 when before it. */
  outward: number;
  /** Whether the box is wide enough to list formation codes. */
  showCodes: boolean;
}

/**
 * The depot's box, in screen pixels.
 *
 * Deliberately *not* a world-space rectangle. 鷺沼車庫's stub is 500 m and
 * 長津田車両工場's is capped at ~1 km, which at the fitted zoom is 37 px and
 * 76 px — a box drawn to scale would be an illegible sliver and a wide empty
 * bar respectively. Instead the box is a fixed minimum size anchored to the
 * end of the stub, and it *grows* with the stub as the user zooms in, gaining
 * room for the formation codes once it is wide enough to hold them.
 */
export function depotBoxLayout(args: {
  /** Screen x where the stub leaves the main line. */
  junctionX: number;
  /** Screen x of the far end of the stub. */
  stubEndX: number;
  /** Screen y of the depot lane's centre. */
  centerY: number;
  laneHeight: number;
  viewportWidth: number;
}): DepotBox {
  const { junctionX, stubEndX, centerY, laneHeight, viewportWidth } = args;
  const outward = stubEndX < junctionX ? -1 : 1;
  const room = Math.abs(stubEndX - junctionX);
  const w = Math.max(DEPOT_BOX_MIN_W, Math.min(DEPOT_BOX_MAX_W, room));
  const h = Math.max(24, Math.min(38, laneHeight - 6));

  // Anchored to the stub end and grown back towards the junction, so the box
  // is always attached to the thing it labels and never hangs off the edge.
  let x = outward < 0 ? stubEndX : stubEndX - w;
  const limit = viewportWidth - w - 4;
  if (limit > 4) x = Math.max(4, Math.min(limit, x));

  return { x, y: centerY - h / 2, w, h, outward, showCodes: w >= DEPOT_BOX_CODES_W && h >= 28 };
}
