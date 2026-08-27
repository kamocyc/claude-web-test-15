import { describe, expect, it } from 'vitest';

import { buildIndex } from '@/engine';
import { entityList } from '@/domain/units';
import { intervalsOverlap } from '@/domain/time';
import { runValidation } from '@/validation/run';
import { projectDigest } from '../digest';
import { buildKodomonokuniProject, lastKodomonokuniBuildReport } from './index';

const doc = buildKodomonokuniProject();
const report = lastKodomonokuniBuildReport()!;
const idx = buildIndex(doc);

const H = 3600;
const stationNamed = (name: string) =>
  entityList(doc.stations).find((s) => s.name === name)!;
const serviceTrains = entityList(doc.trains).filter((t) => t.category === 'service');

/** The clock window a train occupies the *line* for, origin to terminus. */
function span(trainId: string): { from: number; to: number } {
  const train = doc.trains.byId[trainId]!;
  const first = train.stops[0]!;
  const last = train.stops[train.stops.length - 1]!;
  return { from: first.dep ?? first.arr!, to: last.arr ?? last.dep! };
}

describe('こどもの国線 — the timetable', () => {
  it('runs 134 service trains, evenly split', () => {
    const digest = projectDigest(doc);
    expect(digest.serviceTrains).toBe(134);
    expect(digest.trainsByDirection).toEqual({ down: 70, up: 70 });
  });

  it('matches the band plan', () => {
    expect(report.perBand.map((b) => [b.name, b.trains, b.tph])).toEqual([
      ['早朝', 12, 3],
      ['朝ラッシュ', 20, 5],
      ['日中', 42, 3],
      ['夕ラッシュ', 30, 5],
      ['夜間', 30, 3],
    ]);
  });

  it('calls every train at all three stations — there is nothing to skip', () => {
    for (const train of serviceTrains) {
      expect(train.stops).toHaveLength(3);
      expect(train.stops.every((s) => s.kind === 'stop')).toBe(true);
    }
  });
});

