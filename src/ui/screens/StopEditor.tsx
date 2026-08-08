/**
 * 停車設定 — everything about ONE stop of ONE train that the grid itself has no
 * room for: 停車/通過, 運転停車, メモ, and the two authored-intent lists the whole
 * product is built around, 待避 (`overtakenBy`) and 緩急接続 (`connectsTo`).
 *
 * The candidate lists are the interesting part. A weekday has ~600 trains and
 * an unfiltered picker is useless, so a train only appears if it could
 * plausibly be the other half of the relationship:
 *
 *   待避 — same direction, calls at this station, and is there while this train
 *          stands (arrival → departure, widened by a tolerance so a timetable
 *          that is still being authored can still declare the intent).
 *   接続 — same direction, passenger service, and departs this station inside
 *          the transfer window the validation config already uses, from a
 *          little before this train arrives to `connectionMaxWaitSec` after.
 *
 * Anything already declared is always listed even when it falls outside the
 * window: a declaration you cannot see is a declaration you cannot undo.
 */

import { useMemo } from 'react';
import { TID } from '@e2e/testids';

import type { TrainId } from '@/domain/ids';
import type { ProjectDocument, StopKind, Train, TrainStop } from '@/domain/model';
import { trainLabel } from '@/domain/project';
import { formatTime } from '@/domain/time';
import { entityList } from '@/domain/units';
import { Card, CheckField, Field } from '../components/Field';
import { useDispatch } from '../hooks';
import { clearing } from '../patch';

import styles from './Editor.module.css';
import grid from './Timetable.module.css';

/** How far outside the exact window a candidate may still sit, in seconds. */
const OVERTAKE_TOLERANCE_SEC = 10 * 60;
const CONNECT_LEAD_SEC = 5 * 60;
const MAX_CANDIDATES = 14;

export interface StopCandidate {
  train: Train;
  /** The moment that train is at this station. */
  at: number | undefined;
  label: string;
  declared: boolean;
}

function timeAt(stop: TrainStop | undefined): number | undefined {
  return stop?.arr ?? stop?.dep;
}

function departureAt(stop: TrainStop | undefined): number | undefined {
  return stop?.dep ?? stop?.arr;
}

function findStop(train: Train, stationId: string): TrainStop | undefined {
  return train.stops.find((s) => s.stationId === stationId);
}

function sharesDayType(a: Train, b: Train): boolean {
  if (a.dayTypeIds.length === 0 || b.dayTypeIds.length === 0) return true;
  return a.dayTypeIds.some((id) => b.dayTypeIds.includes(id));
}

function order(list: StopCandidate[], pivot: number | undefined): StopCandidate[] {
  const key = (c: StopCandidate): number =>
    c.at === undefined || pivot === undefined ? Number.MAX_SAFE_INTEGER : Math.abs(c.at - pivot);
  return list
    .slice()
    .sort((a, b) => (a.declared === b.declared ? key(a) - key(b) : a.declared ? -1 : 1))
    .slice(0, MAX_CANDIDATES);
}

/**
 * Trains that could overtake `train` while it stands at `stops[stopIndex]`.
 * Exported so the filtering rule can be unit-tested without a DOM.
 */
export function overtakeCandidates(
  doc: ProjectDocument,
  train: Train,
  stopIndex: number,
): StopCandidate[] {
  const stop = train.stops[stopIndex];
  if (stop === undefined) return [];
  const declared = new Set<string>(stop.overtakenBy ?? []);
  const arr = stop.arr ?? stop.dep;
  const dep = stop.dep ?? stop.arr;
  const from = arr === undefined ? undefined : arr - OVERTAKE_TOLERANCE_SEC;
  const to = dep === undefined ? undefined : dep + OVERTAKE_TOLERANCE_SEC;

  const out: StopCandidate[] = [];
  for (const other of entityList(doc.trains)) {
    if (other.id === train.id) continue;
    const isDeclared = declared.has(other.id);
    if (!isDeclared) {
      if (other.direction !== train.direction) continue;
      if (!sharesDayType(train, other)) continue;
    }
    const otherStop = findStop(other, stop.stationId);
    if (otherStop === undefined) continue;
    const at = timeAt(otherStop);
    if (!isDeclared) {
      if (at === undefined || from === undefined || to === undefined) continue;
      if (at < from || at > to) continue;
    }
    out.push({ train: other, at, label: trainLabel(doc, other), declared: isDeclared });
  }
  return order(out, arr);
}

