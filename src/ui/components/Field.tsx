import type { ReactNode } from 'react';

import styles from '../screens/Editor.module.css';

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function CheckField({
  label,
  checked,
  onChange,
  testid,
}: {
  label: string;
  checked: boolean;
  onChange(next: boolean): void;
  testid?: string;
}) {
  return (
    <label className={styles.checkField}>
      <input
        type="checkbox"
        data-testid={testid}
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function Card({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>
        {title}
        <span className={styles.spacer} />
        {actions}
      </h2>
      {children}
    </section>
  );
}