describe('こどもの国線 — 単線', () => {
  it('validates with no errors', () => {
    const result = runValidation(doc);
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('never puts two trains in one section head to head', () => {
    // The rule that makes `trackCount: 1` mean anything. If the cycles were
    // wrong by so much as a few seconds this is what would say so.
    const opposing = runValidation(doc, { ruleIds: ['headway.singleTrackOpposing'] });
    expect(opposing.issues).toEqual([]);
  });

  it('holds one train at a time in the middle of the day', () => {
    // Off-peak is one set shuttling: at no instant between 09:30 and 15:30 are
    // two service trains on the line at once. This is the non-vacuous half of
    // 「ラッシュ時のみ交換」 — without it, "no meets off-peak" could just mean
    // "no trains".
    const midday = serviceTrains
      .filter((t) => t.origin?.bandId === 'midday')
      .map((t) => span(t.id))
      .filter((s) => s.from > 9.5 * H && s.to < 15.5 * H);
    expect(midday.length).toBeGreaterThan(30);
    for (let i = 0; i < midday.length; i++) {
      for (let j = i + 1; j < midday.length; j++) {
        const a = midday[i]!;
        const b = midday[j]!;
        expect(intervalsOverlap(a.from, a.to, b.from, b.to)).toBe(false);
      }
    }
  });
});

describe('こどもの国線 — 交換', () => {
  it('meets once per peak cycle, and only in the peaks', () => {
    // 10 morning cycles + 15 evening ones. Nothing declares this: it is what
    // a 12-minute cycle over a 5-minute half-journey does.
    expect(report.meetsByBand).toEqual({ amPeak: 10, pmPeak: 15 });
    expect(report.meets).toBe(25);
  });

  it('meets only at 恩田', () => {
    const onda = stationNamed('恩田');
    expect(idx.meets).not.toHaveLength(0);
    for (const meet of idx.meets) expect(meet.stationId).toBe(onda.id);
  });

  it('puts the two trains of a meet on different roads', () => {
    // The non-vacuous check. A "meet" where both trains are booked onto the
    // same road is not a meet, it is a collision that `track.doubleOccupancy`
    // would report — so this asserts the plan actually uses the loop.
    for (const meet of idx.meets) {
      const trackOf = (trainId: string): string | undefined =>
        doc.trains.byId[trainId]!.stops.find((s) => s.stationId === meet.stationId)?.trackId;
      const a = trackOf(meet.downTrainId);
      const b = trackOf(meet.upTrainId);
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a).not.toBe(b);
    }
  });

  it('touches 恩田 2番線 exactly as often as it meets, and no more', () => {
    // The loop is not a second platform that trains use because it is there.
    // It is used 25 times, which is the number of meets, and the rest of the
    // day everything runs through 1番線 — which is 「ラッシュ時のみ交換」 stated
    // as a count rather than as an intention.
    const onda = stationNamed('恩田');
    const loop = entityList(doc.stationTracks).find(
      (t) => t.stationId === onda.id && t.canBeOvertaken,
    )!;
    const uses = entityList(doc.trains).flatMap((t) =>
      t.stops.filter((s) => s.trackId === loop.id),
    );
    expect(uses).toHaveLength(report.meets);
  });

  it('marks both trains of a meet as held', () => {
    const meet = idx.meets[0]!;
    for (const trainId of [meet.downTrainId, meet.upTrainId]) {
      const event = idx.timelines
        .get(trainId)!
        .events.find((e) => e.stationId === meet.stationId)!;
      expect(event.isMeetWait).toBe(true);
    }
  });
});

describe('こどもの国線 — stock and crew', () => {
  it('works the line with three sets, one of them spare', () => {
    const formations = entityList(doc.formations);
    expect(formations.map((f) => f.code)).toEqual(['Y001F', 'Y002F', 'Y003F']);
    // Three sets is what lets an examination happen without stopping the
    // railway; the spare is the point of the third one.
    expect(formations.filter((f) => f.status === 'active').length).toBeLessThan(3);
    expect(runValidation(doc, { ruleIds: ['formation.insufficientFleet'] }).issues).toEqual([]);
  });

  it('brackets every duty with a 出庫 and an 入庫', () => {
    for (const duty of entityList(doc.duties)) {
      const trainLegs = duty.legs.filter((l) => l.kind === 'train');
      const firstId = (trainLegs[0] as { trainId: string }).trainId;
      const lastId = (trainLegs[trainLegs.length - 1] as { trainId: string }).trainId;
      expect(doc.trains.byId[firstId]!.category).toBe('deadhead');
      expect(doc.trains.byId[lastId]!.category).toBe('deadhead');
    }
  });

  it('is ワンマン — every 行路 is a driver, and no train wants a conductor', () => {
    for (const duty of entityList(doc.crewDuties)) expect(duty.role).toBe('driver');
    for (const type of entityList(doc.trainTypes)) expect(type.crewRoles).toBeUndefined();
  });

  it('covers every train with a crew', () => {
    expect(runValidation(doc, { ruleIds: ['crew.trainNotCovered'] }).issues).toEqual([]);
  });

  it('splits the examinations between the shed and the works', () => {
    // A 重要部検査 booked at the running shed would be an error, and the
    // document is shaped so the rule has something to be right about.
    expect(runValidation(doc, { ruleIds: ['inspection.depotNotCapable'] }).issues).toEqual([]);
    const works = entityList(doc.depots).find((d) => d.name === '長津田工場')!;
    const heavy = entityList(doc.inspectionRecords).filter(
      (r) => r.kind === 'bogie' || r.kind === 'general',
    );
    expect(heavy).not.toHaveLength(0);
    for (const record of heavy) expect(record.depotId).toBe(works.id);
  });
});

describe('こどもの国線 — determinism', () => {
  it('builds byte-identical output twice', () => {
    expect(JSON.stringify(buildKodomonokuniProject())).toBe(
      JSON.stringify(buildKodomonokuniProject()),
    );
  });

  it('has a stable digest', () => {
    expect(projectDigest(doc)).toMatchSnapshot();
  });
});
