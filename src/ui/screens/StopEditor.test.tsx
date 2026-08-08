/**
 * The 待避 / 緩急接続 declaration controls.
 *
 * Two things are worth pinning down: that the candidate filter narrows a
 * 600-train document to the handful of trains that could plausibly be the
 * other half of the relationship, and that ticking a box really does reach
 * `train/setOvertakenBy` / `train/setConnectsTo` rather than mutating a stop.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TID } from '@e2e/testids';

import type { Train } from '@/domain/model';
import { useProjectStore } from '@/store/projectStore';
import { useUiStore } from '@/store/uiStore';
import { TOY, toyProject } from '@/testing/toyProject';

import { StopEditor, connectionCandidates, overtakeCandidates } from './StopEditor';

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
const trainOf = (id: string): Train => doc().trains.byId[id] as Train;

/** The local stands at C (stop index 2) from 08:04 to 08:08. */
function renderLocalAtC() {
  return render(<StopEditor doc={doc()} train={trainOf(TOY.localDown)} stopIndex={2} />);
}

describe('candidate filtering', () => {
  beforeEach(reset);

  it('offers the express as an overtaking train at C', () => {
    const ids = overtakeCandidates(doc(), trainOf(TOY.localDown), 2).map((c) => c.train.id);
    expect(ids).toContain(TOY.expressDown);
  });

  it('never offers the train itself', () => {
    const ids = overtakeCandidates(doc(), trainOf(TOY.localDown), 2).map((c) => c.train.id);
    expect(ids).not.toContain(TOY.localDown);
  });

  it('excludes a train running the other way through the same station', () => {
    // 回8002 calls at C at 08:22 but is an `up` train — it cannot overtake.
    const ids = overtakeCandidates(doc(), trainOf(TOY.localDown), 2).map((c) => c.train.id);
    expect(ids).not.toContain(TOY.depotIn);
  });

  it('excludes a same-direction train that is nowhere near in time', () => {
    const shifted = toyProject();
    const express = shifted.trains.byId[TOY.expressDown] as Train;
    for (const stop of express.stops) {
      if (stop.arr !== undefined) stop.arr += 4 * 3600;
      if (stop.dep !== undefined) stop.dep += 4 * 3600;
    }
    const local = shifted.trains.byId[TOY.localDown] as Train;
    delete local.stops[2]?.overtakenBy;
    const ids = overtakeCandidates(shifted, local, 2).map((c) => c.train.id);
    expect(ids).not.toContain(TOY.expressDown);
  });

  it('still lists an already-declared train that has drifted out of the window', () => {
    const shifted = toyProject();
    const express = shifted.trains.byId[TOY.expressDown] as Train;
    for (const stop of express.stops) {
      if (stop.arr !== undefined) stop.arr += 4 * 3600;
      if (stop.dep !== undefined) stop.dep += 4 * 3600;
    }
    // The declaration survives from the fixture, so it must stay removable.
    const ids = overtakeCandidates(shifted, shifted.trains.byId[TOY.localDown] as Train, 2).map(
      (c) => c.train.id,
    );
    expect(ids).toContain(TOY.expressDown);
  });

  it('offers the express as a 緩急接続 partner at C', () => {
    const ids = connectionCandidates(doc(), trainOf(TOY.localDown), 2).map((c) => c.train.id);
    expect(ids).toContain(TOY.expressDown);
  });

  it('excludes 回送 from the connection list', () => {
    const ids = connectionCandidates(doc(), trainOf(TOY.localDown), 2).map((c) => c.train.id);
    expect(ids).not.toContain(TOY.depotOut);
    expect(ids).not.toContain(TOY.depotIn);
  });
});

