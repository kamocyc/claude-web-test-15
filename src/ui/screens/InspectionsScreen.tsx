/**
 * 検査規程 and the per-formation record history.
 *
 * Rules are the plan (interval in days and/or km); records are what actually
 * happened. The projection that turns the two into a due date lives in the
 * engine — this screen only edits the inputs.
 */

import { useMemo, useState } from 'react';
import { TID } from '@e2e/testids';

import { ID_PREFIX } from '@/domain/ids';
import type { DepotId, FormationId } from '@/domain/ids';
import {
  INSPECTION_KINDS,
  INSPECTION_KIND_LABEL,
  type InspectionKind,
  type InspectionRecord,
  type InspectionRule,
} from '@/domain/model';
import { entityList } from '@/domain/units';
import { computeInspectionStatus } from '@/engine';
import { newId } from '@/store/idPool';
import { useUiStore } from '@/store/uiStore';
import { Card, Field } from '../components/Field';
import { useDispatch, useDoc } from '../hooks';

import styles from './Editor.module.css';

/**
 * A patch that clears one optional field.
 *
 * `Partial<T>` under `exactOptionalPropertyTypes` cannot express "set this key
 * to undefined", but the reducer treats an explicit undefined as a delete —
 * which is the only way to turn a km-based rule back into a days-only one.
 */
function clearing<T>(key: keyof T & string): Partial<T> {
  return { [key]: undefined } as unknown as Partial<T>;
}

