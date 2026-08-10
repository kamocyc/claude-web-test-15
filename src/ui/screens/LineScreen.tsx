import { useMemo, useState } from 'react';
import { TID } from '@e2e/testids';

import { entityList } from '@/domain/units';
import { LineViewCanvas } from '@/render';
import { useClockStore } from '@/store/clockStore';
import { useUiStore } from '@/store/uiStore';
import { useDoc } from '../hooks';

import styles from './Editor.module.css';

/** The線区 view: the line drawn to scale with every train on it right now. */
export function LineScreen() {
  const doc = useDoc();
  const select = useUiStore((s) => s.select);
  const seek = useClockStore((s) => s.seek);
  const [showDeadhead, setShowDeadhead] = useState(true);
  // Shared with 運行図表 and with the inspector's 「運用を強調」 — see uiStore.
  const highlightDutyId = useUiStore((s) => s.highlightDutyId);
  const setHighlightDuty = useUiStore((s) => s.setHighlightDuty);

  const types = useMemo(
    () => entityList(doc.trainTypes).slice().sort((a, b) => a.sortOrder - b.sortOrder),
    [doc],
  );
  const duties = useMemo(() => entityList(doc.duties), [doc]);

  return (
    <div className={styles.screen}>
      <div className={styles.chipRow}>
        <button
          type="button"
          className={`${styles.chip} ${showDeadhead ? styles.chipOn : styles.chipOff}`}
          aria-pressed={showDeadhead}
          onClick={() => setShowDeadhead((v) => !v)}
        >
          回送を表示
        </button>
        <select
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
      </div>

      <div className={styles.canvasHost}>
        <LineViewCanvas
          showDeadhead={showDeadhead}
          {...(highlightDutyId !== undefined ? { highlightDutyId } : {})}
          onSelect={(ref, additive) => select(ref, additive)}
          onSeek={(t) => seek(t)}
        />
      </div>

      <div className={styles.legend} data-testid={TID.lineViewLegend}>
        {types.length === 0 ? <span>種別が未登録です</span> : null}
        {types.map((type) => (
          <span key={type.id} className={styles.legendItem}>
            <span className={styles.swatch} style={{ background: type.color }} />
            {type.name}
          </span>
        ))}
      </div>
    </div>
  );
}
