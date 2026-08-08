/**
 * 設定 — the parts of the document that are not a station, a train or a duty:
 * project metadata, the service day, the validation thresholds, and the
 * calendar.
 *
 * The 暦 half matters more than it looks. Without a second DayType a project is
 * permanently a single weekday: `Train.dayTypeIds` and `Duty.dayTypeIds` have
 * exactly one value to choose from, the 運用 board filters on the active day
 * type, and 充当 is per date. Being able to add 土休日 here is what turns the
 * multi-day-type dimension of the model on.
 */

import { useMemo, useState } from 'react';
import { TID } from '@e2e/testids';

import { ID_PREFIX } from '@/domain/ids';
import type { DayTypeId } from '@/domain/ids';
import type { ProjectSettings, ValidationConfig } from '@/domain/model';
import { formatTime, isIsoDate, parseTime } from '@/domain/time';
import { entityList } from '@/domain/units';
import { newId } from '@/store/idPool';
import { ALL_RULES } from '@/validation/registry';
import { Card, Field } from '../components/Field';
import { useDispatch, useDoc } from '../hooks';

import styles from './Editor.module.css';

type Severity = 'error' | 'warning' | 'info' | 'off';

const SEVERITY_LABEL: Record<Severity, string> = {
  error: 'エラー',
  warning: '警告',
  info: '情報',
  off: '無効',
};

const GRAINS: Array<ProjectSettings['timeGrainSec']> = [1, 5, 10, 15, 30, 60];

/** The tunable numbers of `ValidationConfig`, in the order a user reads them. */
const CONFIG_FIELDS: Array<{
  key: keyof ValidationConfig & string;
  label: string;
  step?: number;
}> = [
  { key: 'defaultMinHeadwaySec', label: '既定の最小時隔(秒)' },
  { key: 'defaultMinTurnbackSec', label: '既定の最小折返(秒)' },
  { key: 'preferredTurnbackSec', label: '推奨の折返(秒)' },
  { key: 'connectionMinTransferSec', label: '最小乗換時分(秒)' },
  { key: 'connectionMaxWaitSec', label: '最大待ち時間(秒)' },
  { key: 'overtakeClearanceSec', label: '待避の間合い(秒)' },
  { key: 'inspectionWarnRatio', label: '検査警告の比率', step: 0.05 },
];

