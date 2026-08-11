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
  useUiStore.setState({
    selected: [],
    hovered: undefined,
    focusTarget: undefined,
    timetableSeconds: false,
  });
}

afterEach(cleanup);

const localTrain = (): Train => useProjectStore.getState().doc.trains.byId[TOY.localDown] as Train;

describe('TimetableScreen keyboard editing', () => {
  beforeEach(reset);

  it('writes 07:43 when 0743 is typed and Enter is pressed', () => {
    render(<TimetableScreen />);
    const cell = screen.getByTestId(TID.timeCell(TOY.localDown, 1, 'arr'));
    fireEvent.focus(cell);
    fireEvent.change(cell, { target: { value: '0743' } });
    fireEvent.keyDown(cell, { key: 'Enter' });

    expect(localTrain().stops[1]?.arr).toBe(7 * 3600 + 43 * 60);
    expect(useProjectStore.getState().history).toHaveLength(1);
  });

  it('accepts a colon form and full-width digits', () => {
    render(<TimetableScreen />);
    const cell = screen.getByTestId(TID.timeCell(TOY.localDown, 1, 'dep'));
    fireEvent.change(cell, { target: { value: '２５：０５' } });
    fireEvent.keyDown(cell, { key: 'Tab' });
    expect(localTrain().stops[1]?.dep).toBe(25 * 3600 + 5 * 60);
  });

  it('Escape cancels the edit and leaves the document untouched', () => {
    render(<TimetableScreen />);
    const before = localTrain().stops[1]?.arr;
    const cell = screen.getByTestId(TID.timeCell(TOY.localDown, 1, 'arr'));
    fireEvent.change(cell, { target: { value: '0102' } });
    fireEvent.keyDown(cell, { key: 'Escape' });

    expect(localTrain().stops[1]?.arr).toBe(before);
    expect(useProjectStore.getState().history).toHaveLength(0);
    expect((screen.getByTestId(TID.timeCell(TOY.localDown, 1, 'arr')) as HTMLInputElement).value)
      .toBe('08:01');
  });

  it('an unparseable value is rejected rather than written', () => {
    render(<TimetableScreen />);
    const before = localTrain().stops[1]?.arr;
    const cell = screen.getByTestId(TID.timeCell(TOY.localDown, 1, 'arr'));
    fireEvent.change(cell, { target: { value: 'ちがう' } });
    fireEvent.keyDown(cell, { key: 'Enter' });
    expect(localTrain().stops[1]?.arr).toBe(before);
  });

  it('an empty value clears the cell', () => {
    render(<TimetableScreen />);
    const cell = screen.getByTestId(TID.timeCell(TOY.localDown, 1, 'arr'));
    fireEvent.change(cell, { target: { value: '' } });
    fireEvent.keyDown(cell, { key: 'Enter' });
    expect(localTrain().stops[1]?.arr).toBeUndefined();
  });

  it('arrow keys move the cell cursor without editing anything', () => {
    render(<TimetableScreen />);
    const cell = screen.getByTestId(TID.timeCell(TOY.localDown, 1, 'arr'));
    fireEvent.focus(cell);
    fireEvent.keyDown(cell, { key: 'ArrowDown' });
    fireEvent.keyDown(cell, { key: 'ArrowRight' });
    expect(useProjectStore.getState().history).toHaveLength(0);
  });

  it('ArrowDown moves focus from 着 to 発 at the same station', async () => {
    render(<TimetableScreen />);
    const arr = screen.getByTestId(TID.timeCell(TOY.localDown, 1, 'arr'));
    fireEvent.focus(arr);
    fireEvent.keyDown(arr, { key: 'ArrowDown' });
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(document.activeElement).toBe(screen.getByTestId(TID.timeCell(TOY.localDown, 1, 'dep')));
  });

  it('ArrowRight moves focus to the next train at the same row', async () => {
    render(<TimetableScreen />);
    const arr = screen.getByTestId(TID.timeCell(TOY.localDown, 2, 'arr'));
    fireEvent.focus(arr);
    fireEvent.keyDown(arr, { key: 'ArrowRight' });
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    // The express is the next column and it also calls at station C (index 2).
    expect(document.activeElement).toBe(
      screen.getByTestId(TID.timeCell(TOY.expressDown, 2, 'arr')),
    );
  });

  it('the 番線 cell writes the chosen track', () => {
    render(<TimetableScreen />);
    const cell = screen.getByTestId(TID.trackCell(TOY.localDown, 2));
    fireEvent.change(cell, { target: { value: TOY.c1 } });
    expect(localTrain().stops[2]?.trackId).toBe(TOY.c1);
  });
});

