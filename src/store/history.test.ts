import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import type { ProjectDocument, Train } from '@/domain/model';
import { entityList } from '@/domain/units';
import { TOY, toyProject } from '@/testing/toyProject';

import type { Command } from './commands';
import { MERGE_WINDOW_MS, pushHistory, type HistoryEntry } from './history';
import { useProjectStore } from './projectStore';
import { useUiStore } from './uiStore';

function reset(doc: ProjectDocument = toyProject()): void {
  useProjectStore.setState({ doc, revision: 0, history: [], redoStack: [], dirty: false });
  useUiStore.setState({ selected: [], hovered: undefined, focusTarget: undefined });
}

const store = () => useProjectStore.getState();

beforeEach(() => reset());
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------

describe('pushHistory', () => {
  const entry = (mergeKey: string | undefined, at: number): HistoryEntry => {
    const e: HistoryEntry = {
      label: 'テスト',
      patches: [{ op: 'replace', path: ['a'], value: at }],
      inverse: [{ op: 'replace', path: ['a'], value: at - 1 }],
      scopes: ['trains'],
      selectionBefore: [],
      selectionAfter: [],
      at,
    };
    if (mergeKey !== undefined) e.mergeKey = mergeKey;
    return e;
  };

  it('coalesces consecutive entries with the same merge key inside the window', () => {
    const one = pushHistory([], entry('k', 1000));
    const two = pushHistory(one, entry('k', 1000 + MERGE_WINDOW_MS - 1));
    expect(two).toHaveLength(1);
    expect(two[0]?.patches).toHaveLength(2);
    // The newer inverse must be applied first.
    expect(two[0]?.inverse[0]?.value).toBe(1000 + MERGE_WINDOW_MS - 2);
  });

  it('does not coalesce once the window has passed', () => {
    const one = pushHistory([], entry('k', 1000));
    const two = pushHistory(one, entry('k', 1000 + MERGE_WINDOW_MS + 1));
    expect(two).toHaveLength(2);
  });

  it('never coalesces entries without a merge key', () => {
    const one = pushHistory([], entry(undefined, 1000));
    const two = pushHistory(one, entry(undefined, 1001));
    expect(two).toHaveLength(2);
  });

  it('caps the history at 200 entries', () => {
    let history: HistoryEntry[] = [];
    for (let i = 0; i < 250; i++) history = pushHistory(history, entry(undefined, i));
    expect(history).toHaveLength(200);
    expect(history[history.length - 1]?.at).toBe(249);
  });
});

// ---------------------------------------------------------------------------

