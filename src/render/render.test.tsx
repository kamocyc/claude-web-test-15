/**
 * Component-level checks of the DOM shadows and the yard chart.
 *
 * These run in jsdom, where `getContext` returns null — so nothing here
 * asserts on drawing. What they pin down is the *contract with the E2E suite*:
 * the testids, the data attributes and the interaction callbacks. Canvas
 * geometry is covered with zero DOM in the `draw.test.ts` files.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TID } from '@e2e/testids';
import { TOY } from '@/testing/toyProject';
import { sampleScene, sampleSceneWithYardConflict } from './__fixtures__/sampleScene';
import { resetFrameTasks } from './canvas/rafLoop';
import { LineViewCanvas } from './lineView/LineViewCanvas';
import { setRenderSceneSource, staticSceneSource, type RenderScene } from './scene';
import { StationYardChart } from './stationYard/StationYardChart';
import { StringDiagramCanvas } from './stringDiagram/StringDiagramCanvas';

function mount(ui: React.ReactElement, scene: RenderScene = sampleScene()) {
  setRenderSceneSource(staticSceneSource(scene));
  return render(ui);
}

afterEach(() => {
  cleanup();
  setRenderSceneSource(undefined);
  resetFrameTasks();
});

describe('LineViewCanvas', () => {
  it('stacks three canvases inside the view', () => {
    mount(<LineViewCanvas />);
    expect(screen.getByTestId(TID.lineView).querySelectorAll('canvas')).toHaveLength(3);
    expect(screen.getByTestId(TID.lineViewCanvas)).toBeTruthy();
  });

  it('publishes a shadow row per active train with the agreed attributes', () => {
    mount(<LineViewCanvas />);
    const rows = screen.getAllByTestId(TID.trainMarker);
    expect(rows).toHaveLength(2);

    const local = rows.find((r) => r.getAttribute('data-train-number') === '101')!;
    expect(local.getAttribute('data-train-id')).toBe(TOY.localDown);
    expect(local.getAttribute('data-type')).toBe('各駅停車');
    expect(local.getAttribute('data-phase')).toBe('dwelling');
    expect(local.getAttribute('data-reason')).toBe('overtakeWait');
    expect(local.getAttribute('data-station')).toBe(TOY.stationC);
    expect(local.getAttribute('data-track')).toBe(TOY.c2);
    expect(local.getAttribute('data-formation')).toBe('T01F');
    expect(local.getAttribute('data-km')).toBe('2.000');

    const express = rows.find((r) => r.getAttribute('data-train-number') === '201')!;
    expect(express.getAttribute('data-phase')).toBe('running');
    expect(express.getAttribute('data-reason')).toBe('');
  });

  it('never lists a pending or finished train', () => {
    mount(<LineViewCanvas />);
    const numbers = screen.getAllByTestId(TID.trainMarker).map((r) => r.getAttribute('data-train-number'));
    expect(numbers).not.toContain('回8001'); // finished at 07:52
    expect(numbers).not.toContain('回8002'); // pending until 08:20
  });

  it('drops 回送 from the shadow when showDeadhead is off', () => {
    mount(<LineViewCanvas showDeadhead={false} />, sampleScene(7 * 3600 + 51 * 60));
    expect(screen.queryAllByTestId(TID.trainMarker)).toHaveLength(0);
  });

  it('the shadow is visually hidden but present in the DOM', () => {
    mount(<LineViewCanvas />);
    expect(screen.getByTestId(TID.lineViewTrains).className).toBe('visually-hidden');
  });

  it('lists what is stabled in each depot', () => {
    mount(<LineViewCanvas />);
    const depot = screen.getByTestId(TID.lineViewDepot(TOY.depot));
    // At 08:05 both toy formations are out on the line.
    expect(depot.getAttribute('data-formation-count')).toBe('0');

    cleanup();
    mount(<LineViewCanvas />, sampleScene(3 * 3600));
    const early = screen.getByTestId(TID.lineViewDepot(TOY.depot));
    expect(early.getAttribute('data-formation-count')).toBe('2');
    expect(early.getAttribute('data-formations')).toBe('T01F T02F');
  });
});

describe('StringDiagramCanvas', () => {
  it('publishes one shadow row per train, with a vertex count', () => {
    mount(<StringDiagramCanvas />);
    const rows = screen.getAllByTestId(TID.diagramTrainLine);
    expect(rows).toHaveLength(4);
    const local = rows.find((r) => r.getAttribute('data-train-id') === TOY.localDown)!;
    expect(local.getAttribute('data-type')).toBe('各駅停車');
    // Six vertices: the dwell stubs at B and C each contribute a second one.
    expect(local.getAttribute('data-point-count')).toBe('6');
  });

  it('publishes the 待避 marker with both train ids', () => {
    mount(<StringDiagramCanvas />);
    const marker = screen.getByTestId(TID.overtakeMarker);
    expect(marker.getAttribute('data-station-id')).toBe(TOY.stationC);
    expect(marker.getAttribute('data-waiting-train')).toBe(TOY.localDown);
    expect(marker.getAttribute('data-passing-train')).toBe(TOY.expressDown);
  });

  it('publishes the 緩急接続 marker', () => {
    mount(<StringDiagramCanvas />);
    const marker = screen.getByTestId(TID.connectionMarker);
    expect(marker.getAttribute('data-station-id')).toBe(TOY.stationC);
    // 各101 arrives C 08:04:00, 急201 leaves 08:06:30.
    expect(marker.getAttribute('data-transfer-sec')).toBe('150');
  });

  it('honours showDeadhead', () => {
    mount(<StringDiagramCanvas showDeadhead={false} />);
    expect(screen.getAllByTestId(TID.diagramTrainLine)).toHaveLength(2);
  });

  it('draws one direction on its own', () => {
    mount(<StringDiagramCanvas direction="up" />);
    const rows = screen.getAllByTestId(TID.diagramTrainLine);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute('data-train-id')).toBe(TOY.depotIn);
    expect(rows[0]!.getAttribute('data-direction')).toBe('up');
    // The 待避 pairs two 下り trains and goes with them.
    expect(screen.queryByTestId(TID.overtakeMarker)).toBeNull();
  });

  it('names the duty of each line so the shadow can be filtered by 運用', () => {
    mount(<StringDiagramCanvas />);
    const local = screen
      .getAllByTestId(TID.diagramTrainLine)
      .find((r) => r.getAttribute('data-train-id') === TOY.localDown)!;
    expect(local.getAttribute('data-duty')).toBe(TOY.dutyLocal);
  });
});

describe('StationYardChart', () => {
  it('draws one lane per 番線 and a bar per occupancy', () => {
    mount(<StationYardChart stationId={TOY.stationC} />);
    expect(screen.getByTestId(TID.yardLane(TOY.c1))).toBeTruthy();
    expect(screen.getByTestId(TID.yardLane(TOY.c2))).toBeTruthy();
    expect(screen.getByTestId(TID.yardLane(TOY.c3))).toBeTruthy();

    const bar = screen.getByTestId(TID.yardBar(TOY.localDown));
    expect(bar.getAttribute('data-track-id')).toBe(TOY.c2);
    expect(bar.getAttribute('data-stop-index')).toBe('2');
    expect(bar.getAttribute('data-conflict')).toBe('0');
  });

  it('marks overlapping bars as conflicts', () => {
    mount(<StationYardChart stationId={TOY.stationC} />, sampleSceneWithYardConflict());
    expect(screen.getAllByTestId(TID.yardConflict).length).toBeGreaterThan(0);
    expect(screen.getByTestId(TID.yardChart).getAttribute('data-conflict-count')).not.toBe('0');
  });

  it('reassigns a stop to the adjacent 番線 from the keyboard', () => {
    const onReassignTrack = vi.fn();
    mount(<StationYardChart stationId={TOY.stationC} onReassignTrack={onReassignTrack} />);
    // 各101 is on 2番線 (lane 1); ArrowUp moves it to 1番線.
    fireEvent.keyDown(screen.getByTestId(TID.yardBar(TOY.localDown)), { key: 'ArrowUp' });
    expect(onReassignTrack).toHaveBeenCalledWith(TOY.localDown, 2, TOY.c1);
  });

  it('does not run off the end of the lane list', () => {
    const onReassignTrack = vi.fn();
    mount(<StationYardChart stationId={TOY.stationC} onReassignTrack={onReassignTrack} />);
    const bar = screen.getByTestId(TID.yardBar(TOY.expressDown)); // 1番線, lane 0
    fireEvent.keyDown(bar, { key: 'ArrowUp' });
    expect(onReassignTrack).not.toHaveBeenCalled();
  });

  it('selects the stop when a bar is activated', () => {
    const onSelect = vi.fn();
    mount(<StationYardChart stationId={TOY.stationC} onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByTestId(TID.yardBar(TOY.localDown)), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(
      { kind: 'train', trainId: TOY.localDown, stopIndex: 2 },
      false,
    );
  });
});

describe('without a scene source', () => {
  it('every view still mounts and renders an empty shadow', () => {
    setRenderSceneSource(undefined);
    render(
      <>
        <LineViewCanvas />
        <StringDiagramCanvas />
        <StationYardChart stationId={TOY.stationC} />
      </>,
    );
    expect(screen.getByTestId(TID.lineViewTrains).children).toHaveLength(0);
    expect(screen.getByTestId(TID.diagramTrains).children).toHaveLength(0);
    expect(screen.getByTestId(TID.yardChart)).toBeTruthy();
  });
});