describe('列車を追加', () => {
  beforeEach(reset);

  it('creates a train from a pattern with times derived from the origin departure', () => {
    render(<TimetableScreen />);
    fireEvent.change(screen.getByTestId(TID.trainNumberInput), { target: { value: '999' } });
    fireEvent.change(screen.getByTestId(TID.trainPatternSelect), {
      target: { value: TOY.patLocalDown },
    });
    fireEvent.change(screen.getByTestId(TID.trainOriginDepInput), { target: { value: '0930' } });
    fireEvent.click(screen.getByTestId(TID.trainSubmit));

    const doc = useProjectStore.getState().doc;
    const created = Object.values(doc.trains.byId).find((t) => t.number === '999');
    expect(created).toBeDefined();
    expect(created?.stops).toHaveLength(4);
    expect(created?.stops[0]?.dep).toBe(9 * 3600 + 30 * 60);
    expect(created?.stops[0]?.arr).toBeUndefined();
    expect(created?.stops[3]?.arr).toBeGreaterThan(9 * 3600 + 30 * 60);
    expect(created?.stops[3]?.dep).toBeUndefined();
    // One command, so one Ctrl+Z removes the whole train.
    expect(useProjectStore.getState().history).toHaveLength(1);
  });

  it('refuses an unparseable origin departure', () => {
    render(<TimetableScreen />);
    fireEvent.change(screen.getByTestId(TID.trainOriginDepInput), { target: { value: 'zz' } });
    fireEvent.click(screen.getByTestId(TID.trainSubmit));
    expect(useProjectStore.getState().history).toHaveLength(0);
    expect(screen.getByText(/始発時刻を/)).toBeTruthy();
  });
});

describe('秒表示と方向', () => {
  beforeEach(reset);

  it('shows minutes by default and seconds when asked', () => {
    render(<TimetableScreen />);
    const cell = () =>
      screen.getByTestId(TID.timeCell(TOY.localDown, 2, 'arr')) as HTMLInputElement;
    // 各101 arrives at C駅 at 08:04:00 — but the interesting one is a time that
    // is not on the minute, so give it one.
    expect(cell().value).toBe('08:04');

    fireEvent.click(screen.getByTestId(TID.timetableSeconds));
    expect(cell().value).toBe('08:04:00');
  });

  it('still writes what is typed, seconds and all', () => {
    render(<TimetableScreen />);
    fireEvent.click(screen.getByTestId(TID.timetableSeconds));
    const cell = screen.getByTestId(TID.timeCell(TOY.localDown, 1, 'arr'));
    fireEvent.change(cell, { target: { value: '074330' } });
    fireEvent.keyDown(cell, { key: 'Enter' });
    expect(localTrain().stops[1]?.arr).toBe(7 * 3600 + 43 * 60 + 30);
    expect(
      (screen.getByTestId(TID.timeCell(TOY.localDown, 1, 'arr')) as HTMLInputElement).value,
    ).toBe('07:43:30');
  });

  it('marks each column with the direction its train runs', () => {
    render(<TimetableScreen />);
    const down = screen.getByTestId(TID.trainHeaderDirection(TOY.localDown));
    expect(down.getAttribute('data-direction')).toBe('down');
    expect(down.textContent).toBe('▼');
    expect(down.getAttribute('title')).toContain('下り');

    const up = screen.getByTestId(TID.trainHeaderDirection(TOY.depotIn));
    expect(up.getAttribute('data-direction')).toBe('up');
    expect(up.textContent).toBe('▲');
    expect(up.getAttribute('title')).toContain('上り');
  });
});
