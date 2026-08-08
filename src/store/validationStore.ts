/**
 * Validation runs 250 ms after the last command, not on every keystroke.
 *
 * It runs inline rather than in a worker: correctness first, and the whole rule
 * catalogue over a day's timetable is a few milliseconds. A generation counter
 * discards results that arrive after a newer run has started, so a slow pass can
 * never overwrite a fresh one.
 */

import { create } from 'zustand';

import type { ProjectDocument } from '@/domain/model';
import { getIndex } from './projectStore';
import { runValidation, type Issue, type Severity, type ValidationResult } from '@/validation';

export const VALIDATION_DEBOUNCE_MS = 250;

export const EMPTY_VALIDATION: ValidationResult = {
  issues: [],
  byRule: {},
  errorCount: 0,
  warningCount: 0,
  infoCount: 0,
  durationMs: 0,
  truncated: false,
};

export interface ValidationStoreState {
  result: ValidationResult;
  running: boolean;
  /** Severities the problem panel is currently showing. */
  filters: Record<Severity, boolean>;
  setFilter(severity: Severity, on: boolean): void;
  visibleIssues(): Issue[];
}

export const useValidationStore = create<ValidationStoreState>((set, get) => ({
  result: EMPTY_VALIDATION,
  running: false,
  filters: { error: true, warning: true, info: true },
  setFilter: (severity, on) => set({ filters: { ...get().filters, [severity]: on } }),
  visibleIssues: () => {
    const { result, filters } = get();
    return result.issues.filter((i) => filters[i.severity]);
  },
}));

function setRootState(value: 'running' | 'idle'): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-validation-state', value);
  const app = document.querySelector('[data-testid="app"]');
  if (app) app.setAttribute('data-validation-state', value);
}

let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Run the catalogue now, bypassing the debounce. */
export function runValidationNow(doc: ProjectDocument): void {
  const mine = ++generation;
  useValidationStore.setState({ running: true });
  setRootState('running');
  try {
    const result = runValidation(doc, { date: doc.settings.activeDate, index: getIndex() });
    if (mine !== generation) return;
    useValidationStore.setState({ result, running: false });
  } catch (err) {
    if (mine !== generation) return;
    useValidationStore.setState({
      result: {
        ...EMPTY_VALIDATION,
        issues: [],
      },
      running: false,
    });
    if (typeof console !== 'undefined') console.error('検証に失敗しました', err);
  } finally {
    if (mine === generation) setRootState('idle');
  }
}

/** Debounced entry point. Every command funnels through here. */
export function scheduleValidation(getDoc: () => ProjectDocument): void {
  if (timer !== undefined) clearTimeout(timer);
  useValidationStore.setState({ running: true });
  setRootState('running');
  timer = setTimeout(() => {
    timer = undefined;
    runValidationNow(getDoc());
  }, VALIDATION_DEBOUNCE_MS);
}

export function cancelScheduledValidation(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}
