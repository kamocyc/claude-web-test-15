/**
 * 行路表 — the picture, checked against the plan it claims to draw.
 *
 * The assertions are all of the same shape as the 構内配線図's: the chart says
 * what the model says, and it says the same thing the checks say. Anything the
 * chart computes for itself — the conflict flag, the row totals — is checked
 * against the rule that reports the same fact.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { ProjectDocument } from '@/domain/model';
import { buildOimachiProject } from '@/seed';
import { entityList } from '@/domain/units';
import { toyProjectCopy, TOY } from '@/testing/toyProject';
import { computeCrewChartLayout, rowAtY } from './layout';

let seed: ProjectDocument;

beforeAll(() => {
  seed = buildOimachiProject();
});

function layoutOf(doc: ProjectDocument, role?: 'driver' | 'conductor') {
  return computeCrewChartLayout(doc, {
    dayTypeId: doc.settings.activeDayTypeId,
    date: doc.settings.activeDate,
    ...(role === undefined ? {} : { role }),
  });
}

describe('行路表', () => {
  it('draws one row per 行路 and one bar per leg', () => {
    const doc = toyProjectCopy();
    const layout = layoutOf(doc);
    expect(layout.rows).toHaveLength(entityList(doc.crewDuties).length);
    const legs = entityList(doc.crewDuties).reduce((n, d) => n + d.legs.length, 0);
    expect(layout.bars).toHaveLength(legs);
    expect(layout.conflictCount).toBe(0);
  });

  it('orders the rows by sign-on and names the person booked on the date', () => {
    const layout = layoutOf(seed);
    for (let i = 1; i < layout.rows.length; i++) {
      expect(layout.rows[i]!.signOn).toBeGreaterThanOrEqual(layout.rows[i - 1]!.signOn);
    }
    expect(layout.rows.every((r) => r.crewLabel !== undefined)).toBe(true);
  });

  it('widens every row past its legs by the two 点呼', () => {
    const doc = toyProjectCopy();
    const layout = layoutOf(doc);
    for (const row of layout.rows) {
      const bars = layout.bars.filter((b) => b.crewDutyId === row.crewDutyId);
      const first = bars[0]!;
      const last = bars[bars.length - 1]!;
      expect(row.signOn).toBe(first.from - doc.validationConfig.crewSignOnSec);
      expect(row.signOff).toBe(last.to + doc.validationConfig.crewSignOffSec);
      expect(row.spreadSec).toBe(row.signOff - row.signOn);
    }
  });

  it('counts 実乗務 from the 乗務 legs only, not the 添乗', () => {
    const doc = toyProjectCopy();
    const layout = layoutOf(doc);
    const express = layout.rows.find((r) => r.crewDutyId === TOY.crewDutyExpress)!;
    const bars = layout.bars.filter((b) => b.crewDutyId === TOY.crewDutyExpress);
    const riding = bars.filter((b) => b.kind === 'train' || b.kind === 'deadhead');
    expect(riding.length).toBeGreaterThan(1);
    const ridingSec = riding.reduce((n, b) => n + (b.to - b.from), 0);
    expect(express.workSec).toBeLessThan(ridingSec);
    expect(express.workSec).toBe(
      bars.filter((b) => b.kind === 'train').reduce((n, b) => n + (b.to - b.from), 0),
    );
  });

  it('flags a leg that starts before the one before it finished', () => {
    const doc = toyProjectCopy();
    const legs = doc.crewDuties.byId[TOY.crewDutyLocal]!.legs;
    const standby = legs[2]!;
    if (standby.kind !== 'standby') throw new Error('fixture changed');
    standby.from -= 20 * 60;
    const layout = layoutOf(doc);
    expect(layout.conflictCount).toBe(1);
    expect(layout.bars.filter((b) => b.conflict)).toHaveLength(1);
  });

  it('filters by 職種', () => {
    const doc = toyProjectCopy();
    doc.crewDuties.byId[TOY.crewDutyExpress]!.role = 'conductor';
    expect(layoutOf(doc, 'driver').rows).toHaveLength(1);
    expect(layoutOf(doc, 'conductor').rows).toHaveLength(1);
    expect(layoutOf(doc).rows).toHaveLength(2);
  });

  it('labels an 添乗 differently from the same train worked', () => {
    const doc = toyProjectCopy();
    const layout = layoutOf(doc);
    const worked = layout.bars.find(
      (b) => b.crewDutyId === TOY.crewDutyLocal && b.kind === 'train' && b.legIndex === 0,
    )!;
    const ridden = layout.bars.find(
      (b) => b.crewDutyId === TOY.crewDutyExpress && b.kind === 'deadhead',
    )!;
    expect(ridden.label).toContain('添乗');
    expect(ridden.label).toContain(worked.label);
  });

  it('covers the whole seeded day and never leaves a row empty', () => {
    const layout = layoutOf(seed);
    expect(layout.rows.length).toBeGreaterThan(30);
    expect(layout.from).toBeLessThan(6 * 3600);
    expect(layout.to).toBeGreaterThan(24 * 3600);
    for (const row of layout.rows) {
      expect(layout.bars.some((b) => b.crewDutyId === row.crewDutyId)).toBe(true);
    }
  });
});

describe('rowAtY', () => {
  it('clamps to the rows that exist', () => {
    expect(rowAtY(-40, 24, 3)).toBe(0);
    expect(rowAtY(30, 24, 3)).toBe(1);
    expect(rowAtY(9999, 24, 3)).toBe(2);
    expect(rowAtY(10, 24, 0)).toBe(0);
  });
});
