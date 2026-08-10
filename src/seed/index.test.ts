/**
 * Structural tests for the generated 東急大井町線 project.
 *
 * Every assertion here is written to stand on its own: it reads the document
 * and checks a property of it, rather than trusting `runValidation`. That was
 * deliberate — the validator was a stub while this generator was being built,
 * and "the validator is happy" is worth nothing when the validator returns an
 * empty array. The validator gate is asserted too, at the end, as a second
 * opinion rather than the only one.
 */

import { describe, expect, it } from 'vitest';
import type { Link, LinkRunTime, ProjectDocument, StationTrack, Train } from '@/domain/model';
import { entityList } from '@/domain/units';
import { SEC_PER_DAY, intervalsOverlap } from '@/domain/time';
import { runValidation } from '@/validation/run';
import { buildOimachiProject, lastBuildReport } from './index';
import { projectDigest } from './digest';

const doc = buildOimachiProject();
const report = lastBuildReport()!;
const trains = entityList(doc.trains);
const service = trains.filter((t) => t.category === 'service');
const deadheads = trains.filter((t) => t.category === 'deadhead');

const stationNamed = (name: string) => entityList(doc.stations).find((s) => s.name === name)!;
const typeNamed = (name: string) => entityList(doc.trainTypes).find((t) => t.name === name)!;
const track = (id: string): StationTrack => doc.stationTracks.byId[id]!;

const OIMACHI = stationNamed('大井町');
const HATANODAI = stationNamed('旗の台');
const KAMINOGE = stationNamed('上野毛');
const MIZONOKUCHI = stationNamed('溝の口');
const FUTAKOSHINCHI = stationNamed('二子新地');
const TAKATSU = stationNamed('高津');

const EXPRESS = typeNamed('急行');
const GREEN = typeNamed('各駅停車(緑)');
const BLUE = typeNamed('各駅停車(青)');

// --- run-time lookup, built from the document itself ------------------------
const linkBetween = new Map<string, Link>();
for (const l of entityList(doc.links)) {
  linkBetween.set(`${l.fromStationId}|${l.toStationId}`, l);
  linkBetween.set(`${l.toStationId}|${l.fromStationId}`, l);
}
const runTimeByKey = new Map<string, LinkRunTime>();
for (const rt of doc.linkRunTimes) runTimeByKey.set(`${rt.linkId}|${rt.profileId}`, rt);

function minSectionSec(train: Train, i: number): number {
  const prev = train.stops[i - 1]!;
  const cur = train.stops[i]!;
  const link = linkBetween.get(`${prev.stationId}|${cur.stationId}`)!;
  const profileId = doc.trainTypes.byId[train.typeId]!.perfProfileId;
  const rt = runTimeByKey.get(`${link.id}|${profileId}`)!;
  return (
    rt.baseRunSec +
    (prev.kind === 'stop' ? rt.startPenaltySec : 0) +
    (cur.kind === 'stop' ? rt.stopPenaltySec : 0)
  );
}

