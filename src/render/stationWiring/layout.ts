/**
 * 構内配線図 geometry — one station's throats, drawn.
 *
 * The picture is a 配線略図: roads as horizontal lines at their 分岐位置, the
 * leads they fan onto running out of each throat, and a turnout dot wherever a
 * road meets a lead. Everything in it comes from `computeStationWiring`, so the
 * drawing and the 平面交差支障 check cannot disagree — which is the whole reason
 * to draw it at all.
 *
 * **The order of the turnouts along a throat is a drawing convention.** The
 * model does not carry it (see `src/domain/wiring.ts`), and nothing depends on
 * it: the fan is laid out innermost-first by how far the road sits from its
 * lead, because that is what a ladder usually looks like. What *is* modelled,
 * and what the picture is therefore honest about, is which road meets which
 * lead, and that a 渡り線 lies beyond every road turnout in its throat.
 */

import type { StationId, StationTrackId } from '@/domain/ids';
import type { ProjectDocument, StationEnd, ThroatLead, TrackUsage } from '@/domain/model';
import { computeStationWiring, isLineLead, lineLadder, spanContains } from '@/domain/wiring';
import type { RoadWiring, StationWiring } from '@/domain/wiring';

export interface DiagramOptions {
  width: number;
  laneH: number;
  topPad: number;
  /** Space reserved on the left for 番線 names. */
  labelW: number;
  pad: number;
}

export const DIAGRAM_DEFAULTS: DiagramOptions = {
  width: 720,
  laneH: 34,
  topPad: 26,
  labelW: 84,
  pad: 12,
};

/** How long the slope from a road across to its lead is. */
const TAPER = 22;
const CROSS_W = 26;

export interface DiagramRoad {
  trackId: StationTrackId;
  name: string;
  ladder: number;
  y: number;
  usage: TrackUsage;
  hasPlatform: boolean;
  ends: StationEnd[];
  /** The road itself, as one horizontal run. */
  x0: number;
  x1: number;
  /** Ends that stop dead — drawn as buffer stops. */
  buffers: number[];
  labelX: number;
  /** Nudged apart when two roads share a 分岐位置, as 溝の口's tail tracks do. */
  labelY: number;
}

export interface DiagramLead {
  key: string;
  end: StationEnd;
  lead: ThroatLead;
  label: string;
  isLine: boolean;
  y: number;
  x0: number;
  x1: number;
  /** A named lead stops in the throat; a running line carries on off-scene. */
  closed: boolean;
  /** Where the buffer-ish end mark goes, when closed. */
  closeX?: number;
}

export interface DiagramTurnout {
  key: string;
  trackId: StationTrackId;
  end: StationEnd;
  lead: ThroatLead;
  /** The point on the lead — where the 分岐器 is. */
  x: number;
  y: number;
  /** Road → lead, as a polyline. */
  points: Array<{ x: number; y: number }>;
}

