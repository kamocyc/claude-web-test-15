import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TID } from '@e2e/testids';

import { entityList } from '@/domain/units';
import { useProjectStore } from '@/store/projectStore';
import { useUiStore } from '@/store/uiStore';
import { TOY, toyProject } from '@/testing/toyProject';

import { TypesScreen } from './TypesScreen';

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

const entryAt = (patternId: string, stationId: string): string | undefined =>
  useProjectStore.getState().doc.stopPatterns.byId[patternId]?.entries[stationId];

describe('stop pattern matrix', () => {
  beforeEach(reset);

  it('cycles a cell 停 → 通 → − → 停', () => {
    render(<TypesScreen />);
    const cell = () => screen.getByTestId(TID.patternCell(TOY.patLocalDown, TOY.stationB));

    expect(entryAt(TOY.patLocalDown, TOY.stationB)).toBe('stop');
    expect(cell().textContent).toBe('停');

    fireEvent.click(cell());
    expect(entryAt(TOY.patLocalDown, TOY.stationB)).toBe('pass');
    expect(cell().textContent).toBe('通');

    fireEvent.click(cell());
    expect(entryAt(TOY.patLocalDown, TOY.stationB)).toBeUndefined();
    expect(cell().textContent).toBe('−');

    fireEvent.click(cell());
    expect(entryAt(TOY.patLocalDown, TOY.stationB)).toBe('stop');
  });

  it('each click is its own undo step', () => {
    render(<TypesScreen />);
    const cell = screen.getByTestId(TID.patternCell(TOY.patExpressDown, TOY.stationA));
    fireEvent.click(cell);
    fireEvent.click(screen.getByTestId(TID.patternCell(TOY.patExpressDown, TOY.stationA)));
    expect(useProjectStore.getState().history).toHaveLength(2);

    useProjectStore.getState().undo();
    useProjectStore.getState().undo();
    expect(entryAt(TOY.patExpressDown, TOY.stationA)).toBe('stop');
  });

  it('exposes the current state on the cell for assertions', () => {
    render(<TypesScreen />);
    expect(
      screen
        .getByTestId(TID.patternCell(TOY.patExpressDown, TOY.stationB))
        .getAttribute('data-kind'),
    ).toBe('pass');
  });
});

describe('種別の追加', () => {
  beforeEach(reset);

  it('creates a train type from the form', () => {
    render(<TypesScreen />);
    fireEvent.change(screen.getByTestId(TID.trainTypeNameInput), { target: { value: '特急' } });
    fireEvent.change(screen.getByTestId(TID.trainTypeShortInput), { target: { value: '特' } });
    fireEvent.click(screen.getByTestId(TID.trainTypeAdd));

    const types = entityList(useProjectStore.getState().doc.trainTypes);
    expect(types.map((t) => t.name)).toContain('特急');
  });

  it('creates a pattern that stops everywhere by default', () => {
    render(<TypesScreen />);
    fireEvent.change(screen.getByTestId(TID.patternNameInput), { target: { value: '新パターン' } });
    fireEvent.click(screen.getByTestId(TID.patternAdd));

    const created = entityList(useProjectStore.getState().doc.stopPatterns).find(
      (p) => p.name === '新パターン',
    );
    expect(created).toBeDefined();
    expect(Object.values(created?.entries ?? {})).toEqual(['stop', 'stop', 'stop', 'stop']);
  });
});
