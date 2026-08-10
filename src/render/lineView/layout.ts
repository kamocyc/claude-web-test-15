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
 * ## The wiring is drawn, and the trains follow it
 *
 * A 番線 that is not the running lane is joined to the running lanes it serves
 * by a **lead** at each end of the station block, and a depot's roads fan out
 * of a **throat** off the main line. Those leads are not decoration: the same
 * numbers place the trains, so a train entering the 待避線 swings out of the
 * through road along the drawn turnout instead of changing lane in one frame,
 * and a 回送 entering the yard runs down the throat onto its own road. Every
 * position a marker can take is a point on a line this module also draws.
 *
 * ## Label and marker placement
 *
 * The other half of this module is the *screen-space* geometry that keeps the
 * view readable when the line is dense: which station and train labels survive
 * at the current zoom and on which row (`StationLabelPlacer`), and where a
 * yard's name plate goes (`depotPlateLayout`). Both are pure number-crunching
 * with no canvas, and both are allocation-free after warm-up so the render loop
 * can call them every frame.
 *
 * Note what is *not* here any more: nothing moves a train to make room. A
 * marker that slides along its lane to avoid its neighbour is a marker in the
 * wrong place, and on a line view the position is the whole message. Crowding
 * is resolved by moving the *label* to a free row, or by dropping the label and
 * leaving the dot.
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
/** Blank world below the last lane, so a yard is not flush with the edge. */
export const BOTTOM_PAD_LANES = 0.6;
/** Blank lanes between the running lines and a yard, and between two yards. */
export const DEPOT_GAP_LANES = 0.5;

/**
 * How much of a station block each turnout lead takes, either end.
 *
 * Slightly over half, so a road that leaves the running lane and comes back
 * has a short flat body in the middle — long enough to carry the road's name
 * and to stand a train on without the marker sitting on a diagonal.
 */
export const LEAD_FRACTION = 0.55;

/**
 * Lane pitch inside a yard, in main-line lanes per road.
 *
 * 鷺沼車庫 has ten stabling roads. Drawn at the full lane pitch they would take
 * more vertical space than the entire running railway, for 500 m of a 17 km
 * line — so beyond a handful of roads a yard is packed tighter, and the pitch
 * shrinks so that a yard of any size stays about four lanes deep. Nothing runs
 * at speed in a yard and what sits on these lanes is a formation chip rather
 * than a train marker, so the pitch only has to keep the roads apart.
 */
export function depotLanePitch(trackCount: number): number {
  return trackCount <= 4 ? 1 : Math.max(0.3, 4 / trackCount);
}

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
  /** The flat body of the road; `[x0, bodyX0]` and `[bodyX1, x1]` are leads. */
  bodyX0: Meters;
  bodyX1: Meters;
  /** Running lanes this road is connected to. Empty when it is one of them. */
  leadLanes: number[];
}

export interface SectionLane extends LaneCommon {
  kind: 'section';
  fromStationId: StationId;
  toStationId: StationId;
  direction: Direction;
  /** Index of the section: between ordered stations `i` and `i + 1`. */
  sectionIndex: number;
}

/** One road of a yard. Depot roads are lanes like any other. */
export interface DepotTrackLane extends LaneCommon {
  kind: 'depotTrack';
  depotId: DepotId;
  stationId: StationId;
  trackId: StationTrackId;
  usage: StationTrack['usage'];
}

/**
 * A yard: the throat off the main line, the ladder, and one lane per road.
 *
 * Not a `Lane` itself — nothing is drawn *on* it. The depot's own roads are,
 * and they are what a train or a stabled formation sits on.
 */
