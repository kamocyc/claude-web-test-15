/**
 * 運用 — duty composition and formation assignment.
 *
 * Drag and drop is a nice-to-have; the mandatory path is the button next to
 * every unassigned train, which opens a list of duties. Keyboard users and the
 * E2E suite use the same path, which means it cannot silently break.
 */

import { useMemo, useState } from 'react';
import { TID } from '@e2e/testids';

import { ID_PREFIX } from '@/domain/ids';
import type { DutyId, FormationId, TrainId } from '@/domain/ids';
import type { Duty, DutyLeg } from '@/domain/model';
import {
  dutyDistance,
  dutyOfTrainMap,
  dutySpan,
  trainEndSec,
  trainLabel,
  trainStartSec,
} from '@/domain/project';
import { formatTime } from '@/domain/time';
import { entityList, formatKm } from '@/domain/units';
import { newId } from '@/store/idPool';
import { useUiStore } from '@/store/uiStore';
import { Card, Field } from '../components/Field';
import { useDispatch, useDoc } from '../hooks';

import styles from './Editor.module.css';
import duties from './Duties.module.css';

const GANTT_W = 460;

export function DutiesScreen() {
  const doc = useDoc();
  const dispatch = useDispatch();
  const select = useUiStore((s) => s.select);
  const focusOn = useUiStore((s) => s.focusOn);

  const dayTypeId = doc.settings.activeDayTypeId;
  const date = doc.settings.activeDate;

  const dutyList = useMemo(
    () => entityList(doc.duties).filter((d) => d.dayTypeIds.includes(dayTypeId)),
    [doc, dayTypeId],
  );
  const formations = useMemo(() => entityList(doc.formations), [doc]);
  const coverage = useMemo(() => dutyOfTrainMap(doc), [doc]);
  const unassigned = useMemo(
    () =>
      entityList(doc.trains)
        .filter((t) => t.dayTypeIds.includes(dayTypeId))
        .filter((t) => !coverage.has(t.id))
        .sort((a, b) => (trainStartSec(a) ?? 0) - (trainStartSec(b) ?? 0)),
    [doc, coverage, dayTypeId],
  );

  const assignmentByDuty = useMemo(() => {
    const map = new Map<string, FormationId>();
    for (const a of entityList(doc.assignments)) {
      if (a.date === date) map.set(a.dutyId, a.formationId);
    }
    return map;
  }, [doc, date]);

  const window = useMemo(() => {
    let from = Number.POSITIVE_INFINITY;
    let to = Number.NEGATIVE_INFINITY;
    for (const duty of dutyList) {
      const span = dutySpan(doc, duty);
      if (span === undefined) continue;
      from = Math.min(from, span.from);
      to = Math.max(to, span.to);
    }
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return { from: doc.settings.serviceDayStartSec, to: doc.settings.serviceDayEndSec };
    }
    return { from, to };
  }, [doc, dutyList]);

  const [code, setCode] = useState('');
  const [openTrainId, setOpenTrainId] = useState<string | undefined>(undefined);

  const addDuty = (): void => {
    const trimmed = code.trim();
    const duty: Duty = {
      id: newId<'Duty'>(ID_PREFIX.duty),
      code: trimmed === '' ? String(dutyList.length + 1).padStart(2, '0') : trimmed,
      dayTypeIds: [dayTypeId],
      legs: [],
    };
    dispatch({ type: 'duty/add', duty });
    setCode('');
  };

  const addTrainToDuty = (trainId: TrainId, dutyId: DutyId): void => {
    const leg: DutyLeg = { kind: 'train', trainId };
    dispatch({ type: 'duty/insertLeg', dutyId, leg });
    dispatch({ type: 'duty/sortLegsByTime', dutyId });
    setOpenTrainId(undefined);
  };

  return (
    <div className={styles.screen}>
      <Card
        title="運用"
        actions={
          <>
            <Field label="運用番号">
              <input
                className={styles.narrow}
                data-testid={TID.dutyCodeInput}
                value={code}
                onChange={(e) => setCode(e.currentTarget.value)}
              />
            </Field>
            <button type="button" data-testid={TID.dutySubmit} onClick={addDuty}>
              追加
            </button>
            <button type="button" data-testid={TID.dutyAdd} onClick={addDuty}>
              運用を追加
            </button>
            <button
              type="button"
              data-testid={TID.dutyAutoAssign}
              onClick={() => dispatch({ type: 'duty/autoAssign', dayTypeId })}
            >
              運用を自動組成
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: 'assignment/autoFill', date })}
              disabled={dutyList.length === 0}
            >
              充当を自動設定
            </button>
          </>
        }
      >
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid={TID.dutyBoard}>
            <thead>
              <tr>
                <th>運用</th>
                <th>充当編成</th>
                <th>時間帯</th>
                <th>距離</th>
                <th>行路</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {dutyList.length === 0 ? (
                <tr>
                  <td colSpan={6} className={styles.empty}>
                    運用がありません
                  </td>
                </tr>
              ) : null}
              {dutyList.map((duty) => {
                const span = dutySpan(doc, duty);
                return (
                  <tr
                    key={duty.id}
                    data-testid={TID.dutyRow(duty.id)}
                    onClick={() => select({ kind: 'duty', dutyId: duty.id })}
                  >
                    <td>
                      <input
                        className={styles.narrow}
                        value={duty.code}
                        aria-label={`運用 ${duty.code} の番号`}
                        onChange={(e) =>
                          dispatch({
                            type: 'duty/update',
                            id: duty.id,
                            patch: { code: e.currentTarget.value },
                          })
                        }
                      />
                    </td>
                    <td>
                      <select
                        data-testid={TID.dutyFormationSelect(duty.id)}
                        aria-label={`運用 ${duty.code} の充当編成`}
                        value={assignmentByDuty.get(duty.id) ?? ''}
                        onChange={(e) => {
                          const value = e.currentTarget.value;
                          if (value === '') {
                            dispatch({ type: 'assignment/clear', date, dutyId: duty.id });
                            return;
                          }
                          dispatch({
                            type: 'assignment/set',
                            id: newId<'Assignment'>(ID_PREFIX.assignment),
                            date,
                            dutyId: duty.id,
                            formationId: value as FormationId,
                          });
                        }}
                      >
                        <option value="">未充当</option>
                        {formations.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.code} ({f.cars}両)
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={styles.num}>
                      {span === undefined
                        ? '—'
                        : `${formatTime(span.from)}–${formatTime(span.to)}`}
                    </td>
                    <td className={styles.num}>{formatKm(dutyDistance(doc, duty))}</td>
                    <td>
                      <DutyGantt duty={duty} from={window.from} to={window.to} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className={styles.danger}
                        onClick={() => dispatch({ type: 'duty/remove', dutyIds: [duty.id] })}
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={`未充当の列車 (${unassigned.length})`}>
        <ul className={duties.tray} data-testid={TID.unassignedTrains}>
          {unassigned.length === 0 ? (
            <li className={styles.empty}>すべての列車が運用に組み込まれています</li>
          ) : null}
          {unassigned.map((train) => {
            const start = trainStartSec(train);
            const end = trainEndSec(train);
            return (
              <li
                key={train.id}
                className={duties.trayItem}
                data-testid={TID.unassignedTrain(train.id)}
              >
                <button
                  type="button"
                  className={duties.trayLabel}
                  onClick={() =>
                    focusOn({ ref: { kind: 'train', trainId: train.id }, ...(start !== undefined ? { at: start } : {}) })
                  }
                >
                  {trainLabel(doc, train)}
                </button>
                <span className={duties.trayTime}>
                  {start === undefined ? '—' : formatTime(start)} →{' '}
                  {end === undefined ? '—' : formatTime(end)}
                </span>
                <button
                  type="button"
                  data-testid={TID.addTrainToDuty(train.id)}
                  onClick={() => setOpenTrainId(openTrainId === train.id ? undefined : train.id)}
                  aria-expanded={openTrainId === train.id}
                >
                  運用に追加 ▾
                </button>
                {openTrainId === train.id ? (
                  <ul className={duties.choiceList}>
                    {dutyList.length === 0 ? (
                      <li className={styles.empty}>先に運用を作成してください</li>
                    ) : null}
                    {dutyList.map((duty) => (
                      <li key={duty.id}>
                        <button
                          type="button"
                          data-testid={TID.addTrainToDutyChoice(duty.id)}
                          onClick={() => addTrainToDuty(train.id, duty.id)}
                        >
                          {duty.code}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

function DutyGantt({ duty, from, to }: { duty: Duty; from: number; to: number }) {
  const doc = useDoc();
  const dispatch = useDispatch();
  const focusOn = useUiStore((s) => s.focusOn);
  const span = to - from || 1;
  const x = (t: number): number => ((t - from) / span) * GANTT_W;

  return (
    <svg
      className={duties.gantt}
      width={GANTT_W}
      height={16}
      role="img"
      aria-label={`運用 ${duty.code} の行路`}
    >
      <rect x={0} y={7} width={GANTT_W} height={2} fill="var(--border)" />
      {duty.legs.map((leg, index) => {
        const bounds = legBounds(doc, leg);
        if (bounds === undefined) return null;
        const left = x(bounds.from);
        const width = Math.max(x(bounds.to) - left, 2);
        return (
          <g key={`${leg.kind}-${index}`}>
            <rect
              data-testid={TID.dutyLeg(duty.id, index)}
              x={left}
              y={2}
              width={width}
              height={12}
              rx={2}
              fill={legColor(leg)}
              stroke="var(--bg)"
              onClick={() => {
                if (leg.kind !== 'train') return;
                focusOn({ ref: { kind: 'train', trainId: leg.trainId }, at: bounds.from });
              }}
              onDoubleClick={() =>
                dispatch({ type: 'duty/removeLeg', dutyId: duty.id, legIndex: index })
              }
            >
              <title>{legTitle(doc, leg)}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}

function legBounds(
  doc: ReturnType<typeof useDoc>,
  leg: DutyLeg,
): { from: number; to: number } | undefined {
  if (leg.kind !== 'train') return { from: leg.from, to: leg.to };
  const train = doc.trains.byId[leg.trainId];
  if (train === undefined) return undefined;
  const from = trainStartSec(train);
  const to = trainEndSec(train);
  if (from === undefined || to === undefined) return undefined;
  return { from, to };
}

function legColor(leg: DutyLeg): string {
  if (leg.kind === 'stable') return 'var(--text-faint)';
  if (leg.kind === 'inspection') return 'var(--warning)';
  return 'var(--accent-dim)';
}

function legTitle(doc: ReturnType<typeof useDoc>, leg: DutyLeg): string {
  if (leg.kind === 'train') {
    const train = doc.trains.byId[leg.trainId];
    return train === undefined ? '(削除済み)' : trainLabel(doc, train);
  }
  if (leg.kind === 'stable') {
    return `留置 ${doc.stations.byId[leg.stationId]?.name ?? ''}`;
  }
  return `検査 ${doc.depots.byId[leg.depotId]?.name ?? ''}`;
}
