/**
 * 種別 and 停車パターン.
 *
 * The matrix is the fastest way to author a stopping pattern: one click per
 * station cycles 停 → 通 → − (not served), which is exactly the three states the
 * model has.
 */

import { useMemo, useState } from 'react';
import { TID } from '@e2e/testids';

import { ID_PREFIX } from '@/domain/ids';
import type { StationId, TrainTypeId } from '@/domain/ids';
import type { Direction, PerfProfile, StopKind, StopPattern, TrainType } from '@/domain/model';
import { orderedStations } from '@/domain/project';
import { entityList } from '@/domain/units';
import { newId } from '@/store/idPool';
import { Card, Field } from '../components/Field';
import { useDispatch, useDoc } from '../hooks';

import styles from './Editor.module.css';

const CYCLE: Array<StopKind | 'none'> = ['stop', 'pass', 'none'];
const CELL_LABEL: Record<StopKind | 'none', string> = { stop: '停', pass: '通', none: '−' };

export function TypesScreen() {
  const doc = useDoc();
  const dispatch = useDispatch();

  const types = useMemo(
    () => entityList(doc.trainTypes).slice().sort((a, b) => a.sortOrder - b.sortOrder),
    [doc],
  );
  const patterns = useMemo(() => entityList(doc.stopPatterns), [doc]);
  const stations = useMemo(() => orderedStations(doc), [doc]);
  const profiles = useMemo(() => entityList(doc.perfProfiles), [doc]);

  const [typeName, setTypeName] = useState('');
  const [typeShort, setTypeShort] = useState('');
  const [typeColor, setTypeColor] = useState('#2563eb');

  const ensureProfile = (): PerfProfile => {
    const existing = profiles[0];
    if (existing !== undefined) return existing;
    const profile: PerfProfile = {
      id: newId<'PerfProfile'>(ID_PREFIX.perfProfile),
      name: '標準性能',
      accelKmhps: 3.0,
      decelKmhps: 3.5,
      maxSpeedKmh: 110,
    };
    dispatch({ type: 'perfProfile/add', profile });
    return profile;
  };

  const addType = (): void => {
    const name = typeName.trim();
    if (name === '') {
      document.querySelector<HTMLInputElement>(`[data-testid="${TID.trainTypeNameInput}"]`)?.focus();
      return;
    }
    const profile = ensureProfile();
    const trainType: TrainType = {
      id: newId<'TrainType'>(ID_PREFIX.trainType),
      name,
      shortName: typeShort.trim() === '' ? name.slice(0, 1) : typeShort.trim(),
      color: typeColor,
      lineStyle: 'solid',
      lineWidth: 1.5,
      isPassengerService: true,
      perfProfileId: profile.id,
      sortOrder: (types[types.length - 1]?.sortOrder ?? 0) + 10,
    };
    dispatch({ type: 'trainType/add', trainType });
    setTypeName('');
    setTypeShort('');
  };

  return (
    <div className={styles.screen}>
      <div className={styles.columns}>
        <Card title="種別">
          <div className={styles.form}>
            <Field label="名称">
              <input
                className={styles.medium}
                data-testid={TID.trainTypeNameInput}
                value={typeName}
                onChange={(e) => setTypeName(e.currentTarget.value)}
              />
            </Field>
            <Field label="略称">
              <input
                className={styles.narrow}
                data-testid={TID.trainTypeShortInput}
                value={typeShort}
                onChange={(e) => setTypeShort(e.currentTarget.value)}
              />
            </Field>
            <Field label="色">
              <input
                type="color"
                data-testid={TID.trainTypeColorInput}
                value={typeColor}
                onChange={(e) => setTypeColor(e.currentTarget.value)}
              />
            </Field>
            <button type="button" data-testid={TID.trainTypeSubmit} onClick={addType}>
              追加
            </button>
            <button type="button" data-testid={TID.trainTypeAdd} onClick={addType}>
              種別を追加
            </button>
          </div>

          <table className={styles.table} data-testid={TID.trainTypeList}>
            <thead>
              <tr>
                <th>名称</th>
                <th>略称</th>
                <th>色</th>
                <th>旅客</th>
                <th>順序</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {types.length === 0 ? (
                <tr>
                  <td colSpan={6} className={styles.empty}>
                    種別がありません
                  </td>
                </tr>
              ) : null}
              {types.map((type) => (
                <tr key={type.id} data-testid={TID.trainTypeRow} data-type-id={type.id}>
                  <td>
                    <input
                      className={styles.medium}
                      value={type.name}
                      aria-label={`${type.name} の名称`}
                      onChange={(e) =>
                        dispatch({
                          type: 'trainType/update',
                          id: type.id,
                          patch: { name: e.currentTarget.value },
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      className={styles.narrow}
                      value={type.shortName}
                      aria-label={`${type.name} の略称`}
                      onChange={(e) =>
                        dispatch({
                          type: 'trainType/update',
                          id: type.id,
                          patch: { shortName: e.currentTarget.value },
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="color"
                      value={type.color}
                      aria-label={`${type.name} の色`}
                      onChange={(e) =>
                        dispatch({
                          type: 'trainType/update',
                          id: type.id,
                          patch: { color: e.currentTarget.value },
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={type.isPassengerService}
                      aria-label={`${type.name} は旅客列車`}
                      onChange={(e) =>
                        dispatch({
                          type: 'trainType/update',
                          id: type.id,
                          patch: { isPassengerService: e.currentTarget.checked },
                        })
                      }
                    />
                  </td>
                  <td className={styles.num}>{type.sortOrder}</td>
                  <td>
                    <button
                      type="button"
                      className={styles.danger}
                      onClick={() => dispatch({ type: 'trainType/remove', id: type.id })}
                    >
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <PatternForm types={types} stations={stations} />
      </div>

      <Card title="停車パターン">
        {patterns.length === 0 || stations.length === 0 ? (
          <p className={styles.empty}>停車パターンを追加すると表が現れます</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table} data-testid={TID.patternMatrix}>
              <thead>
                <tr>
                  <th>駅</th>
                  {patterns.map((p) => (
                    <th key={p.id}>{p.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stations.map((station) => (
                  <tr key={station.id}>
                    <td>{station.name}</td>
                    {patterns.map((pattern) => {
                      const value: StopKind | 'none' = pattern.entries[station.id] ?? 'none';
                      const next = CYCLE[(CYCLE.indexOf(value) + 1) % CYCLE.length] ?? 'stop';
                      return (
                        <td key={pattern.id}>
                          <button
                            type="button"
                            data-testid={TID.patternCell(pattern.id, station.id)}
                            data-kind={value}
                            title={`${pattern.name} / ${station.name}`}
                            onClick={() =>
                              dispatch({
                                type: 'stopPattern/setEntry',
                                patternId: pattern.id,
                                stationId: station.id,
                                kind: next,
                              })
                            }
                          >
                            {CELL_LABEL[value]}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr>
                  <td>操作</td>
                  {patterns.map((pattern) => (
                    <td key={pattern.id}>
                      <button
                        type="button"
                        className={styles.danger}
                        onClick={() => dispatch({ type: 'stopPattern/remove', id: pattern.id })}
                      >
                        削除
                      </button>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function PatternForm({
  types,
  stations,
}: {
  types: TrainType[];
  stations: Array<{ id: StationId; name: string }>;
}) {
  const dispatch = useDispatch();
  const [name, setName] = useState('');
  const [typeId, setTypeId] = useState('');
  const [direction, setDirection] = useState<Direction | 'both'>('down');
  const [originId, setOriginId] = useState('');
  const [terminusId, setTerminusId] = useState('');

  const effectiveTypeId = typeId !== '' ? typeId : (types[0]?.id ?? '');
  const effectiveOrigin = originId !== '' ? originId : (stations[0]?.id ?? '');
  const effectiveTerminus =
    terminusId !== '' ? terminusId : (stations[stations.length - 1]?.id ?? '');

  const addPattern = (): void => {
    if (effectiveTypeId === '' || effectiveOrigin === '' || effectiveTerminus === '') return;
    const trimmed = name.trim();
    const typeName = types.find((t) => t.id === effectiveTypeId)?.name ?? '';
    const dirLabel = direction === 'up' ? '上り' : direction === 'down' ? '下り' : '両方向';
    const pattern: StopPattern = {
      id: newId<'StopPattern'>(ID_PREFIX.stopPattern),
      name: trimmed === '' ? `${typeName}(${dirLabel})` : trimmed,
      trainTypeId: effectiveTypeId as TrainTypeId,
      direction,
      originStationId: effectiveOrigin as StationId,
      terminusStationId: effectiveTerminus as StationId,
      // Default to stopping everywhere; the matrix is then a subtractive edit.
      entries: Object.fromEntries(stations.map((s) => [s.id, 'stop' as StopKind])),
    };
    dispatch({ type: 'stopPattern/add', pattern });
    setName('');
  };

  return (
    <Card title="停車パターンを追加">
      <div className={styles.form}>
        <Field label="名称">
          <input
            className={styles.medium}
            data-testid={TID.patternNameInput}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </Field>
        <Field label="種別">
          <select
            data-testid={TID.patternTypeSelect}
            value={effectiveTypeId}
            onChange={(e) => setTypeId(e.currentTarget.value)}
          >
            {types.length === 0 ? <option value="">(種別なし)</option> : null}
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="方向">
          <select
            data-testid={TID.patternDirectionSelect}
            value={direction}
            onChange={(e) => setDirection(e.currentTarget.value as Direction | 'both')}
          >
            <option value="down">下り</option>
            <option value="up">上り</option>
            <option value="both">両方向</option>
          </select>
        </Field>
        <Field label="始発駅">
          <select
            data-testid={TID.patternOriginSelect}
            value={effectiveOrigin}
            onChange={(e) => setOriginId(e.currentTarget.value)}
          >
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="終着駅">
          <select
            data-testid={TID.patternTerminusSelect}
            value={effectiveTerminus}
            onChange={(e) => setTerminusId(e.currentTarget.value)}
          >
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <button
          type="button"
          data-testid={TID.patternSubmit}
          onClick={addPattern}
          disabled={types.length === 0 || stations.length < 2}
        >
          追加
        </button>
        <button
          type="button"
          data-testid={TID.patternAdd}
          onClick={addPattern}
          disabled={types.length === 0 || stations.length < 2}
        >
          パターンを追加
        </button>
      </div>
      <p className={styles.hint}>
        追加した直後は全駅「停」です。表のセルをクリックして 停 → 通 → − と切り替えてください。
      </p>
    </Card>
  );
}