export interface DepotLane {
  kind: 'depot';
  depotId: DepotId;
  /** The synthetic depot `Station`. */
  stationId: StationId;
  attachedStationId: StationId;
  label: string;
  /** The depot node's km — a routing fact the drawn geometry compresses. */
  km: Meters;
  /** Where the throat leaves the main line: the edge of the attached block. */
  junctionX: Meters;
  /** Where the throat fans out. */
  rootX: Meters;
  rootLane: number;
  /** Where the roads become parallel. */
  throatX: Meters;
  /** The far end of the yard. */
  endX: Meters;
  /** Where a formation stands: the middle of a road's flat body. */
  berthX: Meters;
  x0: Meters;
  x1: Meters;
  tracks: DepotTrackLane[];
  /** Lane for stock whose road the plan does not name — the yard lead. */
  leadLane: number;
  laneFrom: number;
  laneTo: number;
  /** Lanes per road. See `depotLanePitch`. */
  lanePitch: number;
}

export type Lane = StationTrackLane | SectionLane | DepotTrackLane;

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
  /** Including every yard road. Fractional, because yard lanes are packed. */
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
  /** World length of one turnout lead, either end of a station block. */
  stationLeadWidth: Meters;
  /** Everything there is: what panning and zooming is allowed to reach. */
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  /**
   * What the camera frames when the view opens.
   *
   * Not the same rectangle. A line with two yards has half again as many lanes
   * as it has running roads, and fitting all of them would shrink the railway
   * itself to make room for stabling roads nobody has asked to look at yet. So
   * the opening shot is the running line plus the head of the first yard, and
   * the rest is a scroll away — the same progressive-disclosure bargain the
   * station-name band already makes.
   */
  fitBounds: { minX: number; maxX: number; minY: number; maxY: number };
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
 * the drawn stub is capped.
 */
export function depotStubCap(lineSpan: Meters, halfWidth: Meters): Meters {
  return Math.max(halfWidth * 6, lineSpan * 0.16, 200);
}

/**
 * How long a yard is *drawn*, given how long it really is.
 *
 * Capped at the top for the reason above, and floored at the bottom for the
 * mirror-image reason: 鷺沼車庫 is 500 m off a 17 km line, which is 3% of the
 * width — a ladder of ten roads inside 25 px is a smear, not a track layout.
 *
 * So a yard is drawn **schematically**: long enough for its roads to read as
 * roads and to be zoomed into, short enough not to dominate the line. This is
 * the one place the km axis is knowingly not to scale, and it is the same
 * bargain the cap already makes at the other end — with the difference that
 * `placeTrain` maps km onto the drawn stub, so a 回送 into the yard still
 * arrives exactly when the timetable says it does.
 */
