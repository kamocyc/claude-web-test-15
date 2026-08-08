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
 */

import type { DepotId, StationId, StationTrackId } from '@/domain/ids';
import type { Direction, ProjectDocument, Station, StationTrack } from '@/domain/model';
import { allStationsInKmOrder, orderedStations, tracksOfStation } from '@/domain/project';
import type { Meters } from '@/domain/units';
import { entityList } from '@/domain/units';

/** CSS pixels per lane. Fixed — see the file header. */
export const LANE_HEIGHT = 26;

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
 * - bidirectional tracks take the free lanes nearest the middle.
 *
 * Collision-free because `downOnly + upOnly <= trackCount <= laneCount`.
 * Returns lane index per track id.
 */
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

  downOnly.forEach((t, i) => {
    const lane = Math.min(i, lanes - 1);
    out.set(t.id, lane);
    taken[lane] = true;
  });

  // Reverse so the *last* authored up track ends up at the very bottom and
  // authored order still reads downwards.
  upOnly
    .slice()
    .reverse()
    .forEach((t, i) => {
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

  // -- depot stubs ----------------------------------------------------------
  const depots: DepotLane[] = [];
  const depotLaneOfStation = new Map<StationId, DepotLane>();
  const depotEntities = entityList(doc.depots);
  depotEntities.forEach((depot, i) => {
    const depotStation = doc.stations.byId[depot.stationId];
    const attached = stationOf.get(depot.attachedStationId);
    const junctionX = attached?.x ?? 0;
    const depotX =
      depotStation?.kmFromOrigin ?? junctionX + (depot.stubOffsetMeters || -500);
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
      junctionLane: depotX < junctionX ? laneDown : laneUp,
    };
    for (const tid of trackIds) laneOfTrack.set(tid, index);
    depots.push(lane);
    lanes.push(lane);
    depotLaneOfStation.set(depot.stationId, lane);
  });

  // -- bounds ---------------------------------------------------------------
  let minX = Infinity;
  let maxX = -Infinity;
  for (const s of allStationsInKmOrder(doc)) {
    minX = Math.min(minX, s.kmFromOrigin - halfWidth);
    maxX = Math.max(maxX, s.kmFromOrigin + halfWidth);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    maxX = 1000;
  }

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
    bounds: { minX, maxX, minY: 0, maxY: totalLaneCount },
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
export function placeTrain(
  layout: LineLayout,
  args: {
    km: Meters;
    direction: Direction;
    trackId?: StationTrackId;
    stationId?: StationId;
    fromStationId?: StationId;
    toStationId?: StationId;
  },
): TrainPlacement {
  const { km, direction, trackId, stationId, fromStationId, toStationId } = args;

  if (trackId !== undefined) {
    const lane = layout.laneOfTrack.get(trackId);
    if (lane !== undefined) return { x: km, lane };
  }

  for (const id of [stationId, fromStationId, toStationId]) {
    if (id === undefined) continue;
    const depotLane = layout.depotLaneOfStation.get(id);
    if (depotLane) return { x: km, lane: depotLane.index };
  }

  if (stationId !== undefined) {
    const station = layout.stationOf.get(stationId);
    if (station && station.trackLanes.length > 0) {
      const preferred = station.trackLanes.find((l) => l.directions.includes(direction));
      if (preferred) return { x: km, lane: preferred.index };
    }
  }

  return { x: km, lane: runningLane(layout, direction) };
}

/** Screen y of the centre of a lane, given the camera's y scale and origin. */
export function laneCenterY(lane: number, camY: number, scaleY: number): number {
  return (lane + 0.5 - camY) * scaleY;
}
