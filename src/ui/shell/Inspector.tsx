import { useMemo } from 'react';
import { TID } from '@e2e/testids';

import { formatTime } from '@/domain/time';
import { formatKm, getEntity } from '@/domain/units';
import { trainLabel, trainStartSec, trainEndSec, dutySpan, dutyDistance } from '@/domain/project';
import { useUiStore } from '@/store/uiStore';
import { useDoc } from '../hooks';

import styles from './Shell.module.css';

/** Details of the primary selection. Read-only; editing happens in screens. */
export function Inspector() {
  const open = useUiStore((s) => s.inspectorOpen);
  const toggle = useUiStore((s) => s.toggleInspector);
  const ref = useUiStore((s) => s.selected[0]);
  const count = useUiStore((s) => s.selected.length);

  const doc = useDoc();
  const rows = useMemo((): Array<[string, string]> => {
    if (ref === undefined) return [];
    switch (ref.kind) {
      case 'train': {
        const train = getEntity(doc.trains, ref.trainId);
        if (train === undefined) return [['列車', '(削除済み)']];
        const start = trainStartSec(train);
        const end = trainEndSec(train);
        return [
          ['列車', trainLabel(doc, train)],
          ['番号', train.number],
          ['方向', train.direction === 'down' ? doc.line.downDirectionLabel : doc.line.upDirectionLabel],
          ['区分', train.category],
          ['停車数', String(train.stops.length)],
          ['始発', start === undefined ? '—' : formatTime(start)],
          ['終着', end === undefined ? '—' : formatTime(end)],
        ];
      }
      case 'station': {
        const station = getEntity(doc.stations, ref.stationId);
        if (station === undefined) return [['駅', '(削除済み)']];
        return [
          ['駅', station.name],
          ['営業キロ', formatKm(station.kmFromOrigin)],
          ['番線数', String(station.trackIds.length)],
          ['最小停車', `${station.minDwellSec}秒`],
          ['最小折返', `${station.minTurnbackSec}秒`],
        ];
      }
      case 'stationTrack': {
        const track = getEntity(doc.stationTracks, ref.stationTrackId);
        if (track === undefined) return [['番線', '(削除済み)']];
        const station = getEntity(doc.stations, track.stationId);
        return [
          ['番線', `${station?.name ?? ''} ${track.name}`],
          ['用途', track.usage],
          ['ホーム', track.hasPlatform ? 'あり' : 'なし'],
          ['方向', track.directions.join('/')],
          ['折返', track.canTurnBack ? '可' : '不可'],
          ['待避', track.canBeOvertaken ? '可' : '不可'],
          ['有効長', `${track.maxCars}両`],
        ];
      }
      case 'link': {
        const link = getEntity(doc.links, ref.linkId);
        if (link === undefined) return [['駅間', '(削除済み)']];
        return [
          ['駅間', `${getEntity(doc.stations, link.fromStationId)?.name ?? ''} — ${getEntity(doc.stations, link.toStationId)?.name ?? ''}`],
          ['距離', formatKm(link.distance)],
          ['線路数', String(link.trackCount)],
          ['最小時隔', `${link.minHeadwaySec}秒`],
        ];
      }
      case 'duty': {
        const duty = getEntity(doc.duties, ref.dutyId);
        if (duty === undefined) return [['運用', '(削除済み)']];
        const span = dutySpan(doc, duty);
        return [
          ['運用', duty.code],
          ['行路数', String(duty.legs.length)],
          ['時間帯', span === undefined ? '—' : `${formatTime(span.from)}–${formatTime(span.to)}`],
          ['走行距離', formatKm(dutyDistance(doc, duty))],
          ['必要両数', duty.requiredCars === undefined ? '—' : `${duty.requiredCars}両`],
        ];
      }
      case 'formation': {
        const formation = getEntity(doc.formations, ref.formationId);
        if (formation === undefined) return [['編成', '(削除済み)']];
        return [
          ['編成', formation.code],
          ['形式', getEntity(doc.formationSeries, formation.seriesId)?.name ?? '—'],
          ['両数', `${formation.cars}両`],
          ['状態', formation.status],
          ['基準走行', `${formation.odometerKm.toLocaleString()}km`],
        ];
      }
      case 'depot': {
        const depot = getEntity(doc.depots, ref.depotId);
        if (depot === undefined) return [['車庫', '(削除済み)']];
        return [
          ['車庫', depot.name],
          ['接続駅', getEntity(doc.stations, depot.attachedStationId)?.name ?? '—'],
          ['出入庫時分', `${depot.accessRunSec}秒`],
          ['収容', `${depot.capacityFormations}編成`],
        ];
      }
      case 'inspection': {
        const formation = getEntity(doc.formations, ref.formationId);
        const rule = getEntity(doc.inspectionRules, ref.ruleId);
        return [
          ['検査', rule?.name ?? ref.ruleId],
          ['編成', formation?.code ?? ref.formationId],
        ];
      }
      default:
        return [];
    }
  }, [doc, ref]);

  if (!open) {
    return (
      <aside className={`${styles.inspector} ${styles.inspectorCollapsed}`} data-testid={TID.inspector}>
        <button type="button" onClick={() => toggle()} title="詳細を開く">
          ‹
        </button>
      </aside>
    );
  }

  return (
    <aside className={styles.inspector} data-testid={TID.inspector}>
      <div className={styles.group}>
        <span className={styles.inspectorTitle} data-testid={TID.inspectorTitle}>
          {ref === undefined ? '未選択' : titleOf(ref.kind)}
        </span>
        <span className={styles.spacer} />
        <button type="button" onClick={() => toggle()} title="詳細を閉じる">
          ›
        </button>
      </div>
      {count > 1 ? <p>{count} 件選択中</p> : null}
      <dl className={styles.kv}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

function titleOf(kind: string): string {
  const map: Record<string, string> = {
    train: '列車',
    station: '駅',
    stationTrack: '番線',
    link: '駅間',
    duty: '運用',
    formation: '編成',
    depot: '車庫',
    inspection: '検査',
  };
  return map[kind] ?? kind;
}