export function depotStubReach(
  trueReach: Meters,
  lineSpan: Meters,
  halfWidth: Meters,
): Meters {
  const cap = depotStubCap(lineSpan, halfWidth);
  const floor = Math.min(cap, Math.max(halfWidth * 3, lineSpan * 0.14));
  return Math.min(Math.max(trueReach, floor), cap);
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
  const leadWidth = halfWidth * LEAD_FRACTION;

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
      // Which running lanes this road is switched into. A road sitting on the
      // running lane it serves needs no lead: it *is* the through road.
      const leadLanes: number[] = [];
      for (const d of t.directions) {
        const running = d === 'down' ? laneDown : laneUp;
        if (running !== index && !leadLanes.includes(running)) leadLanes.push(running);
      }
      const inset = leadLanes.length > 0 ? leadWidth : 0;
      const lane: StationTrackLane = {
        kind: 'stationTrack',
        index,
        x0,
        x1,
        bodyX0: x0 + inset,
        bodyX1: x1 - inset,
        leadLanes,
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
  const lineSpan = maxX - minX;

  // -- yards ----------------------------------------------------------------
  // A depot is a fan of roads off the running line, not a box: its throat
  // leaves the main line at the edge of the attached station's block, opens
  // into a ladder, and every stabling road gets a lane of its own so a
  // formation can be drawn on the road the plan actually berths it on.
  const depots: DepotLane[] = [];
  const depotLaneOfStation = new Map<StationId, DepotLane>();
  let nextFreeLane = mainLaneCount;
  let maxLane = mainLaneCount - 1;

  for (const depot of entityList(doc.depots)) {
    const depotStation = doc.stations.byId[depot.stationId];
    const attached = stationOf.get(depot.attachedStationId);
    const centreX = attached?.x ?? 0;
    const km = depotStation?.kmFromOrigin ?? centreX + (depot.stubOffsetMeters || -500);
    const outward = km < centreX ? -1 : 1;
    const junctionX = centreX + outward * halfWidth;
    const reach = depotStubReach(Math.abs(km - centreX), lineSpan, halfWidth);
    const endX = centreX + outward * reach;
    // Lead, then ladder, then the roads themselves. The lead gets the largest
    // share: it is a single track, and it is the bit a train is drawn moving
    // along on its way in and out.
    const stubLen = Math.abs(endX - junctionX);
    const rootX = junctionX + outward * stubLen * 0.45;
    const throatX = junctionX + outward * stubLen * 0.6;

    const tracks = tracksOfStation(doc, depot.stationId);
    const pitch = depotLanePitch(tracks.length);
    const laneFrom = nextFreeLane + DEPOT_GAP_LANES;
    const rootLane = laneFrom - DEPOT_GAP_LANES / 2;

    const trackLanes: DepotTrackLane[] = tracks.map((t, i) => {
      const index = laneFrom + i * pitch;
      laneOfTrack.set(t.id, index);
      return {
        kind: 'depotTrack',
        index,
        x0: Math.min(rootX, endX),
        x1: Math.max(rootX, endX),
        label: t.name,
        depotId: depot.id,
        stationId: depot.stationId,
        trackId: t.id,
        usage: t.usage,
      };
    });
    for (const lane of trackLanes) lanes.push(lane);

    const laneTo = trackLanes.length > 0 ? trackLanes[trackLanes.length - 1]!.index : laneFrom;
    const yard: DepotLane = {
      kind: 'depot',
      depotId: depot.id,
      stationId: depot.stationId,
      attachedStationId: depot.attachedStationId,
      label: depot.name,
      km,
      junctionX,
      rootX,
      rootLane,
      throatX,
      endX,
      berthX: (throatX + endX) / 2,
      x0: Math.min(endX, junctionX),
      x1: Math.max(endX, junctionX),
      tracks: trackLanes,
      leadLane: rootLane,
      laneFrom,
      laneTo,
      lanePitch: pitch,
    };
    depots.push(yard);
    depotLaneOfStation.set(depot.stationId, yard);
    minX = Math.min(minX, yard.x0);
    maxX = Math.max(maxX, yard.x1);
    maxLane = Math.max(maxLane, laneTo);
    nextFreeLane = laneTo + 1;
  }

  const totalLaneCount = maxLane + 1;

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
    stationLeadWidth: leadWidth,
    // The label band and the bottom gutter are part of the world, so the
    // camera fit reserves room for station names instead of the draw code
    // having to sneak them into a margin the camera does not know about.
    bounds: {
      minX,
      maxX,
      minY: -LABEL_BAND_LANES,
      maxY: totalLaneCount + BOTTOM_PAD_LANES,
    },
    fitBounds: {
      minX,
      maxX,
      minY: -LABEL_BAND_LANES,
      maxY: Math.min(totalLaneCount + BOTTOM_PAD_LANES, mainLaneCount + 1),
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
 * 待避 becomes visible as a vertical displacement. A train *between* two stops
 * is placed on the polyline that joins the road it left to the road it is
 * heading for, through the running lane in between: the same leads the static
 * layer draws. That is what stops a train from changing lane in a single frame
 * at the departure instant, and what makes a 出庫回送 come up the yard throat
 * instead of sliding along the bottom of the picture.
 *
 * The x axis is remapped the same way. A depot node's km is a routing fact —
 * 長津田車両工場 sits at km 30 off a 17 km line — so a leg that touches a yard
 * maps km linearly onto the *drawn* stub. Otherwise a 回送 to the works would
 * fly off the end of the line while its yard stayed where it was drawn.
 */
export interface PlaceTrainArgs {
  km: Meters;
  direction: Direction;
  trackId?: StationTrackId | undefined;
  stationId?: StationId | undefined;
  fromStationId?: StationId | undefined;
  toStationId?: StationId | undefined;
  fromTrackId?: StationTrackId | undefined;
  toTrackId?: StationTrackId | undefined;
  /** 0..1 across a shunt from `fromTrackId` onto `trackId`, at one station. */
  trackBlend?: number | undefined;
}

/**
 * One end of a leg: where it sits, and how the wiring leaves it.
 *
 * `off[i]`/`lane[i]` is a polyline in "distance from the anchor towards the
 * other end" — `off[0]` is always 0. Fixed-size and reused, because the
 * dynamic layer resolves this for every train on every frame.
 */
interface EndKnots {
  x: number;
  km: number;
  n: number;
  reach: number;
  off: Float64Array;
  lane: Float64Array;
}

function emptyKnots(): EndKnots {
  return { x: 0, km: 0, n: 1, reach: 0, off: new Float64Array(4), lane: new Float64Array(4) };
}

/** Reusable solver buffers — see the note on allocation above. */
const endA = emptyKnots();
const endB = emptyKnots();

/** The lane a train standing at `stationId` on `trackId` occupies. */
function standingLane(
  layout: LineLayout,
  stationId: StationId | undefined,
  trackId: StationTrackId | undefined,
  direction: Direction,
): number {
  if (trackId !== undefined) {
    const lane = layout.laneOfTrack.get(trackId);
    if (lane !== undefined) return lane;
  }
  if (stationId !== undefined) {
    const yard = layout.depotLaneOfStation.get(stationId);
    if (yard !== undefined) return yard.leadLane;
    const station = layout.stationOf.get(stationId);
    if (station) {
      for (const l of station.trackLanes) {
        if (l.directions.includes(direction)) return l.index;
      }
      if (station.trackLanes.length > 0) return station.trackLanes[0]!.index;
    }
  }
  return runningLane(layout, direction);
}

/** Drawn x of a train standing at a station, which is not always its km. */
function standingX(
  layout: LineLayout,
  stationId: StationId | undefined,
  fallbackKm: Meters,
): Meters {
  if (stationId === undefined) return fallbackKm;
  const yard = layout.depotLaneOfStation.get(stationId);
  if (yard !== undefined) return yard.berthX;
  return layout.stationOf.get(stationId)?.x ?? fallbackKm;
}

/** Fill `out` with the geometry of one end of a leg. */
function resolveEnd(
  layout: LineLayout,
  stationId: StationId | undefined,
  trackId: StationTrackId | undefined,
  direction: Direction,
  fallbackKm: Meters,
  out: EndKnots,
): EndKnots {
  const running = runningLane(layout, direction);
  const yard = stationId === undefined ? undefined : layout.depotLaneOfStation.get(stationId);
  if (yard !== undefined) {
    const lane = standingLane(layout, stationId, trackId, direction);
    out.x = yard.berthX;
    out.km = yard.km;
    out.off[0] = 0;
    out.lane[0] = lane;
    out.off[1] = Math.abs(yard.berthX - yard.throatX);
    out.lane[1] = lane;
    out.off[2] = Math.abs(yard.berthX - yard.rootX);
    out.lane[2] = yard.rootLane;
    out.off[3] = Math.abs(yard.berthX - yard.junctionX);
    out.lane[3] = running;
    out.n = 4;
    out.reach = out.off[3]!;
    return out;
  }

  const station = stationId === undefined ? undefined : layout.stationOf.get(stationId);
  const lane = standingLane(layout, stationId, trackId, direction);
  out.x = station?.x ?? fallbackKm;
  out.km = station?.km ?? fallbackKm;
  out.off[0] = 0;
  out.lane[0] = lane;
  out.off[1] = layout.stationHalfWidth - layout.stationLeadWidth;
  out.lane[1] = lane;
  out.off[2] = layout.stationHalfWidth;
  out.lane[2] = running;
  out.n = 3;
  out.reach = out.off[2]!;
  return out;
}

/** The polyline of `k`, `o` metres from its anchor. */
function laneAtOffset(k: EndKnots, o: number): number {
  if (o <= 0) return k.lane[0]!;
  for (let i = 1; i < k.n; i++) {
    const a = k.off[i - 1]!;
    const b = k.off[i]!;
    if (o > b) continue;
    if (b <= a) return k.lane[i]!;
    return k.lane[i - 1]! + (k.lane[i]! - k.lane[i - 1]!) * ((o - a) / (b - a));
  }
  return k.lane[k.n - 1]!;
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

  if (fromStationId !== undefined && toStationId !== undefined) {
    return placeOnLeg(layout, args, out);
  }

  out.x = standingX(layout, stationId, km);
  out.lane = standingLane(layout, stationId, trackId, direction);

  // Mid-shunt: crossing from one road to another without leaving the station.
  const blend = args.trackBlend;
  if (blend !== undefined && args.fromTrackId !== undefined) {
    const from = layout.laneOfTrack.get(args.fromTrackId);
    if (from !== undefined) {
      const f = blend < 0 ? 0 : blend > 1 ? 1 : blend;
      out.lane = from + (out.lane - from) * f;
    }
  }
  return out;
}

/** Place a train running between two stops, along the drawn wiring. */
function placeOnLeg(
  layout: LineLayout,
  args: PlaceTrainArgs,
  out: TrainPlacement,
): TrainPlacement {
  const { km, direction } = args;
  resolveEnd(layout, args.fromStationId, args.fromTrackId, direction, km, endA);
  resolveEnd(layout, args.toStationId, args.toTrackId, direction, km, endB);

  const dkm = endB.km - endA.km;
  const progress = dkm === 0 ? 0 : (km - endA.km) / dkm;
  const clamped = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  const dx = endB.x - endA.x;
  const x = endA.x + dx * clamped;
  out.x = x;

  const span = Math.abs(dx);
  const need = endA.reach + endB.reach;
  if (span === 0 || need <= 0) {
    out.lane = endA.lane[0]!;
    return out;
  }
  // A leg shorter than the two ends' wiring squeezes both of them in
  // proportion, so the polyline stays continuous and monotone.
  const squeeze = need > span ? span / need : 1;
  const u = Math.abs(x - endA.x);
  if (u <= endA.reach * squeeze) out.lane = laneAtOffset(endA, u / squeeze);
  else if (span - u <= endB.reach * squeeze) out.lane = laneAtOffset(endB, (span - u) / squeeze);
  else out.lane = runningLane(layout, direction);
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
 * Which labels can be drawn, and on which row.
 *
 * The line has 23 stations in 16.9 km and the first eight are inside the first
 * two kilometres, so at the fitted zoom their names simply cannot all be
 * drawn. Shrinking the font until they fit trades one unreadable picture for
 * another, so instead:
 *
 *   1. labels are placed most-important-first (so a 急行 stop can never be
 *      crowded out by the 各停 stop next to it),
 *   2. each label takes the topmost row it fits on — two rows roughly doubles
 *      the density the view survives,
 *   3. a label with no free row is dropped, and reappears on its own as the
 *      user zooms in and its neighbours move apart.
 *
 * The result is overlap-free **by construction**: a row only ever accepts an
 * interval that misses everything already on it.
 *
 * Train labels use the same solver with a **preferred row** — the row beside
 * the train — and a drift limit, so a label lands as close to its dot as it
 * can get without landing on another label. That is the whole reason the dots
 * themselves never have to move.
 *
 * Reusable and allocation-free after the first `push` of a given size, because
 * this runs on every static redraw — which means every frame of a pan.
 */
export class StationLabelPlacer {
  private xs = new Float64Array(0);
  private widths = new Float64Array(0);
  private priorities = new Float64Array(0);
  /** Preferred row, or < 0 for "topmost that fits". */
  private prefer = new Float64Array(0);
  private rows = new Int32Array(0);
  private order = new Int32Array(0);
  /** Per row: parallel interval lists, `rowCap` entries each. */
  private rowLeft = new Float64Array(0);
  private rowRight = new Float64Array(0);
  private rowCount = new Int32Array(0);
  private n = 0;
  private rowLimit = 2;
  private gap = LABEL_GAP;
  private maxDrift = Infinity;

  get count(): number {
    return this.n;
  }

  get rowsUsed(): number {
    return this.rowLimit;
  }

  /**
   * Begin a new placement pass. `rows` is clamped to at least one.
   *
   * `maxDrift` bounds how far a candidate with a preferred row may be pushed
   * from it, in rows — a train label six rows from its train is worse than no
   * label at all, because it looks like it belongs to a different train.
   */
  reset(rows = 2, gap = LABEL_GAP, maxDrift = Infinity): void {
    this.n = 0;
    this.rowLimit = Math.max(1, Math.floor(rows));
    this.gap = gap;
    this.maxDrift = maxDrift;
    this.ensureRows();
    this.rowCount.fill(0);
  }

  /**
   * Register a candidate; returns its slot index.
   *
   * `preferredRow` asks for a row and takes the nearest free one; omitting it
   * asks for the topmost free row, which is what a station name wants.
   */
  push(x: number, width: number, priority: number, preferredRow = -1): number {
    if (this.n === this.xs.length) this.grow();
    const i = this.n++;
    this.xs[i] = x;
    this.widths[i] = width;
    this.priorities[i] = priority;
    this.prefer[i] = preferredRow;
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
      const want = this.prefer[i]!;
      const steps =
        want < 0 ? this.rowLimit : Math.min(this.rowLimit, 2 * this.maxDrift + 1);
      for (let step = 0; step < steps; step++) {
        const r = want < 0 ? step : this.nearestRow(want, step);
        if (r < 0 || r >= this.rowLimit) continue;
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

  /**
   * The `step`-th row out from `want`: itself, then below, then above.
   *
   * Below first, because a label under its train reads as belonging to it
   * while one above it is easily mistaken for the lane overhead.
   */
  private nearestRow(want: number, step: number): number {
    const offset = step % 2 === 1 ? (step + 1) / 2 : -(step / 2);
    if (Math.abs(offset) > this.maxDrift) return -1;
    return Math.round(want) + offset;
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
    const prefer = new Float64Array(cap);
    prefer.set(this.prefer);
    this.xs = xs;
    this.widths = widths;
    this.priorities = priorities;
    this.prefer = prefer;
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
// Depot name plate
// ---------------------------------------------------------------------------

export const DEPOT_PLATE_H = 15;
export const DEPOT_PLATE_PAD = 6;

export interface DepotPlate {
  x: number;
  y: number;
  w: number;
  h: number;
  /** +1 when the yard lies beyond the junction, -1 when before it. */
  outward: number;
}

/**
 * The plate carrying a yard's name and how much is stabled in it.
 *
 * It used to be a box big enough to list the formations, drawn *over* the
 * stub — which is precisely why the yard's roads were invisible. Now the roads
 * are the drawing and the plate is a caption: it sits above the first road,
 * hangs off the outer end of the yard so it never covers the throat, and is
 * only as wide as its text.
 *
 * Screen pixels rather than world space, because 鷺沼車庫's 500 m stub is 37 px
 * at the fitted zoom and a label drawn to scale would be an illegible sliver.
 */
export function depotPlateLayout(args: {
  /** Screen x where the throat leaves the main line. */
  junctionX: number;
  /** Screen x of the far end of the yard. */
  stubEndX: number;
  /** Screen y the plate is centred on. */
  centerY: number;
  /** Measured width of the text the plate has to hold. */
  contentWidth: number;
  viewportWidth: number;
}): DepotPlate {
  const { junctionX, stubEndX, centerY, contentWidth, viewportWidth } = args;
  const outward = stubEndX < junctionX ? -1 : 1;
  const w = Math.max(32, contentWidth + DEPOT_PLATE_PAD * 2);

  // Anchored to the outer end and grown back towards the junction, so the
  // plate is always attached to the thing it labels.
  let x = outward < 0 ? stubEndX : stubEndX - w;
  const limit = viewportWidth - w - 4;
  if (limit > 4) x = Math.max(4, Math.min(limit, x));

  return { x, y: centerY - DEPOT_PLATE_H / 2, w, h: DEPOT_PLATE_H, outward };
}
