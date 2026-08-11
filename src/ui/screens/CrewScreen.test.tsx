/**
 * 乗務員 — the screen, checked at the level of what it writes to the document.
 *
 * The chart itself is tested in `src/render/crewDuty/layout.test.ts`; what
 * matters here is that every control turns into the command it claims to, and
 * that the two things this screen can author which nothing else can — a 休憩
 * and a part-of-a-train 乗務 — really do come out of it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TID } from '@e2e/testids';

import type { CrewDuty } from '@/domain/model';
import { setRenderSceneSource, staticSceneSource } from '@/render';
import { buildIndex } from '@/engine/buildIndex';
import { snapshotAt } from '@/engine/snapshot';
import { useProjectStore } from '@/store/projectStore';
import { useUiStore } from '@/store/uiStore';
import { TOY, toyProject } from '@/testing/toyProject';

import { CrewScreen } from './CrewScreen';

function reset(): void {
  const doc = toyProject();
  useProjectStore.setState({
    doc,
    revision: 0,
    history: [],
    redoStack: [],
    dirty: false,
  });
  useUiStore.setState({ selected: [], hovered: undefined, focusTarget: undefined });
  // The chart reads the scene imperatively, exactly as it does in the app.
  const index = buildIndex(doc);
  setRenderSceneSource(
    staticSceneSource({ doc, index, t: 0, snapshot: snapshotAt(index, 0), generation: 1 }),
  );
}

afterEach(cleanup);

const doc = () => useProjectStore.getState().doc;
const local = (): CrewDuty => doc().crewDuties.byId[TOY.crewDutyLocal] as CrewDuty;

function openLocalDuty(): void {
  render(<CrewScreen />);
  fireEvent.click(screen.getByTestId(TID.crewDutyExpand(TOY.crewDutyLocal)));
}

describe('乗務員行路の一覧', () => {
  beforeEach(reset);

  it('lists both 行路 with their 職種 and 担当', () => {
    render(<CrewScreen />);
    expect(screen.getByTestId(TID.crewDutyRow(TOY.crewDutyLocal))).toBeTruthy();
    expect(screen.getByTestId(TID.crewDutyRow(TOY.crewDutyExpress))).toBeTruthy();
    const person = screen.getByTestId(
      TID.crewDutyPersonSelect(TOY.crewDutyLocal),
    ) as HTMLSelectElement;
    expect(person.value).toBe(TOY.driver1);
  });

  it('reassigns the person through the 担当 select', () => {
    render(<CrewScreen />);
    fireEvent.change(screen.getByTestId(TID.crewDutyPersonSelect(TOY.crewDutyLocal)), {
      target: { value: TOY.driver2 },
    });
    const assignments = Object.values(doc().crewAssignments.byId).filter(
      (a) => a.crewDutyId === TOY.crewDutyLocal,
    );
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.crewId).toBe(TOY.driver2);
  });

  it('clears the assignment when 未担当 is chosen', () => {
    render(<CrewScreen />);
    fireEvent.change(screen.getByTestId(TID.crewDutyPersonSelect(TOY.crewDutyLocal)), {
      target: { value: '' },
    });
    expect(
      Object.values(doc().crewAssignments.byId).some((a) => a.crewDutyId === TOY.crewDutyLocal),
    ).toBe(false);
  });

  it('changes a 行路 の職種', () => {
    render(<CrewScreen />);
    fireEvent.change(screen.getByTestId(TID.crewDutyRole(TOY.crewDutyExpress)), {
      target: { value: 'conductor' },
    });
    expect(doc().crewDuties.byId[TOY.crewDutyExpress]!.role).toBe('conductor');
  });

  it('filters the board by 職種', () => {
    render(<CrewScreen />);
    fireEvent.change(screen.getByTestId(TID.crewDutyRole(TOY.crewDutyExpress)), {
      target: { value: 'conductor' },
    });
    const filter = screen.getByTestId(TID.crewRoleFilter);
    fireEvent.click(filter.querySelectorAll('button')[1]!); // 運転士
    expect(screen.queryByTestId(TID.crewDutyRow(TOY.crewDutyExpress))).toBeNull();
    expect(screen.getByTestId(TID.crewDutyRow(TOY.crewDutyLocal))).toBeTruthy();
  });
});

describe('行路の編集', () => {
  beforeEach(reset);

  it('adds a 休憩 at the place the 行路 currently ends', () => {
    openLocalDuty();
    const before = local().legs.length;
    fireEvent.click(screen.getByTestId(TID.crewAddBreakLeg(TOY.crewDutyLocal)));
    const legs = local().legs;
    expect(legs).toHaveLength(before + 1);
    const added = legs[legs.length - 1]!;
    expect(added.kind).toBe('break');
    if (added.kind !== 'break') throw new Error('unreachable');
    // The 行路 ends at the depot with the 入庫回送, so the break starts there.
    expect(added.stationId).toBe(TOY.stationDepot);
    expect(added.to - added.from).toBe(30 * 60);
  });

  it('adds a 待機 and removes it again', () => {
    openLocalDuty();
    fireEvent.click(screen.getByTestId(TID.crewAddStandbyLeg(TOY.crewDutyLocal)));
    const index = local().legs.length - 1;
    expect(local().legs[index]!.kind).toBe('standby');
    fireEvent.click(screen.getByTestId(TID.crewLegRemove(TOY.crewDutyLocal, index)));
    expect(local().legs).toHaveLength(index);
  });

  it('reorders legs with the ↑ button', () => {
    openLocalDuty();
    const before = local().legs.map((l) => l.kind);
    fireEvent.click(screen.getByTestId(TID.crewLegUp(TOY.crewDutyLocal, 2)));
    const after = local().legs.map((l) => l.kind);
    expect(after[1]).toBe(before[2]);
    expect(after[2]).toBe(before[1]);
  });

  it('turns a whole-train 乗務 into a part of one — 途中交代', () => {
    openLocalDuty();
    const selects = screen
      .getByTestId(TID.crewLegRow(TOY.crewDutyLocal, 1))
      .querySelectorAll('select');
    // 乗車駅 / 降車駅 for the 各停, which calls at all four stations.
    fireEvent.change(selects[1]!, { target: { value: '2' } });
    const leg = local().legs[1]!;
    if (leg.kind !== 'train') throw new Error('fixture changed');
    expect(leg.fromIndex).toBe(0);
    expect(leg.toIndex).toBe(2);
  });

  it('deletes a whole 行路 with its assignment', () => {
    render(<CrewScreen />);
    fireEvent.click(screen.getByTestId(TID.crewDutyRemove(TOY.crewDutyLocal)));
    expect(doc().crewDuties.byId[TOY.crewDutyLocal]).toBeUndefined();
    expect(
      Object.values(doc().crewAssignments.byId).some((a) => a.crewDutyId === TOY.crewDutyLocal),
    ).toBe(false);
  });
});

describe('乗務員', () => {
  beforeEach(reset);

  it('adds a person and edits their name', () => {
    render(<CrewScreen />);
    fireEvent.click(screen.getByTestId(TID.crewAdd));
    const ids = doc().crew.allIds;
    expect(ids).toHaveLength(3);
    const added = ids[ids.length - 1]!;
    fireEvent.change(screen.getByLabelText(`乗務員 D003 の氏名`), { target: { value: '丙' } });
    expect(doc().crew.byId[added]!.name).toBe('丙');
  });

  it('removing a person clears their assignment', () => {
    render(<CrewScreen />);
    fireEvent.click(screen.getByTestId(TID.crewRemove(TOY.driver1)));
    expect(doc().crew.byId[TOY.driver1]).toBeUndefined();
    expect(Object.values(doc().crewAssignments.byId).some((a) => a.crewId === TOY.driver1)).toBe(
      false,
    );
  });
});

describe('自動組成', () => {
  beforeEach(reset);

  it('rebuilds the 運転士 行路 from the trains', () => {
    render(<CrewScreen />);
    fireEvent.click(screen.getByTestId(TID.crewAutoAssign));
    const rebuilt = Object.values(doc().crewDuties.byId);
    expect(rebuilt.length).toBeGreaterThan(0);
    expect(rebuilt.every((d) => d.role === 'driver')).toBe(true);
    // Every train that needs a driver is in exactly one of them.
    const covered = rebuilt.flatMap((d) =>
      d.legs.filter((l) => l.kind === 'train').map((l) => (l.kind === 'train' ? l.trainId : '')),
    );
    expect(new Set(covered).size).toBe(covered.length);
    expect(covered).toContain(TOY.localDown);
    expect(covered).toContain(TOY.expressDown);
  });

  it('fills the 担当 column from the people on the roster', () => {
    render(<CrewScreen />);
    fireEvent.click(screen.getByTestId(TID.crewAutoAssign));
    fireEvent.click(screen.getByTestId(TID.crewAssignAutoFill));
    const assignments = Object.values(doc().crewAssignments.byId);
    expect(assignments.length).toBeGreaterThan(0);
    expect(new Set(assignments.map((a) => a.crewId)).size).toBe(assignments.length);
  });
});

describe('行路表', () => {
  beforeEach(reset);

  it('draws a row per 行路 and a bar per leg', () => {
    render(<CrewScreen />);
    const chart = screen.getByTestId(TID.crewChart);
    expect(chart.getAttribute('data-row-count')).toBe('2');
    expect(chart.getAttribute('data-conflict-count')).toBe('0');
    expect(screen.getByTestId(TID.crewChartRow(TOY.crewDutyLocal))).toBeTruthy();
    expect(screen.getByTestId(TID.crewChartBar(TOY.crewDutyLocal, 0))).toBeTruthy();
  });

  it('marks the 添乗 bars so they read differently from 乗務', () => {
    render(<CrewScreen />);
    const bar = screen.getByTestId(TID.crewChartBar(TOY.crewDutyExpress, 0));
    expect(bar.getAttribute('data-kind')).toBe('deadhead');
    expect(
      screen.getByTestId(TID.crewChartBar(TOY.crewDutyExpress, 2)).getAttribute('data-kind'),
    ).toBe('train');
  });

  it('opens the leg editor when a bar is clicked', () => {
    render(<CrewScreen />);
    expect(screen.queryByTestId(TID.crewLegList(TOY.crewDutyExpress))).toBeNull();
    fireEvent.click(screen.getByTestId(TID.crewChartBar(TOY.crewDutyExpress, 2)));
    expect(screen.getByTestId(TID.crewLegList(TOY.crewDutyExpress))).toBeTruthy();
    expect(useUiStore.getState().selected[0]).toEqual({
      kind: 'crewDuty',
      crewDutyId: TOY.crewDutyExpress,
    });
  });
});