export interface DiagramCrossover {
  key: string;
  end: StationEnd;
  index: number;
  name: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The band one route sweeps across a throat, for the selected road. */
export interface DiagramRoute {
  key: string;
  end: StationEnd;
  label: string;
  /** Ladder positions, not pixels — the caller shades between them. */
  fromY: number;
  toY: number;
  x0: number;
  x1: number;
  fouls: StationTrackId[];
}

export interface WiringDiagram {
  stationId: StationId;
  width: number;
  height: number;
  bodyL: number;
  bodyR: number;
  roads: DiagramRoad[];
  leads: DiagramLead[];
  turnouts: DiagramTurnout[];
  crossovers: DiagramCrossover[];
  wiring: StationWiring;
}

const END_LABEL: Record<StationEnd, string> = { down: '下り方', up: '上り方' };

function leadLabel(lead: ThroatLead): string {
  if (lead === 'down') return '下り本線';
  if (lead === 'up') return '上り本線';
  return lead;
}

/** A road drawn across the platform area rather than only out in a throat. */
function inBody(road: RoadWiring, hasPlatform: boolean): boolean {
  return hasPlatform || road.ends.length >= 2;
}

export function computeWiringDiagram(
  doc: ProjectDocument,
  stationId: StationId,
  options: Partial<DiagramOptions> = {},
): WiringDiagram {
  const opts = { ...DIAGRAM_DEFAULTS, ...options };
  const wiring = computeStationWiring(doc, stationId);
  const ladders = wiring.roads.map((r) => r.ladder);
  const lineLadders = [wiring.linePosition.down, wiring.linePosition.up];
  const min = Math.min(...ladders, ...lineLadders, 0);
  const max = Math.max(...ladders, ...lineLadders, 0);
  const y = (ladder: number): number => opts.topPad + (ladder - min) * opts.laneH;
  const height = opts.topPad * 2 + (max - min) * opts.laneH;

  const leftEdge = opts.labelW;
  const rightEdge = opts.width - opts.pad;
  const inner = rightEdge - leftEdge;
  const throatW = inner * 0.3;
  const bodyL = leftEdge + throatW;
  const bodyR = rightEdge - throatW;

  const hasPlatform = new Map(
    wiring.roads.map((r) => [r.trackId, doc.stationTracks.byId[r.trackId]?.hasPlatform ?? false]),
  );

  const leads: DiagramLead[] = [];
  const turnouts: DiagramTurnout[] = [];
  const crossovers: DiagramCrossover[] = [];

  for (const end of ['up', 'down'] as const) {
    const dir = end === 'down' ? 1 : -1;
    const edgeX = end === 'down' ? bodyR : bodyL;
    const outerX = end === 'down' ? rightEdge : leftEdge;

    // Which leads exist in this throat, and where each sits across it.
    const byLead = new Map<ThroatLead, RoadWiring[]>();
    for (const road of wiring.roads) {
      for (const lead of road.connects[end]) {
        const list = byLead.get(lead);
        if (list === undefined) byLead.set(lead, [road]);
        else list.push(road);
      }
    }
    for (const link of wiring.crossovers.filter((c) => c.end === end)) {
      for (const lead of [link.from, link.to]) {
        if (!byLead.has(lead)) byLead.set(lead, []);
      }
    }
    /**
     * Where a road meets a lead, across the throat.
     *
     * For a running line this is `lineLadder` — the same resolution the
     * 交差支障 check makes, nearest 本線 road first — rather than one position
     * per direction, because a 方向別複々線 has two 下り本線 and a train on
     * either of them diverges nowhere. Going through the same function is what
     * guarantees the picture and the check cannot disagree; where the check is
     * optimistic, so is the drawing, visibly.
     */
    const leadYFor = (lead: ThroatLead, nearLadder: number): number => {
      if (isLineLead(lead)) return lineLadder(wiring, lead, nearLadder);
      const on = byLead.get(lead) ?? [];
      return on.length === 0 ? 0 : on.reduce((a, r) => a + r.ladder, 0) / on.length;
    };

    // The fan, innermost first. A drawing convention — see the module note.
    const pairs: Array<{ road: RoadWiring; lead: ThroatLead }> = [];
    for (const road of wiring.roads) {
      for (const lead of road.connects[end]) pairs.push({ road, lead });
    }
    pairs.sort((a, b) => {
      const da = Math.abs(a.road.ladder - leadYFor(a.lead, a.road.ladder));
      const db = Math.abs(b.road.ladder - leadYFor(b.lead, b.road.ladder));
      return (
        da - db ||
        a.road.ladder - b.road.ladder ||
        a.road.name.localeCompare(b.road.name) ||
        a.lead.localeCompare(b.lead)
      );
    });

    const links = wiring.crossovers.filter((c) => c.end === end);
    const slots = pairs.length + links.length + 1;
    const step = Math.abs(outerX - edgeX) / slots;
    const slotX = (k: number): number => edgeX + dir * step * (k + 1);

    /** Keyed by `lead|ladder`: one drawn lead per position it is met at. */
    const outermost = new Map<string, { lead: ThroatLead; at: number; x: number }>();
    const reach = (lead: ThroatLead, at: number, x: number): void => {
      const key = `${lead}|${at}`;
      const cur = outermost.get(key);
      if (cur === undefined || Math.abs(x - edgeX) > Math.abs(cur.x - edgeX)) {
        outermost.set(key, { lead, at, x });
      }
    };
    pairs.forEach(({ road, lead }, k) => {
      const px = slotX(k);
      const at = leadYFor(lead, road.ladder);
      const py = y(at);
      const ry = y(road.ladder);
      const stub = !inBody(road, hasPlatform.get(road.trackId) ?? false);
      const points = stub
        ? [
            { x: px + dir * (TAPER + step * 0.4), y: ry },
            { x: px + dir * TAPER, y: ry },
            { x: px, y: py },
          ]
        : [
            { x: edgeX, y: ry },
            { x: px - dir * TAPER, y: ry },
            { x: px, y: py },
          ];
      turnouts.push({
        key: `${road.trackId}|${end}|${lead}`,
        trackId: road.trackId,
        end,
        lead,
        x: px,
        y: py,
        points,
      });
      reach(lead, at, px);
    });

    links.forEach((link, i) => {
      const px = slotX(pairs.length + i);
      // A crossover is out beyond every road turnout, and it joins the leads
      // where they lie *there* — which for a running line is its own position,
      // not the one nearest some road.
      const fromAt = leadYFor(link.from, wiring.linePosition[isLineLead(link.from) ? link.from : 'down']);
      const toAt = leadYFor(link.to, wiring.linePosition[isLineLead(link.to) ? link.to : 'down']);
      crossovers.push({
        key: `${stationId}|${end}|${i}`,
        end,
        index: i,
        name: link.name ?? `${leadLabel(link.from)}⇄${leadLabel(link.to)}`,
        x0: px - dir * CROSS_W * 0.5,
        y0: y(fromAt),
        x1: px + dir * CROSS_W * 0.5,
        y1: y(toAt),
      });
      reach(link.from, fromAt, px - dir * CROSS_W * 0.5);
      reach(link.to, toAt, px + dir * CROSS_W * 0.5);
    });

    for (const [key, { lead, at, x }] of outermost) {
      const closed = !isLineLead(lead);
      const end1 = closed ? x + dir * step * 0.5 : outerX;
      leads.push({
        key: `${end}|${key}`,
        end,
        lead,
        label: leadLabel(lead),
        isLine: isLineLead(lead),
        y: y(at),
        x0: Math.min(edgeX, end1),
        x1: Math.max(edgeX, end1),
        closed,
        ...(closed ? { closeX: end1 } : {}),
      });
    }
  }

  const shareLadder = new Map<number, number>();
  for (const road of wiring.roads) {
    shareLadder.set(road.ladder, (shareLadder.get(road.ladder) ?? 0) + 1);
  }
  const seenLadder = new Map<number, number>();

  const roads: DiagramRoad[] = wiring.roads.map((road) => {
    const platform = hasPlatform.get(road.trackId) ?? false;
    const body = inBody(road, platform);
    const buffers: number[] = [];
    let x0: number;
    let x1: number;
    if (body) {
      x0 = road.ends.includes('up') ? bodyL : bodyL + 18;
      x1 = road.ends.includes('down') ? bodyR : bodyR - 18;
      if (!road.ends.includes('up')) buffers.push(x0);
      if (!road.ends.includes('down')) buffers.push(x1);
    } else if (road.ends.includes('down')) {
      const own = turnouts.filter((t) => t.trackId === road.trackId && t.end === 'down');
      const from = Math.min(...own.map((t) => t.x + TAPER), bodyR + 24);
      x0 = from;
      x1 = rightEdge;
      buffers.push(x1);
    } else {
      const own = turnouts.filter((t) => t.trackId === road.trackId && t.end === 'up');
      const to = Math.max(...own.map((t) => t.x - TAPER), bodyL - 24);
      x0 = leftEdge;
      x1 = to;
      buffers.push(x0);
    }
    const share = shareLadder.get(road.ladder) ?? 1;
    const seen = seenLadder.get(road.ladder) ?? 0;
    seenLadder.set(road.ladder, seen + 1);
    return {
      trackId: road.trackId,
      name: road.name,
      ladder: road.ladder,
      y: y(road.ladder),
      labelY: y(road.ladder) + 4 + (seen - (share - 1) / 2) * 12,
      usage: road.usage,
      hasPlatform: platform,
      ends: road.ends,
      x0,
      x1,
      buffers,
      labelX: opts.labelW - 8,
    };
  });

  return {
    stationId,
    width: opts.width,
    height,
    bodyL,
    bodyR,
    roads,
    leads,
    turnouts,
    crossovers,
    wiring,
  };
}

/**
 * Every route into and out of one road, and the roads each of them fouls.
 *
 * The same span the 平面交差支障 check works on, drawn: selecting a road shades
 * the band each of its routes sweeps, and the roads lying inside the band are
 * exactly the ones a simultaneous move on them would conflict with.
 */
export function routesOfRoad(
  diagram: WiringDiagram,
  trackId: StationTrackId,
  moves: ReadonlyArray<{
    end: StationEnd;
    label: string;
    from: number;
    to: number;
  }>,
): DiagramRoute[] {
  return moves.map((move, i) => {
    const lo = Math.min(move.from, move.to);
    const hi = Math.max(move.from, move.to);
    const dir = move.end === 'down' ? 1 : -1;
    const edgeX = move.end === 'down' ? diagram.bodyR : diagram.bodyL;
    const outerX = move.end === 'down' ? diagram.width : 0;
    return {
      key: `${trackId}|${move.end}|${i}`,
      end: move.end,
      label: `${END_LABEL[move.end]} ${move.label}`,
      fromY: lo,
      toY: hi,
      x0: Math.min(edgeX, edgeX + dir * Math.abs(outerX - edgeX)),
      x1: Math.max(edgeX, edgeX + dir * Math.abs(outerX - edgeX)),
      fouls: diagram.wiring.roads
        .filter((r) => r.trackId !== trackId && spanContains(lo, hi, r.ladder))
        .map((r) => r.trackId),
    };
  });
}
