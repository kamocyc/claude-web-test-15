/**
 * 設定 — the screen that makes a from-zero project more than a single weekday.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TID } from '@e2e/testids';

import { entityList } from '@/domain/units';
import { useProjectStore } from '@/store/projectStore';
import { useUiStore } from '@/store/uiStore';
import { TOY, toyProject } from '@/testing/toyProject';

import { SettingsScreen } from './SettingsScreen';

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

describe('プロジェクト設定', () => {
  beforeEach(reset);

  it('renames the project', () => {
    render(<SettingsScreen />);
    fireEvent.change(screen.getByTestId(TID.projectNameInput), { target: { value: '大井町線' } });
    expect(doc().meta.name).toBe('大井町線');
  });

  it('moves the service day end past midnight on blur', () => {
    render(<SettingsScreen />);
    const input = screen.getByTestId(TID.serviceDayEndInput);
    fireEvent.change(input, { target: { value: '27:30' } });
    fireEvent.blur(input, { target: { value: '27:30' } });
    expect(doc().settings.serviceDayEndSec).toBe(27 * 3600 + 30 * 60);
  });

  it('rejects an unparseable service time rather than writing zero', () => {
    render(<SettingsScreen />);
    const input = screen.getByTestId(TID.serviceDayStartInput);
    const before = doc().settings.serviceDayStartSec;
    fireEvent.change(input, { target: { value: 'ちがう' } });
    fireEvent.blur(input, { target: { value: 'ちがう' } });
    expect(doc().settings.serviceDayStartSec).toBe(before);
  });

  it('changes the time grain', () => {
    render(<SettingsScreen />);
    fireEvent.change(screen.getByTestId(TID.timeGrainSelect), { target: { value: '15' } });
    expect(doc().settings.timeGrainSec).toBe(15);
  });
});

describe('曜日種別とカレンダー', () => {
  beforeEach(reset);

  it('adds a second day type, which is what unlocks a 土休日 timetable', () => {
    render(<SettingsScreen />);
    fireEvent.change(screen.getByTestId(TID.dayTypeNameInput), { target: { value: '土休日' } });
    fireEvent.click(screen.getByTestId(TID.dayTypeAdd));

    const names = entityList(doc().dayTypes).map((d) => d.name);
    expect(names).toContain('土休日');
    expect(names).toHaveLength(2);
  });

  it('renames an existing day type', () => {
    render(<SettingsScreen />);
    fireEvent.change(screen.getByTestId(TID.dayTypeNameCell(TOY.dayType)), {
      target: { value: '月〜金' },
    });
    expect(doc().dayTypes.byId[TOY.dayType]?.name).toBe('月〜金');
  });

  it('refuses to delete the day type the app is currently showing', () => {
    render(<SettingsScreen />);
    const button = screen.getByTestId(TID.dayTypeRemove(TOY.dayType)) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('assigns a date to a day type', () => {
    render(<SettingsScreen />);
    fireEvent.change(screen.getByTestId(TID.calendarDateInput), {
      target: { value: '2026-05-04' },
    });
    fireEvent.click(screen.getByTestId(TID.calendarAdd));
    expect(doc().calendar.find((c) => c.date === '2026-05-04')?.dayTypeId).toBe(TOY.dayType);
  });
});

describe('検証設定', () => {
  beforeEach(reset);

  it('edits a threshold the connection rules read', () => {
    render(<SettingsScreen />);
    fireEvent.change(screen.getByTestId(TID.validationNumberInput('connectionMaxWaitSec')), {
      target: { value: '600' },
    });
    expect(doc().validationConfig.connectionMaxWaitSec).toBe(600);
  });

  it('turns one rule off and back to its default', () => {
    render(<SettingsScreen />);
    const select = screen.getByTestId(TID.validationSeveritySelect('overtake.undeclared'));
    fireEvent.change(select, { target: { value: 'off' } });
    expect(doc().validationConfig.severityOverrides['overtake.undeclared']).toBe('off');

    fireEvent.change(select, { target: { value: '' } });
    expect(doc().validationConfig.severityOverrides['overtake.undeclared']).toBeUndefined();
  });
});