describe('列車', () => {
  it('produces a full weekday of service plus its empty stock moves', () => {
    expect(service.length).toBeGreaterThan(400);
    expect(deadheads.length).toBeGreaterThan(0);
    expect(deadheads.length).toBe(entityList(doc.duties).length * 2);
  });

  it('gives every train strictly increasing times', () => {
    for (const train of trains) {
      let last = Number.NEGATIVE_INFINITY;
      for (const stop of train.stops) {
        if (stop.arr !== undefined) {
          expect(stop.arr, `${train.number} @ ${stop.stationId}`).toBeGreaterThan(last);
          last = stop.arr;
        }
        if (stop.dep !== undefined) {
          expect(stop.dep, `${train.number} @ ${stop.stationId}`).toBeGreaterThanOrEqual(last);
          last = stop.dep;
        }
      }
      expect(train.stops[0]!.arr).toBeUndefined();
      expect(train.stops[train.stops.length - 1]!.dep).toBeUndefined();
    }
  });

  it('meets the minimum run time on every section', () => {
    for (const train of trains) {
      for (let i = 1; i < train.stops.length; i++) {
        const booked = train.stops[i]!.arr! - train.stops[i - 1]!.dep!;
        expect(booked, `${train.number} section ${i}`).toBeGreaterThanOrEqual(
          minSectionSec(train, i),
        );
      }
    }
  });

  it('puts every time on the 5-second grain', () => {
    for (const train of trains) {
      for (const stop of train.stops) {
        if (stop.arr !== undefined) expect(stop.arr % 5).toBe(0);
        if (stop.dep !== undefined) expect(stop.dep % 5).toBe(0);
      }
    }
  });

  it('runs the last trains past midnight as 24:xx / 25:xx, not wrapped', () => {
    const latest = Math.max(
      ...trains.map((t) => t.stops[t.stops.length - 1]!.arr ?? t.stops[0]!.dep ?? 0),
    );
    expect(latest).toBeGreaterThan(SEC_PER_DAY);
    expect(latest).toBeLessThan(26 * 3600);
  });

  it('gives every train a unique 列車番号', () => {
    const numbers = trains.map((t) => t.number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

describe('種別ごとの停車パターン', () => {
  const withinMainLine = (train: Train) =>
    train.stops.filter((s) => {
      const km = doc.stations.byId[s.stationId]!.kmFromOrigin;
      return km >= OIMACHI.kmFromOrigin && km <= MIZONOKUCHI.kmFromOrigin;
    });

  it('stops every 急行 at exactly the six 急行停車駅', () => {
    const expected = ['大井町', '旗の台', '大岡山', '自由が丘', '二子玉川', '溝の口'];
    const expresses = service.filter((t) => t.typeId === EXPRESS.id);
    expect(expresses.length).toBeGreaterThan(100);
    for (const train of expresses) {
      const stops = withinMainLine(train)
        .filter((s) => s.kind === 'stop')
        .map((s) => doc.stations.byId[s.stationId]!.name);
      expect([...stops].sort(), train.number).toEqual([...expected].sort());
    }
  });

  it('passes 二子新地・高津 with 急行 and 緑各停, stops there with 青各停', () => {
    for (const train of service) {
      for (const stop of train.stops) {
        if (stop.stationId !== FUTAKOSHINCHI.id && stop.stationId !== TAKATSU.id) continue;
        const expected = train.typeId === BLUE.id ? 'stop' : 'pass';
        expect(stop.kind, `${train.number} @ ${stop.stationId}`).toBe(expected);
      }
    }
  });

  it('routes 青各停 on the 田園都市線 platforms there and everything else on the 通過線', () => {
    for (const train of service) {
      for (const stop of train.stops) {
        if (stop.stationId !== FUTAKOSHINCHI.id && stop.stationId !== TAKATSU.id) continue;
        const t = track(stop.trackId!);
        expect(t.hasPlatform, `${train.number}`).toBe(train.typeId === BLUE.id);
      }
    }
  });

  it('turns every 大井町線 train on the 大井町線 faces at 溝の口', () => {
    // 1・4番線 belong to the 田園都市線, whose own trains this document does not
    // model: they only *look* free. Stock that starts or ends its run at 溝の口
    // stands on 2・3番線 — whichever pair of rails it ran in on, since the 青各停
    // uses the outer pair to reach 二子新地 and 高津 — and everything that runs
    // through is on the 田園都市線 beyond the station, so it uses 1・4.
    const face = (t: Train, i: number): string => track(t.stops[i]!.trackId!).name;
    const OM = ['2番線', '3番線'];
    const DT = ['1番線', '4番線'];

    let turning = 0;
    let through = 0;
    for (const train of trains) {
      train.stops.forEach((stop, i) => {
        if (stop.stationId !== MIZONOKUCHI.id) return;
        const name = face(train, i);
        if (name.startsWith('引上')) return;
        if (i === 0 || i === train.stops.length - 1) {
          turning++;
          expect(OM, `${train.number} @ 溝の口`).toContain(name);
        } else {
          through++;
          expect(DT, `${train.number} @ 溝の口`).toContain(name);
        }
      });
    }
    expect(turning).toBeGreaterThan(100);
    expect(through).toBeGreaterThan(100);
  });

  it('books no passenger stop on a 通過線', () => {
    for (const train of service) {
      for (const stop of train.stops) {
        if (stop.kind !== 'stop') continue;
        expect(track(stop.trackId!).hasPlatform, `${train.number}`).toBe(true);
      }
    }
  });

  it('serves 緑 and 青 alike everywhere except 二子新地・高津', () => {
    const stopSet = (typeId: string) => {
      // Compare like with like: both samples must terminate at 溝の口, not run
      // through onto the 田園都市線.
      const sample = service.find(
        (t) =>
          t.typeId === typeId &&
          t.direction === 'down' &&
          t.stops[t.stops.length - 1]!.stationId === MIZONOKUCHI.id,
      )!;
      return sample.stops
        .filter((s) => s.kind === 'stop')
        .map((s) => doc.stations.byId[s.stationId]!.name);
    };
    const green = stopSet(GREEN.id);
    const blue = stopSet(BLUE.id).filter((n) => n !== '二子新地' && n !== '高津');
    expect(blue).toEqual(green);
  });
});

describe('待避と緩急接続', () => {
  it('only ever overtakes at 旗の台 or 上野毛, and 上野毛 only in the 上り', () => {
    let count = 0;
    for (const train of trains) {
      for (const stop of train.stops) {
        if ((stop.overtakenBy ?? []).length === 0) continue;
        count++;
        expect([HATANODAI.id, KAMINOGE.id]).toContain(stop.stationId);
        if (stop.stationId === KAMINOGE.id) expect(train.direction).toBe('up');
      }
    }
    expect(count).toBeGreaterThan(100);
  });

  it('stands the waiting train on a 待避線 and the passing train on the through road', () => {
    const trainById = new Map(trains.map((t) => [t.id, t]));
    for (const train of trains) {
      train.stops.forEach((stop) => {
        const passers = stop.overtakenBy ?? [];
        if (passers.length === 0) return;
        expect(track(stop.trackId!).canBeOvertaken, `waiting ${train.number}`).toBe(true);
        for (const passerId of passers) {
          const passer = trainById.get(passerId)!;
          const at = passer.stops.find((s) => s.stationId === stop.stationId)!;
          expect(track(at.trackId!).canBeOvertaken, `passing ${passer.number}`).toBe(false);
        }
      });
    }
  });

  it('actually lets the passing train through: it clears before the waiter leaves', () => {
    const trainById = new Map(trains.map((t) => [t.id, t]));
    for (const train of trains) {
      for (const stop of train.stops) {
        for (const passerId of stop.overtakenBy ?? []) {
          const passer = trainById.get(passerId)!;
          const at = passer.stops.find((s) => s.stationId === stop.stationId)!;
          const passerArr = at.arr ?? at.dep!;
          const passerDep = at.dep ?? at.arr!;
          expect(stop.arr!, `${train.number} vs ${passer.number}`).toBeLessThan(passerArr);
          expect(stop.dep!, `${train.number} vs ${passer.number}`).toBeGreaterThan(passerDep);
        }
      }
    }
  });

  it('declares a 緩急接続 only where the receiving train is genuinely faster', () => {
    const trainById = new Map(trains.map((t) => [t.id, t]));
    let declared = 0;
    for (const train of trains) {
      for (const stop of train.stops) {
        for (const toId of stop.connectsTo ?? []) {
          declared++;
          const other = trainById.get(toId)!;
          expect(other.direction).toBe(train.direction);
          expect(doc.stations.byId[stop.stationId]!.isConnectionPoint).toBe(true);
          const otherStop = other.stops.find((s) => s.stationId === stop.stationId)!;
          const transfer = (otherStop.dep ?? otherStop.arr!) - stop.arr!;
          expect(transfer).toBeGreaterThanOrEqual(doc.validationConfig.connectionMinTransferSec);
          expect(transfer).toBeLessThanOrEqual(doc.validationConfig.connectionMaxWaitSec);
        }
      }
    }
    expect(declared).toBeGreaterThan(100);
  });
});

describe('番線', () => {
  it('assigns a 番線 to every stop, in a direction the track allows', () => {
    for (const train of trains) {
      for (const stop of train.stops) {
        expect(stop.trackId, train.number).toBeDefined();
        const t = track(stop.trackId!);
        expect(t.stationId).toBe(stop.stationId);
        expect(t.directions, `${train.number}`).toContain(train.direction);
        expect(t.maxCars).toBeGreaterThanOrEqual(train.minCars ?? 0);
      }
    }
  });

  it('never double-books a 番線', () => {
    const byTrack = new Map<string, Array<{ from: number; to: number; label: string }>>();
    for (const train of trains) {
      for (const stop of train.stops) {
        const t = track(stop.trackId!);
        const t0 = (stop.arr ?? stop.dep!) - t.approachSec;
        const t1 = (stop.dep ?? stop.arr!) + t.clearSec;
        const list = byTrack.get(t.id) ?? [];
        list.push({ from: t0, to: t1, label: `${train.number}` });
        byTrack.set(t.id, list);
      }
    }
    for (const [trackId, windows] of byTrack) {
      windows.sort((a, b) => a.from - b.from);
      for (let i = 1; i < windows.length; i++) {
        const prev = windows[i - 1]!;
        const cur = windows[i]!;
        expect(
          intervalsOverlap(prev.from, prev.to, cur.from, cur.to),
          `${track(trackId).name} @ ${doc.stations.byId[track(trackId).stationId]!.name}: ${prev.label} / ${cur.label}`,
        ).toBe(false);
      }
    }
  });
});

describe('運用と編成', () => {
  const duties = entityList(doc.duties);

  it('starts every duty with a 出庫 and ends it with a 入庫', () => {
    expect(duties.length).toBeGreaterThan(10);
    for (const duty of duties) {
      const first = duty.legs[0]!;
      const last = duty.legs[duty.legs.length - 1]!;
      expect(first.kind).toBe('train');
      expect(last.kind).toBe('train');
      const out = doc.trains.byId[(first as { trainId: string }).trainId]!;
      const back = doc.trains.byId[(last as { trainId: string }).trainId]!;
      expect(out.stops[0]!.operation, duty.code).toBe('depotOut');
      expect(back.stops[back.stops.length - 1]!.operation, duty.code).toBe('depotIn');
    }
  });

  it('keeps every duty continuous in space and time', () => {
    for (const duty of duties) {
      let where: string | undefined;
      let when = Number.NEGATIVE_INFINITY;
      for (const leg of duty.legs) {
        if (leg.kind === 'train') {
          const t = doc.trains.byId[leg.trainId]!;
          const from = t.stops[0]!;
          const to = t.stops[t.stops.length - 1]!;
          if (where !== undefined) expect(from.stationId, duty.code).toBe(where);
          expect(from.dep!, duty.code).toBeGreaterThanOrEqual(when);
          where = to.stationId;
          when = to.arr!;
        } else if (leg.kind === 'stable') {
          if (where !== undefined) expect(leg.stationId, duty.code).toBe(where);
          expect(leg.from, duty.code).toBeGreaterThanOrEqual(when);
          where = leg.stationId;
          when = leg.to;
        }
      }
    }
  });

  it('respects the turnback time at every change of train', () => {
    for (const duty of duties) {
      const legs = duty.legs.filter((l) => l.kind === 'train');
      for (let i = 1; i < legs.length; i++) {
        const prev = doc.trains.byId[(legs[i - 1] as { trainId: string }).trainId]!;
        const next = doc.trains.byId[(legs[i] as { trainId: string }).trainId]!;
        const at = prev.stops[prev.stops.length - 1]!;
        const gap = next.stops[0]!.dep! - at.arr!;
        expect(gap, duty.code).toBeGreaterThanOrEqual(
          doc.stations.byId[at.stationId]!.minTurnbackSec,
        );
      }
    }
  });

  it('covers every service train by exactly one duty', () => {
    const counts = new Map<string, number>();
    for (const duty of duties) {
      for (const leg of duty.legs) {
        if (leg.kind !== 'train') continue;
        counts.set(leg.trainId, (counts.get(leg.trainId) ?? 0) + 1);
      }
    }
    for (const train of service) {
      expect(counts.get(train.id), `train ${train.number} uncovered`).toBe(1);
    }
    for (const train of deadheads) expect(counts.get(train.id)).toBe(1);
  });

  it('never mixes car counts inside a duty', () => {
    for (const duty of duties) {
      for (const leg of duty.legs) {
        if (leg.kind !== 'train') continue;
        expect(doc.trains.byId[leg.trainId]!.minCars).toBe(duty.requiredCars);
      }
    }
  });

  it('assigns a formation of the right length to every duty, and never double-books one', () => {
    const assignments = entityList(doc.assignments);
    expect(assignments).toHaveLength(duties.length);
    const spans = new Map<string, Array<{ from: number; to: number }>>();
    for (const a of assignments) {
      const duty = doc.duties.byId[a.dutyId]!;
      const formation = doc.formations.byId[a.formationId]!;
      expect(formation.cars, duty.code).toBe(duty.requiredCars);
      expect(formation.status).toBe('active');
      expect(a.date).toBe(doc.settings.activeDate);

      const legs = duty.legs.flatMap((l) =>
        l.kind === 'train' ? [doc.trains.byId[l.trainId]!] : [],
      );
      const from = legs[0]!.stops[0]!.dep!;
      const to = legs[legs.length - 1]!.stops.at(-1)!.arr!;
      const list = spans.get(a.formationId) ?? [];
      for (const other of list) expect(intervalsOverlap(from, to, other.from, other.to)).toBe(false);
      list.push({ from, to });
      spans.set(a.formationId, list);
    }
  });

  it('keeps the depot within its capacity', () => {
    const depot = entityList(doc.depots).find((d) => d.name === '鷺沼車庫')!;
    expect(report.depotCapacityExceeded).toBe(false);
    expect(report.depotPeakStabled).toBeLessThanOrEqual(depot.capacityFormations);
  });

  it('fills the yard road by road instead of piling every 回送 onto one', () => {
    // The yard's roads have no direction and no through movement, so the
    // station's "default" road used to take every single empty move: every
    // 出庫 left 留置10番線 and every 入庫 arrived at 留置1番線, and the line view
    // drew nineteen formations stacked on one road.
    const yard = entityList(doc.stations).find((s) => s.name === '鷺沼車庫')!;
    const perRoad = new Map<string, number>();
    for (const train of deadheads) {
      for (const stop of train.stops) {
        if (stop.stationId !== yard.id) continue;
        expect(stop.trackId, `${train.number}`).toBeDefined();
        perRoad.set(stop.trackId!, (perRoad.get(stop.trackId!) ?? 0) + 1);
      }
    }

    const total = [...perRoad.values()].reduce((n, v) => n + v, 0);
    expect(total).toBe(deadheads.length);
    // Every road carries some of it, and none of them carries a quarter.
    expect(perRoad.size).toBe(yard.trackIds.length);
    for (const [trackId, count] of perRoad) {
      expect(count, track(trackId).name).toBeLessThan(total / 4);
    }
  });
});

describe('検査', () => {
  it('gives every formation a completed record for every rule', () => {
    const records = entityList(doc.inspectionRecords);
    for (const formation of entityList(doc.formations)) {
      for (const rule of entityList(doc.inspectionRules)) {
        const found = records.filter(
          (r) => r.formationId === formation.id && r.ruleId === rule.id && r.status === 'completed',
        );
        expect(found, `${formation.code} / ${rule.name}`).toHaveLength(1);
        expect(found[0]!.odometerKmAt).toBeDefined();
        expect(found[0]!.depotId).toBe(rule.depotIds[0]);
      }
    }
  });

  it('sends 重要部検査 and 全般検査 to 長津田車両工場 and the rest to 鷺沼', () => {
    const works = entityList(doc.depots).find((d) => d.name === '長津田車両工場')!;
    const saginuma = entityList(doc.depots).find((d) => d.name === '鷺沼車庫')!;
    for (const rule of entityList(doc.inspectionRules)) {
      const expected = rule.kind === 'bogie' || rule.kind === 'general' ? works.id : saginuma.id;
      expect(rule.depotIds, rule.name).toEqual([expected]);
    }
  });

  it('has at least one formation in the shops and none rostered while it is', () => {
    const inShops = entityList(doc.formations).filter((f) => f.status === 'inInspection');
    expect(inShops.length).toBeGreaterThan(0);
    const rostered = new Set(entityList(doc.assignments).map((a) => a.formationId));
    for (const f of inShops) expect(rostered.has(f.id)).toBe(false);
  });

  it('produces a visible spread of 期限間近 without anything overdue', () => {
    const issues = runValidation(doc).issues;
    expect(issues.filter((i) => i.ruleId === 'inspection.dueSoon').length).toBeGreaterThan(0);
    expect(issues.filter((i) => i.ruleId === 'inspection.overdue')).toEqual([]);
  });
});

describe('時間帯別の運転本数', () => {
  it('matches the planned trains per hour in each direction', () => {
    const expected: Record<string, { down: number; up: number }> = {
      早朝: { down: 8, up: 8 },
      立上り: { down: 8, up: 8 },
      朝ラッシュ準備: { down: 8, up: 16 },
      朝ラッシュ: { down: 16, up: 16 },
      日中準備: { down: 16, up: 12 },
      日中: { down: 12, up: 12 },
      夕ラッシュ準備: { down: 12, up: 16 },
      夕ラッシュ: { down: 16, up: 16 },
      夜間準備: { down: 16, up: 12 },
      夜間: { down: 12, up: 12 },
      夜間後半: { down: 12, up: 12 },
      深夜準備: { down: 12, up: 8 },
      深夜: { down: 6, up: 6 },
    };
    expect(report.perBand.map((b) => b.name).sort()).toEqual(Object.keys(expected).sort());
    const bandById = new Map(report.perBand.map((b) => [b.name, b]));
    for (const [name, want] of Object.entries(expected)) {
      const band = bandById.get(name)!;
      const hours = band.down / band.tph;
      expect(band.tph, `${name} 下り`).toBe(want.down);
      // A 鷺沼始発 上り 急行 leaves one cycle ahead of the grid, so a band's
      // first cycle can carry one 上り train fewer. Everything else is exact.
      expect(band.up / hours, `${name} 上り`).toBeGreaterThan(want.up - 0.7);
      expect(band.up / hours, `${name} 上り`).toBeLessThanOrEqual(want.up);
    }
  });

  /**
   * The peak/off-peak contrast is the point of the band ladder, so pin both
   * halves of it: the density AND the mix inside a cycle. 16 本/時 is one 急行
   * to three 各停; 12 本/時 is one 急行 to two, because the 1 : 3 version of it
   * needs a 1200 s cycle that 大井町 cannot be handed — see the header of
   * `service.ts` for the whole argument.
   */
  it('runs 急行1:各停3 in the peaks and 急行1:各停2 off-peak, both directions', () => {
    const mix: Record<string, [number, number]> = {
      朝ラッシュ: [1, 3],
      夕ラッシュ: [1, 3],
      日中: [1, 2],
      夜間: [1, 2],
      夜間後半: [1, 2],
    };
    for (const [name, [wantExpress, wantLocal]] of Object.entries(mix)) {
      const band = report.perBand.find((b) => b.name === name)!;
      for (const direction of ['down', 'up'] as const) {
        const inBand = service.filter(
          (t) => t.origin?.bandId === band.bandId && t.direction === direction,
        );
        const express = inBand.filter((t) => t.typeId === EXPRESS.id).length;
        const local = inBand.length - express;
        expect(local / express, `${name} ${direction}`).toBe(wantLocal / wantExpress);
      }
    }
  });

  /**
   * 大井町 is a stub: every 上り train that arrives has to leave again as a 下り
   * train, and the terminal can hold two formations. A steady band therefore
   * has to be symmetric — an asymmetric peak is not a denser timetable, it is
   * stock piling up on two dead-end platform roads.
   *
   * The 準備 bands are asymmetric on purpose, and in the direction that puts
   * the difference at 溝の口 instead: the 上り changes gear a run time before
   * the 下り does, so 大井町 sees arrivals and departures step together while
   * 溝の口 — two 引上線, four faces, 鷺沼車庫 eight minutes away — absorbs the
   * formations entering or leaving service. See `RAMP_LEAD_SEC` in service.ts.
   */
  it('keeps every steady band balanced, because 大井町 cannot store the difference', () => {
    for (const band of report.perBand) {
      if (band.name.endsWith('準備')) {
        expect(band.up, `${band.name}`).not.toBe(band.down);
        continue;
      }
      expect(Math.abs(band.up - band.down), `${band.name}`).toBeLessThanOrEqual(1);
    }
  });

  it('balances over the whole day: what 大井町 takes in, it sends out', () => {
    const down = report.perBand.reduce((n, b) => n + b.down, 0);
    const up = report.perBand.reduce((n, b) => n + b.up, 0);
    expect(Math.abs(up - down)).toBeLessThanOrEqual(3);
  });
});

describe('決定性とダイジェスト', () => {
  it('builds byte-identically twice', { timeout: 30_000 }, () => {
    const a = buildOimachiProject();
    const b = buildOimachiProject();
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('uses no wall clock', () => {
    const meta = doc.meta;
    expect(meta.createdAt).toBe(meta.updatedAt);
    expect(meta.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('matches the digest baseline', () => {
    // The DIGEST is snapshotted, never the document: ids churn whenever a
    // station or a slot moves, and a whole-document snapshot would go red on
    // changes that alter nothing anyone cares about.
    expect(projectDigest(doc)).toMatchSnapshot();
  });
});

describe('検証', () => {
  it('produces no validation errors', () => {
    const result = runValidation(doc);
    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors.map((e) => `${e.ruleId}: ${e.detail}`)).toEqual([]);
    expect(result.errorCount).toBe(0);
  });

  it('is a complete document', () => {
    const d: ProjectDocument = doc;
    expect(d.schemaVersion).toBe(1);
    expect(d.calendar).toHaveLength(1);
    expect(d.calendar[0]!.date).toBe(d.settings.activeDate);
    expect(d.settings.timeGrainSec).toBe(5);
    expect(entityList(d.perfProfiles)).toHaveLength(2);
    expect(entityList(d.formationSeries)).toHaveLength(5);
  });
});
