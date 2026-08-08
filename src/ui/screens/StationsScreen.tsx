/**
 * 駅・番線・駅間・車庫 — the infrastructure the whole timetable rests on, and
 * therefore the first screen of the from-scratch build path.
 */

import { useMemo, useState } from 'react';
import { TID } from '@e2e/testids';

import { ID_PREFIX } from '@/domain/ids';
import type { PerfProfileId, StationId } from '@/domain/ids';
import type {
  Depot,
  Direction,
  PerfProfile,
  Station,
  StationTrack,
  TrackUsage,
} from '@/domain/model';
import { orderedStations, tracksOfStation } from '@/domain/project';
import { entityList, formatKm, kmToMeters, metersToKm } from '@/domain/units';
import { StationYardChart } from '@/render';
import { newId } from '@/store/idPool';
import { useUiStore } from '@/store/uiStore';
import { Card, CheckField, Field } from '../components/Field';
import { useDispatch, useDoc } from '../hooks';

import styles from './Editor.module.css';

const USAGES: TrackUsage[] = ['main', 'passing', 'through', 'depot', 'stabling'];
const USAGE_LABEL: Record<TrackUsage, string> = {
  main: '本線',
  passing: '待避線',
  through: '通過線',
  depot: '入出庫線',
  stabling: '留置線',
};

