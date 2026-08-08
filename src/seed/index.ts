/**
 * STUB — owned by the seed stream. Replace the body, keep the signature.
 *
 * Builds the 東急大井町線 sample project deterministically: no Date.now(), no
 * Math.random(), ids from a monotonic counter, so the output is byte-stable.
 */
import type { ProjectDocument } from '@/domain/model';
import { createEmptyProject } from '@/domain/project';

export function buildOimachiProject(): ProjectDocument {
  return createEmptyProject({ name: '東急大井町線', lineName: '大井町線' });
}