export function SettingsScreen() {
  const doc = useDoc();
  const dispatch = useDispatch();

  const dayTypes = useMemo(() => entityList(doc.dayTypes), [doc]);
  const calendar = useMemo(
    () => doc.calendar.slice().sort((a, b) => a.date.localeCompare(b.date)),
    [doc],
  );

  const [dayTypeName, setDayTypeName] = useState('');
  const [dayTypeKind, setDayTypeKind] = useState<'weekday' | 'holiday' | 'special'>('holiday');
  const [calendarDate, setCalendarDate] = useState(doc.settings.activeDate);
  const [calendarDayTypeId, setCalendarDayTypeId] = useState('');
  const [startText, setStartText] = useState<string | undefined>(undefined);
  const [endText, setEndText] = useState<string | undefined>(undefined);

  const addDayType = (): void => {
    const name = dayTypeName.trim();
    if (name === '') {
      document.querySelector<HTMLInputElement>(`[data-testid="${TID.dayTypeNameInput}"]`)?.focus();
      return;
    }
    dispatch({
      type: 'dayType/add',
      dayType: {
        id: newId<'DayType'>(ID_PREFIX.dayType),
        name,
        kind: dayTypeKind,
        color: dayTypeKind === 'holiday' ? '#b91c1c' : '#334155',
      },
    });
    setDayTypeName('');
  };

  const setCalendarEntry = (): void => {
    const dayTypeId = calendarDayTypeId !== '' ? calendarDayTypeId : dayTypes[0]?.id;
    if (dayTypeId === undefined || !isIsoDate(calendarDate)) return;
    dispatch({ type: 'calendar/set', date: calendarDate, dayTypeId: dayTypeId as DayTypeId });
  };

  const commitServiceTime = (
    field: 'serviceDayStartSec' | 'serviceDayEndSec',
    text: string,
  ): void => {
    const value = parseTime(text);
    if (value === undefined) return;
    dispatch({ type: 'settings/update', patch: { [field]: value } });
  };

  return (
    <div className={styles.screen} data-testid={TID.settingsScreen}>
      <div className={styles.columns}>
        <Card title="プロジェクト">
          <div className={styles.form}>
            <Field label="プロジェクト名">
              <input
                className={styles.wide}
                data-testid={TID.projectNameInput}
                value={doc.meta.name}
                onChange={(e) =>
                  dispatch({ type: 'project/setMeta', patch: { name: e.currentTarget.value } })
                }
              />
            </Field>
            <Field label="運行開始時刻">
              <input
                className={styles.narrow}
                data-testid={TID.serviceDayStartInput}
                value={startText ?? formatTime(doc.settings.serviceDayStartSec)}
                onChange={(e) => setStartText(e.currentTarget.value)}
                onBlur={(e) => {
                  commitServiceTime('serviceDayStartSec', e.currentTarget.value);
                  setStartText(undefined);
                }}
              />
            </Field>
            <Field label="運行終了時刻">
              <input
                className={styles.narrow}
                data-testid={TID.serviceDayEndInput}
                value={endText ?? formatTime(doc.settings.serviceDayEndSec)}
                onChange={(e) => setEndText(e.currentTarget.value)}
                onBlur={(e) => {
                  commitServiceTime('serviceDayEndSec', e.currentTarget.value);
                  setEndText(undefined);
                }}
              />
            </Field>
            <Field label="時刻の刻み">
              <select
                data-testid={TID.timeGrainSelect}
                value={doc.settings.timeGrainSec}
                onChange={(e) =>
                  dispatch({
                    type: 'settings/update',
                    patch: {
                      timeGrainSec: Number(
                        e.currentTarget.value,
                      ) as ProjectSettings['timeGrainSec'],
                    },
                  })
                }
              >
                {GRAINS.map((g) => (
                  <option key={g} value={g}>
                    {g} 秒
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <p className={styles.hint}>
            運行時刻は 26:00 のように 24 時を超えて指定できます。入力欄を離れると確定します。
          </p>
        </Card>

        <Card title="曜日種別 (暦)">
          <div className={styles.form}>
            <Field label="名称">
              <input
                className={styles.medium}
                data-testid={TID.dayTypeNameInput}
                value={dayTypeName}
                onChange={(e) => setDayTypeName(e.currentTarget.value)}
              />
            </Field>
            <Field label="種類">
              <select
                data-testid={TID.dayTypeKindSelect}
                value={dayTypeKind}
                onChange={(e) =>
                  setDayTypeKind(e.currentTarget.value as 'weekday' | 'holiday' | 'special')
                }
              >
                <option value="weekday">平日</option>
                <option value="holiday">土休日</option>
                <option value="special">特殊</option>
              </select>
            </Field>
            <button type="button" data-testid={TID.dayTypeAdd} onClick={addDayType}>
              曜日種別を追加
            </button>
          </div>

          <table className={styles.table} data-testid={TID.dayTypeList}>
            <thead>
              <tr>
                <th>名称</th>
                <th>種類</th>
                <th>色</th>
                <th>列車</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {dayTypes.map((dt) => {
                const trainCount = entityList(doc.trains).filter((t) =>
                  t.dayTypeIds.includes(dt.id),
                ).length;
                return (
                  <tr key={dt.id} data-testid={TID.dayTypeRow(dt.id)} data-day-type-id={dt.id}>
                    <td>
                      <input
                        className={styles.medium}
                        data-testid={TID.dayTypeNameCell(dt.id)}
                        value={dt.name}
                        aria-label={`${dt.name} の名称`}
                        onChange={(e) =>
                          dispatch({
                            type: 'dayType/update',
                            id: dt.id,
                            patch: { name: e.currentTarget.value },
                          })
                        }
                      />
                    </td>
                    <td>
                      {dt.kind === 'weekday' ? '平日' : dt.kind === 'holiday' ? '土休日' : '特殊'}
                    </td>
                    <td>
                      <input
                        type="color"
                        data-testid={TID.dayTypeColorCell(dt.id)}
                        value={dt.color}
                        aria-label={`${dt.name} の色`}
                        onChange={(e) =>
                          dispatch({
                            type: 'dayType/update',
                            id: dt.id,
                            patch: { color: e.currentTarget.value },
                          })
                        }
                      />
                    </td>
                    <td className={styles.num}>{trainCount}</td>
                    <td>
                      <button
                        type="button"
                        className={styles.danger}
                        data-testid={TID.dayTypeRemove(dt.id)}
                        disabled={dayTypes.length <= 1 || dt.id === doc.settings.activeDayTypeId}
                        title={
                          dt.id === doc.settings.activeDayTypeId
                            ? '表示中の曜日種別は削除できません'
                            : '削除'
                        }
                        onClick={() => dispatch({ type: 'dayType/remove', id: dt.id })}
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </div>

      <div className={styles.columns}>
        <Card title="カレンダー">
          <div className={styles.form}>
            <Field label="日付">
              <input
                type="date"
                data-testid={TID.calendarDateInput}
                value={calendarDate}
                onChange={(e) => setCalendarDate(e.currentTarget.value)}
              />
            </Field>
            <Field label="曜日種別">
              <select
                data-testid={TID.calendarDayTypeSelect}
                value={calendarDayTypeId !== '' ? calendarDayTypeId : (dayTypes[0]?.id ?? '')}
                onChange={(e) => setCalendarDayTypeId(e.currentTarget.value)}
              >
                {dayTypes.map((dt) => (
                  <option key={dt.id} value={dt.id}>
                    {dt.name}
                  </option>
                ))}
              </select>
            </Field>
            <button type="button" data-testid={TID.calendarAdd} onClick={setCalendarEntry}>
              この日に割り当て
            </button>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table} data-testid={TID.calendarList}>
              <thead>
                <tr>
                  <th>日付</th>
                  <th>曜日種別</th>
                </tr>
              </thead>
              <tbody>
                {calendar.length === 0 ? (
                  <tr>
                    <td colSpan={2} className={styles.empty}>
                      カレンダーが未設定です (すべて既定の曜日種別として扱われます)
                    </td>
                  </tr>
                ) : null}
                {calendar.map((entry) => (
                  <tr key={entry.date} data-testid={TID.calendarRow(entry.date)}>
                    <td>{entry.date}</td>
                    <td>
                      <select
                        value={entry.dayTypeId}
                        aria-label={`${entry.date} の曜日種別`}
                        onChange={(e) =>
                          dispatch({
                            type: 'calendar/set',
                            date: entry.date,
                            dayTypeId: e.currentTarget.value as DayTypeId,
                          })
                        }
                      >
                        {dayTypes.map((dt) => (
                          <option key={dt.id} value={dt.id}>
                            {dt.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="検証設定">
          <div className={styles.form}>
            {CONFIG_FIELDS.map((field) => (
              <Field key={field.key} label={field.label}>
                <input
                  className={styles.narrow}
                  data-testid={TID.validationNumberInput(field.key)}
                  value={String(doc.validationConfig[field.key] as number)}
                  inputMode="decimal"
                  onChange={(e) => {
                    const value = Number(e.currentTarget.value);
                    if (!Number.isFinite(value)) return;
                    dispatch({
                      type: 'validationConfig/update',
                      patch: { [field.key]: value },
                    });
                  }}
                />
              </Field>
            ))}
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table} data-testid={TID.validationConfigList}>
              <thead>
                <tr>
                  <th>検証ルール</th>
                  <th>既定</th>
                  <th>重大度</th>
                </tr>
              </thead>
              <tbody>
                {ALL_RULES.map((rule) => {
                  const override = doc.validationConfig.severityOverrides[rule.id];
                  return (
                    <tr key={rule.id} data-rule-id={rule.id}>
                      <td title={rule.id}>{rule.name}</td>
                      <td>{SEVERITY_LABEL[rule.defaultSeverity]}</td>
                      <td>
                        <select
                          data-testid={TID.validationSeveritySelect(rule.id)}
                          aria-label={`${rule.name} の重大度`}
                          value={override ?? ''}
                          onChange={(e) => {
                            const value = e.currentTarget.value;
                            const next = { ...doc.validationConfig.severityOverrides };
                            if (value === '') delete next[rule.id];
                            else next[rule.id] = value as Severity;
                            dispatch({
                              type: 'validationConfig/update',
                              patch: { severityOverrides: next },
                            });
                          }}
                        >
                          <option value="">既定のまま</option>
                          <option value="error">エラー</option>
                          <option value="warning">警告</option>
                          <option value="info">情報</option>
                          <option value="off">無効</option>
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
