/**
 * Synchronous and pure, so Vitest and the seed generator can call it directly.
 * The UI wraps it in a worker.
 */

import type { ProjectDocument } from '@/domain/model';
import { buildIndex } from '@/engine/buildIndex';
import { ALL_RULES, RULES } from './registry';
import {
  MAX_ISSUES,
  type Issue,
  type Rule,
  type RuleId,
  type RunValidationOptions,
  type Severity,
  type ValidationContext,
  type ValidationResult,
} from './types';

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * `'off'` disables a rule entirely; otherwise an explicit override wins over
 * whatever the rule chose.
 *
 * Absent an override the *issue's own* severity stands. Most rules emit a
 * single severity equal to their `defaultSeverity`, but a few genuinely have
 * two grades of the same finding — `turnback.trackChanged` is an error where
 * the infrastructure makes the move impossible and a warning where it is
 * merely unmodelled — and forcing every issue to the rule default would erase
 * that distinction.
 */
function severityOf(rule: Rule, ctx: ValidationContext): Severity | 'off' | undefined {
  return ctx.cfg.severityOverrides[rule.id];
}

function compareIssues(a: Issue, b: Issue): number {
  const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (bySeverity !== 0) return bySeverity;
  const at = (a.at ?? Number.POSITIVE_INFINITY) - (b.at ?? Number.POSITIVE_INFINITY);
  if (at !== 0 && Number.isFinite(at)) return at;
  if (a.at === undefined && b.at !== undefined) return 1;
  if (a.at !== undefined && b.at === undefined) return -1;
  return a.id.localeCompare(b.id);
}

export function runValidation(
  doc: ProjectDocument,
  opts: RunValidationOptions = {},
): ValidationResult {
  const started = now();
  const date = opts.date ?? opts.index?.date ?? doc.settings.activeDate;
  const idx = opts.index ?? buildIndex(doc, date);
  const ctx: ValidationContext = { doc, idx, cfg: doc.validationConfig };

  const selected = opts.ruleIds === undefined ? undefined : new Set<RuleId>(opts.ruleIds);
  const wanted = (rule: Rule): boolean => selected === undefined || selected.has(rule.id);

  const collect = (rules: Rule[]): Issue[] => {
    const issues: Issue[] = [];
    for (const rule of rules) {
      if (!wanted(rule)) continue;
      const override = severityOf(rule, ctx);
      if (override === 'off') continue;
      for (const issue of rule.run(ctx)) {
        issue.severity = override ?? issue.severity ?? rule.defaultSeverity;
        issues.push(issue);
      }
    }
    return issues;
  };

  // Referential integrity short-circuits everything else: with a dangling id
  // the remaining rules only produce cascading noise from one root cause.
  const refRule = RULES['ref.dangling'];
  let issues: Issue[];
  const refIssues = wanted(refRule) ? collect([refRule]) : [];
  if (refIssues.length > 0) {
    issues = refIssues;
  } else {
    issues = collect(ALL_RULES.filter((r) => r.id !== 'ref.dangling'));
  }

  issues.sort(compareIssues);
  const truncated = issues.length > MAX_ISSUES;
  if (truncated) issues = issues.slice(0, MAX_ISSUES);

  const byRule: Record<string, number> = {};
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  for (const issue of issues) {
    byRule[issue.ruleId] = (byRule[issue.ruleId] ?? 0) + 1;
    if (issue.severity === 'error') errorCount++;
    else if (issue.severity === 'warning') warningCount++;
    else infoCount++;
  }

  return {
    issues,
    byRule,
    errorCount,
    warningCount,
    infoCount,
    durationMs: now() - started,
    truncated,
  };
}