describe('undo and redo, per command family', () => {
  const cases: Array<[string, Command, (doc: ProjectDocument) => unknown]> = [
    [
      '駅',
      { type: 'station/update', id: TOY.stationB, patch: { name: 'B改' } },
      (doc) => doc.stations.byId[TOY.stationB]?.name,
    ],
    [
      '番線',
      { type: 'track/update', id: TOY.b1, patch: { canBeOvertaken: true } },
      (doc) => doc.stationTracks.byId[TOY.b1]?.canBeOvertaken,
    ],
    [
      '停車パターン',
      {
        type: 'stopPattern/setEntry',
        patternId: TOY.patLocalDown,
        stationId: TOY.stationB,
        kind: 'none',
      },
      (doc) => doc.stopPatterns.byId[TOY.patLocalDown]?.entries[TOY.stationB],
    ],
    [
      '列車時刻',
      { type: 'train/setStopTime', trainId: TOY.localDown, stopIndex: 1, field: 'arr', value: 1 },
      (doc) => (doc.trains.byId[TOY.localDown] as Train | undefined)?.stops[1]?.arr,
    ],
    [
      '列車削除',
      { type: 'train/remove', trainIds: [TOY.expressDown] },
      (doc) => doc.trains.allIds.length,
    ],
    [
      '運用',
      { type: 'duty/removeLeg', dutyId: TOY.dutyLocal, legIndex: 0 },
      (doc) => doc.duties.byId[TOY.dutyLocal]?.legs.length,
    ],
    [
      '編成',
      { type: 'formation/update', id: TOY.formation1, patch: { cars: 8 } },
      (doc) => doc.formations.byId[TOY.formation1]?.cars,
    ],
    [
      '充当',
      { type: 'assignment/clear', date: '2026-04-06', dutyId: TOY.dutyLocal },
      (doc) => doc.assignments.allIds.length,
    ],
    [
      '番線自動割付',
      { type: 'train/autoAssignTracks' },
      (doc) => JSON.stringify(entityList(doc.trains).map((t) => t.stops.map((s) => s.trackId))),
    ],
    [
      '運用自動組成',
      { type: 'duty/autoAssign', dayTypeId: TOY.dayType },
      (doc) => JSON.stringify(entityList(doc.duties).map((d) => d.legs)),
    ],
  ];

  for (const [name, cmd, read] of cases) {
    it(`${name}: undo restores, redo reapplies`, () => {
      reset();
      const before = read(store().doc);
      store().dispatch(cmd);
      const after = read(store().doc);
      expect(store().history).toHaveLength(1);

      store().undo();
      expect(read(store().doc)).toEqual(before);
      expect(store().history).toHaveLength(0);
      expect(store().redoStack).toHaveLength(1);

      store().redo();
      expect(read(store().doc)).toEqual(after);
      expect(store().redoStack).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------

describe('dispatch bookkeeping', () => {
  it('coalesces rapid edits to the same cell into one undo step', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(10_000);
    store().dispatch({
      type: 'train/setStopTime',
      trainId: TOY.localDown,
      stopIndex: 1,
      field: 'arr',
      value: 100,
    });
    now.mockReturnValue(10_400);
    store().dispatch({
      type: 'train/setStopTime',
      trainId: TOY.localDown,
      stopIndex: 1,
      field: 'arr',
      value: 200,
    });
    expect(store().history).toHaveLength(1);

    store().undo();
    const train = store().doc.trains.byId[TOY.localDown] as Train;
    expect(train.stops[1]?.arr).toBe(8 * 3600 + 90);
    now.mockRestore();
  });

  it('starts a new entry once the merge window has passed', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(10_000);
    store().dispatch({
      type: 'train/setStopTime',
      trainId: TOY.localDown,
      stopIndex: 1,
      field: 'arr',
      value: 100,
    });
    now.mockReturnValue(10_000 + MERGE_WINDOW_MS + 1);
    store().dispatch({
      type: 'train/setStopTime',
      trainId: TOY.localDown,
      stopIndex: 1,
      field: 'arr',
      value: 200,
    });
    expect(store().history).toHaveLength(2);
    now.mockRestore();
  });

  it('a new command invalidates the redo stack', () => {
    store().dispatch({ type: 'station/update', id: TOY.stationB, patch: { name: '一' } });
    store().undo();
    expect(store().redoStack).toHaveLength(1);
    store().dispatch({ type: 'station/update', id: TOY.stationC, patch: { name: '二' } });
    expect(store().redoStack).toHaveLength(0);
  });

  it('undo restores the selection that was active before the edit', async () => {
    useUiStore.getState().setSelected([{ kind: 'station', stationId: TOY.stationA }]);
    store().dispatch({ type: 'station/update', id: TOY.stationB, patch: { name: '一' } });
    // A handler typically selects what it just touched, in the same tick.
    useUiStore.getState().setSelected([{ kind: 'station', stationId: TOY.stationD }]);
    await Promise.resolve();

    store().undo();
    expect(useUiStore.getState().selected).toEqual([{ kind: 'station', stationId: TOY.stationA }]);
    store().redo();
    expect(useUiStore.getState().selected).toEqual([{ kind: 'station', stationId: TOY.stationD }]);
  });

  it('a command that changes nothing does not enter the history', () => {
    store().dispatch({
      type: 'station/update',
      id: 'stn-does-not-exist' as never,
      patch: { name: 'x' },
    });
    expect(store().history).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

const COMMAND_ARB: fc.Arbitrary<Command> = fc.oneof(
  fc
    .record({ name: fc.string({ minLength: 1, maxLength: 6 }) })
    .map((r): Command => ({ type: 'station/update', id: TOY.stationB, patch: { name: r.name } })),
  fc
    .record({ km: fc.integer({ min: -2000, max: 6000 }) })
    .map((r): Command => ({
      type: 'station/update',
      id: TOY.stationC,
      patch: { kmFromOrigin: r.km },
    })),
  fc
    .record({ v: fc.boolean() })
    .map((r): Command => ({ type: 'track/update', id: TOY.b1, patch: { canBeOvertaken: r.v } })),
  fc
    .record({
      index: fc.integer({ min: 0, max: 3 }),
      field: fc.constantFrom<'arr' | 'dep'>('arr', 'dep'),
      value: fc.integer({ min: 0, max: 100_000 }),
    })
    .map((r): Command => ({
      type: 'train/setStopTime',
      trainId: TOY.localDown,
      stopIndex: r.index,
      field: r.field,
      value: r.value,
    })),
  fc
    .record({ delta: fc.integer({ min: -600, max: 600 }) })
    .map((r): Command => ({
      type: 'train/shift',
      trainIds: [TOY.localDown, TOY.expressDown],
      deltaSec: r.delta,
    })),
  fc
    .record({
      index: fc.integer({ min: 0, max: 3 }),
      kind: fc.constantFrom<'stop' | 'pass'>('stop', 'pass'),
    })
    .map((r): Command => ({
      type: 'train/setStopKind',
      trainId: TOY.localDown,
      stopIndex: r.index,
      kind: r.kind,
    })),
  fc
    .record({
      station: fc.constantFrom(TOY.stationA, TOY.stationB, TOY.stationC, TOY.stationD),
      kind: fc.constantFrom<'stop' | 'pass' | 'none'>('stop', 'pass', 'none'),
    })
    .map((r): Command => ({
      type: 'stopPattern/setEntry',
      patternId: TOY.patExpressDown,
      stationId: r.station,
      kind: r.kind,
    })),
  fc.constant<Command>({ type: 'train/autoAssignTracks' }),
  fc.constant<Command>({ type: 'train/recomputeTimes', trainId: TOY.localDown }),
  fc.constant<Command>({ type: 'link/rebuild' }),
  fc.constant<Command>({ type: 'station/reorderByKm' }),
  fc.constant<Command>({ type: 'duty/autoAssign', dayTypeId: TOY.dayType }),
  fc.constant<Command>({ type: 'assignment/autoFill', date: '2026-04-06' }),
  fc.constant<Command>({ type: 'duty/sortLegsByTime', dutyId: TOY.dutyLocal }),
  fc
    .record({ cars: fc.integer({ min: 4, max: 10 }) })
    .map((r): Command => ({ type: 'formation/update', id: TOY.formation1, patch: { cars: r.cars } })),
  fc
    .record({ legIndex: fc.integer({ min: 0, max: 3 }) })
    .map((r): Command => ({
      type: 'duty/removeLeg',
      dutyId: TOY.dutyLocal,
      legIndex: r.legIndex,
    })),
  fc.constant<Command>({ type: 'train/remove', trainIds: [TOY.depotIn] }),
);

describe('undo is a true inverse', () => {
  it('50 random commands followed by 50 undos restores the original document', () => {
    fc.assert(
      fc.property(fc.array(COMMAND_ARB, { minLength: 50, maxLength: 50 }), (commands) => {
        const original = toyProject();
        reset(structuredClone(original));

        for (const cmd of commands) store().dispatch(cmd);
        for (let i = 0; i < 50; i++) store().undo();

        expect(store().history).toHaveLength(0);
        expect(store().doc).toEqual(original);
      }),
      { numRuns: 30 },
    );
  });
});
