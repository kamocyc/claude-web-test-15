import { useMemo, useState } from 'react';
import { TID } from '@e2e/testids';

import { entityList } from '@/domain/units';
import { StringDiagramCanvas } from '@/render';
import { useClockStore } from '@/store/clockStore';
import { useUiStore } from '@/store/uiStore';
import { useDoc } from '../hooks';

import styles from './Editor.module.css';

/** 運行図表 — the classic time/distance string diagram. */
export function DiagramScreen() {
  const doc = useDoc();
  const select = useUiStore((s) => s.select);
  const seek = useClockStore((s) => s.seek);
  const [showDeadhead, setShowDeadhead] = useState(true);
  const [highlightDutyId, setHighlightDutyId] = useState('');
  const [verticalScale, setVerticalScale] = useState<'km' | 'index'>('km');

  const duties = useMemo(() => entityList(doc.duties), [doc]);

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
          data-testid={TID.diagramHighlightDuty}
          aria-label="運用を強調"
          value={highlightDutyId}
          onChange={(e) => setHighlightDutyId(e.currentTarget.value)}
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
      </div>

      <div className={styles.canvasHost}>
        <StringDiagramCanvas
          showDeadhead={showDeadhead}
          verticalScale={verticalScale}
          {...(highlightDutyId !== '' ? { highlightDutyId } : {})}
          onSelect={(ref, additive) => select(ref, additive)}
          onSeek={(t) => seek(t)}
        />
      </div>
    </div>
  );
}
