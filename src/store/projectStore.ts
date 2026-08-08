/**
 * The document store.
 *
 * Three properties matter and each drives a design choice:
 *
 * 1. **Every write is undoable.** `dispatch` runs the reducer through
 *    `produceWithPatches` and files the patch pair in history.
 * 2. **The derived index is expensive.** It is memoized on `revision` and built
 *    lazily, so a command that nobody looks at costs nothing.
 * 3. **The render loop must not subscribe.** `useProjectStore.getState()` is a
 *    plain read; the 60 Hz canvas loop calls it inside its animation frame and
 *    never triggers a React render.
 */

import { applyPatches, enablePatches, produceWithPatches } from 'immer';
import { create } from 'zustand';

import type { ProjectDocument } from '@/domain/model';
import { createEmptyProject } from '@/domain/project';
import { buildIndex, type TimetableIndex } from '@/engine';
import type { EntityRef } from '@/validation/types';

import { COMMAND_LABEL, mergeKeyOf, scopesOf, type Command } from './commands';
import { pushHistory, type HistoryEntry } from './history';
import { observeDocument } from './idPool';
import { reduce } from './reducer';
import { useUiStore } from './uiStore';

enablePatches();

export interface ProjectStoreState {
  doc: ProjectDocument;
  /** Increments on every accepted mutation, including undo and redo. */
  revision: number;
  history: HistoryEntry[];
  redoStack: HistoryEntry[];
  dirty: boolean;
  dispatch(cmd: Command): void;
  undo(): void;
  redo(): void;
  markSaved(): void;
  /** Replace the document without touching history — used by autosave restore. */
  hydrate(doc: ProjectDocument): void;
}

function initialDoc(): ProjectDocument {
  const doc = createEmptyProject();
  observeDocument(doc);
  return doc;
}

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  doc: initialDoc(),
  revision: 0,
  history: [],
  redoStack: [],
  dirty: false,

  dispatch: (cmd) => {
    const state = get();
    const selectionBefore = useUiStore.getState().selected;

    const [next, patches, inverse] = produceWithPatches(state.doc, (draft) => {
      reduce(draft, cmd);
    });
    if (patches.length === 0) return;

    observeDocument(next);
    const selectionAfter = useUiStore.getState().selected;
    const mergeKey = mergeKeyOf(cmd);

    const entry: HistoryEntry = {
      label: COMMAND_LABEL[cmd.type] ?? cmd.type,
      patches: patches as HistoryEntry['patches'],
      inverse: inverse as HistoryEntry['inverse'],
      scopes: scopesOf(cmd),
      selectionBefore,
      selectionAfter,
      at: Date.now(),
    };
    if (mergeKey !== undefined) entry.mergeKey = mergeKey;

    const history = pushHistory(state.history, entry);
    set({
      doc: next,
      revision: state.revision + 1,
      history,
      redoStack: [],
      dirty: true,
    });

    // A handler often selects what it just created *after* dispatching. Settle
    // `selectionAfter` at the end of the tick so redo lands on that selection
    // rather than on whatever was selected before the edit.
    const top = history[history.length - 1];
    if (top !== undefined) {
      queueMicrotask(() => {
        const current = get().history;
        if (current[current.length - 1] !== top) return;
        top.selectionAfter = useUiStore.getState().selected;
      });
    }
  },

  undo: () => {
    const state = get();
    const entry = state.history[state.history.length - 1];
    if (entry === undefined) return;
    const doc = applyPatches(state.doc, entry.inverse);
    set({
      doc,
      revision: state.revision + 1,
      history: state.history.slice(0, -1),
      redoStack: [...state.redoStack, entry],
      dirty: true,
    });
    useUiStore.getState().setSelected(entry.selectionBefore);
  },

  redo: () => {
    const state = get();
    const entry = state.redoStack[state.redoStack.length - 1];
    if (entry === undefined) return;
    const doc = applyPatches(state.doc, entry.patches);
    set({
      doc,
      revision: state.revision + 1,
      history: [...state.history, entry],
      redoStack: state.redoStack.slice(0, -1),
      dirty: true,
    });
    useUiStore.getState().setSelected(entry.selectionAfter);
  },

  markSaved: () => set({ dirty: false }),

  hydrate: (doc) => {
    observeDocument(doc);
    set({ doc, revision: get().revision + 1, history: [], redoStack: [], dirty: false });
  },
}));

// ---------------------------------------------------------------------------
// The memoized simulation index
// ---------------------------------------------------------------------------

let cached: { revision: number; date: string; index: TimetableIndex } | undefined;
let indexGeneration = 0;

/**
 * The derived index for the current document. Rebuilt only when the revision or
 * the active date has moved — callers may hit this many times per frame.
 */
export function getIndex(): TimetableIndex {
  const { doc, revision } = useProjectStore.getState();
  const date = doc.settings.activeDate;
  if (cached !== undefined && cached.revision === revision && cached.date === date) {
    return cached.index;
  }
  const index = buildIndex(doc, date);
  cached = { revision, date, index };
  indexGeneration += 1;
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-index-generation', String(indexGeneration));
  }
  return index;
}

export function getIndexGeneration(): number {
  return indexGeneration;
}

/**
 * Subscribe to the index. Re-renders only when the document revision or the
 * active date moves — never on a clock tick.
 */
export function useTimetableIndex(): TimetableIndex {
  const revision = useProjectStore((s) => s.revision);
  const date = useProjectStore((s) => s.doc.settings.activeDate);
  void revision;
  void date;
  return getIndex();
}

/** Drop the memo — only needed by tests that swap documents behind the store. */
export function resetIndexCache(): void {
  cached = undefined;
}

// ---------------------------------------------------------------------------
// Selection-aware helpers used across the UI
// ---------------------------------------------------------------------------

export function dispatch(cmd: Command): void {
  useProjectStore.getState().dispatch(cmd);
}

export function getDoc(): ProjectDocument {
  return useProjectStore.getState().doc;
}

export function currentSelection(): EntityRef[] {
  return useUiStore.getState().selected;
}