export function InspectionsScreen() {
  const doc = useDoc();
  const dispatch = useDispatch();
  const select = useUiStore((s) => s.select);
  const asOf = doc.settings.activeDate;

  const rules = useMemo(
    () => entityList(doc.inspectionRules).slice().sort((a, b) => a.sortOrder - b.sortOrder),
    [doc],
  );
  const records = useMemo(() => entityList(doc.inspectionRecords), [doc]);
  const formations = useMemo(() => entityList(doc.formations), [doc]);
  const depots = useMemo(() => entityList(doc.depots), [doc]);
  const statuses = useMemo(() => computeInspectionStatus(doc, asOf), [doc, asOf]);

  const [kind, setKind] = useState<InspectionKind>('train');
  const [name, setName] = useState('');
  const [intervalDays, setIntervalDays] = useState('10');
  const [intervalKm, setIntervalKm] = useState('');
  const [selectedFormationId, setSelectedFormationId] = useState('');

  const currentFormationId =
    selectedFormationId !== '' ? selectedFormationId : (formations[0]?.id ?? '');

  const addRule = (): void => {
    const depotIds = depots.map((d) => d.id);
    const rule: InspectionRule = {
      id: newId<'InspectionRule'>(ID_PREFIX.inspectionRule),
      kind,
      name: name.trim() === '' ? INSPECTION_KIND_LABEL[kind] : name.trim(),
      appliesTo: 'all',
      outOfServiceDays: kind === 'general' ? 20 : kind === 'bogie' ? 10 : 1,
      depotIds,
      sortOrder: (rules[rules.length - 1]?.sortOrder ?? 0) + 10,
    };
    const days = Number(intervalDays);
    if (Number.isFinite(days) && days > 0) {
      rule.intervalDays = days;
      rule.warnBeforeDays = Math.max(1, Math.round(days * 0.1));
    }
    const km = Number(intervalKm);
    if (Number.isFinite(km) && km > 0) {
      rule.intervalKm = km;
      rule.warnBeforeKm = Math.round(km * 0.1);
    }
    dispatch({ type: 'inspectionRule/add', rule });
    setName('');
  };

  const addRecord = (): void => {
    const rule = rules[0];
    const depot = depots[0];
    if (rule === undefined || depot === undefined || currentFormationId === '') return;
    const record: InspectionRecord = {
      id: newId<'InspectionRecord'>(ID_PREFIX.inspectionRecord),
      formationId: currentFormationId as FormationId,
      ruleId: rule.id,
      kind: rule.kind,
      status: 'completed',
      from: asOf,
      to: asOf,
      odometerKmAt: doc.formations.byId[currentFormationId]?.odometerKm ?? 0,
      depotId: depot.id as DepotId,
    };
    dispatch({ type: 'inspectionRecord/add', record });
  };

  const formationRecords = records
    .filter((r) => r.formationId === currentFormationId)
    .sort((a, b) => b.from.localeCompare(a.from));

  return (
    <div className={styles.screen}>
      <Card title="検査規程">
        <div className={styles.form}>
          <Field label="種類">
            <select value={kind} onChange={(e) => setKind(e.currentTarget.value as InspectionKind)}>
              {INSPECTION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {INSPECTION_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="名称">
            <input
              className={styles.medium}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
          </Field>
          <Field label="周期(日)">
            <input
              className={styles.narrow}
              value={intervalDays}
              inputMode="numeric"
              onChange={(e) => setIntervalDays(e.currentTarget.value)}
            />
          </Field>
          <Field label="周期(km)">
            <input
              className={styles.narrow}
              value={intervalKm}
              inputMode="numeric"
              onChange={(e) => setIntervalKm(e.currentTarget.value)}
            />
          </Field>
          <button type="button" onClick={addRule}>
            規程を追加
          </button>
        </div>

        <table className={styles.table} data-testid={TID.inspectionRuleList}>
          <thead>
            <tr>
              <th>種類</th>
              <th>名称</th>
              <th>周期(日)</th>
              <th>周期(km)</th>
              <th>離脱(日)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 ? (
              <tr>
                <td colSpan={6} className={styles.empty}>
                  検査規程がありません
                </td>
              </tr>
            ) : null}
            {rules.map((rule) => (
              <tr key={rule.id} data-rule-id={rule.id}>
                <td>{INSPECTION_KIND_LABEL[rule.kind]}</td>
                <td>
                  <input
                    className={styles.medium}
                    value={rule.name}
                    aria-label={`${rule.name} の名称`}
                    onChange={(e) =>
                      dispatch({
                        type: 'inspectionRule/update',
                        id: rule.id,
                        patch: { name: e.currentTarget.value },
                      })
                    }
                  />
                </td>
                <td className={styles.num}>
                  <input
                    className={styles.narrow}
                    value={rule.intervalDays ?? ''}
                    inputMode="numeric"
                    aria-label={`${rule.name} の日数周期`}
                    onChange={(e) => {
                      const v = Number(e.currentTarget.value);
                      dispatch({
                        type: 'inspectionRule/update',
                        id: rule.id,
                        patch:
                          Number.isFinite(v) && v > 0
                            ? { intervalDays: v }
                            : clearing<InspectionRule>('intervalDays'),
                      });
                    }}
                  />
                </td>
                <td className={styles.num}>
                  <input
                    className={styles.narrow}
                    value={rule.intervalKm ?? ''}
                    inputMode="numeric"
                    aria-label={`${rule.name} の距離周期`}
                    onChange={(e) => {
                      const v = Number(e.currentTarget.value);
                      dispatch({
                        type: 'inspectionRule/update',
                        id: rule.id,
                        patch:
                          Number.isFinite(v) && v > 0
                            ? { intervalKm: v }
                            : clearing<InspectionRule>('intervalKm'),
                      });
                    }}
                  />
                </td>
                <td className={styles.num}>{rule.outOfServiceDays}</td>
                <td>
                  <button
                    type="button"
                    className={styles.danger}
                    onClick={() => dispatch({ type: 'inspectionRule/remove', id: rule.id })}
                  >
                    削除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card
        title="検査状況"
        actions={
          <select
            aria-label="編成"
            value={currentFormationId}
            onChange={(e) => {
              setSelectedFormationId(e.currentTarget.value);
              select({ kind: 'formation', formationId: e.currentTarget.value as FormationId });
            }}
          >
            {formations.length === 0 ? <option value="">(編成なし)</option> : null}
            {formations.map((f) => (
              <option key={f.id} value={f.id}>
                {f.code}
              </option>
            ))}
          </select>
        }
      >
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid={TID.inspectionTable}>
            <thead>
              <tr>
                <th>編成</th>
                <th>検査</th>
                <th>状態</th>
                <th>前回</th>
                <th>期限</th>
                <th>残日数</th>
                <th>残km</th>
              </tr>
            </thead>
            <tbody>
              {statuses.length === 0 ? (
                <tr>
                  <td colSpan={7} className={styles.empty}>
                    編成と検査規程を登録すると状況が表示されます
                  </td>
                </tr>
              ) : null}
              {statuses.map((status) => (
                <tr
                  key={`${status.formationId}-${status.ruleId}`}
                  data-testid={TID.inspectionSchedule(status.formationId)}
                  data-rule-id={status.ruleId}
                >
                  <td>{doc.formations.byId[status.formationId]?.code ?? status.formationId}</td>
                  <td>{status.label}</td>
                  <td>{status.state}</td>
                  <td>{status.lastDate ?? '—'}</td>
                  <td>{status.dueDate ?? '—'}</td>
                  <td className={styles.num}>{status.daysRemaining ?? '—'}</td>
                  <td className={styles.num}>
                    {status.kmRemaining === undefined ? '—' : Math.round(status.kmRemaining)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="検査履歴"
        actions={
          <button
            type="button"
            onClick={addRecord}
            disabled={rules.length === 0 || depots.length === 0 || currentFormationId === ''}
          >
            履歴を追加
          </button>
        }
      >
        <table className={styles.table}>
          <thead>
            <tr>
              <th>検査</th>
              <th>状態</th>
              <th>開始</th>
              <th>終了</th>
              <th>走行(km)</th>
              <th>施行庫</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {formationRecords.length === 0 ? (
              <tr>
                <td colSpan={7} className={styles.empty}>
                  履歴がありません
                </td>
              </tr>
            ) : null}
            {formationRecords.map((record) => (
              <tr key={record.id}>
                <td>{doc.inspectionRules.byId[record.ruleId]?.name ?? record.kind}</td>
                <td>{record.status === 'completed' ? '実施済' : '予定'}</td>
                <td>
                  <input
                    type="date"
                    value={record.from}
                    aria-label="検査開始日"
                    onChange={(e) =>
                      dispatch({
                        type: 'inspectionRecord/update',
                        id: record.id,
                        patch: { from: e.currentTarget.value },
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    type="date"
                    value={record.to}
                    aria-label="検査終了日"
                    onChange={(e) =>
                      dispatch({
                        type: 'inspectionRecord/update',
                        id: record.id,
                        patch: { to: e.currentTarget.value },
                      })
                    }
                  />
                </td>
                <td className={styles.num}>{record.odometerKmAt ?? '—'}</td>
                <td>{doc.depots.byId[record.depotId]?.name ?? '—'}</td>
                <td>
                  <button
                    type="button"
                    className={styles.danger}
                    onClick={() => dispatch({ type: 'inspectionRecord/remove', id: record.id })}
                  >
                    削除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
