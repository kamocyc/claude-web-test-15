import { TID } from '@e2e/testids';

import { entityCount } from '@/domain/units';
import { useProjectStore } from '@/store/projectStore';
import { useValidationStore } from '@/store/validationStore';
import { useDocValue } from '../hooks';

import styles from './Shell.module.css';

export interface StatusBarProps {
  message: string;
}

export function StatusBar({ message }: StatusBarProps) {
  const trainCount = useDocValue((d) => entityCount(d.trains));
  const stationCount = useDocValue((d) => entityCount(d.stations));
  const dutyCount = useDocValue((d) => entityCount(d.duties));
  const errorCount = useValidationStore((s) => s.result.errorCount);
  const warningCount = useValidationStore((s) => s.result.warningCount);
  const dirty = useProjectStore((s) => s.dirty);

  return (
    <footer className={styles.statusBar} data-testid={TID.statusBar}>
      <span data-testid={TID.statusTrainCount}>列車 {trainCount}</span>
      <span>駅 {stationCount}</span>
      <span>運用 {dutyCount}</span>
      <span className={styles.countError} data-testid={TID.statusErrorCount}>
        エラー {errorCount}
      </span>
      <span className={styles.countWarning} data-testid={TID.statusWarningCount}>
        警告 {warningCount}
      </span>
      {dirty ? <span className={styles.dirtyDot}>● 未保存</span> : null}
      <span className={styles.spacer} />
      <span>{message}</span>
    </footer>
  );
}
