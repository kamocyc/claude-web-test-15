/**
 * The 東急大井町線 平日ダイヤ sample, exercised end to end.
 *
 * The sample is the proof that the model scales: a real weekday of ~600 trains
 * with 待避, 緩急接続, 出庫 and 入庫, and not one validation error. Everything
 * below is asserted through the hidden DOM shadows the canvases publish, never
 * against pixels.
 */

import { expect, test } from '@playwright/test';

import { Simulator } from './pageObjects';
import { TID } from './testids';

const T_EARLY = 4 * 3600 + 30 * 60; //  04:30 — 出庫 time
const T_PEAK = 8 * 3600; //             08:00 — the morning peak
const T_OVERTAKE = 8 * 3600 + 600; //   08:10 — a 待避 is in progress
const T_LATE = 25 * 3600; //            25:00 — past midnight, 入庫 time

test.describe('東急大井町線 sample', () => {
  test.beforeEach(async ({ page }) => {
    const sim = new Simulator(page);
    await sim.open();
    await sim.app.loadSample();
  });

  test('loads ~600 trains with zero validation errors', async ({ page }) => {
    const sim = new Simulator(page);

    expect(await sim.app.trainCount()).toBeGreaterThan(500);
    await sim.app.expectNoErrors();
    await expect(page.getByTestId(TID.statusErrorCount)).toHaveText('エラー 0');
  });

  test('the morning peak has a plausible active set and a real 待避', async ({ page }) => {
    const sim = new Simulator(page);
    await sim.line.open();

    await sim.line.seek(T_PEAK);
    const peak = await sim.line.markers().count();
    // A 16 trains/hour peak over a 10 km line: a few tens of trains, not two
    // and not two hundred. Asserting a band, not a magic number.
    expect(peak).toBeGreaterThanOrEqual(8);
    expect(peak).toBeLessThanOrEqual(40);

    const rows = await sim.line.rows();
    expect(rows.filter((r) => r.phase === 'running').length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.phase === 'dwelling').length).toBeGreaterThan(0);
    // Every marker knows where it is and which road it is on.
    for (const row of rows) {
      expect(row.number).not.toBe('');
      expect(Number.isFinite(row.km)).toBe(true);
    }

    // 緩急接続 actually happening: a 各停 held for a faster train to pass.
    await sim.line.seek(T_OVERTAKE);
    await expect(sim.line.withReason('overtakeWait')).not.toHaveCount(0);
    const waiting = sim.line.withReason('overtakeWait').first();
    await expect(waiting).toHaveAttribute('data-phase', 'dwelling');
    await expect(waiting).not.toHaveAttribute('data-station', '');
  });

  test('the 運行図表 shows 待避 and 緩急接続 markers', async ({ page }) => {
    const sim = new Simulator(page);
    await sim.diagram.open();

    await expect(sim.diagram.lines()).not.toHaveCount(0);
    expect(await sim.diagram.lines().count()).toBeGreaterThan(500);
    await expect(sim.diagram.overtakeMarkers()).not.toHaveCount(0);
    await expect(sim.diagram.connectionMarkers()).not.toHaveCount(0);
    // Every detected 待避 must be on a road that permits it.
    await expect(sim.diagram.illegalOvertakes()).toHaveCount(0);

    // The geometry probe agrees that the polylines were actually drawn.
    const digest = await sim.app.renderDigest('diagram');
    expect(digest.view).toBe('diagram');
    expect(digest.width).toBeGreaterThan(0);
    expect(digest.stations.length).toBeGreaterThan(0);
  });

  test('旗の台 構内ダイヤ renders lanes with no 番線二重使用', async ({ page }) => {
    const sim = new Simulator(page);
    await sim.stations.open();
    await sim.stations.selectStation('旗の台');

    await expect(sim.stations.yardChart).toHaveAttribute('data-station-id', /^stn-/);
    // 旗の台 is the line's overtaking station: four roads.
    expect(await sim.stations.yardLanes().count()).toBeGreaterThanOrEqual(3);
    expect(await sim.stations.yardBars().count()).toBeGreaterThan(0);
    await expect(sim.stations.yardConflicts).toHaveCount(0);
    await expect(sim.stations.yardChart).toHaveAttribute('data-conflict-count', '0');
  });

  test('the 検査 screen renders the inspection projection and its badges', async ({ page }) => {
    const sim = new Simulator(page);

    await sim.inspections.open();
    await expect(sim.inspections.ruleList).toBeVisible();
    expect(await sim.inspections.scheduleRows().count()).toBeGreaterThan(0);

    await sim.formations.open();
    const badges = sim.formations.badges();
    expect(await badges.count()).toBeGreaterThan(0);
    // A badge always resolves to a state, never to a blank cell.
    const states = await badges.evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute('data-state') ?? ''),
    );
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      expect(['ok', 'dueSoon', 'overdue', 'unknown']).toContain(state);
    }
  });

  test('出庫 and 入庫 are modelled: trains run before 05:00 and after 24:00', async ({
    page,
  }) => {
    const sim = new Simulator(page);
    await sim.line.open();

    await sim.line.seek(T_EARLY);
    await expect(sim.line.markers()).not.toHaveCount(0);
    const early = await sim.line.rows();
    expect(early.length).toBeGreaterThan(0);

    await sim.line.seek(T_LATE);
    await expect(sim.line.markers()).not.toHaveCount(0);
    const late = await sim.line.rows();
    expect(late.length).toBeGreaterThan(0);

    // Different times of day, different trains on the line.
    const earlyIds = new Set(early.map((r) => r.trainId));
    expect(late.some((r) => !earlyIds.has(r.trainId))).toBe(true);
  });

  test('playing at speed changes the active set', async ({ page }) => {
    const sim = new Simulator(page);
    await sim.line.open();

    await sim.line.seek(T_PEAK);
    const before = new Set((await sim.line.rows()).map((r) => r.trainId));
    expect(before.size).toBeGreaterThan(0);

    await sim.app.setSpeed(600);
    await sim.app.play();
    for (let i = 0; i < 4; i++) await sim.line.advance(600);
    await sim.app.pause();

    expect(await sim.app.time()).toBe(T_PEAK + 2400);
    const after = new Set((await sim.line.rows()).map((r) => r.trainId));
    expect(after.size).toBeGreaterThan(0);
    const moved = [...after].some((id) => !before.has(id));
    expect(moved, '40 minutes later the line holds different trains').toBe(true);
  });
});
