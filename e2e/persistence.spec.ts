/**
 * Autosave survives a reload.
 *
 * This is the one spec that runs with `persist=1`: under a plain `?e2e=1` the
 * app deliberately refuses to restore, so that every other spec starts from a
 * known-empty document.
 */

import { expect, test } from '@playwright/test';

import { Simulator } from './pageObjects';
import { STATE_ATTR } from './testids';

const PERSIST = 'e2e=1&persist=1';
const STATION = '保存テスト駅';

test.describe('autosave', () => {
  test('an edit made before a reload is still there afterwards', async ({ page }) => {
    const sim = new Simulator(page);
    await sim.open(PERSIST);

    // A fresh browser context has an empty IndexedDB, so this really is a
    // brand-new project.
    await sim.stations.open();
    await expect(sim.stations.rows).toHaveCount(0);

    await sim.stations.addStation(STATION, 4.2);
    await expect(sim.stations.row(STATION)).toHaveCount(1);

    // Autosave is debounced; the app publishes its state rather than making
    // the test guess how long to wait.
    await expect(page.locator('html')).toHaveAttribute(STATE_ATTR.autosave, 'saved');
    await expect(sim.app.root).toHaveAttribute(STATE_ATTR.autosave, 'saved');
    // 未保存 disappears from the status bar once the document is clean.
    await expect(page.getByText('● 未保存')).toHaveCount(0);

    // -- reload ------------------------------------------------------------
    await page.reload();
    await sim.app.waitReady();

    await sim.stations.open();
    await expect(sim.stations.rows).toHaveCount(1);
    await expect(sim.stations.row(STATION)).toHaveCount(1);
    await expect(sim.stations.row(STATION).getByLabel(`${STATION} の営業キロ`)).toHaveValue(
      '4.2',
    );

    // The restored document is a real document: its 番線 came back too.
    await sim.stations.selectStation(STATION);
    await expect(sim.stations.trackRows).toHaveCount(1);
  });
});
