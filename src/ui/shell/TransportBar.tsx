import { TID } from '@e2e/testids';

import { formatTime } from '@/domain/time';
import { entityList } from '@/domain/units';
import type { DayTypeId } from '@/domain/ids';
import { CLOCK_SPEEDS } from '@/engine';
import { useClockStore } from '@/store/clockStore';
import { useDispatch, useDoc } from '../hooks';


import styles from './Shell.module.css';

/** Play/pause, the clock readout, a scrub slider, speed, date and day type. */
export function TransportBar() {
  const tSec = useClockStore((s) => s.tSec);
  const playing = useClockStore((s) => s.playing);
  const speed = useClockStore((s) => s.speed);
  const from = useClockStore((s) => s.from);
  const to = useClockStore((s) => s.to);
  const seek = useClockStore((s) => s.seek);
  const toggle = useClockStore((s) => s.toggle);
  const setSpeed = useClockStore((s) => s.setSpeed);

  const dispatch = useDispatch();
  const doc = useDoc();
  const activeDate = doc.settings.activeDate;
  const activeDayTypeId = doc.settings.activeDayTypeId;
  const dayTypes = entityList(doc.dayTypes);

  return (
    <div className={styles.transport} data-testid={TID.transportBar}>
      <button
        type="button"
        data-testid={TID.playPause}
        aria-pressed={playing}
        onClick={() => toggle()}
        title={playing ? '一時停止' : '再生'}
      >
        {playing ? '⏸' : '▶'}
      </button>

      <output className={styles.clock} data-testid={TID.clockReadout}>
        {formatTime(tSec)}
      </output>

      <input
        className={styles.slider}
        type="range"
        data-testid={TID.clockSlider}
        aria-label="時刻"
        min={from}
        max={to}
        step={30}
        value={Math.round(tSec)}
        onChange={(e) => seek(Number(e.currentTarget.value))}
      />

      <select
        data-testid={TID.speedSelect}
        aria-label="再生速度"
        value={String(speed)}
        onChange={(e) => setSpeed(Number(e.currentTarget.value))}
      >
        {CLOCK_SPEEDS.map((s) => (
          <option key={s} value={String(s)}>
            ×{s}
          </option>
        ))}
      </select>

      <input
        type="date"
        data-testid={TID.dateInput}
        aria-label="対象日"
        value={activeDate}
        onChange={(e) =>
          dispatch({ type: 'settings/update', patch: { activeDate: e.currentTarget.value } })
        }
      />

      <select
        data-testid={TID.dayTypeSelect}
        aria-label="曜日種別"
        value={activeDayTypeId}
        onChange={(e) =>
          dispatch({
            type: 'settings/update',
            patch: { activeDayTypeId: e.currentTarget.value as DayTypeId },
          })
        }
      >
        {dayTypes.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
    </div>
  );
}
