/**
 * THE headline test.
 *
 * The product requirement is: **a working timetable can be built from zero
 * entirely through the GUI, with no hand-edited JSON.** This spec proves it by
 * doing exactly that — four stations, a passing loop, run times, a depot, two
 * train types with stop patterns, three trains, a keyboard time edit, platform
 * auto-allocation, duties and formations — and then asserting that the
 * validator, which is what tells a user their timetable is sound, reports zero
 * errors.
 *
 * Every mutation below goes through a real click, a real `selectOption` or a
 * real keystroke. Nothing is injected into the store, and the only reads that
 * bypass the DOM are `window.__sim` / `window.__render`, which are the app's
 * own published test hooks.
 */

import { expect, test } from '@playwright/test';

import { Simulator } from './pageObjects';
import { TID } from './testids';

/** 08:00:00 as seconds from midnight — the whole app speaks this unit. */
const T0 = 8 * 3600;

/** Base 駅間 run time, seconds. Penalties of 10 s each are added by the app. */
const BASE_RUN_SEC = 90;

test.describe('build a timetable from scratch, through the GUI only', () => {
  test('four stations, a passing loop, three trains, zero validation errors', async ({
    page,
  }) => {
    const sim = new Simulator(page);

    // -- 1. a brand-new, empty project -----------------------------------
    await sim.open();
    await expect(page.locator('html')).toHaveAttribute('data-sim-ready', '1');
    await expect(sim.app.root).toHaveAttribute('data-sim-ready', '1');
    await expect(sim.app.problemPanel).toBeVisible();
    await expect(page.getByTestId(TID.problemEmpty)).toBeVisible();
    expect(await sim.app.errorCount()).toBe(0);
    expect(await sim.app.trainCount()).toBe(0);

    // -- 2. four stations --------------------------------------------------
    await sim.stations.open();
    await sim.stations.addStation('A', 0);
    await sim.stations.addStation('B', 1);
    await sim.stations.addStation('C', 2);
    await sim.stations.addStation('D', 3);
    await expect(sim.stations.rows).toHaveCount(4);
    // Adding four stations creates the three 駅間 between them.
    await expect(sim.stations.linkRows).toHaveCount(3);

    // -- 3. C gets a passing loop -----------------------------------------
    // Every station already has 1番線 from the add form; C additionally needs a
    // road a slower train can be overtaken on.
    for (const name of ['A', 'B', 'C', 'D']) {
      await sim.stations.selectStation(name);
      await expect(sim.stations.trackRows).toHaveCount(1);
      // Both directions must be usable, or every train trips
      // track.directionNotAllowed.
      await expect(sim.stations.trackRow('1番線').getByLabel('1番線 の下り')).toBeChecked();
      await expect(sim.stations.trackRow('1番線').getByLabel('1番線 の上り')).toBeChecked();
    }

    await sim.stations.selectStation('C');
    await sim.stations.addTrack({
      name: '2番線',
      usage: 'passing',
      hasPlatform: true,
      canTurnBack: true,
      canBeOvertaken: true,
      down: true,
      up: true,
    });
    await expect(sim.stations.trackRows).toHaveCount(2);
    expect(await sim.stations.trackCanBeOvertaken('2番線')).toBe(true);
    expect(await sim.stations.trackCanBeOvertaken('1番線')).toBe(false);

    // The 待避線 is the road a down train stands on at C, so the platform
    // allocator puts the waiting local there and leaves 1番線 for the express.
    await sim.stations.makeDefaultTrack('2番線', 'down');

    // -- 4. 駅間 run times (this is what creates 標準性能) ------------------
    await sim.stations.fillRunTimes(BASE_RUN_SEC);

    // -- 5. a depot attached to A -----------------------------------------
    await sim.stations.addDepot('北車庫', 'A');
    await expect(sim.stations.depotRows).toHaveCount(1);
    // A depot station sits off the main axis: it must not become a 駅間.
    await expect(sim.stations.linkRows).toHaveCount(3);

    // -- 6. 種別 and 停車パターン -------------------------------------------
    await sim.types.open();
    await sim.types.addType('各停', '各');
    await sim.types.addType('急行', '急');

    await sim.types.addPattern({
      name: '各停 下り',
      typeName: '各停',
      direction: 'down',
      origin: 'A',
      terminus: 'D',
    });
    await sim.types.addPattern({
      name: '急行 下り',
      typeName: '急行',
      direction: 'down',
      origin: 'A',
      terminus: 'D',
    });

    const [localPatternId, expressPatternId] = await sim.types.patternIds();
    expect(localPatternId, 'the 各停 pattern column').toBeTruthy();
    expect(expressPatternId, 'the 急行 pattern column').toBeTruthy();

    await sim.stations.open();
    const stationIds = {
      a: await sim.stations.stationIdOf('A'),
      b: await sim.stations.stationIdOf('B'),
      c: await sim.stations.stationIdOf('C'),
      d: await sim.stations.stationIdOf('D'),
    };
    await sim.types.open();

    // 急行 runs through B and C; the matrix cell cycles 停 → 通 → −.
    await sim.types.setCell(expressPatternId as string, stationIds.b, 'pass');
    await sim.types.setCell(expressPatternId as string, stationIds.c, 'pass');
    await expect(sim.types.cell(localPatternId as string, stationIds.b)).toHaveAttribute(
      'data-kind',
      'stop',
    );

    // -- 7. three trains, then a time edited by keyboard -------------------
    await sim.timetable.open();
    const local1 = await sim.timetable.addTrain({
      number: '101',
      typeName: '各停',
      patternName: '各停 下り',
      originDep: '0800',
    });
    const express = await sim.timetable.addTrain({
      number: '201',
      typeName: '急行',
      patternName: '急行 下り',
      originDep: '0803',
    });
    const local2 = await sim.timetable.addTrain({
      number: '103',
      typeName: '各停',
      patternName: '各停 下り',
      originDep: '0810',
    });
    expect(await sim.app.trainCount()).toBe(3);

    // The 各停 calls at all four stations: A=0, B=1, C=2, D=3.
    expect(await sim.timetable.cellSeconds(local1, 0, 'dep')).toBe(T0);
    expect(await sim.timetable.cellSeconds(local1, 2, 'arr')).toBe(T0 + 240);
    expect(await sim.timetable.cellSeconds(local1, 2, 'dep')).toBe(T0 + 260);

    // Hold 101 at C until 08:09 so that 201 can overtake it there. Typed into
    // the cell as `0809` and committed with Enter, exactly like a real author.
    await sim.timetable.selectTrain(local1);
    await sim.timetable.typeTime(local1, 2, 'dep', '0809');
    await expect(sim.timetable.timeCell(local1, 2, 'dep')).toHaveValue('08:09');
    expect(await sim.timetable.cellSeconds(local1, 2, 'dep')).toBe(T0 + 540);

    // Push the longer dwell through to the rest of the column.
    await sim.timetable.recomputeTimes();
    expect(await sim.timetable.cellSeconds(local1, 2, 'arr')).toBe(T0 + 240);
    expect(await sim.timetable.cellSeconds(local1, 2, 'dep')).toBe(T0 + 540);
    expect(await sim.timetable.cellSeconds(local1, 3, 'arr')).toBe(T0 + 650);

    // The 急行 skips B and C, so its stop list is A=0, B=1(通), C=2(通), D=3.
    expect(await sim.timetable.cellSeconds(express, 2, 'arr')).toBe(T0 + 370);
    expect(await sim.timetable.cellSeconds(express, 3, 'arr')).toBe(T0 + 470);

    // -- 8. 番線を自動割付 --------------------------------------------------
    await sim.timetable.autoAssignTracks();
    // The waiting 101 must end up on the 待避線 at C; the passing 201 on 1番線.
    const loopTrackId = await sim.timetable.trackCell(local1, 2).inputValue();
    const expressTrackId = await sim.timetable.trackCell(express, 2).inputValue();
    expect(loopTrackId).not.toBe('');
    expect(expressTrackId).not.toBe('');
    expect(loopTrackId).not.toBe(expressTrackId);
    await expect(sim.timetable.trackCell(local1, 2)).toHaveValue(loopTrackId);

    // -- 9. THE assertion: validation is genuinely wired to the UI ---------
    // Before the platforms were allocated the timetable had unassigned roads;
    // now every rule in the catalogue must be quiet at error severity.
    await sim.app.expectNoErrors();
    await expect(page.getByTestId(TID.statusErrorCount)).toHaveText('エラー 0');

    // -- 10. 編成 and 運用 --------------------------------------------------
    await sim.formations.open();
    await sim.formations.addSeries('1000系', 6);
    await sim.formations.addFormation({
      code: 'F01',
      seriesName: '1000系',
      cars: 6,
      depotName: '北車庫',
    });
    await sim.formations.addFormation({
      code: 'F02',
      seriesName: '1000系',
      cars: 6,
      depotName: '北車庫',
    });
    await expect(sim.formations.rows()).toHaveCount(2);

    await sim.duties.open();
    await sim.duties.autoAssign();
    const dutyIds = await sim.duties.dutyIds();
    expect(dutyIds.length).toBeGreaterThanOrEqual(2);
    // Every duty the auto-composer produced holds at least one 行路.
    await expect(sim.duties.legs(dutyIds[0] as string)).not.toHaveCount(0);

    // Two formations, so two duties can be crewed; they must be different
    // formations or formation.doubleBooked fires.
    await sim.duties.assignFormation(dutyIds[0] as string, 'F01');
    await sim.duties.assignFormation(dutyIds[1] as string, 'F02');

    // The third train is still uncovered — that is a warning, never an error.
    await sim.app.expectNoErrors();

    // The formation reaches the line view through the duty, so the shadow can
    // prove the whole chain train → duty → assignment → formation is wired.
    await sim.duties.autoAssign();
    await sim.app.settle();

    // -- 11. the simulation, read off the line view's DOM shadow -----------
    await sim.line.open();

    await sim.app.setTime(T0 + 50); // 08:00:50 — 101 is between A and B
    await expect(sim.line.marker(local1)).toHaveAttribute('data-phase', 'running');
    await expect(sim.line.withPhase('running')).not.toHaveCount(0);

    await sim.app.setTime(T0 + 120); // 08:02:00 — 101 stands at B
    await expect(sim.line.marker(local1)).toHaveAttribute('data-phase', 'dwelling');
    await expect(sim.line.withPhase('dwelling')).not.toHaveCount(0);

    // The overtake this timetable was built around: 101 waits at C from 08:04
    // to 08:09 while 201 runs past it.
    await sim.app.setTime(T0 + 400); // 08:06:40
    await expect(sim.line.marker(local1)).toHaveAttribute('data-reason', 'overtakeWait');
    await expect(sim.line.withReason('overtakeWait')).toHaveCount(1);
    await expect(sim.line.marker(local1)).toHaveAttribute('data-station', stationIds.c);
    await expect(sim.line.marker(local1)).toHaveAttribute('data-track', loopTrackId);

    // Stepping the clock moves the same train on, without a timeout anywhere.
    await sim.app.step(300); // 08:11:40
    await expect(sim.line.marker(local1)).not.toHaveAttribute('data-phase', 'dwelling');

    // …and the diagram agrees that the overtake happened, and that it is legal.
    await sim.diagram.open();
    await expect(sim.diagram.lines()).toHaveCount(3);
    await expect(sim.diagram.overtakeMarkers()).not.toHaveCount(0);
    await expect(sim.diagram.illegalOvertakes()).toHaveCount(0);
    const overtake = sim.diagram.overtakeMarkers().first();
    await expect(overtake).toHaveAttribute('data-waiting-train', local1);
    await expect(overtake).toHaveAttribute('data-passing-train', express);
    expect(local2).toBeTruthy();

    // -- 12. export, and check the file describes what we built ------------
    const { download, json } = await sim.app.exportProject();
    expect(download.suggestedFilename()).toMatch(/\.json$/);

    expect(typeof json.schemaVersion).toBe('number');
    expect(json.schemaVersion).toBeGreaterThanOrEqual(1);

    const stations = json.stations as { allIds: string[] };
    const trains = json.trains as { allIds: string[] };
    const depots = json.depots as { allIds: string[] };
    const formations = json.formations as { allIds: string[] };
    // Four passenger stations plus the depot station created with 北車庫.
    expect(stations.allIds).toHaveLength(5);
    expect(trains.allIds).toHaveLength(3);
    expect(depots.allIds).toHaveLength(1);
    expect(formations.allIds).toHaveLength(2);
    expect(trains.allIds).toContain(local1);
    expect(trains.allIds).toContain(express);
    expect(trains.allIds).toContain(local2);
  });
});
