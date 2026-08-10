/**
 * A complete scene for developing and testing the render stream.
 *
 * This used to hand-build timelines and runtimes because `src/engine/**` was
 * still a stub. It is not any more, so the fixture is now the **real engine
 * over the toy document** — `buildIndex` + `snapshotAt`, memoized. A second
 * implementation of the engine living in the test fixtures is exactly how the
 * draw code ends up being verified against phases the engine never produces.
 *
 * The snapshot is taken at **08:05:00**, chosen because at that instant the
 * toy timetable has one of each interesting state:
 *
 *   - 各 101 is *dwelling at C on the 待避線* waiting to be passed (08:04→08:08)
 *   - 急 201 is *running* B→C and will pass it at 08:06
 *   - 回8001 berthed at A at 07:52 and its stock left as 各 101 at 08:00, so by
 *     08:05 it is *finished*
 *   - 回8002 has not started (pending — and is therefore never drawn)
 */

import type { ProjectDocument } from '@/domain/model';
import type { Sec } from '@/domain/units';
import { buildIndex } from '@/engine/buildIndex';
import { snapshotAt } from '@/engine/snapshot';
import type { TimetableIndex } from '@/engine/types';
import { TOY, toyProject } from '@/testing/toyProject';
import type { RenderScene } from '../scene';

const H = 3600;
const M = 60;

/** 08:05:00 — see the file header. */
export const FIXTURE_T: Sec = 8 * H + 5 * M;

let cachedDoc: ProjectDocument | undefined;
let cachedIndex: TimetableIndex | undefined;

export function sampleDoc(): ProjectDocument {
  cachedDoc ??= toyProject();
  return cachedDoc;
}

export function sampleIndex(): TimetableIndex {
  cachedIndex ??= buildIndex(sampleDoc());
  return cachedIndex;
}

/** The full scene at `FIXTURE_T` (or any other instant). */
export function sampleScene(t: Sec = FIXTURE_T): RenderScene {
  const index = sampleIndex();
  return {
    doc: index.doc,
    index,
    t,
    snapshot: snapshotAt(index, t),
    generation: 1,
  };
}

/**
 * A variant whose C 1番線 is double-booked, so the yard chart's conflict
 * rendering has something to show.
 */
export function sampleSceneWithYardConflict(t: Sec = FIXTURE_T): RenderScene {
  const scene = sampleScene(t);
  const index: TimetableIndex = {
    ...scene.index,
    trackIntervals: new Map(scene.index.trackIntervals),
  };
  const existing = index.trackIntervals.get(TOY.c1) ?? [];
  const clash = existing[0];
  if (clash) {
    index.trackIntervals.set(TOY.c1, [
      ...existing,
      {
        ...clash,
        trainId: TOY.localDown,
        from: clash.from - 30,
        to: clash.to + 120,
        bookedFrom: clash.bookedFrom - 30,
        bookedTo: clash.bookedTo + 120,
      },
    ]);
  }
  return { ...scene, index, generation: scene.generation + 1 };
}

/**
 * A variant where 運用 01 is moved across D駅 — arrival on 1番線, then standing
 * on 2番線 — so the yard chart has an 入換 to draw.
 */
export function sampleSceneWithShunt(t: Sec = FIXTURE_T): RenderScene {
  const scene = sampleScene(t);
  const trackIntervals = new Map(scene.index.trackIntervals);
  trackIntervals.set(TOY.d1, [
    {
      trackId: TOY.d1,
      stationId: TOY.stationD,
      trainId: TOY.localDown,
      from: 8 * H + 10 * M,
      to: 8 * H + 12 * M,
      bookedFrom: 8 * H + 10 * M + 30,
      bookedTo: 8 * H + 11 * M + 30,
    },
  ]);
  trackIntervals.set(TOY.d2, [
    {
      trackId: TOY.d2,
      stationId: TOY.stationD,
      trainId: TOY.depotIn,
      from: 8 * H + 12 * M,
      to: 8 * H + 20 * M,
      bookedFrom: 8 * H + 12 * M + 30,
      bookedTo: 8 * H + 19 * M,
    },
  ]);
  const index: TimetableIndex = { ...scene.index, trackIntervals };
  return { ...scene, index, generation: scene.generation + 1 };
}

/** Drop the memoized document — for tests that mutate it. */
export function resetSampleScene(): void {
  cachedDoc = undefined;
  cachedIndex = undefined;
}
