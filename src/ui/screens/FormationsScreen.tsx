/**
 * 形式 / 編成, the derived odometer, and one inspection badge per kind.
 *
 * The odometer column is computed from assignments, never stored — see the note
 * on `Formation.odometerKm`. Playing the clock must not be able to change a
 * saved document.
 */

import { useMemo, useState } from 'react';
import { TID } from '@e2e/testids';

import { ID_PREFIX } from '@/domain/ids';
import type { DepotId, SeriesId } from '@/domain/ids';
import { INSPECTION_KINDS, INSPECTION_KIND_LABEL, type Formation, type FormationSeries, type InspectionKind, type PerfProfile } from '@/domain/model';
import { entityList } from '@/domain/units';
import { computeInspectionStatus, currentOdometerKm, type InspectionState } from '@/engine';
import { newId } from '@/store/idPool';
import { useUiStore } from '@/store/uiStore';
import { Card, Field } from '../components/Field';
import { useDispatch, useDoc } from '../hooks';

import styles from './Editor.module.css';

const BADGE_CLASS: Record<InspectionState, string> = {
  ok: styles.badgeOk ?? '',
  dueSoon: styles.badgeDueSoon ?? '',
  overdue: styles.badgeOverdue ?? '',
  unknown: styles.badgeUnknown ?? '',
};

const BADGE_LABEL: Record<InspectionState, string> = {
  ok: '良',
  dueSoon: '近',
  overdue: '超過',
  unknown: '—',
};

