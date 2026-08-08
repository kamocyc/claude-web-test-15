/**
 * The OuDia-style timetable grid.
 *
 * Rows are stations (着 / 発 / 番線 sub-rows), columns are trains — the
 * orientation Japanese timetable authors expect. Columns are virtualized
 * because a real weekday is ~500 of them, and the whole thing is keyboard
 * driven: the cell cursor moves with the arrow keys, typing `0743` and pressing
 * Enter writes 07:43.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { TID } from '@e2e/testids';

import { ID_PREFIX } from '@/domain/ids';
import type { StationTrackId, TrainId } from '@/domain/ids';
import type { Train, TrainStop } from '@/domain/model';
import {
  allStationsInKmOrder,
  stopsFromPattern,
  tracksOfStation,
} from '@/domain/project';
import { formatTime, parseTime } from '@/domain/time';
import { entityList } from '@/domain/units';
import { newId } from '@/store/idPool';
import { recomputeTrainTimes } from '@/store/reducer';
import { useUiStore } from '@/store/uiStore';
import { useDispatch, useDoc } from '../hooks';
import { StopEditor } from './StopEditor';
import { TrainDeleteDialog, TrainEditor } from './TrainEditor';

import styles from './Timetable.module.css';

const ROW_H = 22;
const HEADER_H = 60;
const COL_W = 62;
const NAME_W = 96;
const LABEL_W = 26;

type Field = 'arr' | 'dep' | 'track';
const FIELDS: Field[] = ['arr', 'dep', 'track'];
const FIELD_LABEL: Record<Field, string> = { arr: '着', dep: '発', track: '番' };

interface Cursor {
  col: number;
  /** stationIndex * 3 + fieldIndex */
  row: number;
}

const FALLBACK_VIEWPORT_W = 1100;

/**
 * Measure the scroll container, treating a zero-width rect as "not laid out
 * yet" and substituting a nominal viewport. Without this the grid renders zero
 * columns anywhere `getBoundingClientRect` returns zeros — jsdom, a hidden tab,
 * a print stylesheet — which looks exactly like data loss.
 */
function observeWidthWithFallback(
  instance: { scrollElement: Element | null | undefined },
  cb: (rect: { width: number; height: number }) => void,
): (() => void) | undefined {
  const element = instance.scrollElement;
  if (!element) return undefined;
  const measure = (): void => {
    const rect = element.getBoundingClientRect();
    cb({ width: rect.width || FALLBACK_VIEWPORT_W, height: rect.height || HEADER_H });
  };
  measure();
  if (typeof ResizeObserver === 'undefined') return undefined;
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  return () => observer.disconnect();
}

function cellTestId(trainId: string, stopIndex: number, field: Field): string {
  return field === 'track'
    ? TID.trackCell(trainId, stopIndex)
    : TID.timeCell(trainId, stopIndex, field);
}

