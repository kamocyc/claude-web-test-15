/**
 * 運用 — duty composition and formation assignment.
 *
 * Drag and drop is a nice-to-have; the mandatory path is the button next to
 * every unassigned train, which opens a list of duties. Keyboard users and the
 * E2E suite use the same path, which means it cannot silently break.
 */

import { Fragment, useMemo, useState } from 'react';
import { TID } from '@e2e/testids';

import { ID_PREFIX } from '@/domain/ids';
import type { DayTypeId, DepotId, DutyId, FormationId, SeriesId, StationId, TrainId } from '@/domain/ids';
import type { Duty, DutyLeg, InspectionKind, ProjectDocument } from '@/domain/model';
import { INSPECTION_KIND_LABEL } from '@/domain/model';
import {
  dutyDistance,
  dutyLegEndpoints,
  dutyLegSpan,
  dutyOfTrainMap,
  dutySpan,
  trainEndSec,
  trainLabel,
  trainStartSec,
} from '@/domain/project';
import { formatTime, parseTime } from '@/domain/time';
import { entityList, formatKm } from '@/domain/units';
import { newId } from '@/store/idPool';
import { useUiStore } from '@/store/uiStore';
import { Card, Field } from '../components/Field';
import { useDispatch, useDoc } from '../hooks';
import { clearing, numberOrUndefined } from '../patch';

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
  const [expandedDutyId, setExpandedDutyId] = useState<string | undefined>(undefined);

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
                const expanded = expandedDutyId === duty.id;
                return (
                  <Fragment key={duty.id}>
                  <tr
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
                        data-testid={TID.dutyExpand(duty.id)}
                        aria-expanded={expanded}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedDutyId(expanded ? undefined : duty.id);
                        }}
                      >
                        行路を編集
                      </button>
                      <button
                        type="button"
                        className={styles.danger}
                        onClick={() => dispatch({ type: 'duty/remove', dutyIds: [duty.id] })}
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                  {expanded ? (
                    <tr>
                      <td colSpan={6}>
                        <DutyDetail duty={duty} />
                      </td>
                    </tr>
                  ) : null}
                  </Fragment>
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

/**
 * The legs of one duty, in order, plus the constraints that decide which
 * formation may work it.
 *
 * 留置 and 検査 legs render in the Gantt and in the continuity check but had no
 * way to be created: the only leg-producing path was 運用に追加, which makes
 * `train` legs. A duty that parks a set at a terminus for two hours, or takes it
 * into the depot for a 列車検査 mid-day, is now expressible.
 */
