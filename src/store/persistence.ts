/**
 * Autosave into IndexedDB.
 *
 * Debounced 1500 ms, and every save also lands in a 10-deep ring buffer. The
 * ring exists because the failure mode that actually loses work is not a crash
 * — it is a bad bulk edit autosaved over a good document, and a single "latest"
 * slot cannot recover from that.
 */

import { openDB, type IDBPDatabase } from 'idb';

import type { ProjectDocument } from '@/domain/model';
import { RESTORE_AUTOSAVE } from '@/testMode';

import { fromJson, toJson } from '@/io/serialize';

export const DB_NAME = 'rosim';
export const DB_VERSION = 1;
export const STORE_CURRENT = 'current';
export const STORE_SNAPSHOTS = 'snapshots';
export const AUTOSAVE_DEBOUNCE_MS = 1500;
export const SNAPSHOT_RING_SIZE = 10;

export type AutosaveState = 'saving' | 'saved' | 'idle' | 'error';

export interface SnapshotRecord {
  seq: number;
  savedAt: string;
  name: string;
  json: string;
}

let dbPromise: Promise<IDBPDatabase> | undefined;

function db(): Promise<IDBPDatabase> {
  if (dbPromise === undefined) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(STORE_CURRENT)) {
          database.createObjectStore(STORE_CURRENT);
        }
        if (!database.objectStoreNames.contains(STORE_SNAPSHOTS)) {
          database.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'seq' });
        }
      },
    });
  }
  return dbPromise;
}

function setAutosaveAttribute(state: AutosaveState): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-autosave-state', state);
  const app = document.querySelector('[data-testid="app"]');
  if (app) app.setAttribute('data-autosave-state', state);
}

let timer: ReturnType<typeof setTimeout> | undefined;
let sequence = 0;
const listeners = new Set<(state: AutosaveState) => void>();

function emit(state: AutosaveState): void {
  setAutosaveAttribute(state);
  for (const fn of listeners) fn(state);
}

export function onAutosaveStateChange(fn: (state: AutosaveState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Write immediately. Returns false when persistence is unavailable. */
export async function saveNow(doc: ProjectDocument): Promise<boolean> {
  if (typeof indexedDB === 'undefined') {
    emit('idle');
    return false;
  }
  emit('saving');
  try {
    const json = toJson(doc);
    const database = await db();
    await database.put(STORE_CURRENT, { json, savedAt: new Date().toISOString() }, 'doc');

    sequence += 1;
    const record: SnapshotRecord = {
      seq: sequence,
      savedAt: new Date().toISOString(),
      name: doc.meta.name,
      json,
    };
    await database.put(STORE_SNAPSHOTS, record);

    const keys = (await database.getAllKeys(STORE_SNAPSHOTS)) as number[];
    if (keys.length > SNAPSHOT_RING_SIZE) {
      const doomed = keys.sort((a, b) => a - b).slice(0, keys.length - SNAPSHOT_RING_SIZE);
      for (const key of doomed) await database.delete(STORE_SNAPSHOTS, key);
    }

    emit('saved');
    return true;
  } catch (err) {
    if (typeof console !== 'undefined') console.error('自動保存に失敗しました', err);
    emit('error');
    return false;
  }
}

/** Debounced autosave. Every command funnels through here. */
export function scheduleAutosave(getDoc: () => ProjectDocument, onSaved?: () => void): void {
  if (typeof indexedDB === 'undefined') return;
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void saveNow(getDoc()).then((ok) => {
      if (ok && onSaved) onSaved();
    });
  }, AUTOSAVE_DEBOUNCE_MS);
}

export function cancelScheduledAutosave(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}

/**
 * Read back the last autosave. Returns undefined when restore is disabled
 * (`?e2e=1` without `persist=1`), when nothing is stored, or when the stored
 * document no longer validates.
 */
export async function restoreAutosave(): Promise<ProjectDocument | undefined> {
  if (!RESTORE_AUTOSAVE) return undefined;
  if (typeof indexedDB === 'undefined') return undefined;
  try {
    const database = await db();
    const stored = (await database.get(STORE_CURRENT, 'doc')) as { json: string } | undefined;
    if (stored === undefined) return undefined;
    const parsed = fromJson(stored.json);
    if (!parsed.ok) return undefined;
    // Keep the ring's sequence monotonic across reloads.
    const keys = (await database.getAllKeys(STORE_SNAPSHOTS)) as number[];
    sequence = keys.length > 0 ? Math.max(...keys) : 0;
    return parsed.doc;
  } catch {
    return undefined;
  }
}

export async function listSnapshots(): Promise<SnapshotRecord[]> {
  if (typeof indexedDB === 'undefined') return [];
  try {
    const database = await db();
    const all = (await database.getAll(STORE_SNAPSHOTS)) as SnapshotRecord[];
    return all.sort((a, b) => b.seq - a.seq);
  } catch {
    return [];
  }
}

export async function clearAutosave(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const database = await db();
    await database.clear(STORE_CURRENT);
    await database.clear(STORE_SNAPSHOTS);
    sequence = 0;
    emit('idle');
  } catch {
    emit('error');
  }
}
