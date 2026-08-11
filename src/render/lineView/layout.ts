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
import { defaultStubEnd, ladderOfTrack } from '@/domain/wiring';

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
 * The rest is the flat body of the road, which is the bit that reads as a
 * platform — so the leads get under half, leaving a body longer than the
 * pointwork at either end of it.
 */
export const LEAD_FRACTION = 0.42;

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

/**
 * Which end of a station a 引上線 hangs off: +1 for the higher-km end.
 *
 * A tail track is not a road through the station, it is a stub beyond the
 * platform, and which end it is beyond is a fact about the place: 溝の口's two
 * are on the 梶が谷 side, 自由が丘's on the 溝の口 side, and 大井町 famously has
 * none because there is no room past the buffers. Where the document states it
 * — `TrackWiring.ends` — that is the answer; where it does not, it is derived
 * from the one thing that usually agrees with it: a stub points at the end of
 * the line its station is nearest, which is exactly right at a terminal (where
 * tail tracks live) and merely the best available guess anywhere else. 自由が丘
 * is precisely where the guess is wrong, which is why the field exists.
 */
export function stubSide(km: Meters, lineFromKm: Meters, lineToKm: Meters): 1 | -1 {
  return defaultStubEnd(km, lineFromKm, lineToKm) === 'down' ? 1 : -1;
}

/** The drawn side of a stub: its authored end, or the km guess. */
function sideOfStub(
  track: StationTrack,
  km: Meters,
  lineFromKm: Meters,
  lineToKm: Meters,
): 1 | -1 {
  const stated = track.wiring?.ends;
  if (stated !== undefined && stated.length > 0) return stated[0] === 'down' ? 1 : -1;
  return stubSide(km, lineFromKm, lineToKm);
}

/**
 * A road that dead-ends off the end of a station rather than running through.
 *
 * A 頭端式 platform road is open at one end too — 大井町's two are — but it is
 * still the road the service runs on and is drawn as one; what makes a stub a
 * stub *here* is that trains do not pass along it. So: a stabling road always,
 * and any other road that the wiring says is open at one end and that has no
 * platform.
 */
