/**
 * 行路の編集 — reordering legs, and creating the 留置 / 検査 legs that the Gantt
 * and the continuity rule could already draw but nothing could author.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TID } from '@e2e/testids';

import type { Duty } from '@/domain/model';
import { useProjectStore } from '@/store/projectStore';
import { useUiStore } from '@/store/uiStore';
import { TOY, toyProject } from '@/testing/toyProject';

import { DutiesScreen } from './DutiesScreen';

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
const dutyLocal = (): Duty => doc().duties.byId[TOY.dutyLocal] as Duty;

function openLocalDuty(): void {
  render(<DutiesScreen />);
  fireEvent.click(screen.getByTestId(TID.dutyExpand(TOY.dutyLocal)));
}

describe('行路の並べ替え', () => {
  beforeEach(reset);

  it('swaps two legs with the ↑ button', () => {
    openLocalDuty();
    const before = dutyLocal().legs.map((l) => (l.kind === 'train' ? l.trainId : l.kind));
    fireEvent.click(screen.getByTestId(TID.dutyLegUp(TOY.dutyLocal, 1)));
    const after = dutyLocal().legs.map((l) => (l.kind === 'train' ? l.trainId : l.kind));

    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);
    expect(after).toHaveLength(before.length);
    expect(useProjectStore.getState().history[0]?.label).toBe('運用を並べ替え');
  });

  it('cannot move the first leg up', () => {
    openLocalDuty();
    const button = screen.getByTestId(TID.dutyLegUp(TOY.dutyLocal, 0)) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('removes a leg', () => {
    openLocalDuty();
    const before = dutyLocal().legs.length;
    fireEvent.click(screen.getByTestId(TID.dutyLegRemove(TOY.dutyLocal, 0)));
    expect(dutyLocal().legs).toHaveLength(before - 1);
  });
});

describe('留置・検査の行路', () => {
  beforeEach(reset);

  it('appends a 留置 leg at the point the duty currently ends', () => {
    openLocalDuty();
    fireEvent.click(screen.getByTestId(TID.dutyAddStableLeg(TOY.dutyLocal)));
    const last = dutyLocal().legs[dutyLocal().legs.length - 1];
    expect(last?.kind).toBe('stable');
    if (last?.kind === 'stable') {
      expect(last.stationId).toBe(TOY.stationDepot);
      expect(last.to - last.from).toBe(30 * 60);
    }
  });

  it('appends an 検査 leg at the depot', () => {
    openLocalDuty();
    fireEvent.click(screen.getByTestId(TID.dutyAddInspectionLeg(TOY.dutyLocal)));
    const last = dutyLocal().legs[dutyLocal().legs.length - 1];
    expect(last?.kind).toBe('inspection');
    if (last?.kind === 'inspection') expect(last.depotId).toBe(TOY.depot);
  });
});

describe('運用へのジャンプ', () => {
  beforeEach(reset);

  it('opens the focused duty without anyone clicking 行路を編集', () => {
    useUiStore.getState().focusOn({ ref: { kind: 'duty', dutyId: TOY.dutyLocal } });
    render(<DutiesScreen />);
    expect(screen.getByTestId(TID.dutyLegList(TOY.dutyLocal))).toBeTruthy();
  });

  it('opens the duty that works a focused train, and marks that leg', () => {
    useUiStore.getState().focusOn({ ref: { kind: 'train', trainId: TOY.localDown } });
    render(<DutiesScreen />);

    const legs = screen.getByTestId(TID.dutyLegList(TOY.dutyLocal));
    const marked = legs.querySelectorAll('tbody tr[class]');
    expect(marked).toHaveLength(1);
    // 各101 is the second leg of 運用 01 (出庫 → 各101 → 留置 → 入庫).
    expect(marked[0]!.getAttribute('data-leg-index')).toBe('1');
  });

  it('leaves the board alone when the focus is something it cannot show', () => {
    useUiStore.getState().focusOn({ ref: { kind: 'station', stationId: TOY.stationC } });
    render(<DutiesScreen />);
    expect(screen.queryByTestId(TID.dutyLegList(TOY.dutyLocal))).toBeNull();
  });
});

describe('運用の条件', () => {
  beforeEach(reset);

  it('sets and clears 必要両数', () => {
    openLocalDuty();
    const input = screen.getByTestId(TID.dutyRequiredCars(TOY.dutyLocal));
    fireEvent.change(input, { target: { value: '8' } });
    expect(dutyLocal().requiredCars).toBe(8);
    fireEvent.change(input, { target: { value: '' } });
    expect(dutyLocal().requiredCars).toBeUndefined();
  });

  it('restricts the duty to one 形式', () => {
    openLocalDuty();
    fireEvent.click(screen.getByTestId(TID.dutyRequiredSeries(TOY.dutyLocal)));
    expect(dutyLocal().requiredSeriesIds).toEqual([TOY.series]);
  });
});
