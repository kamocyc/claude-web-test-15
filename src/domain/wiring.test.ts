/**
 * 構内配線 — the derivation, and the geometry the 交差支障 check rests on.
 *
 * Built on the real seeded document rather than on hand-made stations, because
 * the whole point of the model is the awkward places: a 頭端式 terminal with no
 * through road, a 方向別複々線 with two 下り本線, and a 引上線 on the side the km
 * heuristic would not have guessed.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { ProjectDocument, StationTrack } from './model';
import { buildOimachiProject } from '@/seed';
import { tracksOfStation } from './project';
import { entityList } from './units';
import {
  canEnterFrom,
  computeStationWiring,
  defaultStubEnd,
  leadsReachable,
  endsOfTrack,
  ladderOfTrack,
  lineLadder,
  movesCross,
  shuntMove,
  spansFoul,
  stationWiring,
  trainMove,
} from './wiring';

let doc: ProjectDocument;

function stationNamed(name: string) {
  const station = entityList(doc.stations).find((s) => s.name === name);
  if (station === undefined) throw new Error(`no station ${name}`);
  return station;
}

function trackNamed(stationName: string, trackName: string): StationTrack {
  const track = tracksOfStation(doc, stationNamed(stationName).id).find(
    (t) => t.name === trackName,
  );
  if (track === undefined) throw new Error(`no track ${stationName} ${trackName}`);
  return track;
}

beforeAll(() => {
  doc = buildOimachiProject();
});

describe('derivation', () => {
  it('leaves a road with no wiring connected at both ends', () => {
    const track = trackNamed('緑が丘', '1番線');
    expect(track.wiring).toBeUndefined();
    expect(endsOfTrack(track, 'down')).toEqual(['down', 'up']);
  });

  it('points an unwired stub at the end of the line its station is nearest', () => {
    expect(defaultStubEnd(12_400, 0, 16_900)).toBe('down');
    expect(defaultStubEnd(6_400, 0, 16_900)).toBe('up');
  });

  it('takes the authored order as 分岐位置 until told otherwise', () => {
    const track = trackNamed('緑が丘', '2番線');
    expect(ladderOfTrack(track, 1)).toBe(1);
    expect(ladderOfTrack({ ...track, wiring: { ends: ['down'], ladder: 7 } }, 1)).toBe(7);
  });

  it('reads 自由が丘 の引上線 off the wiring, not off the km post', () => {
    const station = stationNamed('自由が丘');
    // The heuristic would say 上り方 — 自由が丘 is in the 大井町 half.
    expect(defaultStubEnd(station.kmFromOrigin, 0, 16_900)).toBe('up');
    const wiring = computeStationWiring(doc, station.id);
    const tail = wiring.roads.find((r) => r.name === '引上線')!;
    expect(tail.stubEnd).toBe('down');
    // …and it lies beyond the up platform, which is what makes a shunt in or
    // out of it cross the 上り本線.
    const up = wiring.roads.find((r) => r.name === '2番線')!;
    expect(tail.ladder).toBeGreaterThan(up.ladder);
  });

  it('gives 溝の口 a 下り本線 on each pair', () => {
    const wiring = computeStationWiring(doc, stationNamed('溝の口').id);
    const dt = wiring.roads.find((r) => r.name === '1番線')!;
    const om = wiring.roads.find((r) => r.name === '2番線')!;
    expect(dt.line).toContain('down');
    expect(om.line).toEqual(['down']);
    // Each is its own line: a train on either diverges nowhere.
    expect(lineLadder(wiring, 'down', dt.ladder)).toBe(dt.ladder);
    expect(lineLadder(wiring, 'down', om.ladder)).toBe(om.ladder);
  });

  it('sends an up departure from 溝の口 2番線 towards 3番線, not towards 1番線', () => {
    const wiring = computeStationWiring(doc, stationNamed('溝の口').id);
    const om = wiring.roads.find((r) => r.name === '2番線')!;
    const up = wiring.roads.find((r) => r.name === '3番線')!;
    expect(lineLadder(wiring, 'up', om.ladder)).toBe(up.ladder);
  });

  it('memoizes per document', () => {
    const id = stationNamed('大井町').id;
    expect(stationWiring(doc, id)).toBe(stationWiring(doc, id));
  });
});

describe('平面交差', () => {
  it('overlapping bands foul, disjoint ones do not', () => {
    expect(spansFoul({ from: 0, to: 2 }, { from: 1, to: 1 })).toBe(true);
    expect(spansFoul({ from: 0, to: 0 }, { from: 1, to: 3 })).toBe(false);
    // Touching counts: the two moves meet on the same rails.
    expect(spansFoul({ from: 0, to: 1 }, { from: 1, to: 2 })).toBe(true);
  });

  it('lets two parallel moves through one throat', () => {
    const wiring = computeStationWiring(doc, stationNamed('緑が丘').id);
    const down = trainMove(wiring, {
      kind: 'arrive',
      trackId: trackNamed('緑が丘', '1番線').id,
      direction: 'down',
      end: 'up',
    })!;
    const up = trainMove(wiring, {
      kind: 'depart',
      trackId: trackNamed('緑が丘', '2番線').id,
      direction: 'up',
      end: 'up',
    })!;
    expect(down.from).toBe(down.to);
    expect(movesCross(down, up)).toBe(false);
  });

  it('crosses an arrival into the far face with a departure from the near one', () => {
    // 大井町 is 頭端式1面2線: both roads hang off the same throat, so the 上り
    // 本線 fans into both and the 下り本線 out of both.
    const wiring = computeStationWiring(doc, stationNamed('大井町').id);
    const arriveFar = trainMove(wiring, {
      kind: 'arrive',
      trackId: trackNamed('大井町', '1番線').id,
      direction: 'up',
      end: 'down',
    })!;
    const departNear = trainMove(wiring, {
      kind: 'depart',
      trackId: trackNamed('大井町', '2番線').id,
      direction: 'down',
      end: 'down',
    })!;
    expect(movesCross(arriveFar, departNear)).toBe(true);

    // The other pairing is the parallel one and has to stay legal, or the
    // terminal could not work at all.
    const arriveNear = trainMove(wiring, {
      kind: 'arrive',
      trackId: trackNamed('大井町', '2番線').id,
      direction: 'up',
      end: 'down',
    })!;
    const departFar = trainMove(wiring, {
      kind: 'depart',
      trackId: trackNamed('大井町', '1番線').id,
      direction: 'down',
      end: 'down',
    })!;
    expect(movesCross(arriveNear, departFar)).toBe(false);
  });

  it('never reports a pair that shares a road or a 本線', () => {
    const wiring = computeStationWiring(doc, stationNamed('大井町').id);
    const arrive = trainMove(wiring, {
      kind: 'arrive',
      trackId: trackNamed('大井町', '1番線').id,
      direction: 'up',
      end: 'down',
    })!;
    const depart = trainMove(wiring, {
      kind: 'depart',
      trackId: trackNamed('大井町', '1番線').id,
      direction: 'down',
      end: 'down',
    })!;
    // Same road — that is a 二重使用 question, not a crossing one.
    expect(movesCross(arrive, depart)).toBe(false);
    const other = trainMove(wiring, {
      kind: 'arrive',
      trackId: trackNamed('大井町', '2番線').id,
      direction: 'up',
      end: 'down',
    })!;
    // Same 本線 — that is a 時隔 question.
    expect(movesCross(arrive, other)).toBe(false);
  });
});

describe('入換', () => {
  it('works a shunt into a stub at the end the stub is open at', () => {
    const wiring = computeStationWiring(doc, stationNamed('自由が丘').id);
    const move = shuntMove(
      wiring,
      trackNamed('自由が丘', '1番線').id,
      trackNamed('自由が丘', '引上線').id,
    )!;
    expect(move.end).toBe('down');
    expect(move.kind).toBe('shunt');
  });

  it('crosses the 上り本線 between the 自由が丘 down platform and the 引上線', () => {
    const wiring = computeStationWiring(doc, stationNamed('自由が丘').id);
    const shunt = shuntMove(
      wiring,
      trackNamed('自由が丘', '1番線').id,
      trackNamed('自由が丘', '引上線').id,
    )!;
    const upTrain = trainMove(wiring, {
      kind: 'depart',
      trackId: trackNamed('自由が丘', '2番線').id,
      direction: 'up',
      end: 'down',
    })!;
    expect(movesCross(shunt, upTrain)).toBe(true);

    // The other half of the move is worse, and that is the whole point of the
    // 片渡り線: the tail track is on the 下り線 only, so getting stock from it
    // to the up platform means running out over the crossover — past every
    // turnout in the throat — and setting back. It fouls the 下り本線 too.
    const back = shuntMove(
      wiring,
      trackNamed('自由が丘', '引上線').id,
      trackNamed('自由が丘', '2番線').id,
    )!;
    expect(back.routing).toBe('crossover');
    const downTrain = trainMove(wiring, {
      kind: 'depart',
      trackId: trackNamed('自由が丘', '1番線').id,
      direction: 'down',
      end: 'down',
    })!;
    expect(movesCross(back, downTrain)).toBe(true);
  });

  it('lets a shunt straight out of the face it serves alone', () => {
    // 溝の口 引上1号線 is the continuation of 2番線 and sits where it sits, so
    // going between them crosses nothing.
    const wiring = computeStationWiring(doc, stationNamed('溝の口').id);
    const shunt = shuntMove(
      wiring,
      trackNamed('溝の口', '2番線').id,
      trackNamed('溝の口', '引上1号線').id,
    )!;
    const other = trainMove(wiring, {
      kind: 'depart',
      trackId: trackNamed('溝の口', '3番線').id,
      direction: 'up',
      end: 'down',
    })!;
    expect(movesCross(shunt, other)).toBe(false);

    // Taking the *other* tail track does cross 3番線.
    const across = shuntMove(
      wiring,
      trackNamed('溝の口', '2番線').id,
      trackNamed('溝の口', '引上2号線').id,
    )!;
    expect(movesCross(across, other)).toBe(true);
  });

  it('reports nothing for a shunt between two roads with no shared end', () => {
    const wiring = computeStationWiring(doc, stationNamed('自由が丘').id);
    expect(
      shuntMove(wiring, trackNamed('自由が丘', '1番線').id, trackNamed('自由が丘', '1番線').id),
    ).toBeUndefined();
  });
});

describe('接続先とリード', () => {
  it('連れて行かれない先には行けない — 鷺沼方から大井町線ホームへは進路がない', () => {
    const wiring = computeStationWiring(doc, stationNamed('溝の口').id);
    // A 回送 off the 鷺沼 line reaching the 梶が谷 throat is on a 田園都市線
    // running line. 2番線 is on the 大井町線 lead and meets neither of them.
    const intoFace = trainMove(wiring, {
      kind: 'arrive',
      trackId: trackNamed('溝の口', '2番線').id,
      direction: 'up',
      end: 'down',
    })!;
    expect(intoFace.routing).toBe('none');

    const intoTail = trainMove(wiring, {
      kind: 'arrive',
      trackId: trackNamed('溝の口', '引上1号線').id,
      direction: 'up',
      end: 'down',
    })!;
    expect(intoTail.routing).toBe('direct');
  });

  it('lets the same face be entered from the 大井町 end, which is where it faces', () => {
    const wiring = computeStationWiring(doc, stationNamed('溝の口').id);
    const move = trainMove(wiring, {
      kind: 'arrive',
      trackId: trackNamed('溝の口', '2番線').id,
      direction: 'down',
      end: 'up',
    })!;
    expect(move.routing).toBe('direct');
  });

  it('joins a face and its tail track through the lead they share', () => {
    const wiring = computeStationWiring(doc, stationNamed('溝の口').id);
    const move = shuntMove(
      wiring,
      trackNamed('溝の口', '2番線').id,
      trackNamed('溝の口', '引上1号線').id,
    )!;
    expect(move.routing).toBe('direct');
  });

  it('reaches 自由が丘の引上線 from the 下り線 only, and over the 片渡り線 otherwise', () => {
    const station = stationNamed('自由が丘');
    const tail = trackNamed('自由が丘', '引上線');
    expect(canEnterFrom(station, tail, 'down', 'down', 'up')).toBe(true);
    expect(canEnterFrom(station, tail, 'up', 'down', 'up')).toBe(false);

    // The 上り線 reaches it too, but only because the 片渡り線 is there.
    expect(canEnterFrom(station, tail, 'down', 'up', 'up')).toBe(true);
    expect(canEnterFrom({ crossovers: [] }, tail, 'down', 'up', 'up')).toBe(false);
  });

  it('takes a shunt over the 片渡り線 across the whole throat', () => {
    const wiring = computeStationWiring(doc, stationNamed('自由が丘').id);
    const over = shuntMove(
      wiring,
      trackNamed('自由が丘', '2番線').id,
      trackNamed('自由が丘', '引上線').id,
    )!;
    expect(over.routing).toBe('crossover');
    // 1番線 (=下り本線, 0) は横切られる: 2番線 は 1 で引上線 は 2 なのに、
    // 渡り線まで出て戻るので帯は 0 まで広がる。
    expect(Math.min(over.from, over.to)).toBe(0);
    expect(Math.max(over.from, over.to)).toBe(2);
  });

  it('follows a chain of 渡り線 when working out what a lead reaches', () => {
    const links = [
      { end: 'up' as const, from: 'a', to: 'b' },
      { end: 'up' as const, from: 'b', to: 'down' },
      { end: 'down' as const, from: 'down', to: 'up' },
    ];
    expect([...leadsReachable({ crossovers: links }, 'up', ['a'])].sort()).toEqual([
      'a',
      'b',
      'down',
    ]);
    // The 下り方 link is in the other throat and does not join anything here.
    expect([...leadsReachable({ crossovers: links }, 'up', ['up'])]).toEqual(['up']);
  });
});
