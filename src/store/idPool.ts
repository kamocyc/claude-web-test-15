/**
 * The single id source for entities created interactively.
 *
 * Ids come from a monotonic counter rather than a random source so that the
 * same sequence of GUI actions produces the same document every run — which is
 * what makes the E2E suite able to assert on ids at all.
 */

import { ID_PREFIX, IdPool, type Id } from '@/domain/ids';
import type { ProjectDocument } from '@/domain/model';
import { collectAllIds } from '@/domain/project';

export const idPool = new IdPool();

export function newId<K extends string>(prefix: string): Id<K> {
  return idPool.next<K>(prefix);
}

/** Seed the pool from a document so interactive ids cannot collide with it. */
export function observeDocument(doc: ProjectDocument): void {
  for (const id of collectAllIds(doc)) idPool.observe(id);
  for (const t of doc.linkRunTimes) {
    idPool.observe(t.linkId);
    idPool.observe(t.profileId);
  }
}

export { ID_PREFIX };
