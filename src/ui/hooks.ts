/**
 * Store access for screens.
 *
 * `useDoc()` deliberately hands back the whole document rather than a selected
 * slice: zustand v5 compares selector results with `Object.is`, so a selector
 * that derives an array (`entityList(...)`) re-renders forever. Screens take the
 * document and memoize their own derivations. The 60 Hz clock lives in a
 * different store, so this costs nothing per frame.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ProjectDocument } from '@/domain/model';
import type { Command } from '@/store/commands';
import { useProjectStore } from '@/store/projectStore';

export function useDoc(): ProjectDocument {
  return useProjectStore((s) => s.doc);
}

/** Selector form — only safe for primitives and stable references. */
export function useDocValue<T>(selector: (doc: ProjectDocument) => T): T {
  return useProjectStore((s) => selector(s.doc));
}

export function useDispatch(): (cmd: Command) => void {
  return useProjectStore((s) => s.dispatch);
}

/** Read the document imperatively — for event handlers, never for rendering. */
export function readDoc(): ProjectDocument {
  return useProjectStore.getState().doc;
}

/** Local form state that resets whenever `resetKey` changes. */
export function useFormState<T extends object>(
  initial: T,
  resetKey?: string,
): [T, (next: Partial<T>) => void, () => void] {
  const initialRef = useRef(initial);
  const [value, setValue] = useState<T>(initial);

  useEffect(() => {
    setValue(initialRef.current);
  }, [resetKey]);

  const patch = useCallback((next: Partial<T>) => {
    setValue((prev) => ({ ...prev, ...next }));
  }, []);
  const reset = useCallback(() => setValue(initialRef.current), []);
  return [value, patch, reset];
}
