/**
 * The 東急こどもの国線 平日ダイヤ sample, exercised end to end.
 *
 * Where the Oimachi sample proves the model scales, this one proves it says
 * something *different* about a different railway: one track, one loop, and a
 * meet that happens only when the timetable is dense enough to need one.
 *
 * The assertions below are deliberately the non-vacuous ones. "No meets in the
 * afternoon" is worthless on its own — there might be no trains. So the middle
 * of the day asserts that there IS a train and there is exactly one, and the
 * peak asserts two trains standing nose to nose at 恩田 on different roads.
 *
 * Everything is read from the hidden DOM the canvas publishes, never pixels.
 */

import { expect, test } from '@playwright/test';

import { Simulator } from './pageObjects';
import { TID } from './testids';

const T_MIDDAY = 12 * 3600; //                  12:00 — one set shuttling
/**
 * 07:03:00 — the first meet of the morning.
 *
 * The peak cycle is 720 s from 07:00, the down train stands at 恩田 from
 * 07:02:30 to 07:03:30, and the up train stands there across the same minute.
 */
const T_MEET = 7 * 3600 + 3 * 60;

test.describe('東急こどもの国線 sample', () => {
  test.beforeEach(async ({ page }) => {
    const sim = new Simulator(page);
    await sim.open();
    await sim.app.loadSample('kodomonokuni');
  });

  test('loads a single-track line with zero validation errors', async ({ page }) => {
    const sim = new Simulator(page);

    expect(await sim.app.trainCount()).toBe(140);
    await sim.app.expectNoErrors();
    await expect(page.getByTestId(TID.statusErrorCount)).toHaveText('エラー 0');
  });

  test('the middle of the day holds exactly one train on the line', async ({ page }) => {
    const sim = new Simulator(page);
    await sim.line.open();
    await sim.line.seek(T_MIDDAY);

    const rows = await sim.line.rows();
    // Exactly one — not zero, which would make every "no meets" claim vacuous.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.number).not.toBe('');
    // ...and it is not held for anybody, because there is nobody to be held for.
    expect(rows[0]!.reason).not.toBe('meetWait');
  });

  test('the peak puts two trains at 恩田 at once, on different roads', async ({ page }) => {
    const sim = new Simulator(page);
    await sim.line.open();
    await sim.line.seek(T_MEET);

    const rows = await sim.line.rows();
    expect(rows).toHaveLength(2);

    // Both standing, both at the same station, both held for the other.
    for (const row of rows) {
      expect(row.phase).toBe('dwelling');
      expect(row.reason).toBe('meetWait');
      expect(row.stationId).not.toBe('');
    }
    expect(rows[0]!.stationId).toBe(rows[1]!.stationId);

    // The whole point: two roads. One train is on the through road and the
    // other on the loop, which is the only way they get past each other.
    expect(rows[0]!.trackId).not.toBe('');
    expect(rows[1]!.trackId).not.toBe('');
    expect(rows[0]!.trackId).not.toBe(rows[1]!.trackId);

    // They are on the same rails on either side of this station, so they are
    // at the same place, one lane apart at most.
    expect(Math.abs(rows[0]!.km - rows[1]!.km)).toBeLessThan(200);
  });

  test('恩田 is the only station with a second road', async ({ page }) => {
    const sim = new Simulator(page);
    await sim.stations.open();

    await sim.stations.selectStation('恩田');
    await expect(sim.stations.yardLanes()).toHaveCount(2);
    await expect(sim.stations.yardBars()).not.toHaveCount(0);
    await expect(sim.stations.yardChart).toHaveAttribute('data-conflict-count', '0');
    await expect(sim.stations.yardConflicts).toHaveCount(0);

    // Both termini have one road, and every trip on the line reverses on it —
    // so a turnback that booked two roads instead of one would show up here as
    // a second lane, and an overlap that the plan did not account for as a
    // conflict.
    for (const name of ['長津田', 'こどもの国']) {
      await sim.stations.selectStation(name);
      await expect(sim.stations.yardLanes(), name).toHaveCount(1);
      expect(await sim.stations.yardBars().count(), name).toBeGreaterThan(0);
      await expect(sim.stations.yardChart, name).toHaveAttribute('data-conflict-count', '0');
    }
  });

  test('a formation never disappears across a turnback', async ({ page }) => {
    // Every trip on this line ends in a reversal, so if a formation vanished
    // between arriving and leaving there would be almost nothing left to draw.
    const sim = new Simulator(page);
    await sim.line.open();

    await sim.line.seek(T_MIDDAY);
    const before = (await sim.line.rows())[0]!;
    expect(before.trainId).not.toBe('');

    // Walk forward across the terminus arrival and out the other side.
    for (let i = 0; i < 12; i++) {
      await sim.line.advance(60);
      const rows = await sim.line.rows();
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.length).toBeLessThanOrEqual(2);
    }
  });
});
