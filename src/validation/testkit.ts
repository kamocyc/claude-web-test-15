/**
 * Shared scaffolding for the rule tests.
 *
 * Every rule test follows the same shape: take `toyProjectCopy()` (which is
 * clean), break exactly one thing, and assert the exact issue id and severity.
 * Running a single rule keeps the assertion honest — a rule cannot pass by
 * riding on another rule's finding.
 */

import type { ProjectDocument } from '@/domain/model';
import { runValidation } from './run';
import type { Issue, RuleId, Severity } from './types';

export function issuesFor(doc: ProjectDocument, ruleId: RuleId): Issue[] {
  return runValidation(doc, { ruleIds: [ruleId] }).issues;
}

export function idsFor(doc: ProjectDocument, ruleId: RuleId): string[] {
  return issuesFor(doc, ruleId).map((i) => i.id);
}

/** Assert that exactly this issue id is present, with this severity. */
export function expectIssue(
  doc: ProjectDocument,
  ruleId: RuleId,
  id: string,
  severity: Severity,
): Issue {
  const issues = issuesFor(doc, ruleId);
  const found = issues.find((i) => i.id === id);
  if (!found) {
    throw new Error(
      `expected issue ${id}\n  got: ${issues.map((i) => i.id).join('\n       ') || '(none)'}`,
    );
  }
  if (found.severity !== severity) {
    throw new Error(`expected severity ${severity} for ${id}, got ${found.severity}`);
  }
  if (found.ruleId !== ruleId) {
    throw new Error(`expected ruleId ${ruleId} for ${id}, got ${found.ruleId}`);
  }
  if (found.detail.trim() === '' || found.title.trim() === '') {
    throw new Error(`issue ${id} has an empty title or detail`);
  }
  return found;
}
