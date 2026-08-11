/**
 * 乗務員 — 行路 composition and who works them.
 *
 * Deliberately the same screen as 運用, because it is the same job done for a
 * different resource: a chart across the top, a table of 行路 with an
 * expandable leg editor, the people below, and a tray of whatever is not
 * covered yet. Anyone who has used the 運用 screen already knows this one.
 *
 * The differences are the ones the domain forces. A 行路 has a 職種 and a
 * 基地; its legs can be 休憩 and 待機 as well as 乗務; and the totals that
 * decide whether it is a legal day's work — 拘束 / 実乗務 / 休憩 — are shown on
 * every row, because they are what the checks are about and a number you
 * cannot see is a number you cannot fix.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { TID } from '@e2e/testids';

import { ID_PREFIX } from '@/domain/ids';
import type { CrewDutyId, CrewId, DayTypeId, StationId, TrainId } from '@/domain/ids';
import type { Crew, CrewDuty, CrewLeg, CrewRole } from '@/domain/model';
import { CREW_LEG_KIND_LABEL, CREW_ROLE_LABEL, CREW_ROLES } from '@/domain/model';
import {
  crewDutySpread,
  crewLegEndpoints,
  crewLegSpan,
  crewOfTrainMap,
  crewRolesOfTrain,
  crewWorkingSec,
  trainEndSec,
  trainLabel,
  trainStartSec,
} from '@/domain/project';
import { formatDuration, formatTime, parseTime } from '@/domain/time';
import { entityList } from '@/domain/units';
import { CrewDutyChart } from '@/render';
import { newId } from '@/store/idPool';
import { useUiStore } from '@/store/uiStore';
import { Card, Field } from '../components/Field';
import { useDispatch, useDoc } from '../hooks';

import styles from './Editor.module.css';
import duties from './Duties.module.css';

type RoleFilter = CrewRole | 'all';

export function CrewScreen() {
  const doc = useDoc();
  const dispatch = useDispatch();
  const select = useUiStore((s) => s.select);
  const focusOn = useUiStore((s) => s.focusOn);

  const dayTypeId = doc.settings.activeDayTypeId;
  const date = doc.settings.activeDate;

  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [code, setCode] = useState('');
  const [openTrainId, setOpenTrainId] = useState<string | undefined>(undefined);
  const [expandedId, setExpandedId] = useState<string | undefined>(undefined);

  const dutyList = useMemo(
    () =>
      entityList(doc.crewDuties)
        .filter((d) => d.dayTypeIds.includes(dayTypeId))
        .filter((d) => roleFilter === 'all' || d.role === roleFilter),
    [doc, dayTypeId, roleFilter],
  );
  const people = useMemo(() => entityList(doc.crew), [doc]);
  const stations = useMemo(() => entityList(doc.stations), [doc]);

  const coverage = useMemo(() => crewOfTrainMap(doc), [doc]);
  const uncovered = useMemo(
    () =>
      entityList(doc.trains)
        .filter((t) => t.dayTypeIds.includes(dayTypeId))
        .filter((t) =>
          crewRolesOfTrain(doc, t).some((role) => !coverage.has(`${t.id}|${role}`)),
        )
        .sort((a, b) => (trainStartSec(a) ?? 0) - (trainStartSec(b) ?? 0)),
    [doc, coverage, dayTypeId],
  );

  const personByDuty = useMemo(() => {
    const map = new Map<string, CrewId>();
    for (const a of entityList(doc.crewAssignments)) {
      if (a.date === date) map.set(a.crewDutyId, a.crewId);
    }
    return map;
  }, [doc, date]);

  const focusTarget = useUiStore((s) => s.focusTarget);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  useEffect(() => {
    if (focusTarget === undefined) return;
    const target = focusTarget.ref;
    if (target.kind !== 'crewDuty') return;
    setExpandedId(target.crewDutyId);
    rowRefs.current.get(target.crewDutyId)?.scrollIntoView?.({ block: 'nearest' });
  }, [focusTarget]);

  const addDuty = (): void => {
    const base = stations.find((s) => s.crewBase === true) ?? stations[0];
    if (base === undefined) return;
    const trimmed = code.trim();
    const duty: CrewDuty = {
      id: newId<'CrewDuty'>(ID_PREFIX.crewDuty),
      code: trimmed === '' ? `${String(dutyList.length + 1).padStart(2, '0')}仕` : trimmed,
      role: roleFilter === 'all' ? 'driver' : roleFilter,
      baseStationId: base.id,
      dayTypeIds: [dayTypeId],
      legs: [],
    };
    dispatch({ type: 'crewDuty/add', duty });
    setCode('');
  };

  const addPerson = (): void => {
    const base = stations.find((s) => s.crewBase === true) ?? stations[0];
    if (base === undefined) return;
    const person: Crew = {
      id: newId<'Crew'>(ID_PREFIX.crew),
      code: `D${String(people.length + 1).padStart(3, '0')}`,
      name: '',
      role: roleFilter === 'all' ? 'driver' : roleFilter,
      baseStationId: base.id,
    };
    dispatch({ type: 'crew/add', crew: person });
  };

  const addTrainToDuty = (trainId: TrainId, crewDutyId: CrewDutyId): void => {
    const train = doc.trains.byId[trainId];
    if (train === undefined) return;
    dispatch({
      type: 'crewDuty/insertLeg',
      crewDutyId,
      leg: { kind: 'train', trainId, fromIndex: 0, toIndex: train.stops.length - 1 },
    });
    dispatch({ type: 'crewDuty/sortLegsByTime', crewDutyId });
    setOpenTrainId(undefined);
  };

  return (
    <div className={styles.screen}>
      <Card
        title="行路表"
        actions={
          <div className={styles.chipRow} data-testid={TID.crewRoleFilter}>
            {(['all', ...CREW_ROLES] as RoleFilter[]).map((value) => (
              <button
                key={value}
                type="button"
                className={`${styles.chip} ${roleFilter === value ? styles.chipOn : styles.chipOff}`}
                aria-pressed={roleFilter === value}
                onClick={() => setRoleFilter(value)}
              >
                {value === 'all' ? '両方' : CREW_ROLE_LABEL[value]}
              </button>
            ))}
          </div>
        }
      >
        <CrewDutyChart
          {...(roleFilter === 'all' ? {} : { role: roleFilter })}
          {...(expandedId === undefined ? {} : { selectedCrewDutyId: expandedId as CrewDutyId })}
          onSelect={(crewDutyId) => {
            setExpandedId(crewDutyId);
            select({ kind: 'crewDuty', crewDutyId });
          }}
        />
      </Card>

      <Card
        title="乗務員行路"
        actions={
          <>
            <Field label="行路番号">
              <input
                className={styles.narrow}
                data-testid={TID.crewCodeInput}
                value={code}
                onChange={(e) => setCode(e.currentTarget.value)}
              />
            </Field>
            <button type="button" data-testid={TID.crewDutyAdd} onClick={addDuty}>
              行路を追加
            </button>
            <button
              type="button"
              data-testid={TID.crewAutoAssign}
              onClick={() =>
                dispatch({
                  type: 'crewDuty/autoAssign',
                  dayTypeId,
                  role: roleFilter === 'all' ? 'driver' : roleFilter,
                })
              }
            >
              行路を自動組成
            </button>
            <button
              type="button"
              data-testid={TID.crewAssignAutoFill}
              onClick={() => dispatch({ type: 'crewAssignment/autoFill', date })}
              disabled={dutyList.length === 0}
            >
              担当を自動設定
            </button>
          </>
        }
      >
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid={TID.crewBoard}>
            <thead>
              <tr>
                <th>行路</th>
                <th>職種</th>
                <th>基地</th>
                <th>担当</th>
                <th>拘束</th>
                <th>実乗務</th>
                <th>休憩</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {dutyList.length === 0 ? (
                <tr>
                  <td colSpan={8} className={styles.empty}>
                    乗務員行路がありません
                  </td>
                </tr>
              ) : null}
              {dutyList.map((duty) => {
                const spread = crewDutySpread(doc, duty);
                const expanded = expandedId === duty.id;
                const breakSec = duty.legs.reduce(
                  (sum, leg) => (leg.kind === 'break' ? sum + (leg.to - leg.from) : sum),
                  0,
                );
                return (
                  <Fragment key={duty.id}>
                    <tr
                      data-testid={TID.crewDutyRow(duty.id)}
                      ref={(el) => {
                        if (el === null) rowRefs.current.delete(duty.id);
                        else rowRefs.current.set(duty.id, el);
                      }}
                      onClick={() => select({ kind: 'crewDuty', crewDutyId: duty.id })}
                    >
                      <td>
                        <input
                          className={styles.narrow}
                          value={duty.code}
                          aria-label={`行路 ${duty.code} の番号`}
                          onChange={(e) =>
                            dispatch({
                              type: 'crewDuty/update',
                              id: duty.id,
                              patch: { code: e.currentTarget.value },
                            })
                          }
                        />
                      </td>
                      <td>
                        <select
                          data-testid={TID.crewDutyRole(duty.id)}
                          aria-label={`行路 ${duty.code} の職種`}
                          value={duty.role}
                          onChange={(e) =>
                            dispatch({
                              type: 'crewDuty/update',
                              id: duty.id,
                              patch: { role: e.currentTarget.value as CrewRole },
                            })
                          }
                        >
                          {CREW_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {CREW_ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          data-testid={TID.crewDutyBase(duty.id)}
                          aria-label={`行路 ${duty.code} の基地`}
                          value={duty.baseStationId}
                          onChange={(e) =>
                            dispatch({
                              type: 'crewDuty/update',
                              id: duty.id,
                              patch: { baseStationId: e.currentTarget.value as StationId },
                            })
                          }
                        >
                          {stations.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                              {s.crewBase === true ? '' : '(基地外)'}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          data-testid={TID.crewDutyPersonSelect(duty.id)}
                          aria-label={`行路 ${duty.code} の担当`}
                          value={personByDuty.get(duty.id) ?? ''}
                          onChange={(e) => {
                            const value = e.currentTarget.value;
                            if (value === '') {
                              dispatch({
                                type: 'crewAssignment/clear',
                                date,
                                crewDutyId: duty.id,
                              });
                              return;
                            }
                            dispatch({
                              type: 'crewAssignment/set',
                              id: newId<'CrewAssignment'>(ID_PREFIX.crewAssignment),
                              date,
                              crewDutyId: duty.id,
                              crewId: value as CrewId,
                            });
                          }}
                        >
                          <option value="">未担当</option>
                          {people.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.code} {p.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className={styles.num}>
                        {spread === undefined
                          ? '—'
                          : `${formatTime(spread.from)}–${formatTime(spread.to)}`}
                      </td>
                      <td className={styles.num}>{formatDuration(crewWorkingSec(doc, duty))}</td>
                      <td className={styles.num}>
                        {breakSec === 0 ? '—' : formatDuration(breakSec)}
                      </td>
                      <td>
                        <button
                          type="button"
                          data-testid={TID.crewDutyExpand(duty.id)}
                          aria-expanded={expanded}
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedId(expanded ? undefined : duty.id);
                          }}
                        >
                          行路を編集
                        </button>
                        <button
                          type="button"
                          className={styles.danger}
                          data-testid={TID.crewDutyRemove(duty.id)}
                          onClick={() =>
                            dispatch({ type: 'crewDuty/remove', crewDutyIds: [duty.id] })
                          }
                        >
                          削除
                        </button>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr>
                        <td colSpan={8}>
                          <CrewDutyDetail duty={duty} />
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

      <Card
        title={`乗務員 (${people.length})`}
        actions={
          <button type="button" data-testid={TID.crewAdd} onClick={addPerson}>
            乗務員を追加
          </button>
        }
      >
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid={TID.crewList}>
            <thead>
              <tr>
                <th>番号</th>
                <th>氏名</th>
                <th>職種</th>
                <th>所属</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {people.length === 0 ? (
                <tr>
                  <td colSpan={5} className={styles.empty}>
                    乗務員がいません
                  </td>
                </tr>
              ) : null}
              {people.map((person) => (
                <tr key={person.id} data-testid={TID.crewRow(person.id)}>
                  <td>
                    <input
                      className={styles.narrow}
                      value={person.code}
                      aria-label={`乗務員 ${person.code} の番号`}
                      onChange={(e) =>
                        dispatch({
                          type: 'crew/update',
                          id: person.id,
                          patch: { code: e.currentTarget.value },
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      className={styles.medium}
                      value={person.name}
                      aria-label={`乗務員 ${person.code} の氏名`}
                      onChange={(e) =>
                        dispatch({
                          type: 'crew/update',
                          id: person.id,
                          patch: { name: e.currentTarget.value },
                        })
                      }
                    />
                  </td>
                  <td>
                    <select
                      value={person.role}
                      aria-label={`乗務員 ${person.code} の職種`}
                      onChange={(e) =>
                        dispatch({
                          type: 'crew/update',
                          id: person.id,
                          patch: { role: e.currentTarget.value as CrewRole },
                        })
                      }
                    >
                      {CREW_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {CREW_ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      value={person.baseStationId}
                      aria-label={`乗務員 ${person.code} の所属`}
                      onChange={(e) =>
                        dispatch({
                          type: 'crew/update',
                          id: person.id,
                          patch: { baseStationId: e.currentTarget.value as StationId },
                        })
                      }
                    >
                      {stations.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button
                      type="button"
                      className={styles.danger}
                      data-testid={TID.crewRemove(person.id)}
                      onClick={() => dispatch({ type: 'crew/remove', id: person.id })}
                    >
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={`乗務員のいない列車 (${uncovered.length})`}>
        <ul className={duties.tray} data-testid={TID.uncrewedTrains}>
          {uncovered.length === 0 ? (
            <li className={styles.empty}>すべての列車に乗務員が付いています</li>
          ) : null}
          {uncovered.slice(0, 60).map((train) => {
            const start = trainStartSec(train);
            const end = trainEndSec(train);
            return (
              <li
                key={train.id}
                className={duties.trayItem}
                data-testid={TID.uncrewedTrain(train.id)}
              >
                <button
                  type="button"
                  className={duties.trayLabel}
                  onClick={() =>
                    focusOn({
                      ref: { kind: 'train', trainId: train.id },
                      ...(start !== undefined ? { at: start } : {}),
                    })
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
                  data-testid={TID.addTrainToCrewDuty(train.id)}
                  aria-expanded={openTrainId === train.id}
                  onClick={() => setOpenTrainId(openTrainId === train.id ? undefined : train.id)}
                >
                  行路に追加 ▾
                </button>
                {openTrainId === train.id ? (
                  <ul
                    className={duties.choiceList}
                    ref={(el) => el?.scrollIntoView({ block: 'nearest' })}
                  >
                    {dutyList.length === 0 ? (
                      <li className={styles.empty}>先に行路を作成してください</li>
                    ) : null}
                    {dutyList.map((duty) => (
                      <li key={duty.id}>
                        <button
                          type="button"
                          data-testid={TID.addTrainToCrewDutyChoice(duty.id)}
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
 * One 行路's legs, in order.
 *
 * A 乗務 leg names a range of the train's stops rather than the whole train,
 * so the two selects are where 途中交代 becomes authorable. Only stops appear
 * as options: you cannot get off a train that runs through.
 */