/** Trains this train could hand passengers over to at `stops[stopIndex]`. */
export function connectionCandidates(
  doc: ProjectDocument,
  train: Train,
  stopIndex: number,
): StopCandidate[] {
  const stop = train.stops[stopIndex];
  if (stop === undefined) return [];
  const declared = new Set<string>(stop.connectsTo ?? []);
  const arr = stop.arr ?? stop.dep;
  const from = arr === undefined ? undefined : arr - CONNECT_LEAD_SEC;
  const to = arr === undefined ? undefined : arr + doc.validationConfig.connectionMaxWaitSec + CONNECT_LEAD_SEC;

  const out: StopCandidate[] = [];
  for (const other of entityList(doc.trains)) {
    if (other.id === train.id) continue;
    const isDeclared = declared.has(other.id);
    if (!isDeclared) {
      if (other.direction !== train.direction) continue;
      if (!sharesDayType(train, other)) continue;
      if (doc.trainTypes.byId[other.typeId]?.isPassengerService === false) continue;
    }
    const otherStop = findStop(other, stop.stationId);
    if (otherStop === undefined) continue;
    const at = departureAt(otherStop);
    if (!isDeclared) {
      if (at === undefined || from === undefined || to === undefined) continue;
      if (at < from || at > to) continue;
    }
    out.push({ train: other, at, label: trainLabel(doc, other), declared: isDeclared });
  }
  return order(out, arr);
}

export interface StopEditorProps {
  doc: ProjectDocument;
  train: Train | undefined;
  stopIndex: number | undefined;
}