describe('待避 declaration', () => {
  beforeEach(reset);

  it('renders the existing declaration as a ticked box', () => {
    renderLocalAtC();
    const box = screen.getByTestId(TID.overtakeCandidate(TOY.expressDown)) as HTMLInputElement;
    expect(box.checked).toBe(true);
  });

  it('unticking dispatches train/setOvertakenBy with an empty list', () => {
    renderLocalAtC();
    fireEvent.click(screen.getByTestId(TID.overtakeCandidate(TOY.expressDown)));
    expect(trainOf(TOY.localDown).stops[2]?.overtakenBy).toBeUndefined();
    expect(useProjectStore.getState().history[0]?.label).toBe('待避設定を変更');
  });

  it('ticking a candidate writes it back', () => {
    renderLocalAtC();
    // off, then on again
    fireEvent.click(screen.getByTestId(TID.overtakeCandidate(TOY.expressDown)));
    cleanup();
    render(<StopEditor doc={doc()} train={trainOf(TOY.localDown)} stopIndex={2} />);
    fireEvent.click(screen.getByTestId(TID.overtakeCandidate(TOY.expressDown)));
    expect(trainOf(TOY.localDown).stops[2]?.overtakenBy).toEqual([TOY.expressDown]);
  });

  it('すべて解除 clears every declaration at once', () => {
    renderLocalAtC();
    fireEvent.click(screen.getByTestId(TID.overtakeClear));
    expect(trainOf(TOY.localDown).stops[2]?.overtakenBy).toBeUndefined();
  });
});

describe('緩急接続 declaration', () => {
  beforeEach(reset);

  it('ticking a partner dispatches train/setConnectsTo', () => {
    renderLocalAtC();
    fireEvent.click(screen.getByTestId(TID.connectCandidate(TOY.expressDown)));
    expect(trainOf(TOY.localDown).stops[2]?.connectsTo).toEqual([TOY.expressDown]);
    expect(useProjectStore.getState().history[0]?.label).toBe('接続設定を変更');
  });

  it('unticking removes just that partner', () => {
    renderLocalAtC();
    fireEvent.click(screen.getByTestId(TID.connectCandidate(TOY.expressDown)));
    cleanup();
    render(<StopEditor doc={doc()} train={trainOf(TOY.localDown)} stopIndex={2} />);
    fireEvent.click(screen.getByTestId(TID.connectCandidate(TOY.expressDown)));
    expect(trainOf(TOY.localDown).stops[2]?.connectsTo).toBeUndefined();
  });
});

describe('停車設定', () => {
  beforeEach(reset);

  it('switches a stop to 通過', () => {
    renderLocalAtC();
    fireEvent.change(screen.getByTestId(TID.stopKindSelect), { target: { value: 'pass' } });
    expect(trainOf(TOY.localDown).stops[2]?.kind).toBe('pass');
  });

  it('marks a stop 運転停車 and clears the flag again', () => {
    renderLocalAtC();
    fireEvent.click(screen.getByTestId(TID.stopOperational));
    expect(trainOf(TOY.localDown).stops[2]?.operational).toBe(true);

    cleanup();
    render(<StopEditor doc={doc()} train={trainOf(TOY.localDown)} stopIndex={2} />);
    fireEvent.click(screen.getByTestId(TID.stopOperational));
    expect(trainOf(TOY.localDown).stops[2]?.operational).toBeUndefined();
  });

  it('writes and then clears a stop note', () => {
    renderLocalAtC();
    fireEvent.change(screen.getByTestId(TID.stopNoteInput), { target: { value: '接続待ち' } });
    expect(trainOf(TOY.localDown).stops[2]?.note).toBe('接続待ち');

    cleanup();
    render(<StopEditor doc={doc()} train={trainOf(TOY.localDown)} stopIndex={2} />);
    fireEvent.change(screen.getByTestId(TID.stopNoteInput), { target: { value: '' } });
    expect(trainOf(TOY.localDown).stops[2]?.note).toBeUndefined();
  });

  it('says so when no stop is selected', () => {
    render(<StopEditor doc={doc()} train={undefined} stopIndex={undefined} />);
    expect(screen.getByTestId(TID.stopEditorEmpty)).toBeTruthy();
  });
});
