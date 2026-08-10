import { useMemo, useState } from 'react';
import { TID } from '@e2e/testids';

import type { TrainId } from '@/domain/ids';
import { entityList, getEntity } from '@/domain/units';
import { StringDiagramCanvas } from '@/render';
import { useClockStore } from '@/store/clockStore';
import { useUiStore, type DirectionFilter } from '@/store/uiStore';
import { useDoc } from '../hooks';

import styles from './Editor.module.css';

/** 運行図表 — the classic time/distance string diagram. */
export function DiagramScreen() {
  const doc = useDoc();
  const select = useUiStore((s) => s.select);
  const seek = useClockStore((s) => s.seek);
  const [showDeadhead, setShowDeadhead] = useState(true);
  const [verticalScale, setVerticalScale] = useState<'km' | 'index'>('km');

  // The duty highlight and the direction filter live in the ui store: the
  // inspector sets the first one from a train, and both survive a trip to
  // another screen and back.
  const highlightDutyId = useUiStore((s) => s.highlightDutyId);
  const setHighlightDuty = useUiStore((s) => s.setHighlightDuty);
  const direction = useUiStore((s) => s.diagramDirection);
  const setDirection = useUiStore((s) => s.setDiagramDirection);
  const selected = useUiStore((s) => s.selected);

  const duties = useMemo(() => entityList(doc.duties), [doc]);
  const selectedTrainIds = useMemo(
    (): TrainId[] => selected.flatMap((ref) => (ref.kind === 'train' ? [ref.trainId] : [])),
    [selected],
  );
  const highlightedDuty =
    highlightDutyId === undefined ? undefined : getEntity(doc.duties, highlightDutyId);

  return (
    <div className={styles.screen}>
      <div className={styles.chipRow}>
        <label className={styles.legendItem}>
          <input
            type="checkbox"
            data-testid={TID.diagramShowDeadhead}
            checked={showDeadhead}
            onChange={(e) => setShowDeadhead(e.currentTarget.checked)}
          />
          回送を表示
        </label>
        <select
          data-testid={TID.diagramDirection}
          aria-label="方向"
          value={direction}
          onChange={(e) => setDirection(e.currentTarget.value as DirectionFilter)}
        >
          <option value="both">上下線とも表示</option>
          <option value="down">{doc.line.downDirectionLabel}のみ</option>
          <option value="up">{doc.line.upDirectionLabel}のみ</option>
        </select>
        <select
          data-testid={TID.diagramHighlightDuty}
          aria-label="運用を強調"
          value={highlightDutyId ?? ''}
          onChange={(e) => {
            const value = e.currentTarget.value;
            setHighlightDuty(value === '' ? undefined : value);
          }}
        >
          <option value="">運用の強調なし</option>
          {duties.map((d) => (
            <option key={d.id} value={d.id}>
              {d.code}
            </option>
          ))}
        </select>
        <select
          aria-label="縦軸"
          value={verticalScale}
          onChange={(e) => setVerticalScale(e.currentTarget.value as 'km' | 'index')}
        >
          <option value="km">縦軸: 営業キロ</option>
          <option value="index">縦軸: 等間隔</option>
        </select>
        {highlightedDuty !== undefined ? (
          <span className={styles.hint} data-testid={TID.diagramHighlightNote}>
            運用 {highlightedDuty.code} を強調中
          </span>
        ) : null}
      </div>

      <div className={styles.canvasHost}>
        <StringDiagramCanvas
          showDeadhead={showDeadhead}
          verticalScale={verticalScale}
          direction={direction}
          selectedTrainIds={selectedTrainIds}
          {...(highlightDutyId !== undefined ? { highlightDutyId } : {})}
          onSelect={(ref, additive) => select(ref, additive)}
          onSeek={(t) => seek(t)}
        />
      </div>
    </div>
  );
}
