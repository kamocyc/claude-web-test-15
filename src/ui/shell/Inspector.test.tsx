/**
 * 列車 → その運用 — the jump the inspector exists to offer.
 *
 * Clicking a train anywhere (a canvas, the timetable, a problem) selects it;
 * from there the panel must name the duty that works it and give both ways of
 * looking at that duty.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ROUTES, TID } from '@e2e/testids';

import type { Duty } from '@/domain/model';
import { emptyEntities } from '@/domain/units';
import { useProjectStore } from '@/store/projectStore';
import { useUiStore } from '@/store/uiStore';
import { TOY, toyProject } from '@/testing/toyProject';

import { Inspector } from './Inspector';

function reset(): void {
  useProjectStore.setState({
    doc: toyProject(),
    revision: 0,
    history: [],
    redoStack: [],
    dirty: false,
  });
  useUiStore.setState({
    route: ROUTES.timetable,
    selected: [],
    hovered: undefined,
    focusTarget: undefined,
    highlightDutyId: undefined,
    diagramDirection: 'both',
  });
}

afterEach(cleanup);

const ui = () => useUiStore.getState();

describe('選択した列車の運用', () => {
  beforeEach(reset);

  it('names the duty and the formation working it', () => {
    ui().select({ kind: 'train', trainId: TOY.localDown });
    render(<Inspector />);

    expect(screen.getByText('運用')).toBeTruthy();
    expect(screen.getByText('01')).toBeTruthy();
    expect(screen.getByText('T01F')).toBeTruthy();
  });

  it('opens the 運用 screen with that duty focused', () => {
    ui().select({ kind: 'train', trainId: TOY.localDown });
    render(<Inspector />);

    fireEvent.click(screen.getByTestId(TID.inspectorOpenDuty));

    expect(ui().route).toBe(ROUTES.duties);
    expect(ui().focusTarget?.ref).toEqual({ kind: 'duty', dutyId: TOY.dutyLocal });
    expect(ui().selected).toEqual([{ kind: 'duty', dutyId: TOY.dutyLocal }]);
  });

  it('highlights the duty on the string diagram, both directions showing', () => {
    useUiStore.setState({ diagramDirection: 'up' });
    ui().select({ kind: 'train', trainId: TOY.localDown });
    render(<Inspector />);

    fireEvent.click(screen.getByTestId(TID.inspectorHighlightDuty));

    expect(ui().route).toBe(ROUTES.diagram);
    expect(ui().highlightDutyId).toBe(TOY.dutyLocal);
    // 運用 01 works 下り 各101 and 上り 回8002 alike — a one-way sheet would
    // hide half of what was just asked for.
    expect(ui().diagramDirection).toBe('both');
  });

  it('stays on 路線ビュー when the highlight is asked for from there', () => {
    useUiStore.setState({ route: ROUTES.line });
    ui().select({ kind: 'train', trainId: TOY.localDown });
    render(<Inspector />);

    fireEvent.click(screen.getByTestId(TID.inspectorHighlightDuty));
    expect(ui().route).toBe(ROUTES.line);
    expect(ui().highlightDutyId).toBe(TOY.dutyLocal);
  });

  it('offers to clear a highlight it already set', () => {
    ui().select({ kind: 'train', trainId: TOY.localDown });
    render(<Inspector />);

    fireEvent.click(screen.getByTestId(TID.inspectorHighlightDuty));
    fireEvent.click(screen.getByTestId(TID.inspectorClearHighlight));
    expect(ui().highlightDutyId).toBeUndefined();
  });

  it('says so when the train is in no duty at all', () => {
    const doc = useProjectStore.getState().doc;
    useProjectStore.setState({
      doc: { ...doc, duties: emptyEntities<Duty>() },
      revision: 1,
    });
    ui().select({ kind: 'train', trainId: TOY.localDown });
    render(<Inspector />);

    expect(screen.getByText('未割当')).toBeTruthy();
    expect(screen.queryByTestId(TID.inspectorOpenDuty)).toBeNull();
    expect(screen.queryByTestId(TID.inspectorHighlightDuty)).toBeNull();
  });
});

describe('選択した運用', () => {
  beforeEach(reset);

  it('lists its trains, and following one selects that train', () => {
    ui().select({ kind: 'duty', dutyId: TOY.dutyLocal });
    render(<Inspector />);

    // 留置 legs carry no train, so only the three train legs are listed.
    expect(screen.getByTestId(TID.inspectorDutyTrain(TOY.depotOut))).toBeTruthy();
    expect(screen.getByTestId(TID.inspectorDutyTrain(TOY.depotIn))).toBeTruthy();

    fireEvent.click(screen.getByTestId(TID.inspectorDutyTrain(TOY.localDown)));
    expect(ui().selected).toEqual([{ kind: 'train', trainId: TOY.localDown }]);
  });
});