export function TimetableScreen() {
  const doc = useDoc();
  const dispatch = useDispatch();
  const select = useUiStore((s) => s.select);
  const selectedTrainId = useUiStore((s) =>
    s.selected[0]?.kind === 'train' ? s.selected[0].trainId : undefined,
  );
  const focusTarget = useUiStore((s) => s.focusTarget);

  const stations = useMemo(() => allStationsInKmOrder(doc), [doc]);
  const trains = useMemo(() => entityList(doc.trains), [doc]);

  const stopIndexMaps = useMemo(
    () =>
      new Map<string, Map<string, number>>(
        trains.map((t) => {
          const map = new Map<string, number>();
          t.stops.forEach((s, i) => map.set(s.stationId, i));
          return [t.id, map];
        }),
      ),
    [trains],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [cursor, setCursor] = useState<Cursor>({ col: 0, row: 0 });
  const [editing, setEditing] = useState<{ key: string; text: string } | undefined>(undefined);
  const [deleteTrainId, setDeleteTrainId] = useState<TrainId | undefined>(undefined);

  const virtualizer = useVirtualizer({
    count: trains.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => COL_W,
    horizontal: true,
    overscan: 8,
    initialRect: { width: FALLBACK_VIEWPORT_W, height: HEADER_H },
    observeElementRect: observeWidthWithFallback,
  });

  // A focus request from the problem panel scrolls its train into view.
  useEffect(() => {
    if (focusTarget === undefined || focusTarget.ref.kind !== 'train') return;
    const trainId = focusTarget.ref.trainId;
    const col = trains.findIndex((t) => t.id === trainId);
    if (col >= 0) {
      virtualizer.scrollToIndex(col, { align: 'center' });
      setCursor((c) => ({ ...c, col }));
    }
  }, [focusTarget, trains, virtualizer]);

  const focusCell = useCallback(
    (next: Cursor) => {
      const train = trains[next.col];
      if (train === undefined) return;
      const stationIndex = Math.floor(next.row / 3);
      const field = FIELDS[next.row % 3];
      const station = stations[stationIndex];
      if (station === undefined || field === undefined) return;
      const stopIndex = stopIndexMaps.get(train.id)?.get(station.id);
      if (stopIndex === undefined) return;
      virtualizer.scrollToIndex(next.col, { align: 'auto' });
      const testid = cellTestId(train.id, stopIndex, field);
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
        el?.focus();
        if (el instanceof HTMLInputElement) el.select();
      });
    },
    [stations, stopIndexMaps, trains, virtualizer],
  );

  /**
   * Step the cursor one cell, then keep stepping past cells the train has no
   * stop for. Running out of grid leaves the cursor exactly where it was —
   * a keypress that cannot go anywhere should do nothing, not jump.
   */
  const move = useCallback(
    (dRow: number, dCol: number) => {
      const lastRow = stations.length * 3 - 1;
      const lastCol = trains.length - 1;
      if (lastRow < 0 || lastCol < 0) return;

      const served = (col: number, row: number): boolean => {
        const train = trains[col];
        const station = stations[Math.floor(row / 3)];
        if (train === undefined || station === undefined) return false;
        return stopIndexMaps.get(train.id)?.has(station.id) === true;
      };

      let col = cursor.col;
      let row = cursor.row;
      const steps = dRow !== 0 ? lastRow + 1 : lastCol + 1;
      for (let i = 0; i < steps; i++) {
        const nextCol = col + dCol;
        const nextRow = row + dRow;
        if (nextCol < 0 || nextCol > lastCol || nextRow < 0 || nextRow > lastRow) return;
        col = nextCol;
        row = nextRow;
        if (served(col, row)) {
          const next = { col, row };
          setCursor(next);
          setEditing(undefined);
          focusCell(next);
          return;
        }
      }
    },
    [cursor, focusCell, stations, stopIndexMaps, trains],
  );

  const commit = useCallback(
    (train: Train, stopIndex: number, field: 'arr' | 'dep', text: string) => {
      const trimmed = text.trim();
      if (trimmed === '') {
        dispatch({
          type: 'train/setStopTime',
          trainId: train.id,
          stopIndex,
          field,
          value: undefined,
        });
        return true;
      }
      const value = parseTime(trimmed);
      if (value === undefined) return false;
      dispatch({ type: 'train/setStopTime', trainId: train.id, stopIndex, field, value });
      return true;
    },
    [dispatch],
  );

  const onCellKeyDown = useCallback(
    (
      e: React.KeyboardEvent<HTMLInputElement>,
      train: Train,
      stopIndex: number,
      field: 'arr' | 'dep',
      key: string,
    ) => {
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          move(-1, 0);
          return;
        case 'ArrowDown':
          e.preventDefault();
          move(1, 0);
          return;
        case 'ArrowLeft':
          e.preventDefault();
          move(0, -1);
          return;
        case 'ArrowRight':
          e.preventDefault();
          move(0, 1);
          return;
        case 'Escape':
          e.preventDefault();
          setEditing(undefined);
          e.currentTarget.blur();
          return;
        case 'Enter':
          e.preventDefault();
          if (editing?.key === key) commit(train, stopIndex, field, editing.text);
          setEditing(undefined);
          move(1, 0);
          return;
        case 'Tab':
          e.preventDefault();
          if (editing?.key === key) commit(train, stopIndex, field, editing.text);
          setEditing(undefined);
          move(0, e.shiftKey ? -1 : 1);
          return;
        default:
          return;
      }
    },
    [commit, editing, move],
  );

  const totalHeight = HEADER_H + stations.length * 3 * ROW_H;
  const cursorTrain = trains[cursor.col];

  // The stop the two editors below the grid act on: whichever cell the cursor
  // is in. Selecting a column header moves the cursor too, so clicking a train
  // and then a station is enough to reach any stop.
  const cursorStation = stations[Math.floor(cursor.row / 3)];
  const cursorStopIndex =
    cursorTrain !== undefined && cursorStation !== undefined
      ? stopIndexMaps.get(cursorTrain.id)?.get(cursorStation.id)
      : undefined;
  const deleteTrain = deleteTrainId === undefined ? undefined : doc.trains.byId[deleteTrainId];

  return (
    <div className={styles.screen}>
      <TrainAddForm />

      <div className={styles.toolbar}>
        <button
          type="button"
          data-testid={TID.autoAssignTracks}
          onClick={() => dispatch({ type: 'train/autoAssignTracks' })}
          disabled={trains.length === 0}
        >
          番線を自動割付
        </button>
        <button
          type="button"
          data-testid={TID.recomputeTimes}
          disabled={cursorTrain === undefined && selectedTrainId === undefined}
          onClick={() => {
            const trainId = (selectedTrainId ?? cursorTrain?.id) as TrainId | undefined;
            if (trainId === undefined) return;
            dispatch({ type: 'train/recomputeTimes', trainId });
          }}
        >
          時刻を再計算
        </button>
        <span className={styles.hint}>
          矢印キーでセル移動 / 数字を入力して Enter・Tab で確定 / Esc で取消
        </span>
      </div>

      <div className={styles.editors}>
        <TrainEditor
          doc={doc}
          train={cursorTrain}
          onRequestDelete={() => {
            if (cursorTrain !== undefined) setDeleteTrainId(cursorTrain.id);
          }}
        />
        <StopEditor doc={doc} train={cursorTrain} stopIndex={cursorStopIndex} />
      </div>

      {stations.length === 0 ? (
        <p className={styles.empty}>
          駅がまだありません。「駅・線路」画面で駅を追加してください。
        </p>
      ) : (
        <div className={styles.grid} data-testid={TID.timetableGrid}>
          <div className={styles.leftPane} style={{ width: NAME_W + LABEL_W }}>
            <div className={styles.headerCell} style={{ height: HEADER_H }}>
              <span className={styles.headerType}>駅 / 種別</span>
            </div>
            {stations.map((station) => (
              <div key={station.id} className={styles.stationBlock} style={{ height: ROW_H * 3 }}>
                <button
                  type="button"
                  className={`${styles.stationName} ${station.kind === 'depot' ? styles.stationDepot : ''}`}
                  style={{ width: NAME_W, background: 'transparent', border: 0 }}
                  onClick={() => select({ kind: 'station', stationId: station.id })}
                  title={station.name}
                >
                  {station.name}
                </button>
                <div className={styles.labelColumn} style={{ width: LABEL_W }}>
                  {FIELDS.map((f) => (
                    <div key={f} className={styles.rowLabel} style={{ height: ROW_H }}>
                      {FIELD_LABEL[f]}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className={styles.rightPane} ref={scrollRef}>
            <div
              className={styles.canvas}
              style={{ width: Math.max(virtualizer.getTotalSize(), 1), height: totalHeight }}
            >
              {virtualizer.getVirtualItems().map((item) => {
                const train = trains[item.index];
                if (train === undefined) return null;
                const type = doc.trainTypes.byId[train.typeId];
                const stopMap = stopIndexMaps.get(train.id);
                return (
                  <div
                    key={train.id}
                    data-testid={TID.trainColumn(train.id)}
                    className={`${styles.column} ${selectedTrainId === train.id ? styles.columnSelected : ''}`}
                    style={{ left: item.start, width: item.size, height: totalHeight }}
                  >
                    <div className={styles.headerCell} style={{ height: HEADER_H }}>
                      <button
                        type="button"
                        className={styles.headerButton}
                        data-testid={TID.trainHeaderNumber(train.id)}
                        onClick={() => {
                          select({ kind: 'train', trainId: train.id });
                          setCursor((c) => ({ ...c, col: item.index }));
                        }}
                        title={`${type?.name ?? ''} ${train.number} — クリックで下の編集欄に読み込みます`}
                      >
                        <span
                          className={styles.headerType}
                          style={{ color: type?.color ?? 'var(--text-dim)' }}
                        >
                          {type?.shortName ?? '—'}
                        </span>
                        <br />
                        <span className={styles.headerNumber}>{train.number}</span>
                      </button>
                      <button
                        type="button"
                        className={styles.headerDelete}
                        data-testid={TID.trainDelete(train.id)}
                        aria-label={`列車 ${train.number} を削除`}
                        title={`列車 ${train.number} を削除`}
                        onClick={() => setDeleteTrainId(train.id)}
                      >
                        削除
                      </button>
                    </div>
                    {stations.map((station, stationIndex) => {
                      const stopIndex = stopMap?.get(station.id);
                      if (stopIndex === undefined) {
                        return (
                          <div
                            key={station.id}
                            className={styles.cellGroup}
                            style={{ height: ROW_H * 3 }}
                          >
                            {FIELDS.map((f) => (
                              <div
                                key={f}
                                className={styles.cellEmpty}
                                style={{ height: ROW_H }}
                              >
                                {f === 'dep' ? '↓' : ''}
                              </div>
                            ))}
                          </div>
                        );
                      }
                      const stop = train.stops[stopIndex]!;
                      return (
                        <div
                          key={station.id}
                          className={styles.cellGroup}
                          style={{ height: ROW_H * 3 }}
                        >
                          <TimeCell
                            train={train}
                            stop={stop}
                            stopIndex={stopIndex}
                            field="arr"
                            editing={editing}
                            setEditing={setEditing}
                            commit={commit}
                            onKeyDown={onCellKeyDown}
                            onFocusCell={() =>
                              setCursor({ col: item.index, row: stationIndex * 3 })
                            }
                          />
                          <TimeCell
                            train={train}
                            stop={stop}
                            stopIndex={stopIndex}
                            field="dep"
                            editing={editing}
                            setEditing={setEditing}
                            commit={commit}
                            onKeyDown={onCellKeyDown}
                            onFocusCell={() =>
                              setCursor({ col: item.index, row: stationIndex * 3 + 1 })
                            }
                          />
                          <select
                            className={styles.trackCell}
                            style={{ height: ROW_H }}
                            data-testid={TID.trackCell(train.id, stopIndex)}
                            value={stop.trackId ?? ''}
                            onFocus={() =>
                              setCursor({ col: item.index, row: stationIndex * 3 + 2 })
                            }
                            aria-label={`${train.number} ${station.name} 番線`}
                            onChange={(e) =>
                              dispatch({
                                type: 'train/setStopTrack',
                                trainId: train.id,
                                stopIndex,
                                trackId:
                                  e.currentTarget.value === ''
                                    ? undefined
                                    : (e.currentTarget.value as StationTrackId),
                              })
                            }
                          >
                            <option value="">—</option>
                            {tracksOfStation(doc, station.id).map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {deleteTrain !== undefined ? (
        <TrainDeleteDialog
          doc={doc}
          train={deleteTrain}
          onCancel={() => setDeleteTrainId(undefined)}
          onConfirm={() => {
            dispatch({ type: 'train/remove', trainIds: [deleteTrain.id] });
            setDeleteTrainId(undefined);
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface TimeCellProps {
  train: Train;
  stop: TrainStop;
  stopIndex: number;
  field: 'arr' | 'dep';
  editing: { key: string; text: string } | undefined;
  setEditing(next: { key: string; text: string } | undefined): void;
  commit(train: Train, stopIndex: number, field: 'arr' | 'dep', text: string): boolean;
  onKeyDown(
    e: React.KeyboardEvent<HTMLInputElement>,
    train: Train,
    stopIndex: number,
    field: 'arr' | 'dep',
    key: string,
  ): void;
  onFocusCell(): void;
}

function TimeCell({
  train,
  stop,
  stopIndex,
  field,
  editing,
  setEditing,
  commit,
  onKeyDown,
  onFocusCell,
}: TimeCellProps) {
  const key = `${train.id}:${stopIndex}:${field}`;
  const raw = stop[field];
  const display = raw === undefined ? '' : formatTime(raw);
  const value = editing?.key === key ? editing.text : display;

  return (
    <input
      type="text"
      inputMode="numeric"
      className={`${styles.cell} ${stop.kind === 'pass' ? styles.cellPass : ''}`}
      style={{ height: ROW_H }}
      data-testid={cellTestId(train.id, stopIndex, field)}
      data-value={raw === undefined ? '' : String(raw)}
      aria-label={`${train.number} ${field === 'arr' ? '着' : '発'}`}
      value={value}
      onChange={(e) => setEditing({ key, text: e.currentTarget.value })}
      onFocus={(e) => {
        onFocusCell();
        e.currentTarget.select();
      }}
      onBlur={() => {
        if (editing?.key !== key) return;
        commit(train, stopIndex, field, editing.text);
        setEditing(undefined);
      }}
      onKeyDown={(e) => onKeyDown(e, train, stopIndex, field, key)}
    />
  );
}

// ---------------------------------------------------------------------------
// 列車を追加 — the form the E2E suite builds a timetable with.
// ---------------------------------------------------------------------------

function TrainAddForm() {
  const doc = useDoc();
  const dispatch = useDispatch();
  const trainTypes = useMemo(() => entityList(doc.trainTypes), [doc]);
  const patterns = useMemo(() => entityList(doc.stopPatterns), [doc]);

  const [number, setNumber] = useState('');
  const [typeId, setTypeId] = useState('');
  const [patternId, setPatternId] = useState('');
  const [originDep, setOriginDep] = useState('');
  const [error, setError] = useState('');

  const effectiveTypeId = typeId !== '' ? typeId : (trainTypes[0]?.id ?? '');
  const visiblePatterns = patterns.filter(
    (p) => effectiveTypeId === '' || p.trainTypeId === effectiveTypeId,
  );
  const effectivePatternId =
    patternId !== '' && visiblePatterns.some((p) => p.id === patternId)
      ? patternId
      : (visiblePatterns[0]?.id ?? '');

  const submit = (): void => {
    setError('');
    const type = doc.trainTypes.byId[effectiveTypeId];
    if (type === undefined) {
      setError('種別を先に作成してください');
      return;
    }
    const pattern = doc.stopPatterns.byId[effectivePatternId];
    if (pattern === undefined) {
      setError('停車パターンを先に作成してください');
      return;
    }
    const stops = stopsFromPattern(doc, pattern.id);
    if (stops === undefined || stops.length < 2) {
      setError('このパターンには 2 駅以上の停車が必要です');
      return;
    }
    const dep = parseTime(originDep);
    if (dep === undefined) {
      setError('始発時刻を 0743 のように入力してください');
      return;
    }

    const originKm = doc.stations.byId[pattern.originStationId]?.kmFromOrigin ?? 0;
    const terminusKm = doc.stations.byId[pattern.terminusStationId]?.kmFromOrigin ?? 0;
    const direction =
      pattern.direction === 'both' ? (terminusKm >= originKm ? 'down' : 'up') : pattern.direction;

    const train: Train = {
      id: newId<'Train'>(ID_PREFIX.train),
      number: number.trim() === '' ? String(doc.trains.allIds.length + 1) : number.trim(),
      typeId: type.id,
      direction,
      category: type.isPassengerService ? 'service' : 'deadhead',
      patternId: pattern.id,
      stops,
      dayTypeIds: [doc.settings.activeDayTypeId],
    };
    stops[0]!.dep = dep;
    // Fill the rest of the column in one command, so one undo removes the train.
    recomputeTrainTimes(doc, train);

    dispatch({ type: 'train/add', train });
    setNumber('');
    setOriginDep('');
  };

  return (
    <div className={styles.toolbar}>
      <button
        type="button"
        data-testid={TID.trainAdd}
        onClick={() => {
          if (originDep.trim() !== '') {
            submit();
            return;
          }
          document.querySelector<HTMLInputElement>(`[data-testid="${TID.trainNumberInput}"]`)?.focus();
        }}
      >
        列車を追加
      </button>
      <label className={styles.hint}>
        列車番号
        <br />
        <input
          data-testid={TID.trainNumberInput}
          value={number}
          size={7}
          onChange={(e) => setNumber(e.currentTarget.value)}
        />
      </label>
      <label className={styles.hint}>
        種別
        <br />
        <select
          data-testid={TID.trainTypeSelect}
          value={effectiveTypeId}
          onChange={(e) => {
            setTypeId(e.currentTarget.value);
            setPatternId('');
          }}
        >
          {trainTypes.length === 0 ? <option value="">(種別なし)</option> : null}
          {trainTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.hint}>
        停車パターン
        <br />
        <select
          data-testid={TID.trainPatternSelect}
          value={effectivePatternId}
          onChange={(e) => setPatternId(e.currentTarget.value)}
        >
          {visiblePatterns.length === 0 ? <option value="">(パターンなし)</option> : null}
          {visiblePatterns.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.hint}>
        始発時刻
        <br />
        <input
          data-testid={TID.trainOriginDepInput}
          value={originDep}
          size={7}
          placeholder="0743"
          onChange={(e) => setOriginDep(e.currentTarget.value)}
        />
      </label>
      <button type="button" data-testid={TID.trainSubmit} onClick={submit}>
        追加
      </button>
      {error !== '' ? <span style={{ color: 'var(--error)' }}>{error}</span> : null}
    </div>
  );
}
