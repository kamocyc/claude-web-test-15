/**
 * Screenshots for human review.
 *
 * Artefacts, not assertions: nothing here compares pixels. The PNGs land in
 * `/tmp/shots/` — deliberately outside the repository — so a reviewer can look
 * at what the app actually draws without the suite ever depending on it.
 *
 * Under `?e2e=1` the shared rAF loop is never installed, so a canvas only
 * paints when `window.__render.digest()` asks it to. `sim.app.paint(view)` is
 * that ask; without it the screenshots would be of blank canvases.
 */

import { mkdir } from 'node:fs/promises';

import { expect, test, type Locator } from '@playwright/test';

import { Simulator } from './pageObjects';

const SHOTS = '/tmp/shots';
const T_PEAK = 8 * 3600;

/** Put a screen's own scroll container back at the top before shooting it. */
async function toTop(target: Locator): Promise<void> {
  await target.evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
  });
}

test.describe('screenshots', () => {
  test('render every major screen of the sample to /tmp/shots', async ({ page }) => {
    await mkdir(SHOTS, { recursive: true });

    const sim = new Simulator(page);
    await sim.open();
    await sim.app.loadSample();
    // The problem list is 1000 rows tall on the sample; collapsed, the screens
    // themselves get the space a reviewer wants to look at.
    await sim.app.setProblemPanelOpen(false);

    // -- 線区ビュー, morning peak -------------------------------------------
    await sim.line.open();
    await sim.line.seek(T_PEAK);
    await sim.app.paint('line');
    await expect(sim.line.markers()).not.toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/line-view-morning-peak.png` });

    // -- 運行図表, zoomed onto the 旗の台 待避 region at the peak -------------
    await sim.diagram.open();
    await sim.app.paint('diagram');
    await expect(sim.diagram.overtakeMarkers()).not.toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/diagram-full-day.png` });

    const hatanodai = await sim.stationIdByName('旗の台');
    await sim.diagram.open();
    await sim.diagram.zoomAround(hatanodai);
    await page.screenshot({ path: `${SHOTS}/diagram-hatanodai-overtakes.png` });

    // -- 構内ダイヤ ----------------------------------------------------------
    await sim.stations.open();
    for (const [station, file] of [
      ['大井町', 'yard-oimachi.png'],
      ['旗の台', 'yard-hatanodai.png'],
    ] as const) {
      await sim.stations.selectStation(station);
      await expect(sim.stations.yardChart).toBeVisible();
      await sim.stations.yardChart.evaluate((el) => {
        el.scrollIntoView({ block: 'end' });
      });
      await page.screenshot({ path: `${SHOTS}/${file}` });
    }

    // -- 時刻表 --------------------------------------------------------------
    await sim.timetable.open();
    await expect(sim.timetable.grid).toBeVisible();
    await toTop(sim.timetable.grid);
    await page.screenshot({ path: `${SHOTS}/timetable-grid.png` });

    // -- 行路表 --------------------------------------------------------------
    await sim.crew.open();
    await expect(sim.crew.chart).toBeVisible();
    await toTop(sim.crew.chart);
    await page.screenshot({ path: `${SHOTS}/crew-chart.png` });

    // -- 運用 ----------------------------------------------------------------
    await sim.duties.open();
    await expect(sim.duties.board).toBeVisible();
    await toTop(sim.duties.board);
    await page.screenshot({ path: `${SHOTS}/duty-board.png` });

    // -- 検査 ----------------------------------------------------------------
    await sim.inspections.open();
    await expect(sim.inspections.ruleList).toBeVisible();
    await toTop(sim.inspections.ruleList);
    await page.screenshot({ path: `${SHOTS}/inspections.png` });
  });
});
