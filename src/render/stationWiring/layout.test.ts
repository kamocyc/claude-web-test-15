/**
 * 構内配線図 — the picture, checked against the facts it claims to draw.
 *
 * The value of the drawing is that it cannot disagree with the check, so the
 * assertions here are all of that shape: the tail track is where the model says
 * it is, the 渡り線 is beyond every turnout the way the model says it is, and a
 * road with no running line in a throat has no turnout drawn onto one.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { buildOimachiProject } from '@/seed';
import type { ProjectDocument } from '@/domain/model';
import { tracksOfStation } from '@/domain/project';
import { entityList } from '@/domain/units';
import { computeWiringDiagram } from './layout';

let doc: ProjectDocument;

function stationNamed(name: string) {
  const station = entityList(doc.stations).find((s) => s.name === name);
  if (station === undefined) throw new Error(`no station ${name}`);
  return station;
}

function trackIdOf(stationName: string, trackName: string): string {
  const track = tracksOfStation(doc, stationNamed(stationName).id).find(
    (t) => t.name === trackName,
  );
  if (track === undefined) throw new Error(`no track ${stationName} ${trackName}`);
  return track.id;
}

beforeAll(() => {
  doc = buildOimachiProject();
});

describe('構内配線図', () => {
  it('draws 自由が丘の引上線 out in the 溝の口 throat, not across the platforms', () => {
    const diagram = computeWiringDiagram(doc, stationNamed('自由が丘').id);
    const tail = diagram.roads.find((r) => r.name === '引上線')!;
    const platform = diagram.roads.find((r) => r.name === '1番線')!;
    expect(tail.x0).toBeGreaterThanOrEqual(diagram.bodyR);
    expect(platform.x0).toBeLessThanOrEqual(diagram.bodyL);
    // …and beyond the up platform across the throat, which is the whole point.
    expect(tail.ladder).toBeGreaterThan(diagram.roads.find((r) => r.name === '2番線')!.ladder);
  });

  it('puts the 片渡り線 beyond every turnout in its throat', () => {
    const diagram = computeWiringDiagram(doc, stationNamed('自由が丘').id);
    const crossover = diagram.crossovers.find((c) => c.end === 'down');
    expect(crossover).toBeDefined();
    const turnouts = diagram.turnouts.filter((t) => t.end === 'down');
    expect(turnouts.length).toBeGreaterThan(0);
    const outer = Math.min(crossover!.x0, crossover!.x1);
    for (const t of turnouts) expect(t.x).toBeLessThan(outer);
  });

  it('gives 溝の口 2番線 no running-line turnout on the 梶が谷 side', () => {
    const diagram = computeWiringDiagram(doc, stationNamed('溝の口').id);
    const face = trackIdOf('溝の口', '2番線');
    const down = diagram.turnouts.filter((t) => t.trackId === face && t.end === 'down');
    expect(down.map((t) => t.lead)).toEqual(['大井町線']);
    // The tail track is on that lead too — which is how the face is reached —
    // and on both running lines, which is how the tail track is.
    const tail = trackIdOf('溝の口', '引上1号線');
    const tailLeads = diagram.turnouts
      .filter((t) => t.trackId === tail && t.end === 'down')
      .map((t) => t.lead)
      .sort();
    expect(tailLeads).toEqual(['down', 'up', '大井町線']);
  });

  it('draws a 本線 per pair at a 方向別複々線, not one per direction', () => {
    const diagram = computeWiringDiagram(doc, stationNamed('溝の口').id);
    const downLines = diagram.leads.filter((l) => l.end === 'up' && l.lead === 'down');
    // One per position `lineLadder` resolves to — the 田園都市線 pair's own
    // 下り本線 and the 大井町線 pair's, at least.
    expect(new Set(downLines.map((l) => l.y)).size).toBeGreaterThan(1);
    const dt = diagram.roads.find((r) => r.name === '1番線')!;
    const om = diagram.roads.find((r) => r.name === '2番線')!;
    expect(downLines.map((l) => l.y)).toContain(dt.y);
    expect(downLines.map((l) => l.y)).toContain(om.y);
  });

  it('closes a lead that is not a running line, and runs a 本線 off the sheet', () => {
    const diagram = computeWiringDiagram(doc, stationNamed('溝の口').id);
    const om = diagram.leads.find((l) => l.lead === '大井町線')!;
    expect(om.closed).toBe(true);
    expect(om.closeX).toBeLessThan(diagram.width);
    const line = diagram.leads.find((l) => l.end === 'down' && l.lead === 'down')!;
    expect(line.closed).toBe(false);
  });

  it('stacks the labels of two roads that share a 分岐位置', () => {
    const diagram = computeWiringDiagram(doc, stationNamed('溝の口').id);
    const face = diagram.roads.find((r) => r.name === '2番線')!;
    const tail = diagram.roads.find((r) => r.name === '引上1号線')!;
    expect(face.ladder).toBe(tail.ladder);
    expect(face.labelY).not.toBe(tail.labelY);
  });
});
