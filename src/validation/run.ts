/**
 * STUB — owned by the engine/validation stream. Replace the body, keep the
 * signature.
 *
 * Synchronous and pure, so Vitest and the seed generator can call it directly.
 * The UI wraps it in a worker.
 */

import type { ProjectDocument } from '@/domain/model';
import type { RunValidationOptions, ValidationResult } from './types';

export function runValidation(
  _doc: ProjectDocument,
  _opts: RunValidationOptions = {},
): ValidationResult {
  return {
    issues: [],
    byRule: {},
    errorCount: 0,
    warningCount: 0,
    infoCount: 0,
    durationMs: 0,
    truncated: false,
  };
}
