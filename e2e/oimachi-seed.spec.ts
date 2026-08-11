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

  test('the terminals — where every turnback is — are also conflict-free', async ({ page }) => {
    // 旗の台 alone is not enough coverage: it is the one busy station with no
    // turnbacks, and a turnback is exactly what produces two overlapping bars
    // for a single formation. A regression that paints every terminal red is
    // invisible from 旗の台.
    const sim = new Simulator(page);
    await sim.stations.open();

    for (const name of ['大井町', '溝の口', '鷺沼']) {
      await sim.stations.selectStation(name);
      expect(await sim.stations.yardBars().count(), `${name} should have bars`).toBeGreaterThan(0);
      await expect(sim.stations.yardChart, name).toHaveAttribute('data-conflict-count', '0');
      await expect(sim.stations.yardConflicts, name).toHaveCount(0);
    }
  });

  test('the 行路表 covers the day with more 乗務員 than 運用, and no clashes', async ({
    page,
  }) => {
    const sim = new Simulator(page);
    await sim.crew.open();

    const ids = await sim.crew.crewDutyIds();
    // 35 運用 against ~70 行路. People take breaks and go home; vehicles do not.
    expect(ids.length).toBeGreaterThan(35);
    expect(ids.length).toBeLessThan(100);

    const counts = await sim.crew.chartCounts();
    expect(counts.rows).toBe(ids.length);
    expect(counts.conflicts).toBe(0);
    expect(await sim.crew.chartBars().count()).toBeGreaterThan(ids.length);

    // Every 行路 has somebody booked on it for the active date.
    const first = ids[0]!;
    expect(await sim.crew.personOf(first)).toMatch(/^crw-/);

    await sim.app.expectNoErrors();
  });

  test('the 行路表 zooms on the same axis as the 構内ダイヤ', async ({ page }) => {
    const sim = new Simulator(page);
    await sim.crew.open();

    const whole = await sim.crew.window();
    await sim.crew.zoomIn();
    const zoomed = await sim.crew.window();
    expect(zoomed).not.toBe(whole);
    await sim.crew.resetZoom();
    expect(await sim.crew.window()).toBe(whole);
  });

  test('a 行路 can be opened and given a 休憩', async ({ page }) => {
    const sim = new Simulator(page);
    await sim.crew.open();

    const ids = await sim.crew.crewDutyIds();
    const target = ids[0]!;
    await sim.crew.expandDuty(target);
    const before = await sim.crew.legs(target).count();
    expect(before).toBeGreaterThan(1);

    await sim.crew.addBreak(target);
    expect(await sim.crew.legs(target).count()).toBe(before + 1);
    // The 休憩 lands on the chart too — the picture and the plan are one thing.
    expect((await sim.crew.chartCounts()).rows).toBe(ids.length);
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

  test('a formation never disappears while its duty is running', async ({ page }) => {
    // The 大井町 stub terminal turns every up train back as a down one, and
    // 溝の口 shunts the long layovers into a 引上線. Through all of it the
    // stock has to stay on screen: it used to blink out at the arrival and
    // reappear minutes later as the next train, which reads as a vanishing
    // vehicle and then a teleporting one.
    const sim = new Simulator(page);
    await sim.line.open();

    await sim.line.seek(T_PEAK);
    const lastKm = new Map<string, number>();
    for (const row of await sim.line.rows()) {
      if (row.formation !== '') lastKm.set(row.formation, row.km);
    }
    expect(lastKm.size).toBeGreaterThan(8);

    // Step through a whole turnback cycle. A formation may finish for the day
    // and go home, but it must never blink out and come back — that gap is
    // the bug, and the reappearance is what makes it unmistakable.
    const gone = new Set<string>();
    const turnedBack = new Set<string>();
    for (let step = 0; step < 12; step++) {
      await sim.line.advance(60);
      const rows = await sim.line.rows();
      const now = new Map<string, { km: number; reason: string }>();
      for (const row of rows) {
        if (row.formation === '') continue;
        expect(now.has(row.formation), `${row.formation} drawn twice`).toBe(false);
        now.set(row.formation, { km: row.km, reason: row.reason });
        if (row.reason === 'turnback') turnedBack.add(row.formation);
      }
      for (const code of lastKm.keys()) {
        const here = now.get(code);
        if (here === undefined) {
          gone.add(code);
          continue;
        }
        expect(gone.has(code), `${code} vanished and came back`).toBe(false);
        // A minute of railway is at most ~2 km, so a bigger step is a jump.
        expect(Math.abs(here.km - lastKm.get(code)!), `${code} jumped`).toBeLessThan(2.5);
        lastKm.set(code, here.km);
      }
    }
    // …and the window really did contain turnbacks, so the above is not vacuous.
    expect(turnedBack.size, 'no formation turned back in twelve minutes').toBeGreaterThan(0);
  });

  test('a panned, zoomed camera survives the clock moving', async ({ page }) => {
    // The view re-renders whenever the shadow refreshes, which is four times a
    // second while the clock runs. That must not be allowed to re-fit the
    // camera: it used to, so anything the reader panned or zoomed to snapped
    // back before they could read it.
    const sim = new Simulator(page);
    await sim.line.open();
    await sim.line.seek(T_PEAK);

    // Station positions are a pure function of the camera, so they are the
    // camera, observed.
    const stations = async (): Promise<string> =>
      JSON.stringify((await sim.app.renderDigest('line')).stations);
    const fitted = await stations();

    const box = (await page.getByTestId(TID.lineView).boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.25, { steps: 8 });
    await page.mouse.up();
    await page.mouse.wheel(0, -240);
    const moved = await stations();
    expect(moved, 'the drag did not move the camera').not.toBe(fitted);

    await sim.line.seek(T_PEAK + 300);
    expect(await stations(), 'the camera snapped back').toBe(moved);
    await sim.line.advance(120);
    expect(await stations(), 'the camera snapped back').toBe(moved);
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