export function FormationsScreen() {
  const doc = useDoc();
  const dispatch = useDispatch();
  const select = useUiStore((s) => s.select);

  const series = useMemo(() => entityList(doc.formationSeries), [doc]);
  const formations = useMemo(() => entityList(doc.formations), [doc]);
  const depots = useMemo(() => entityList(doc.depots), [doc]);
  const asOf = doc.settings.activeDate;

  const statuses = useMemo(() => {
    const map = new Map<string, Map<string, InspectionState>>();
    for (const status of computeInspectionStatus(doc, asOf)) {
      const byKind = map.get(status.formationId) ?? new Map<string, InspectionState>();
      const existing = byKind.get(status.kind);
      byKind.set(status.kind, worse(existing, status.state));
      map.set(status.formationId, byKind);
    }
    return map;
  }, [doc, asOf]);

  // -- forms ---------------------------------------------------------------
  const [seriesName, setSeriesName] = useState('');
  const [seriesCars, setSeriesCars] = useState('6');
  const [code, setCode] = useState('');
  const [seriesId, setSeriesId] = useState('');
  const [cars, setCars] = useState('6');
  const [depotId, setDepotId] = useState('');
  const [odometer, setOdometer] = useState('0');

  const addSeries = (): void => {
    const name = seriesName.trim();
    if (name === '') {
      document.querySelector<HTMLInputElement>(`[data-testid="${TID.seriesNameInput}"]`)?.focus();
      return;
    }
    let profileId = entityList(doc.perfProfiles)[0]?.id;
    if (profileId === undefined) {
      const profile: PerfProfile = {
        id: newId<'PerfProfile'>(ID_PREFIX.perfProfile),
        name: '標準性能',
        accelKmhps: 3.0,
        decelKmhps: 3.5,
        maxSpeedKmh: 110,
      };
      dispatch({ type: 'perfProfile/add', profile });
      profileId = profile.id;
    }
    const next: FormationSeries = {
      id: newId<'FormationSeries'>(ID_PREFIX.series),
      name,
      perfProfileId: profileId,
      allowedCarCounts: [Number(seriesCars) || 6],
    };
    dispatch({ type: 'series/add', series: next });
    setSeriesName('');
  };

  const addFormation = (): void => {
    const effectiveSeries = seriesId !== '' ? seriesId : series[0]?.id;
    const effectiveDepot = depotId !== '' ? depotId : depots[0]?.id;
    if (effectiveSeries === undefined || effectiveDepot === undefined) return;
    const trimmed = code.trim();
    if (trimmed === '') {
      document.querySelector<HTMLInputElement>(`[data-testid="${TID.formationCodeInput}"]`)?.focus();
      return;
    }
    const formation: Formation = {
      id: newId<'Formation'>(ID_PREFIX.formation),
      code: trimmed,
      seriesId: effectiveSeries as SeriesId,
      cars: Number(cars) || 6,
      homeDepotId: effectiveDepot as DepotId,
      status: 'active',
      odometerKm: Number(odometer) || 0,
      odometerAsOf: asOf,
      commissionedOn: asOf,
    };
    dispatch({ type: 'formation/add', formation });
    setCode('');
  };

  return (
    <div className={styles.screen}>
      <Card title="形式">
        <div className={styles.form}>
          <Field label="形式名">
            <input
              className={styles.medium}
              data-testid={TID.seriesNameInput}
              value={seriesName}
              onChange={(e) => setSeriesName(e.currentTarget.value)}
            />
          </Field>
          <Field label="両数">
            <input
              className={styles.narrow}
              data-testid={TID.seriesCarsInput}
              value={seriesCars}
              inputMode="numeric"
              onChange={(e) => setSeriesCars(e.currentTarget.value)}
            />
          </Field>
          <button type="button" data-testid={TID.seriesSubmit} onClick={addSeries}>
            追加
          </button>
          <button type="button" data-testid={TID.seriesAdd} onClick={addSeries}>
            形式を追加
          </button>
        </div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>形式</th>
              <th>両数</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {series.length === 0 ? (
              <tr>
                <td colSpan={3} className={styles.empty}>
                  形式がありません
                </td>
              </tr>
            ) : null}
            {series.map((s) => (
              <tr key={s.id}>
                <td>
                  <input
                    className={styles.medium}
                    value={s.name}
                    aria-label={`${s.name} の名称`}
                    onChange={(e) =>
                      dispatch({
                        type: 'series/update',
                        id: s.id,
                        patch: { name: e.currentTarget.value },
                      })
                    }
                  />
                </td>
                <td className={styles.num}>{s.allowedCarCounts.join(', ')}</td>
                <td>
                  <button
                    type="button"
                    className={styles.danger}
                    onClick={() => dispatch({ type: 'series/remove', id: s.id })}
                  >
                    削除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="編成">
        <div className={styles.form}>
          <Field label="編成番号">
            <input
              className={styles.medium}
              data-testid={TID.formationCodeInput}
              value={code}
              onChange={(e) => setCode(e.currentTarget.value)}
            />
          </Field>
          <Field label="形式">
            <select
              data-testid={TID.formationSeriesSelect}
              value={seriesId !== '' ? seriesId : (series[0]?.id ?? '')}
              onChange={(e) => setSeriesId(e.currentTarget.value)}
            >
              {series.length === 0 ? <option value="">(形式なし)</option> : null}
              {series.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="両数">
            <input
              className={styles.narrow}
              data-testid={TID.formationCarsInput}
              value={cars}
              inputMode="numeric"
              onChange={(e) => setCars(e.currentTarget.value)}
            />
          </Field>
          <Field label="所属">
            <select
              data-testid={TID.formationDepotSelect}
              value={depotId !== '' ? depotId : (depots[0]?.id ?? '')}
              onChange={(e) => setDepotId(e.currentTarget.value)}
            >
              {depots.length === 0 ? <option value="">(車庫なし)</option> : null}
              {depots.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="基準走行(km)">
            <input
              className={styles.narrow}
              data-testid={TID.formationOdometerInput}
              value={odometer}
              inputMode="numeric"
              onChange={(e) => setOdometer(e.currentTarget.value)}
            />
          </Field>
          <button
            type="button"
            data-testid={TID.formationSubmit}
            onClick={addFormation}
            disabled={series.length === 0 || depots.length === 0}
          >
            追加
          </button>
          <button
            type="button"
            data-testid={TID.formationAdd}
            onClick={addFormation}
            disabled={series.length === 0 || depots.length === 0}
          >
            編成を追加
          </button>
        </div>
        {series.length === 0 || depots.length === 0 ? (
          <p className={styles.hint}>形式と車庫を先に登録してください。</p>
        ) : null}

        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid={TID.formationList}>
            <thead>
              <tr>
                <th>編成</th>
                <th>形式</th>
                <th>両数</th>
                <th>所属</th>
                <th>状態</th>
                <th>基準走行(km)</th>
                <th>走行距離(km)</th>
                {INSPECTION_KINDS.map((kind) => (
                  <th key={kind}>{INSPECTION_KIND_LABEL[kind]}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {formations.length === 0 ? (
                <tr>
                  <td colSpan={8 + INSPECTION_KINDS.length} className={styles.empty}>
                    編成がありません
                  </td>
                </tr>
              ) : null}
              {formations.map((formation) => {
                const byKind = statuses.get(formation.id);
                return (
                  <tr
                    key={formation.id}
                    data-testid={TID.formationRow(formation.id)}
                    onClick={() => select({ kind: 'formation', formationId: formation.id })}
                  >
                    <td>
                      <input
                        className={styles.narrow}
                        value={formation.code}
                        aria-label={`${formation.code} の番号`}
                        onChange={(e) =>
                          dispatch({
                            type: 'formation/update',
                            id: formation.id,
                            patch: { code: e.currentTarget.value },
                          })
                        }
                      />
                    </td>
                    <td>
                      <select
                        data-testid={TID.formationSeriesCell(formation.id)}
                        value={formation.seriesId}
                        aria-label={`${formation.code} の形式`}
                        onChange={(e) =>
                          dispatch({
                            type: 'formation/update',
                            id: formation.id,
                            patch: { seriesId: e.currentTarget.value as SeriesId },
                          })
                        }
                      >
                        {series.length === 0 ? <option value="">(形式なし)</option> : null}
                        {series.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={styles.num}>
                      <input
                        className={styles.narrow}
                        data-testid={TID.formationCarsCell(formation.id)}
                        value={formation.cars}
                        inputMode="numeric"
                        aria-label={`${formation.code} の両数`}
                        onChange={(e) =>
                          dispatch({
                            type: 'formation/update',
                            id: formation.id,
                            patch: { cars: Number(e.currentTarget.value) || 1 },
                          })
                        }
                      />
                    </td>
                    <td>
                      <select
                        data-testid={TID.formationDepotCell(formation.id)}
                        value={formation.homeDepotId}
                        aria-label={`${formation.code} の所属`}
                        onChange={(e) =>
                          dispatch({
                            type: 'formation/update',
                            id: formation.id,
                            patch: { homeDepotId: e.currentTarget.value as DepotId },
                          })
                        }
                      >
                        {depots.length === 0 ? <option value="">(車庫なし)</option> : null}
                        {depots.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        value={formation.status}
                        aria-label={`${formation.code} の状態`}
                        onChange={(e) =>
                          dispatch({
                            type: 'formation/update',
                            id: formation.id,
                            patch: {
                              status: e.currentTarget.value as Formation['status'],
                            },
                          })
                        }
                      >
                        <option value="active">運用可</option>
                        <option value="inInspection">検査中</option>
                        <option value="stored">留置</option>
                        <option value="retired">廃車</option>
                      </select>
                    </td>
                    <td className={styles.num}>
                      <input
                        className={styles.narrow}
                        data-testid={TID.formationOdometerCell(formation.id)}
                        value={formation.odometerKm}
                        inputMode="numeric"
                        aria-label={`${formation.code} の基準走行距離`}
                        onChange={(e) =>
                          dispatch({
                            type: 'formation/update',
                            id: formation.id,
                            patch: { odometerKm: Number(e.currentTarget.value) || 0 },
                          })
                        }
                      />
                    </td>
                    <td className={styles.num}>
                      {Math.round(currentOdometerKm(doc, formation.id, asOf)).toLocaleString()}
                    </td>
                    {INSPECTION_KINDS.map((kind: InspectionKind) => {
                      const state = byKind?.get(kind) ?? 'unknown';
                      return (
                        <td key={kind}>
                          <span
                            className={`${styles.badge} ${BADGE_CLASS[state]}`}
                            data-testid={TID.inspectionBadge(formation.id, kind)}
                            data-state={state}
                          >
                            {BADGE_LABEL[state]}
                          </span>
                        </td>
                      );
                    })}
                    <td>
                      <button
                        type="button"
                        className={styles.danger}
                        onClick={() => dispatch({ type: 'formation/remove', id: formation.id })}
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
    </div>
  );
}

const SEVERITY_ORDER: InspectionState[] = ['unknown', 'ok', 'dueSoon', 'overdue'];

function worse(a: InspectionState | undefined, b: InspectionState): InspectionState {
  if (a === undefined) return b;
  return SEVERITY_ORDER.indexOf(b) > SEVERITY_ORDER.indexOf(a) ? b : a;
}
