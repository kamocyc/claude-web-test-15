/**
 * Editing the sample: one cell changed in the 時刻表, and the two things that
 * must react — the validation panel and the 運行図表 — both do.
 *
 * Then undo and redo, because an editor whose history is wrong is worse than
 * one with no history at all.
 */

import { expect, test } from '@playwright/test';

import { Simulator } from './pageObjects';
import { TID } from './testids';

interface EditTarget {
  trainId: string;
  stopIndex: number;
  arr: number;
  dep: number;
}

/**
 * Find a stop in the first rendered column that has a real dwell — an arrival
 * and a later departure. That is the shape the diagram draws a horizontal stub
 * for, so removing the dwell is visible in both the validator and the diagram.
 */
async function findDwellingStop(sim: Simulator): Promise<EditTarget> {
  const trainId = (
    (await sim.timetable.columns().first().getAttribute('data-testid')) ?? ''
  ).replace('train-col-', '');
  expect(trainId).not.toBe('');

  for (let stopIndex = 1; stopIndex < 12; stopIndex++) {
    const arr = await sim.timetable.cellSeconds(trainId, stopIndex, 'arr');
    const dep = await sim.timetable.cellSeconds(trainId, stopIndex, 'dep');
    if (arr === undefined || dep === undefined) continue;
    if (dep - arr >= 15) return { trainId, stopIndex, arr, dep };
  }
  throw new Error(`no dwelling stop found on ${trainId}`);
}

function hhmm(sec: number): string {
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`;
}

test.describe('editing the timetable', () => {
  test('a departure time edit reaches the validator, the diagram and history', async ({
    page,
  }) => {
    const sim = new Simulator(page);
    await sim.open();
    await sim.app.loadSample();

    // Show errors only. The sample has ~1000 informational findings; the panel
    // filters are part of the UI under test, so use them.
    await page.getByTestId(TID.problemFilterWarning).click();
    await page.getByTestId(TID.problemFilterInfo).click();
    await expect(page.getByTestId(TID.problemFilterWarning)).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(page.getByTestId(TID.problemEmpty)).toBeVisible();
    expect(await sim.app.errorCount()).toBe(0);

    await sim.timetable.open();
    const target = await findDwellingStop(sim);

    // What the diagram says about this train before the edit. The horizontal
    // dwell stub is a real vertex, so the count is the dwell's fingerprint.
    await sim.diagram.open();
    const pointsBefore = await sim.diagram.pointCount(target.trainId);
    expect(pointsBefore).toBeGreaterThan(0);

    // -- the edit ----------------------------------------------------------
    // Depart a minute BEFORE arriving: physically impossible, so the validator
    // must notice, and the dwell stub must vanish from the diagram.
    await sim.timetable.open();
    const broken = target.arr - 60;
    await sim.timetable.typeTime(target.trainId, target.stopIndex, 'dep', hhmm(broken));
    expect(await sim.timetable.cellSeconds(target.trainId, target.stopIndex, 'dep')).toBe(
      broken - (broken % 60),
    );

    // 1. the validation panel updated
    expect(await sim.app.errorCount()).toBeGreaterThan(0);
    await expect(page.getByTestId(TID.problemEmpty)).toHaveCount(0);
    await expect(sim.app.errorItems()).not.toHaveCount(0);
    await expect(
      page.locator(`[data-testid="${TID.problemItem}"][data-rule-id="time.nonMonotonic"]`),
    ).not.toHaveCount(0);

    // 2. the diagram updated
    await sim.diagram.open();
    expect(await sim.diagram.pointCount(target.trainId)).toBe(pointsBefore - 1);

    // -- undo --------------------------------------------------------------
    await sim.app.undo();
    await sim.timetable.open();
    expect(await sim.timetable.cellSeconds(target.trainId, target.stopIndex, 'dep')).toBe(
      target.dep,
    );
    expect(await sim.app.errorCount()).toBe(0);
    await expect(page.getByTestId(TID.problemEmpty)).toBeVisible();

    await sim.diagram.open();
    expect(await sim.diagram.pointCount(target.trainId)).toBe(pointsBefore);

    // -- redo --------------------------------------------------------------
    await sim.app.redo();
    await sim.timetable.open();
    expect(await sim.timetable.cellSeconds(target.trainId, target.stopIndex, 'dep')).toBe(
      broken - (broken % 60),
    );
    expect(await sim.app.errorCount()).toBeGreaterThan(0);

    // …and back to a sound timetable, which is where an editing session should
    // be able to end.
    await sim.app.undo();
    expect(await sim.app.errorCount()).toBe(0);
    await sim.timetable.open();
    expect(await sim.timetable.cellSeconds(target.trainId, target.stopIndex, 'dep')).toBe(
      target.dep,
    );
  });
});