export function isStubTrack(
  track: Pick<StationTrack, 'usage' | 'hasPlatform' | 'wiring'>,
): boolean {
  if (track.usage === 'stabling') return true;
  const ends = track.wiring?.ends;
  return ends !== undefined && ends.length < 2 && !track.hasPlatform;
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
  /**
   * +1 / -1 when this road is a stub off that end of the station, 0 when it
   * runs through. See `stubSide`.
   */
  stubSide: number;
  /** Where a train standing on this road is drawn. */
  berthX: Meters;
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
  /** Where a train standing on a given road is drawn — not always its station. */
  berthOfTrack: Map<StationTrackId, Meters>;
  /**
   * The drawn road of a 番線: its flat body, and the end it joins the running
   * line at. `placeTrain` walks this so a train follows the track it is on
   * rather than a straight line between two berths.
   */
  roadOfTrack: Map<StationTrackId, StationTrackLane>;
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
 * The block is the drawn platform: the roads inside it carry the platform
 * strip, and the leads at either end are what a train uses to get onto them.
 * It is sized off the tightest 駅間 rather than off a real 有効長, because a
 * 130 m platform on a 17 km line is half a pixel — the block has to be long
 * enough to *read* as a platform, and short enough that two adjacent ones do
 * not meet. Just over a third of the tightest section satisfies both, and
 * leaves a clear run of open line between every pair of stations.
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
  return Math.max(60, Math.min(600, Math.round(minGap * 0.35)));
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
  return Math.max(lineSpan * 0.16, halfWidth * 2, 200);
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
  const floor = Math.min(cap, Math.max(halfWidth * 1.5, lineSpan * 0.14));
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

  /**
   * 引上線 are sized separately from the roads that run through a station.
   *
   * Counting them together made the stack as deep as 溝の口 has roads — six —
   * which handed the two 引上線 the lanes at the edges of the stack. One of
   * those edges *is* the up running lane, so the tail track was drawn along
   * the main line and every up train appeared to run down a stub. A stub gets
   * an inner lane instead, and the stack only has to be deep enough to hold
   * the through roads plus a clear running lane either side of the stubs.
   */
  let maxThrough = 0;
  let maxStubs = 0;
  for (const s of ordered) {
    let through = 0;
    let stubs = 0;
    for (const t of tracksOfStation(doc, s.id)) {
      if (isStubTrack(t)) stubs += 1;
      else through += 1;
    }
    maxThrough = Math.max(maxThrough, through);
    maxStubs = Math.max(maxStubs, stubs);
  }
  const mainLaneCount = Math.max(2, maxThrough, maxStubs + 2);
  const laneDown = 0;
  const laneUp = mainLaneCount - 1;

  const lanes: Lane[] = [];
  const stations: StationLayout[] = [];
  const stationOf = new Map<StationId, StationLayout>();
  const laneOfTrack = new Map<StationTrackId, number>();
  const roadOfTrack = new Map<StationTrackId, StationTrackLane>();
  const counts = stopCounts(doc);

  // -- station blocks -------------------------------------------------------
  const firstKm = ordered[0]?.kmFromOrigin ?? 0;
  const lastKm = ordered[ordered.length - 1]?.kmFromOrigin ?? 0;
  /** How far a 引上線 reaches past the end of the platform it serves. */
  const stubLength = halfWidth * 1.1;
  const berthOfTrack = new Map<StationTrackId, Meters>();
  let stubMinX = Infinity;
  let stubMaxX = -Infinity;

  for (const station of ordered) {
    const tracks = tracksOfStation(doc, station.id);
    const through = tracks.filter((t) => !isStubTrack(t));
    const stubs = tracks.filter((t) => isStubTrack(t));
    const assignment = assignStationLanes(through, mainLaneCount);
    // Stubs take inner lanes, in authored order, centred on the stack: a 引上線
    // is the continuation of a platform road past the buffer end, so it belongs
    // beside those roads and never on top of a running lane.
    const stubLaneFrom = Math.max(1, Math.floor((mainLaneCount - stubs.length) / 2));
    stubs.forEach((t, i) => {
      // A tail track that is the continuation of a platform road past the
      // buffer end shares that road's lane, because that is what it is: 溝の口's
      // 引上1号線 carries on from 2番線 and is drawn carrying on from it. The
      // two never overlap, since the stub lives beyond the end of the station
      // block. Where the wiring names no such road — 自由が丘's tail track lies
      // outside the up platform, where there is no lane to share — the stub
      // takes an inner lane and stays clear of both running lanes.
      const ladder = ladderOfTrack(t, tracks.indexOf(t));
      const aligned = through.find((r) => ladderOfTrack(r, tracks.indexOf(r)) === ladder);
      const alignedLane = aligned === undefined ? undefined : assignment.get(aligned.id);
      assignment.set(
        t.id,
        alignedLane ?? Math.min(stubLaneFrom + i, Math.max(1, mainLaneCount - 2)),
      );
    });
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
      // A 引上線 is not a road through the station, it is a stub off the end
      // of it — so it is drawn off the end, on the side `stubSide` picks.
      //
      // It leaves the running line at the **edge of the station block**, which
      // is where every other road at this station joins it. That is what lets
      // a shunt out of a platform and into the tail track be drawn as one
      // continuous move along drawn track: out along the platform road, over
      // the throat, and back out on the stub.
      const stub = isStubTrack(t) ? sideOfStub(t, station.kmFromOrigin, firstKm, lastKm) : 0;
      const throatX = stub > 0 ? x1 : x0;
      const stubBodyX = throatX + stub * leadWidth;
      const tipX = stubBodyX + stub * stubLength;
      const lane: StationTrackLane = {
        kind: 'stationTrack',
        index,
        x0: stub === 0 ? x0 : Math.min(throatX, tipX),
        x1: stub === 0 ? x1 : Math.max(throatX, tipX),
        bodyX0: stub === 0 ? x0 + inset : Math.min(stubBodyX, tipX),
        bodyX1: stub === 0 ? x1 - inset : Math.max(stubBodyX, tipX),
        leadLanes,
        stubSide: stub,
        berthX: stub === 0 ? station.kmFromOrigin : (stubBodyX + tipX) / 2,
        label: t.name,
        stationId: station.id,
        trackId: t.id,
        hasPlatform: t.hasPlatform,
        canBeOvertaken: t.canBeOvertaken,
        usage: t.usage,
        directions: t.directions,
      };
      berthOfTrack.set(t.id, lane.berthX);
      roadOfTrack.set(t.id, lane);
      trackLanes.push(lane);
      lanes.push(lane);
      stubMinX = Math.min(stubMinX, lane.x0);
      stubMaxX = Math.max(stubMaxX, lane.x1);
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
  // A tail track reaches past its station, and at a terminal that is past the
  // end of the line.
  if (Number.isFinite(stubMinX)) minX = Math.min(minX, stubMinX);
  if (Number.isFinite(stubMaxX)) maxX = Math.max(maxX, stubMaxX);
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

    const berthX = (throatX + endX) / 2;
    const trackLanes: DepotTrackLane[] = tracks.map((t, i) => {
      const index = laneFrom + i * pitch;
      laneOfTrack.set(t.id, index);
      berthOfTrack.set(t.id, berthX);
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
      berthX,
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
    berthOfTrack,
    roadOfTrack,
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

/**
 * Drawn x of a train standing on a road, which is not always its station's.
 *
 * A 引上線 is off the end of the platform and a yard road is off the line
 * altogether; a formation berthed on either has to be drawn where that road
 * actually is, or the marker sits on a rail it is not standing on.
 */
function standingX(
  layout: LineLayout,
  stationId: StationId | undefined,
  trackId: StationTrackId | undefined,
  fallbackKm: Meters,
): Meters {
  if (trackId !== undefined) {
    const berth = layout.berthOfTrack.get(trackId);
    if (berth !== undefined) return berth;
  }
  if (stationId === undefined) return fallbackKm;
  const yard = layout.depotLaneOfStation.get(stationId);
  if (yard !== undefined) return yard.berthX;
  return layout.stationOf.get(stationId)?.x ?? fallbackKm;
}

/**
 * Where one end of a leg sits: the anchor only, with no wiring yet.
 *
 * Split from the wiring because the wiring depends on which way the leg goes,
 * and that is only known once both anchors are placed.
 */
function resolveAnchor(
  layout: LineLayout,
  stationId: StationId | undefined,
  trackId: StationTrackId | undefined,
  direction: Direction,
  fallbackKm: Meters,
  out: EndKnots,
): EndKnots {
  const yard = stationId === undefined ? undefined : layout.depotLaneOfStation.get(stationId);
  out.lane[0] = standingLane(layout, stationId, trackId, direction);
  out.off[0] = 0;
  out.n = 1;
  out.reach = 0;
  if (yard !== undefined) {
    out.x = yard.berthX;
    out.km = yard.km;
    return out;
  }
  out.x = standingX(layout, stationId, trackId, fallbackKm);
  out.km = layout.stationOf.get(stationId ?? ('' as StationId))?.km ?? fallbackKm;
  return out;
}

/**
 * Fill in how the road at this end reaches the running line, in the direction
 * of travel — `toward` is +1 when the other end of the leg is at a higher x.
 *
 * The offsets come from the road as **drawn**: the flat body first, then the
 * lead onto the running lane. Reading them off the station block instead
 * worked only for roads centred on their station, and a 引上線 is not — it
 * hangs off the end of the block, so its marker used to start swinging while
 * still on the straight and finish after the turnout was behind it.
 */
function resolveKnots(
  layout: LineLayout,
  stationId: StationId | undefined,
  trackId: StationTrackId | undefined,
  direction: Direction,
  toward: number,
  out: EndKnots,
): EndKnots {
  const running = runningLane(layout, direction);
  const lane = out.lane[0]!;
  const yard = stationId === undefined ? undefined : layout.depotLaneOfStation.get(stationId);
  if (yard !== undefined) {
    out.off[1] = Math.abs(out.x - yard.throatX);
    out.lane[1] = lane;
    out.off[2] = Math.abs(out.x - yard.rootX);
    out.lane[2] = yard.rootLane;
    out.off[3] = Math.abs(out.x - yard.junctionX);
    out.lane[3] = running;
    out.n = 4;
    out.reach = out.off[3]!;
    return out;
  }

  const road = trackId === undefined ? undefined : layout.roadOfTrack.get(trackId);
  let bodyEnd: number;
  let joinX: number;
  if (road === undefined) {
    bodyEnd = out.x + toward * (layout.stationHalfWidth - layout.stationLeadWidth);
    joinX = out.x + toward * layout.stationHalfWidth;
  } else if (road.stubSide !== 0) {
    // A stub is connected at one end only — the station end — whichever way
    // the train is going.
    bodyEnd = road.stubSide > 0 ? road.bodyX0 : road.bodyX1;
    joinX = road.stubSide > 0 ? road.x0 : road.x1;
  } else {
    bodyEnd = toward >= 0 ? road.bodyX1 : road.bodyX0;
    joinX = toward >= 0 ? road.x1 : road.x0;
  }

  out.off[1] = Math.abs(bodyEnd - out.x);
  out.lane[1] = lane;
  out.off[2] = Math.max(out.off[1]!, Math.abs(joinX - out.x));
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

  out.x = standingX(layout, stationId, trackId, km);
  out.lane = standingLane(layout, stationId, trackId, direction);

  // Mid-shunt: crossing from one road to another without leaving the station.
  // Both axes move, because a shunt into a 引上線 travels along the line as
  // well as across it — and it travels along *drawn track*: out along the road
  // it is leaving, over the throat at the end of the block, and back out onto
  // the road it is taking. That is the same wiring a running leg follows, so
  // it is solved with the same knots.
  const blend = args.trackBlend;
  if (blend !== undefined && args.fromTrackId !== undefined) {
    const fromLane = layout.laneOfTrack.get(args.fromTrackId);
    if (fromLane !== undefined) {
      const f = blend < 0 ? 0 : blend > 1 ? 1 : blend;
      const fromX = standingX(layout, stationId, args.fromTrackId, km);
      const toX = out.x;
      const toLane = out.lane;
      out.x = fromX + (toX - fromX) * f;
      if (toX === fromX) {
        // Two roads berthed at the same x — nothing to travel along, so the
        // only honest reading is a straight crossing.
        out.lane = fromLane + (toLane - fromLane) * f;
        return out;
      }
      const toward = toX > fromX ? 1 : -1;
      resolveAnchor(layout, stationId, args.fromTrackId, direction, km, endA);
      resolveKnots(layout, stationId, args.fromTrackId, direction, toward, endA);
      resolveAnchor(layout, stationId, trackId, direction, km, endB);
      resolveKnots(layout, stationId, trackId, direction, -toward, endB);
      out.lane = laneAlong(layout, endA, endB, out.x, direction);
    }
  }
  return out;
}

/**
 * The lane at world `x` on the polyline joining two ends.
 *
 * Both ends' wiring is squeezed in proportion when the gap between them is
 * shorter than the two leads need, so the path stays continuous and monotone
 * however tight the move is.
 */
function laneAlong(
  layout: LineLayout,
  a: EndKnots,
  b: EndKnots,
  x: number,
  direction: Direction,
): number {
  const span = Math.abs(b.x - a.x);
  const need = a.reach + b.reach;
  if (span === 0 || need <= 0) return a.lane[0]!;
  const squeeze = need > span ? span / need : 1;
  const u = Math.abs(x - a.x);
  if (u <= a.reach * squeeze) return laneAtOffset(a, u / squeeze);
  if (span - u <= b.reach * squeeze) return laneAtOffset(b, (span - u) / squeeze);
  return runningLane(layout, direction);
}

/** Place a train running between two stops, along the drawn wiring. */
function placeOnLeg(
  layout: LineLayout,
  args: PlaceTrainArgs,
  out: TrainPlacement,
): TrainPlacement {
  const { km, direction } = args;
  resolveAnchor(layout, args.fromStationId, args.fromTrackId, direction, km, endA);
  resolveAnchor(layout, args.toStationId, args.toTrackId, direction, km, endB);
  const toward = endB.x >= endA.x ? 1 : -1;
  resolveKnots(layout, args.fromStationId, args.fromTrackId, direction, toward, endA);
  resolveKnots(layout, args.toStationId, args.toTrackId, direction, -toward, endB);

  const dkm = endB.km - endA.km;
  const progress = dkm === 0 ? 0 : (km - endA.km) / dkm;
  const clamped = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  const dx = endB.x - endA.x;
  const x = endA.x + dx * clamped;
  out.x = x;
  out.lane = laneAlong(layout, endA, endB, x, direction);
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

export const DEPOT_PLATE_H = 14;
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