export function StationsScreen() {
  const doc = useDoc();
  const dispatch = useDispatch();
  const select = useUiStore((s) => s.select);
  const selectedRef = useUiStore((s) => s.selected[0]);

  const stations = useMemo(() => orderedStations(doc), [doc]);
  const allStations = useMemo(() => entityList(doc.stations), [doc]);
  const links = useMemo(() => entityList(doc.links), [doc]);
  const profiles = useMemo(() => entityList(doc.perfProfiles), [doc]);
  const depots = useMemo(() => entityList(doc.depots), [doc]);

  /**
   * A brand-new project has no performance profile, but the run-time table is
   * the first thing a user fills in. Create the default profile on demand
   * rather than disabling the column and stranding them.
   */
  const ensureProfileId = (): PerfProfileId => {
    const existing = entityList(doc.perfProfiles)[0];
    if (existing !== undefined) return existing.id;
    const profile: PerfProfile = {
      id: newId<'PerfProfile'>(ID_PREFIX.perfProfile),
      name: '標準性能',
      accelKmhps: 3.0,
      decelKmhps: 3.5,
      maxSpeedKmh: 110,
    };
    dispatch({ type: 'perfProfile/add', profile });
    return profile.id;
  };

  const [pickedStationId, setPickedStationId] = useState<string>('');
  const currentStationId =
    selectedRef?.kind === 'station'
      ? selectedRef.stationId
      : ((pickedStationId !== '' ? pickedStationId : stations[0]?.id) ?? '');
  const currentStation = doc.stations.byId[currentStationId];

  // -- new station form ----------------------------------------------------
  const [name, setName] = useState('');
  const [km, setKm] = useState('');
  const [code, setCode] = useState('');

  const addStation = (): void => {
    const trimmed = name.trim();
    if (trimmed === '') {
      document.querySelector<HTMLInputElement>(`[data-testid="${TID.stationNameInput}"]`)?.focus();
      return;
    }
    const kmValue = Number(km);
    const station: Station = {
      id: newId<'Station'>(ID_PREFIX.station),
      name: trimmed,
      kind: 'passenger',
      kmFromOrigin: kmToMeters(Number.isFinite(kmValue) ? kmValue : 0),
      trackIds: [],
      minDwellSec: 20,
      minTurnbackSec: doc.validationConfig.defaultMinTurnbackSec,
      defaultTrackId: {},
      isConnectionPoint: false,
    };
    if (code.trim() !== '') station.code = code.trim();

    const track: StationTrack = {
      id: newId<'StationTrack'>(ID_PREFIX.stationTrack),
      stationId: station.id,
      name: '1番線',
      number: 1,
      usage: 'main',
      hasPlatform: true,
      directions: ['down', 'up'],
      canTurnBack: true,
      canBeOvertaken: false,
      maxCars: 10,
      approachSec: 45,
      clearSec: 30,
    };
    station.trackIds.push(track.id);
    station.defaultTrackId = { down: track.id, up: track.id };

    dispatch({ type: 'station/add', station, tracks: [track] });
    setName('');
    setKm('');
    setCode('');
    setPickedStationId(station.id);
    select({ kind: 'station', stationId: station.id });
  };

  return (
    <div className={styles.screen}>
      <div className={styles.columns}>
        <Card title="駅">
          <div className={styles.form}>
            <Field label="駅名">
              <input
                className={styles.medium}
                data-testid={TID.stationNameInput}
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
              />
            </Field>
            <Field label="営業キロ (km)">
              <input
                className={styles.narrow}
                data-testid={TID.stationKmInput}
                value={km}
                inputMode="decimal"
                onChange={(e) => setKm(e.currentTarget.value)}
              />
            </Field>
            <Field label="駅コード">
              <input
                className={styles.narrow}
                data-testid={TID.stationCodeInput}
                value={code}
                onChange={(e) => setCode(e.currentTarget.value)}
              />
            </Field>
            <button type="button" data-testid={TID.stationSubmit} onClick={addStation}>
              追加
            </button>
            <button type="button" data-testid={TID.stationAdd} onClick={addStation}>
              駅を追加
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: 'station/reorderByKm' })}
              disabled={stations.length < 2}
            >
              キロ順に整列
            </button>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table} data-testid={TID.stationList}>
              <thead>
                <tr>
                  <th>駅名</th>
                  <th>km</th>
                  <th>コード</th>
                  <th>最小停車</th>
                  <th>最小折返</th>
                  <th>接続駅</th>
                  <th>番線</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {allStations.length === 0 ? (
                  <tr>
                    <td colSpan={8} className={styles.empty}>
                      駅がありません
                    </td>
                  </tr>
                ) : null}
                {allStations.map((station) => (
                  <tr
                    key={station.id}
                    data-testid={TID.stationRow}
                    data-station-id={station.id}
                    className={station.id === currentStationId ? styles.selectedRow : ''}
                    onClick={() => {
                      setPickedStationId(station.id);
                      select({ kind: 'station', stationId: station.id });
                    }}
                  >
                    <td>
                      <input
                        className={styles.medium}
                        value={station.name}
                        aria-label={`${station.name} の駅名`}
                        onChange={(e) =>
                          dispatch({
                            type: 'station/update',
                            id: station.id,
                            patch: { name: e.currentTarget.value },
                          })
                        }
                      />
                    </td>
                    <td className={styles.num}>
                      <input
                        className={styles.narrow}
                        value={metersToKm(station.kmFromOrigin)}
                        inputMode="decimal"
                        aria-label={`${station.name} の営業キロ`}
                        onChange={(e) =>
                          dispatch({
                            type: 'station/update',
                            id: station.id,
                            patch: { kmFromOrigin: kmToMeters(Number(e.currentTarget.value) || 0) },
                          })
                        }
                      />
                    </td>
                    <td>{station.code ?? '—'}</td>
                    <td className={styles.num}>
                      <input
                        className={styles.narrow}
                        data-testid={
                          station.id === currentStationId ? TID.stationMinDwell : undefined
                        }
                        value={station.minDwellSec}
                        inputMode="numeric"
                        aria-label={`${station.name} の最小停車時間`}
                        onChange={(e) =>
                          dispatch({
                            type: 'station/update',
                            id: station.id,
                            patch: { minDwellSec: Number(e.currentTarget.value) || 0 },
                          })
                        }
                      />
                    </td>
                    <td className={styles.num}>
                      <input
                        className={styles.narrow}
                        data-testid={
                          station.id === currentStationId ? TID.stationMinTurnback : undefined
                        }
                        value={station.minTurnbackSec}
                        inputMode="numeric"
                        aria-label={`${station.name} の最小折返時間`}
                        onChange={(e) =>
                          dispatch({
                            type: 'station/update',
                            id: station.id,
                            patch: { minTurnbackSec: Number(e.currentTarget.value) || 0 },
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        data-testid={
                          station.id === currentStationId ? TID.stationIsConnectionPoint : undefined
                        }
                        checked={station.isConnectionPoint}
                        aria-label={`${station.name} は接続駅`}
                        onChange={(e) =>
                          dispatch({
                            type: 'station/update',
                            id: station.id,
                            patch: { isConnectionPoint: e.currentTarget.checked },
                          })
                        }
                      />
                    </td>
                    <td className={styles.num}>{station.trackIds.length}</td>
                    <td>
                      <button
                        type="button"
                        className={styles.danger}
                        onClick={() => dispatch({ type: 'station/remove', id: station.id })}
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

        <TrackEditor
          station={currentStation}
          onPickStation={(id) => {
            setPickedStationId(id);
            select({ kind: 'station', stationId: id as StationId });
          }}
          stations={allStations}
        />
      </div>

      <div className={styles.columns}>
        <Card title="駅間">
          <div className={styles.tableWrap}>
            <table className={styles.table} data-testid={TID.linkList}>
              <thead>
                <tr>
                  <th>区間</th>
                  <th>距離</th>
                  <th>性能</th>
                  <th>基準運転時分(秒)</th>
                  <th>起動(秒)</th>
                  <th>停止(秒)</th>
                  <th>最小時隔(秒)</th>
                </tr>
              </thead>
              <tbody>
                {links.length === 0 ? (
                  <tr>
                    <td colSpan={7} className={styles.empty}>
                      駅を 2 つ以上追加すると駅間が作られます
                    </td>
                  </tr>
                ) : null}
                {links.map((link) => {
                  const profile = profiles[0];
                  const rt = doc.linkRunTimes.find(
                    (r) => r.linkId === link.id && r.profileId === profile?.id,
                  );
                  return (
                    <tr key={link.id} data-testid={TID.linkRow} data-link-id={link.id}>
                      <td>
                        {doc.stations.byId[link.fromStationId]?.name ?? '?'} —{' '}
                        {doc.stations.byId[link.toStationId]?.name ?? '?'}
                      </td>
                      <td className={styles.num}>{formatKm(link.distance, 2)}</td>
                      <td>{profile?.name ?? '—'}</td>
                      <td className={styles.num}>
                        <input
                          className={styles.narrow}
                          data-testid={TID.linkRunTimeInput}
                          value={rt?.baseRunSec ?? ''}
                          inputMode="numeric"
                          aria-label="基準運転時分"
                          onChange={(e) => {
                            dispatch({
                              type: 'runTime/set',
                              linkId: link.id,
                              profileId: ensureProfileId(),
                              baseRunSec: Number(e.currentTarget.value) || 0,
                              startPenaltySec: rt?.startPenaltySec ?? 10,
                              stopPenaltySec: rt?.stopPenaltySec ?? 10,
                            });
                          }}
                        />
                      </td>
                      <td className={styles.num}>
                        <input
                          className={styles.narrow}
                          value={rt?.startPenaltySec ?? ''}
                          inputMode="numeric"
                          aria-label="起動時分"
                          onChange={(e) => {
                            dispatch({
                              type: 'runTime/set',
                              linkId: link.id,
                              profileId: ensureProfileId(),
                              baseRunSec: rt?.baseRunSec ?? 0,
                              startPenaltySec: Number(e.currentTarget.value) || 0,
                              stopPenaltySec: rt?.stopPenaltySec ?? 10,
                            });
                          }}
                        />
                      </td>
                      <td className={styles.num}>
                        <input
                          className={styles.narrow}
                          value={rt?.stopPenaltySec ?? ''}
                          inputMode="numeric"
                          aria-label="停止時分"
                          onChange={(e) => {
                            dispatch({
                              type: 'runTime/set',
                              linkId: link.id,
                              profileId: ensureProfileId(),
                              baseRunSec: rt?.baseRunSec ?? 0,
                              startPenaltySec: rt?.startPenaltySec ?? 10,
                              stopPenaltySec: Number(e.currentTarget.value) || 0,
                            });
                          }}
                        />
                      </td>
                      <td className={styles.num}>
                        <input
                          className={styles.narrow}
                          data-testid={TID.linkHeadwayInput}
                          value={link.minHeadwaySec}
                          inputMode="numeric"
                          aria-label="最小時隔"
                          onChange={(e) =>
                            dispatch({
                              type: 'link/update',
                              id: link.id,
                              patch: { minHeadwaySec: Number(e.currentTarget.value) || 0 },
                            })
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className={styles.hint}>
            所要時間を入力すると既定の性能 (標準性能) が自動で作成されます。
          </p>
        </Card>

        <DepotEditor stations={stations} depots={depots} />
      </div>

      <Card title="構内ダイヤ">
        {currentStation === undefined ? (
          <p className={styles.empty}>駅を選択してください</p>
        ) : (
          <StationYardChart
            stationId={currentStation.id}
            onSelect={(ref) => select(ref)}
          />
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

function TrackEditor({
  station,
  stations,
  onPickStation,
}: {
  station: Station | undefined;
  stations: Station[];
  onPickStation(id: string): void;
}) {
  const doc = useDoc();
  const dispatch = useDispatch();
  const [name, setName] = useState('');
  const [usage, setUsage] = useState<TrackUsage>('main');
  const [hasPlatform, setHasPlatform] = useState(true);
  const [canTurnBack, setCanTurnBack] = useState(true);
  const [canBeOvertaken, setCanBeOvertaken] = useState(false);
  const [maxCars, setMaxCars] = useState('10');
  const [down, setDown] = useState(true);
  const [up, setUp] = useState(true);

  const tracks = station === undefined ? [] : tracksOfStation(doc, station.id);

  const addTrack = (): void => {
    if (station === undefined) return;
    const directions: Direction[] = [];
    if (down) directions.push('down');
    if (up) directions.push('up');
    const trimmed = name.trim();
    const track: StationTrack = {
      id: newId<'StationTrack'>(ID_PREFIX.stationTrack),
      stationId: station.id,
      name: trimmed === '' ? `${tracks.length + 1}番線` : trimmed,
      number: tracks.length + 1,
      usage,
      hasPlatform,
      directions: directions.length === 0 ? ['down', 'up'] : directions,
      canTurnBack,
      canBeOvertaken,
      maxCars: Number(maxCars) || 10,
      approachSec: 45,
      clearSec: 30,
    };
    dispatch({ type: 'track/add', track });
    setName('');
  };

  return (
    <Card
      title="番線"
      actions={
        <select
          data-testid={TID.stationSelect}
          aria-label="対象駅"
          value={station?.id ?? ''}
          onChange={(e) => onPickStation(e.currentTarget.value)}
        >
          {stations.length === 0 ? <option value="">(駅なし)</option> : null}
          {stations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      }
    >
      {station === undefined ? (
        <p className={styles.empty}>駅を選択してください</p>
      ) : (
        <>
          <div className={styles.form}>
            <Field label="番線名">
              <input
                className={styles.medium}
                data-testid={TID.trackNameInput}
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
              />
            </Field>
            <Field label="用途">
              <select
                data-testid={TID.trackUsageSelect}
                value={usage}
                onChange={(e) => setUsage(e.currentTarget.value as TrackUsage)}
              >
                {USAGES.map((u) => (
                  <option key={u} value={u}>
                    {USAGE_LABEL[u]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="有効長(両)">
              <input
                className={styles.narrow}
                data-testid={TID.trackMaxCars}
                value={maxCars}
                inputMode="numeric"
                onChange={(e) => setMaxCars(e.currentTarget.value)}
              />
            </Field>
            <CheckField
              label="ホーム"
              testid={TID.trackHasPlatform}
              checked={hasPlatform}
              onChange={setHasPlatform}
            />
            <CheckField
              label="折返可"
              testid={TID.trackCanTurnBack}
              checked={canTurnBack}
              onChange={setCanTurnBack}
            />
            <CheckField
              label="待避可"
              testid={TID.trackCanBeOvertaken}
              checked={canBeOvertaken}
              onChange={setCanBeOvertaken}
            />
            <CheckField label="下り" testid={TID.trackDirectionDown} checked={down} onChange={setDown} />
            <CheckField label="上り" testid={TID.trackDirectionUp} checked={up} onChange={setUp} />
            <button type="button" data-testid={TID.trackSubmit} onClick={addTrack}>
              追加
            </button>
            <button type="button" data-testid={TID.trackAdd} onClick={addTrack}>
              番線を追加
            </button>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table} data-testid={TID.trackList}>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>用途</th>
                  <th>ホーム</th>
                  <th>下</th>
                  <th>上</th>
                  <th>折返</th>
                  <th>待避</th>
                  <th>両数</th>
                  <th>進入(秒)</th>
                  <th>開通(秒)</th>
                  <th>既定(下)</th>
                  <th>既定(上)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tracks.length === 0 ? (
                  <tr>
                    <td colSpan={13} className={styles.empty}>
                      番線がありません
                    </td>
                  </tr>
                ) : null}
                {tracks.map((track) => (
                  <tr key={track.id} data-testid={TID.trackRow} data-track-id={track.id}>
                    <td>
                      <input
                        className={styles.narrow}
                        value={track.name}
                        aria-label={`${track.name} の名称`}
                        onChange={(e) =>
                          dispatch({
                            type: 'track/update',
                            id: track.id,
                            patch: { name: e.currentTarget.value },
                          })
                        }
                      />
                    </td>
                    <td>
                      <select
                        value={track.usage}
                        aria-label={`${track.name} の用途`}
                        onChange={(e) =>
                          dispatch({
                            type: 'track/update',
                            id: track.id,
                            patch: { usage: e.currentTarget.value as TrackUsage },
                          })
                        }
                      >
                        {USAGES.map((u) => (
                          <option key={u} value={u}>
                            {USAGE_LABEL[u]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <BoolCell
                      label={`${track.name} のホーム`}
                      value={track.hasPlatform}
                      onChange={(v) =>
                        dispatch({ type: 'track/update', id: track.id, patch: { hasPlatform: v } })
                      }
                    />
                    <DirectionCell track={track} direction="down" />
                    <DirectionCell track={track} direction="up" />
                    <BoolCell
                      label={`${track.name} の折返可`}
                      value={track.canTurnBack}
                      onChange={(v) =>
                        dispatch({ type: 'track/update', id: track.id, patch: { canTurnBack: v } })
                      }
                    />
                    <BoolCell
                      label={`${track.name} の待避可`}
                      value={track.canBeOvertaken}
                      onChange={(v) =>
                        dispatch({
                          type: 'track/update',
                          id: track.id,
                          patch: { canBeOvertaken: v },
                        })
                      }
                    />
                    <td className={styles.num}>
                      <input
                        className={styles.narrow}
                        value={track.maxCars}
                        inputMode="numeric"
                        aria-label={`${track.name} の有効長`}
                        onChange={(e) =>
                          dispatch({
                            type: 'track/update',
                            id: track.id,
                            patch: { maxCars: Number(e.currentTarget.value) || 1 },
                          })
                        }
                      />
                    </td>
                    <td className={styles.num}>
                      <input
                        className={styles.narrow}
                        value={track.approachSec}
                        inputMode="numeric"
                        aria-label={`${track.name} の進入時分`}
                        onChange={(e) =>
                          dispatch({
                            type: 'track/update',
                            id: track.id,
                            patch: { approachSec: Number(e.currentTarget.value) || 0 },
                          })
                        }
                      />
                    </td>
                    <td className={styles.num}>
                      <input
                        className={styles.narrow}
                        value={track.clearSec}
                        inputMode="numeric"
                        aria-label={`${track.name} の開通時分`}
                        onChange={(e) =>
                          dispatch({
                            type: 'track/update',
                            id: track.id,
                            patch: { clearSec: Number(e.currentTarget.value) || 0 },
                          })
                        }
                      />
                    </td>
                    <DefaultTrackCell station={station} track={track} direction="down" />
                    <DefaultTrackCell station={station} track={track} direction="up" />
                    <td>
                      <button
                        type="button"
                        className={styles.danger}
                        onClick={() => dispatch({ type: 'track/remove', id: track.id })}
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

function BoolCell({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange(next: boolean): void;
}) {
  return (
    <td>
      <input
        type="checkbox"
        checked={value}
        aria-label={label}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
    </td>
  );
}

function DirectionCell({ track, direction }: { track: StationTrack; direction: Direction }) {
  const dispatch = useDispatch();
  const on = track.directions.includes(direction);
  return (
    <td>
      <input
        type="checkbox"
        checked={on}
        aria-label={`${track.name} の${direction === 'down' ? '下り' : '上り'}`}
        onChange={(e) => {
          const next = e.currentTarget.checked
            ? [...new Set([...track.directions, direction])]
            : track.directions.filter((d) => d !== direction);
          dispatch({ type: 'track/update', id: track.id, patch: { directions: next } });
        }}
      />
    </td>
  );
}

function DefaultTrackCell({
  station,
  track,
  direction,
}: {
  station: Station;
  track: StationTrack;
  direction: Direction;
}) {
  const dispatch = useDispatch();
  const on = station.defaultTrackId[direction] === track.id;
  return (
    <td>
      <input
        type="radio"
        name={`default-${station.id}-${direction}`}
        checked={on}
        aria-label={`${track.name} を${direction === 'down' ? '下り' : '上り'}既定にする`}
        onChange={() =>
          dispatch({
            type: 'station/update',
            id: station.id,
            patch: {
              defaultTrackId: { ...station.defaultTrackId, [direction]: track.id },
            },
          })
        }
      />
    </td>
  );
}

// ---------------------------------------------------------------------------

function DepotEditor({ stations, depots }: { stations: Station[]; depots: Depot[] }) {
  const doc = useDoc();
  const dispatch = useDispatch();
  const [name, setName] = useState('');
  const [attachedId, setAttachedId] = useState('');
  const [accessSec, setAccessSec] = useState('90');
  const [capacity, setCapacity] = useState('8');

  const addDepot = (): void => {
    const attached = doc.stations.byId[attachedId !== '' ? attachedId : (stations[0]?.id ?? '')];
    if (attached === undefined) return;
    const trimmed = name.trim() === '' ? `${attached.name}車庫` : name.trim();

    const depotId = newId<'Depot'>(ID_PREFIX.depot);
    const station: Station = {
      id: newId<'Station'>(ID_PREFIX.station),
      name: trimmed,
      kind: 'depot',
      kmFromOrigin: attached.kmFromOrigin - 500,
      trackIds: [],
      minDwellSec: 0,
      minTurnbackSec: 0,
      defaultTrackId: {},
      isConnectionPoint: false,
    };
    const track: StationTrack = {
      id: newId<'StationTrack'>(ID_PREFIX.stationTrack),
      stationId: station.id,
      name: '留置1番',
      usage: 'stabling',
      hasPlatform: false,
      directions: ['down', 'up'],
      canTurnBack: true,
      canBeOvertaken: false,
      maxCars: 10,
      approachSec: 30,
      clearSec: 30,
      depotId,
    };
    station.trackIds.push(track.id);

    const depot: Depot = {
      id: depotId,
      name: trimmed,
      stationId: station.id,
      attachedStationId: attached.id,
      accessRunSec: Number(accessSec) || 90,
      prepSec: 300,
      capacityFormations: Number(capacity) || 8,
      inspectionKinds: ['train', 'monthly'],
      stubOffsetMeters: -500,
    };

    dispatch({ type: 'depot/add', depot, station, tracks: [track] });
    setName('');
  };

  return (
    <Card title="車庫">
      <div className={styles.form}>
        <Field label="車庫名">
          <input
            className={styles.medium}
            data-testid={TID.depotNameInput}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </Field>
        <Field label="接続駅">
          <select
            data-testid={TID.depotStationSelect}
            value={attachedId !== '' ? attachedId : (stations[0]?.id ?? '')}
            onChange={(e) => setAttachedId(e.currentTarget.value)}
          >
            {stations.length === 0 ? <option value="">(駅なし)</option> : null}
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="出入庫(秒)">
          <input
            className={styles.narrow}
            data-testid={TID.depotAccessSecInput}
            value={accessSec}
            inputMode="numeric"
            onChange={(e) => setAccessSec(e.currentTarget.value)}
          />
        </Field>
        <Field label="収容(編成)">
          <input
            className={styles.narrow}
            data-testid={TID.depotCapacityInput}
            value={capacity}
            inputMode="numeric"
            onChange={(e) => setCapacity(e.currentTarget.value)}
          />
        </Field>
        <button
          type="button"
          data-testid={TID.depotSubmit}
          onClick={addDepot}
          disabled={stations.length === 0}
        >
          追加
        </button>
        <button
          type="button"
          data-testid={TID.depotAdd}
          onClick={addDepot}
          disabled={stations.length === 0}
        >
          車庫を追加
        </button>
      </div>

      <table className={styles.table} data-testid={TID.depotList}>
        <thead>
          <tr>
            <th>名称</th>
            <th>接続駅</th>
            <th>出入庫(秒)</th>
            <th>準備(秒)</th>
            <th>収容</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {depots.length === 0 ? (
            <tr>
              <td colSpan={6} className={styles.empty}>
                車庫がありません
              </td>
            </tr>
          ) : null}
          {depots.map((depot) => (
            <tr key={depot.id} data-testid={TID.depotRow} data-depot-id={depot.id}>
              <td>{depot.name}</td>
              <td>{doc.stations.byId[depot.attachedStationId]?.name ?? '—'}</td>
              <td className={styles.num}>
                <input
                  className={styles.narrow}
                  value={depot.accessRunSec}
                  inputMode="numeric"
                  aria-label={`${depot.name} の出入庫時分`}
                  onChange={(e) =>
                    dispatch({
                      type: 'depot/update',
                      id: depot.id,
                      patch: { accessRunSec: Number(e.currentTarget.value) || 0 },
                    })
                  }
                />
              </td>
              <td className={styles.num}>
                <input
                  className={styles.narrow}
                  value={depot.prepSec}
                  inputMode="numeric"
                  aria-label={`${depot.name} の準備時分`}
                  onChange={(e) =>
                    dispatch({
                      type: 'depot/update',
                      id: depot.id,
                      patch: { prepSec: Number(e.currentTarget.value) || 0 },
                    })
                  }
                />
              </td>
              <td className={styles.num}>{depot.capacityFormations}</td>
              <td>
                <button
                  type="button"
                  className={styles.danger}
                  onClick={() => dispatch({ type: 'depot/remove', id: depot.id })}
                >
                  削除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
