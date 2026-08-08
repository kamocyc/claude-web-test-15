import { useMemo } from 'react';
import { TID } from '@e2e/testids';

import { formatTime } from '@/domain/time';
import { useUiStore } from '@/store/uiStore';
import { useValidationStore } from '@/store/validationStore';
import { RULE_GROUP_LABEL, type Issue, type Severity } from '@/validation';

import styles from './ProblemPanel.module.css';

const SEVERITY_MARK: Record<Severity, string> = { error: '✖', warning: '▲', info: 'ℹ' };
const SEVERITY_CLASS: Record<Severity, string> = {
  error: styles.sevError ?? '',
  warning: styles.sevWarning ?? '',
  info: styles.sevInfo ?? '',
};

/**
 * Issues grouped by rule. Clicking a row is the app's main navigation gesture:
 * it seeks the clock, switches screen and selects the offending entity in one
 * step, so a finding is never a dead end.
 */
export function ProblemPanel() {
  const result = useValidationStore((s) => s.result);
  const filters = useValidationStore((s) => s.filters);
  const setFilter = useValidationStore((s) => s.setFilter);
  const running = useValidationStore((s) => s.running);
  const open = useUiStore((s) => s.problemPanelOpen);
  const toggleOpen = useUiStore((s) => s.toggleProblemPanel);
  const focusOn = useUiStore((s) => s.focusOn);

  const groups = useMemo(() => {
    const visible = result.issues.filter((i) => filters[i.severity]);
    const byRule = new Map<string, Issue[]>();
    for (const issue of visible) {
      const list = byRule.get(issue.ruleId) ?? [];
      list.push(issue);
      byRule.set(issue.ruleId, list);
    }
    return [...byRule.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [result, filters]);

  const total = groups.reduce((n, [, list]) => n + list.length, 0);

  return (
    <section
      className={`${styles.panel} ${open ? '' : styles.collapsed}`}
      data-testid={TID.problemPanel}
      aria-label="問題"
    >
      <div className={styles.header}>
        <button type="button" onClick={() => toggleOpen()} aria-expanded={open}>
          {open ? '▾' : '▸'}
        </button>
        <span className={styles.title}>問題 {total}</span>
        {running ? <span>検証中…</span> : null}
        <span className={styles.spacer} />
        <FilterChip
          testid={TID.problemFilterError}
          label={`エラー ${result.errorCount}`}
          on={filters.error}
          onToggle={() => setFilter('error', !filters.error)}
        />
        <FilterChip
          testid={TID.problemFilterWarning}
          label={`警告 ${result.warningCount}`}
          on={filters.warning}
          onToggle={() => setFilter('warning', !filters.warning)}
        />
        <FilterChip
          testid={TID.problemFilterInfo}
          label={`情報 ${result.infoCount}`}
          on={filters.info}
          onToggle={() => setFilter('info', !filters.info)}
        />
      </div>

      {open ? (
        <ul className={styles.list} data-testid={TID.problemList}>
          {total === 0 ? (
            <li className={styles.empty} data-testid={TID.problemEmpty}>
              問題は見つかりませんでした
            </li>
          ) : (
            groups.map(([ruleId, issues]) => (
              <li key={ruleId}>
                <div className={styles.group}>
                  {RULE_GROUP_LABEL[ruleId.split('.')[0] ?? ''] ?? ''} / {ruleId} — {issues.length}
                </div>
                <ul className={styles.list}>
                  {issues.map((issue) => (
                    <li key={issue.id}>
                      <button
                        type="button"
                        className={styles.item}
                        data-testid={TID.problemItem}
                        data-severity={issue.severity}
                        data-rule-id={issue.ruleId}
                        onClick={() => {
                          const ref = issue.refs[0];
                          if (ref === undefined) return;
                          const request: Parameters<typeof focusOn>[0] = { ref };
                          if (issue.at !== undefined) request.at = issue.at;
                          if (issue.km !== undefined) request.km = issue.km;
                          focusOn(request);
                        }}
                      >
                        <span className={`${styles.sev} ${SEVERITY_CLASS[issue.severity]}`}>
                          {SEVERITY_MARK[issue.severity]}
                        </span>
                        <span className={styles.itemTitle}>{issue.title}</span>
                        <span className={styles.itemDetail}>{issue.detail}</span>
                        <span className={styles.itemAt}>
                          {issue.at === undefined ? '' : formatTime(issue.at)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </section>
  );
}

function FilterChip({
  testid,
  label,
  on,
  onToggle,
}: {
  testid: string;
  label: string;
  on: boolean;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      aria-pressed={on}
      className={`${styles.filter} ${on ? styles.filterOn : styles.filterOff}`}
      onClick={onToggle}
    >
      {label}
    </button>
  );
}
