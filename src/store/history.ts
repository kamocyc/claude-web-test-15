/**
 * Undo history built on Immer patches.
 *
 * Storing patches rather than whole documents keeps a 200-deep history cheap
 * even for a 500-train timetable, and makes "undo restores what you had
 * selected" possible: an entry carries the selection on both sides of the edit.
 */

import type { Patch } from 'immer';

import type { RuleScope } from '@/validation/types';
import type { EntityRef } from '@/validation/types';

export const HISTORY_LIMIT = 200;

/** Two edits with the same merge key inside this window become one entry. */
export const MERGE_WINDOW_MS = 800;

export interface HistoryEntry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  scopes: readonly RuleScope[];
  selectionBefore: EntityRef[];
  selectionAfter: EntityRef[];
  mergeKey?: string;
  /** `Date.now()` when the edit was made. Drives merge coalescing only. */
  at: number;
}

/**
 * Fold `entry` into `history`, coalescing with the previous entry when both
 * carry the same merge key and arrived close together. Returns a new array —
 * the input is never mutated.
 */
export function pushHistory(history: readonly HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const last = history[history.length - 1];
  const mergeable =
    last !== undefined &&
    entry.mergeKey !== undefined &&
    last.mergeKey === entry.mergeKey &&
    entry.at - last.at <= MERGE_WINDOW_MS;

  if (mergeable && last !== undefined) {
    const merged: HistoryEntry = {
      label: last.label,
      patches: [...last.patches, ...entry.patches],
      // Undo applies these in order, so the newer inverse must come first.
      inverse: [...entry.inverse, ...last.inverse],
      scopes: dedupeScopes([...last.scopes, ...entry.scopes]),
      selectionBefore: last.selectionBefore,
      selectionAfter: entry.selectionAfter,
      at: entry.at,
    };
    if (last.mergeKey !== undefined) merged.mergeKey = last.mergeKey;
    return [...history.slice(0, -1), merged];
  }

  const next = [...history, entry];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

function dedupeScopes(scopes: readonly RuleScope[]): RuleScope[] {
  return [...new Set(scopes)];
}