function DutyDetail({ duty }: { duty: Duty }) {
  const doc = useDoc();
  const dispatch = useDispatch();
  const stations = useMemo(() => entityList(doc.stations), [doc]);
  const depots = useMemo(() => entityList(doc.depots), [doc]);
  const seriesList = useMemo(() => entityList(doc.formationSeries), [doc]);
  const dayTypes = useMemo(() => entityList(doc.dayTypes), [doc]);

  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= duty.legs.length) return;
    const order = duty.legs.map((_, i) => i);
    order[index] = target;
    order[target] = index;
    dispatch({ type: 'duty/reorderLegs', dutyId: duty.id, order });
  };

  /** Where the duty currently ends — the natural place for a new leg. */
  const tail = (): { stationId: StationId | undefined; at: number } => {
    const last = duty.legs[duty.legs.length - 1];
    if (last === undefined) {
      return { stationId: stations[0]?.id, at: doc.settings.serviceDayStartSec };
    }
    const span = dutyLegSpan(doc, last);
    const ends = dutyLegEndpoints(doc, last);
    return {
      stationId: ends?.toStationId ?? stations[0]?.id,
      at: span?.to ?? doc.settings.serviceDayStartSec,
    };
  };

  const addStable = (): void => {
    const { stationId, at } = tail();
    if (stationId === undefined) return;
    dispatch({
      type: 'duty/insertLeg',
      dutyId: duty.id,
      leg: { kind: 'stable', stationId, from: at, to: at + 30 * 60 },
    });
  };

  const addInspection = (): void => {
    const depot = depots[0];
    if (depot === undefined) return;
    const { at } = tail();
    dispatch({
      type: 'duty/insertLeg',
      dutyId: duty.id,
      leg: {
        kind: 'inspection',
        depotId: depot.id,
        inspectionKind: depot.inspectionKinds[0] ?? 'train',
        from: at,
        to: at + 2 * 3600,
      },
    });
  };

  const replaceLeg = (index: number, leg: DutyLeg): void => {
    dispatch({ type: 'duty/removeLeg', dutyId: duty.id, legIndex: index });
    dispatch({ type: 'duty/insertLeg', dutyId: duty.id, leg, atIndex: index });
  };

  return (
    <div>
      <div className={styles.form}>
        <Field label="必要両数">
          <input
            className={styles.narrow}
            data-testid={TID.dutyRequiredCars(duty.id)}
            value={duty.requiredCars ?? ''}
            inputMode="numeric"
            onChange={(e) => {
              const value = numberOrUndefined(e.currentTarget.value);
              dispatch({
                type: 'duty/update',
                id: duty.id,
                patch:
                  value === undefined || value <= 0
                    ? clearing<Omit<Duty, 'legs'>>('requiredCars')
                    : { requiredCars: value },
              });
            }}
          />
        </Field>
        <span className={styles.hint}>必要形式</span>
        {seriesList.map((s) => {
          const chosen = (duty.requiredSeriesIds ?? []).includes(s.id);
          return (
            <label key={s.id} className={styles.checkField}>
              <input
                type="checkbox"
                data-testid={TID.dutyRequiredSeries(duty.id)}
                checked={chosen}
                onChange={(e) => {
                  const current = duty.requiredSeriesIds ?? [];
                  const next: SeriesId[] = e.currentTarget.checked
                    ? [...current.filter((id) => id !== s.id), s.id]
                    : current.filter((id) => id !== s.id);
                  dispatch({
                    type: 'duty/update',
                    id: duty.id,
                    patch:
                      next.length === 0
                        ? clearing<Omit<Duty, 'legs'>>('requiredSeriesIds')
                        : { requiredSeriesIds: next },
                  });
                }}
              />
              <span>{s.name}</span>
            </label>
          );
        })}
        <span className={styles.hint}>運転日</span>
        {dayTypes.map((dt) => (
          <label key={dt.id} className={styles.checkField}>
            <input
              type="checkbox"
              data-testid={TID.dutyDayType(duty.id, dt.id)}
              checked={duty.dayTypeIds.includes(dt.id)}
              onChange={(e) => {
                const next: DayTypeId[] = e.currentTarget.checked
                  ? [...duty.dayTypeIds.filter((id) => id !== dt.id), dt.id]
                  : duty.dayTypeIds.filter((id) => id !== dt.id);
                dispatch({ type: 'duty/update', id: duty.id, patch: { dayTypeIds: next } });
              }}
            />
            <span>{dt.name}</span>
          </label>
        ))}
      </div>

      <div className={styles.form}>
        <button
          type="button"
          data-testid={TID.dutyAddStableLeg(duty.id)}
          onClick={addStable}
          disabled={stations.length === 0}
        >
          留置を追加
        </button>
        <button
          type="button"
          data-testid={TID.dutyAddInspectionLeg(duty.id)}
          onClick={addInspection}
          disabled={depots.length === 0}
        >
          検査を追加
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: 'duty/sortLegsByTime', dutyId: duty.id })}
          disabled={duty.legs.length < 2}
        >
          時刻順に整列
        </button>
      </div>

      <table className={styles.table} data-testid={TID.dutyLegList(duty.id)}>
        <thead>
          <tr>
            <th>#</th>
            <th>種別</th>
            <th>内容</th>
            <th>時刻</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {duty.legs.length === 0 ? (
            <tr>
              <td colSpan={5} className={styles.empty}>
                行路が空です
              </td>
            </tr>
          ) : null}
          {duty.legs.map((leg, index) => (
            <tr key={`${leg.kind}-${index}`} data-leg-index={index} data-leg-kind={leg.kind}>
              <td className={styles.num}>{index + 1}</td>
              <td>{leg.kind === 'train' ? '列車' : leg.kind === 'stable' ? '留置' : '検査'}</td>
              <td>
                <LegContent
                  doc={doc}
                  leg={leg}
                  onChange={(next) => replaceLeg(index, next)}
                />
              </td>
              <td className={styles.num}>
                <LegTimes leg={leg} onChange={(next) => replaceLeg(index, next)} />
              </td>
              <td>
                <button
                  type="button"
                  data-testid={TID.dutyLegUp(duty.id, index)}
                  aria-label={`${index + 1} 番目を上へ`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  data-testid={TID.dutyLegDown(duty.id, index)}
                  aria-label={`${index + 1} 番目を下へ`}
                  disabled={index === duty.legs.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className={styles.danger}
                  data-testid={TID.dutyLegRemove(duty.id, index)}
                  onClick={() =>
                    dispatch({ type: 'duty/removeLeg', dutyId: duty.id, legIndex: index })
                  }
                >
                  削除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LegContent({
  doc,
  leg,
  onChange,
}: {
  doc: ProjectDocument;
  leg: DutyLeg;
  onChange(next: DutyLeg): void;
}) {
  if (leg.kind === 'train') {
    const train = doc.trains.byId[leg.trainId];
    return <span>{train === undefined ? '(削除済み)' : trainLabel(doc, train)}</span>;
  }
  if (leg.kind === 'stable') {
    return (
      <select
        value={leg.stationId}
        aria-label="留置する駅"
        onChange={(e) => onChange({ ...leg, stationId: e.currentTarget.value as StationId })}
      >
        {entityList(doc.stations).map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    );
  }
  return (
    <>
      <select
        value={leg.depotId}
        aria-label="検査する車庫"
        onChange={(e) => onChange({ ...leg, depotId: e.currentTarget.value as DepotId })}
      >
        {entityList(doc.depots).map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
      <select
        value={leg.inspectionKind}
        aria-label="検査の種類"
        onChange={(e) =>
          onChange({ ...leg, inspectionKind: e.currentTarget.value as InspectionKind })
        }
      >
        {(Object.keys(INSPECTION_KIND_LABEL) as InspectionKind[]).map((k) => (
          <option key={k} value={k}>
            {INSPECTION_KIND_LABEL[k]}
          </option>
        ))}
      </select>
    </>
  );
}

function LegTimes({ leg, onChange }: { leg: DutyLeg; onChange(next: DutyLeg): void }) {
  if (leg.kind === 'train') return <span>—</span>;
  return (
    <>
      <input
        className={styles.narrow}
        value={formatTime(leg.from)}
        aria-label="開始時刻"
        onChange={(e) => {
          const value = parseTime(e.currentTarget.value);
          if (value === undefined) return;
          onChange({ ...leg, from: value });
        }}
      />
      <input
        className={styles.narrow}
        value={formatTime(leg.to)}
        aria-label="終了時刻"
        onChange={(e) => {
          const value = parseTime(e.currentTarget.value);
          if (value === undefined) return;
          onChange({ ...leg, to: value });
        }}
      />
    </>
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
