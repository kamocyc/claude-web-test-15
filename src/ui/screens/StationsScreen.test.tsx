/**
 * 路線 editing, and the 構内ダイヤ reassignment that was mounted without a
 * handler and therefore inert.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TID } from '@e2e/testids';

import type { Train } from '@/domain/model';
import { useProjectStore } from '@/store/projectStore';
import { useUiStore } from '@/store/uiStore';
import { TOY, toyProject } from '@/testing/toyProject';

import { StationsScreen } from './StationsScreen';

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

describe('路線', () => {
  beforeEach(reset);

  it('renames the line', () => {
    render(<StationsScreen />);
    fireEvent.change(screen.getByTestId(TID.lineNameInput), { target: { value: '大井町線' } });
    expect(doc().line.name).toBe('大井町線');
  });

  it('sets the 下り direction label', () => {
    render(<StationsScreen />);
    fireEvent.change(screen.getByTestId(TID.lineDownLabelInput), {
      target: { value: '溝の口方面' },
    });
    expect(doc().line.downDirectionLabel).toBe('溝の口方面');
  });
});

describe('駅間', () => {
  beforeEach(reset);

  it('edits the distance in km', () => {
    render(<StationsScreen />);
    const inputs = screen.getAllByTestId(TID.linkDistanceInput);
    fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: '1.4' } });
    expect(doc().links.byId[TOY.linkAB]?.distance).toBe(1400);
  });

  it('rebuilds the chain on demand', () => {
    render(<StationsScreen />);
    // Move a station past its neighbour without going through station/update,
    // so the link distances are stale until the chain is rebuilt.
    fireEvent.change(screen.getAllByTestId(TID.linkDistanceInput)[0] as HTMLInputElement, {
      target: { value: '9' },
    });
    expect(doc().links.byId[TOY.linkAB]?.distance).toBe(9000);
    fireEvent.click(screen.getByTestId(TID.linkRebuild));
    expect(doc().links.byId[TOY.linkAB]?.distance).toBe(1000);
  });

  it('switches a section to 単線', () => {
    render(<StationsScreen />);
    const selects = screen.getAllByTestId(TID.linkTrackCountSelect);
    fireEvent.change(selects[0] as HTMLSelectElement, { target: { value: '1' } });
    expect(doc().links.byId[TOY.linkAB]?.trackCount).toBe(1);
  });
});

describe('構内ダイヤ', () => {
  beforeEach(reset);

  it('picks the station the chart shows', () => {
    render(<StationsScreen />);
    const select = screen.getByTestId(TID.yardChartStationSelect);
    fireEvent.change(select, { target: { value: TOY.stationC } });
    expect(screen.getByTestId(TID.yardChart).getAttribute('data-station-id')).toBe(TOY.stationC);
  });

  it('reassigns a 番線 with the arrow keys', () => {
    render(<StationsScreen />);
    fireEvent.change(screen.getByTestId(TID.yardChartStationSelect), {
      target: { value: TOY.stationC },
    });
    expect(localTrain().stops[2]?.trackId).toBe(TOY.c2);

    const bar = screen.getAllByTestId(TID.yardBar(TOY.localDown))[0] as HTMLElement;
    fireEvent.keyDown(bar, { key: 'ArrowUp' });

    // Lane order follows Station.trackIds — c1, c2, c3 — so up from c2 is c1.
    expect(localTrain().stops[2]?.trackId).toBe(TOY.c1);
    expect(useProjectStore.getState().history[0]?.label).toBe('番線を変更');
  });
});

describe('構内配線', () => {
  beforeEach(reset);

  const pickC = (): void => {
    fireEvent.change(screen.getByTestId(TID.stationSelect), { target: { value: TOY.stationC } });
  };

  it('shows the derived wiring for a road that states none', () => {
    render(<StationsScreen />);
    pickC();
    expect(doc().stationTracks.byId[TOY.c2]?.wiring).toBeUndefined();
    // A road through the station is connected at both ends…
    expect((screen.getByTestId(TID.wiringEnd(TOY.c2, 'down')) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByTestId(TID.wiringEnd(TOY.c2, 'up')) as HTMLInputElement).checked).toBe(
      true,
    );
    // …at its authored position across the throat…
    expect((screen.getByTestId(TID.wiringLadder(TOY.c2)) as HTMLInputElement).value).toBe('1');
    // …and the 下り本線 runs into the road the station nominates, not into 待避線.
    expect((screen.getByTestId(TID.wiringLine(TOY.c1, 'down')) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByTestId(TID.wiringLine(TOY.c2, 'down')) as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it('turns a road into a stub by clearing one end', () => {
    render(<StationsScreen />);
    pickC();
    fireEvent.click(screen.getByTestId(TID.wiringEnd(TOY.c2, 'up')));
    expect(doc().stationTracks.byId[TOY.c2]?.wiring?.ends).toEqual(['down']);
  });

  it('moves a road across the throat', () => {
    render(<StationsScreen />);
    pickC();
    fireEvent.change(screen.getByTestId(TID.wiringLadder(TOY.c2)), { target: { value: '4' } });
    expect(doc().stationTracks.byId[TOY.c2]?.wiring?.ladder).toBe(4);
    // The ends survive the edit — they were derived, and are now stated.
    expect(doc().stationTracks.byId[TOY.c2]?.wiring?.ends).toEqual(['down', 'up']);
  });

  it('declares that a 本線 runs into a road', () => {
    render(<StationsScreen />);
    pickC();
    fireEvent.click(screen.getByTestId(TID.wiringLine(TOY.c2, 'down')));
    expect(doc().stationTracks.byId[TOY.c2]?.wiring?.line).toEqual(['down']);
  });

  it('writes a 接続先 list, and keeps the other end on what it was showing', () => {
    render(<StationsScreen />);
    pickC();
    // 2番線 is a 下り待避線, so what it meets in either throat is the 下り本線.
    const cell = screen.getByTestId(TID.wiringConnects(TOY.c2, 'up')) as HTMLInputElement;
    expect(cell.value).toBe('下り');
    fireEvent.change(cell, { target: { value: '側線' } });
    expect(doc().stationTracks.byId[TOY.c2]?.wiring?.connects).toEqual({
      up: ['側線'],
      down: ['down'],
    });
  });

  it('adds and removes a 渡り線', () => {
    render(<StationsScreen />);
    pickC();
    fireEvent.click(screen.getByTestId(TID.wiringCrossoverAdd('down')));
    expect(doc().stations.byId[TOY.stationC]?.crossovers).toEqual([
      { end: 'down', from: 'up', to: 'down' },
    ]);
    fireEvent.click(screen.getByTestId(TID.wiringCrossoverRemove(0)));
    expect(doc().stations.byId[TOY.stationC]).not.toHaveProperty('crossovers');
  });
});

describe('構内配線図', () => {
  beforeEach(reset);

  const pickC = (): void => {
    fireEvent.change(screen.getByTestId(TID.stationSelect), { target: { value: TOY.stationC } });
  };

  it('draws one line per road, at its 分岐位置', () => {
    render(<StationsScreen />);
    pickC();
    expect(screen.getByTestId(TID.wiringDiagram)).toBeTruthy();
    expect(screen.getByTestId(TID.wiringRoad(TOY.c1)).getAttribute('data-ladder')).toBe('0');
    expect(screen.getByTestId(TID.wiringRoad(TOY.c2)).getAttribute('data-ladder')).toBe('1');
  });

  it('cuts a connection when its 分岐器 is clicked', () => {
    render(<StationsScreen />);
    pickC();
    fireEvent.click(screen.getByTestId(TID.wiringTurnout(TOY.c2, 'up', 'down')));
    expect(doc().stationTracks.byId[TOY.c2]?.wiring?.connects?.up).toEqual([]);
    // The turnout is gone with it — the picture is the model, not a copy.
    expect(screen.queryByTestId(TID.wiringTurnout(TOY.c2, 'up', 'down'))).toBeNull();
  });

  it('shades the routes of the road that is picked, and only then', () => {
    render(<StationsScreen />);
    pickC();
    expect(screen.queryAllByTestId(TID.wiringRoute)).toHaveLength(0);
    fireEvent.pointerDown(screen.getByTestId(TID.wiringRoad(TOY.c2)));
    expect(screen.queryAllByTestId(TID.wiringRoute).length).toBeGreaterThan(0);
  });

  it('moves a road across the throat when it is dragged', () => {
    render(<StationsScreen />);
    pickC();
    const road = screen.getByTestId(TID.wiringRoad(TOY.c2));
    const svg = screen.getByTestId(TID.wiringDiagram);
    svg.getBoundingClientRect = () =>
      ({ top: 0, left: 0, width: 720, height: 100, bottom: 100, right: 720, x: 0, y: 0 }) as DOMRect;
    fireEvent.pointerDown(road);
    fireEvent.pointerMove(svg, { clientY: 100 });
    fireEvent.pointerUp(svg);
    expect(doc().stationTracks.byId[TOY.c2]?.wiring?.ladder).toBeGreaterThan(1);
  });
});

describe('駅の編集', () => {
  beforeEach(reset);

  it('edits the station code after the station exists', () => {
    render(<StationsScreen />);
    const cell = screen.getByTestId(TID.stationCodeCell(TOY.stationB));
    fireEvent.change(cell, { target: { value: 'OM02' } });
    expect(doc().stations.byId[TOY.stationB]?.code).toBe('OM02');
  });

  it('clears the code rather than storing an empty string', () => {
    render(<StationsScreen />);
    const cell = screen.getByTestId(TID.stationCodeCell(TOY.stationB));
    fireEvent.change(cell, { target: { value: 'OM02' } });
    fireEvent.change(cell, { target: { value: '  ' } });
    expect(doc().stations.byId[TOY.stationB]).not.toHaveProperty('code');
  });

  it('offers exactly one 追加 button per form', () => {
    render(<StationsScreen />);
    // Two buttons wired to the same handler read as two different actions.
    expect(screen.getAllByTestId(TID.stationAdd)).toHaveLength(1);
    expect(screen.getAllByTestId(TID.trackAdd)).toHaveLength(1);
    expect(screen.queryAllByRole('button', { name: '追加' })).toHaveLength(0);
  });
});