function CrewDutyDetail({ duty }: { duty: CrewDuty }) {
  const doc = useDoc();
  const dispatch = useDispatch();
  const dayTypes = useMemo(() => entityList(doc.dayTypes), [doc]);
  const stations = useMemo(() => entityList(doc.stations), [doc]);

  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= duty.legs.length) return;
    const order = duty.legs.map((_, i) => i);
    order[index] = target;
    order[target] = index;
    dispatch({ type: 'crewDuty/reorderLegs', crewDutyId: duty.id, order });
  };

  /** Where the 行路 currently ends — the natural place for a new leg. */
  const tail = (): { stationId: StationId | undefined; at: number } => {
    const last = duty.legs[duty.legs.length - 1];
    if (last === undefined) {
      return { stationId: duty.baseStationId, at: doc.settings.serviceDayStartSec };
    }
    return {
      stationId: crewLegEndpoints(doc, last)?.toStationId ?? duty.baseStationId,
      at: crewLegSpan(doc, last)?.to ?? doc.settings.serviceDayStartSec,
    };
  };

  const addLeg = (kind: 'break' | 'standby'): void => {
    const { stationId, at } = tail();
    if (stationId === undefined) return;
    dispatch({
      type: 'crewDuty/insertLeg',
      crewDutyId: duty.id,
      leg: { kind, stationId, from: at, to: at + (kind === 'break' ? 30 * 60 : 10 * 60) },
    });
  };

  const replace = (index: number, leg: CrewLeg): void => {
    dispatch({ type: 'crewDuty/replaceLeg', crewDutyId: duty.id, legIndex: index, leg });
  };

  return (
    <div>
      <div className={styles.form}>
        <button
          type="button"
          data-testid={TID.crewAddBreakLeg(duty.id)}
          onClick={() => addLeg('break')}
        >
          休憩を追加
        </button>
        <button
          type="button"
          data-testid={TID.crewAddStandbyLeg(duty.id)}
          onClick={() => addLeg('standby')}
        >
          待機を追加
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: 'crewDuty/sortLegsByTime', crewDutyId: duty.id })}
          disabled={duty.legs.length < 2}
        >
          時刻順に整列
        </button>
        <span className={styles.hint}>運転日</span>
        {dayTypes.map((dt) => (
          <label key={dt.id} className={styles.checkField}>
            <input
              type="checkbox"
              data-testid={TID.crewDutyDayType(duty.id, dt.id)}
              checked={duty.dayTypeIds.includes(dt.id)}
              onChange={(e) => {
                const next: DayTypeId[] = e.currentTarget.checked
                  ? [...duty.dayTypeIds.filter((id) => id !== dt.id), dt.id]
                  : duty.dayTypeIds.filter((id) => id !== dt.id);
                dispatch({
                  type: 'crewDuty/update',
                  id: duty.id,
                  patch: { dayTypeIds: next },
                });
              }}
            />
            <span>{dt.name}</span>
          </label>
        ))}
      </div>

      <table className={styles.table} data-testid={TID.crewLegList(duty.id)}>
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
          {duty.legs.map((leg, index) => {
            const span = crewLegSpan(doc, leg);
            return (
              <tr
                key={`${leg.kind}-${index}`}
                data-testid={TID.crewLegRow(duty.id, index)}
                data-leg-kind={leg.kind}
              >
                <td className={styles.num}>{index + 1}</td>
                <td>{CREW_LEG_KIND_LABEL[leg.kind]}</td>
                <td>
                  {leg.kind === 'break' || leg.kind === 'standby' ? (
                    <select
                      value={leg.stationId}
                      aria-label="場所"
                      onChange={(e) =>
                        replace(index, { ...leg, stationId: e.currentTarget.value as StationId })
                      }
                    >
                      {stations.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <RideLeg leg={leg} onChange={(next) => replace(index, next)} />
                  )}
                </td>
                <td className={styles.num}>
                  {leg.kind === 'break' || leg.kind === 'standby' ? (
                    <>
                      <input
                        className={styles.narrow}
                        value={formatTime(leg.from)}
                        aria-label="開始時刻"
                        onChange={(e) => {
                          const value = parseTime(e.currentTarget.value);
                          if (value === undefined) return;
                          replace(index, { ...leg, from: value });
                        }}
                      />
                      <input
                        className={styles.narrow}
                        value={formatTime(leg.to)}
                        aria-label="終了時刻"
                        onChange={(e) => {
                          const value = parseTime(e.currentTarget.value);
                          if (value === undefined) return;
                          replace(index, { ...leg, to: value });
                        }}
                      />
                    </>
                  ) : span === undefined ? (
                    '—'
                  ) : (
                    `${formatTime(span.from)}–${formatTime(span.to)}`
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    data-testid={TID.crewLegUp(duty.id, index)}
                    aria-label={`${index + 1} 番目を上へ`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    data-testid={TID.crewLegDown(duty.id, index)}
                    aria-label={`${index + 1} 番目を下へ`}
                    disabled={index === duty.legs.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className={styles.danger}
                    data-testid={TID.crewLegRemove(duty.id, index)}
                    onClick={() =>
                      dispatch({
                        type: 'crewDuty/removeLeg',
                        crewDutyId: duty.id,
                        legIndex: index,
                      })
                    }
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
  );
}

function RideLeg({
  leg,
  onChange,
}: {
  leg: Extract<CrewLeg, { kind: 'train' | 'deadhead' }>;
  onChange(next: CrewLeg): void;
}) {
  const doc = useDoc();
  const train = doc.trains.byId[leg.trainId];
  if (train === undefined) return <span>(削除済み)</span>;

  const options = train.stops
    .map((stop, index) => ({ index, name: doc.stations.byId[stop.stationId]?.name ?? '', stop }))
    .filter((o) => o.stop.kind === 'stop');

  return (
    <>
      <span>{trainLabel(doc, train)}</span>{' '}
      <select
        value={leg.fromIndex}
        aria-label="乗車駅"
        onChange={(e) => onChange({ ...leg, fromIndex: Number(e.currentTarget.value) })}
      >
        {options.map((o) => (
          <option key={o.index} value={o.index}>
            {o.name}
          </option>
        ))}
      </select>
      {' → '}
      <select
        value={leg.toIndex}
        aria-label="降車駅"
        onChange={(e) => onChange({ ...leg, toIndex: Number(e.currentTarget.value) })}
      >
        {options.map((o) => (
          <option key={o.index} value={o.index}>
            {o.name}
          </option>
        ))}
      </select>
    </>
  );
}
