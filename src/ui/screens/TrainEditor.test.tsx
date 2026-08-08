/**
 * Renumbering, re-typing and deleting a train — the three edits that used to
 * require re-importing the JSON.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TID } from '@e2e/testids';

import type { Train } from '@/domain/model';
import { useProjectStore } from '@/store/projectStore';
import { useUiStore } from '@/store/uiStore';
import { TOY, toyProject } from '@/testing/toyProject';

import { TimetableScreen } from './TimetableScreen';

function reset(): void {
  useProjectStore.setState({
    doc: toyProject(),
    revision: 0,
    history: [],
    redoStack: [],
    dirty: false,
  });
  useUiStore.setState({ selected: [], hovered: undefined, focusTarget: undefined });
}

afterEach(cleanup);

const doc = () => useProjectStore.getState().doc;
const localTrain = (): Train => doc().trains.byId[TOY.localDown] as Train;

describe('列車の属性編集', () => {
  beforeEach(reset);

  it('renumbers the train the cursor is on', () => {
    render(<TimetableScreen />);
    fireEvent.change(screen.getByTestId(TID.trainEditNumber), { target: { value: '1701' } });
    expect(localTrain().number).toBe('1701');
  });

  it('changes the 種別', () => {
    render(<TimetableScreen />);
    fireEvent.change(screen.getByTestId(TID.trainEditType), { target: { value: TOY.typeExpress } });
    expect(localTrain().typeId).toBe(TOY.typeExpress);
  });

  it('changes the direction', () => {
    render(<TimetableScreen />);
    fireEvent.change(screen.getByTestId(TID.trainEditDirection), { target: { value: 'up' } });
    expect(localTrain().direction).toBe('up');
  });

  it('sets and then clears 最小両数', () => {
    render(<TimetableScreen />);
    fireEvent.change(screen.getByTestId(TID.trainEditMinCars), { target: { value: '8' } });
    expect(localTrain().minCars).toBe(8);
    fireEvent.change(screen.getByTestId(TID.trainEditMinCars), { target: { value: '' } });
    expect(localTrain().minCars).toBeUndefined();
  });

  it('toggles the train off a day type', () => {
    render(<TimetableScreen />);
    fireEvent.click(screen.getByTestId(TID.trainEditDayType(TOY.dayType)));
    expect(localTrain().dayTypeIds).toEqual([]);
  });

  it('shifts every time of the train by the given number of minutes', () => {
    render(<TimetableScreen />);
    const before = localTrain().stops.map((s) => [s.arr, s.dep]);
    fireEvent.change(screen.getByTestId(TID.trainShiftMinutes), { target: { value: '-3' } });
    fireEvent.click(screen.getByTestId(TID.trainShiftApply));

    localTrain().stops.forEach((stop, i) => {
      const [arr, dep] = before[i] as [number | undefined, number | undefined];
      expect(stop.arr).toBe(arr === undefined ? undefined : arr - 180);
      expect(stop.dep).toBe(dep === undefined ? undefined : dep - 180);
    });
    expect(useProjectStore.getState().history[0]?.label).toBe('列車を時刻移動');
  });

  it('does nothing when the shift is blank', () => {
    render(<TimetableScreen />);
    fireEvent.change(screen.getByTestId(TID.trainShiftMinutes), { target: { value: '' } });
    fireEvent.click(screen.getByTestId(TID.trainShiftApply));
    expect(useProjectStore.getState().history).toHaveLength(0);
  });

  it('loads the clicked column into the editor', () => {
    render(<TimetableScreen />);
    fireEvent.click(screen.getByTestId(TID.trainHeaderNumber(TOY.expressDown)));
    expect((screen.getByTestId(TID.trainEditNumber) as HTMLInputElement).value).toBe('201');
  });
});

describe('列車の削除', () => {
  beforeEach(reset);

  it('asks first, and lists what depends on the train', () => {
    render(<TimetableScreen />);
    fireEvent.click(screen.getByTestId(TID.trainDelete(TOY.localDown)));
    const list = screen.getByTestId(TID.trainDeleteDependants);
    // The local is a leg of 運用 01.
    expect(list.textContent).toContain('運用 01');
    expect(doc().trains.byId[TOY.localDown]).toBeDefined();
  });

  it('cancelling leaves the document untouched', () => {
    render(<TimetableScreen />);
    fireEvent.click(screen.getByTestId(TID.trainDelete(TOY.localDown)));
    fireEvent.click(screen.getByTestId(TID.trainDeleteCancel));
    expect(doc().trains.byId[TOY.localDown]).toBeDefined();
    expect(useProjectStore.getState().history).toHaveLength(0);
  });

  it('confirming removes the train and every reference to it', () => {
    render(<TimetableScreen />);
    // The express is declared as the local's overtaking train.
    expect(localTrain().stops[2]?.overtakenBy).toEqual([TOY.expressDown]);

    fireEvent.click(screen.getByTestId(TID.trainDelete(TOY.expressDown)));
    fireEvent.click(screen.getByTestId(TID.trainDeleteConfirm));

    expect(doc().trains.byId[TOY.expressDown]).toBeUndefined();
    expect(localTrain().stops[2]?.overtakenBy).toBeUndefined();
    expect(doc().duties.byId[TOY.dutyExpress]?.legs).toEqual([]);
    expect(useProjectStore.getState().history).toHaveLength(1);
  });

  it('warns that a 待避 declaration will be dropped', () => {
    render(<TimetableScreen />);
    fireEvent.click(screen.getByTestId(TID.trainDelete(TOY.expressDown)));
    expect(screen.getByTestId(TID.trainDeleteDependants).textContent).toContain('待避/接続');
  });
});