export function StopEditor({ doc, train, stopIndex }: StopEditorProps) {
  const dispatch = useDispatch();
  const stop = train !== undefined && stopIndex !== undefined ? train.stops[stopIndex] : undefined;

  const overtakes = useMemo(
    () =>
      train === undefined || stopIndex === undefined ? [] : overtakeCandidates(doc, train, stopIndex),
    [doc, train, stopIndex],
  );
  const connections = useMemo(
    () =>
      train === undefined || stopIndex === undefined
        ? []
        : connectionCandidates(doc, train, stopIndex),
    [doc, train, stopIndex],
  );

  if (train === undefined || stopIndex === undefined || stop === undefined) {
    return (
      <Card title="停車設定 / 待避・緩急接続">
        <p className={styles.empty} data-testid={TID.stopEditorEmpty}>
          時刻表のセルを選ぶと、その停車の待避・接続を設定できます。
        </p>
      </Card>
    );
  }

  const station = doc.stations.byId[stop.stationId];
  const chosenOvertake = stop.overtakenBy ?? [];
  const chosenConnect = stop.connectsTo ?? [];

  const toggleOvertake = (otherId: TrainId, on: boolean): void => {
    const next = on
      ? [...chosenOvertake.filter((id) => id !== otherId), otherId]
      : chosenOvertake.filter((id) => id !== otherId);
    dispatch({ type: 'train/setOvertakenBy', trainId: train.id, stopIndex, trainIds: next });
  };

  const toggleConnect = (otherId: TrainId, on: boolean): void => {
    const next = on
      ? [...chosenConnect.filter((id) => id !== otherId), otherId]
      : chosenConnect.filter((id) => id !== otherId);
    dispatch({ type: 'train/setConnectsTo', trainId: train.id, stopIndex, trainIds: next });
  };

  return (
    <Card
      title="停車設定 / 待避・緩急接続"
      actions={
        <span className={styles.hint} data-testid={TID.stopEditorTitle}>
          {trainLabel(doc, train)} — {station?.name ?? '?'}{' '}
          {stop.arr === undefined ? '' : formatTime(stop.arr)}
          {stop.arr !== undefined && stop.dep !== undefined ? '→' : ''}
          {stop.dep === undefined ? '' : formatTime(stop.dep)}
        </span>
      }
    >
      <div className={styles.form} data-testid={TID.stopEditor}>
        <Field label="停車/通過">
          <select
            data-testid={TID.stopKindSelect}
            value={stop.kind}
            onChange={(e) =>
              dispatch({
                type: 'train/setStopKind',
                trainId: train.id,
                stopIndex,
                kind: e.currentTarget.value as StopKind,
              })
            }
          >
            <option value="stop">停車</option>
            <option value="pass">通過</option>
          </select>
        </Field>
        <CheckField
          label="運転停車"
          testid={TID.stopOperational}
          checked={stop.operational === true}
          onChange={(on) =>
            dispatch({
              type: 'train/setStopFlags',
              trainId: train.id,
              stopIndex,
              ...(on ? { operational: true } : clearing<{ operational: boolean }>('operational')),
            })
          }
        />
        <Field label="メモ">
          <input
            className={styles.wide}
            data-testid={TID.stopNoteInput}
            value={stop.note ?? ''}
            onChange={(e) => {
              const text = e.currentTarget.value;
              dispatch({
                type: 'train/setStopFlags',
                trainId: train.id,
                stopIndex,
                ...(text === '' ? clearing<{ note: string }>('note') : { note: text }),
              });
            }}
          />
        </Field>
      </div>

      <div className={styles.columns}>
        <div>
          <h3 className={grid.subTitle}>
            待避 — この列車を追い抜く列車
            <button
              type="button"
              data-testid={TID.overtakeClear}
              disabled={chosenOvertake.length === 0}
              onClick={() =>
                dispatch({
                  type: 'train/setOvertakenBy',
                  trainId: train.id,
                  stopIndex,
                  trainIds: [],
                })
              }
            >
              すべて解除
            </button>
          </h3>
          <CandidateList
            testid={TID.overtakeList}
            emptyTestid={TID.overtakeEmpty}
            emptyText="この時間帯に同方向で通過する列車がありません"
            candidates={overtakes}
            chosen={chosenOvertake}
            makeTestid={TID.overtakeCandidate}
            onToggle={toggleOvertake}
          />
        </div>

        <div>
          <h3 className={grid.subTitle}>
            緩急接続 — 乗り継ぐ相手列車
            <button
              type="button"
              data-testid={TID.connectClear}
              disabled={chosenConnect.length === 0}
              onClick={() =>
                dispatch({ type: 'train/setConnectsTo', trainId: train.id, stopIndex, trainIds: [] })
              }
            >
              すべて解除
            </button>
          </h3>
          <CandidateList
            testid={TID.connectList}
            emptyTestid={TID.connectEmpty}
            emptyText="乗り換え可能時分の範囲に発車する列車がありません"
            candidates={connections}
            chosen={chosenConnect}
            makeTestid={TID.connectCandidate}
            onToggle={toggleConnect}
          />
          {station?.isConnectionPoint === false ? (
            <p className={styles.hint}>
              この駅は接続駅に指定されていません。「駅・線路」画面で接続駅にすると接続の検証が働きます。
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function CandidateList({
  testid,
  emptyTestid,
  emptyText,
  candidates,
  chosen,
  makeTestid,
  onToggle,
}: {
  testid: string;
  emptyTestid: string;
  emptyText: string;
  candidates: StopCandidate[];
  chosen: readonly TrainId[];
  makeTestid(trainId: string): string;
  onToggle(trainId: TrainId, on: boolean): void;
}) {
  if (candidates.length === 0) {
    return (
      <p className={styles.empty} data-testid={emptyTestid}>
        {emptyText}
      </p>
    );
  }
  return (
    <ul className={grid.candidateList} data-testid={testid}>
      {candidates.map((candidate) => {
        const on = chosen.includes(candidate.train.id);
        return (
          <li key={candidate.train.id} className={grid.candidate}>
            <label>
              <input
                type="checkbox"
                data-testid={makeTestid(candidate.train.id)}
                checked={on}
                onChange={(e) => onToggle(candidate.train.id, e.currentTarget.checked)}
              />
              <span>{candidate.label}</span>
              <span className={grid.candidateTime}>
                {candidate.at === undefined ? '—' : formatTime(candidate.at)}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
