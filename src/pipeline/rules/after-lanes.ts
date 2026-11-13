import type { Finding, ValidationRequest } from '../../contracts/schemas.js';
import { ContractError } from '../../base/errors.js';
import type { Immutable } from '../../base/json.js';
import { INTERNAL_ERROR_FINDING_LIMIT, notifyInternalError } from '../../core/internal-errors.js';
import type { InternalErrorObserver, RuleActivity } from '../../core/internal-errors.js';
import type { SourceLineIndex } from '../../parsing/locations.js';
import type { RequestBudget } from '../../runtime/request-budget.js';
import { scalarConstEdit, SCALAR_FIX_LIMITS } from '../scalar-fixes.js';
import type { RuleSubject } from '../types.js';
import { internalErrorFinding } from './findings.js';
import type { FixCandidate, Rule, RuleFailure, SubjectReport } from './types.js';

/** Builds the generated fix of one candidate. Injectable for tests; defaults to `scalarConstEdit`. */
export type EditBuilder = typeof scalarConstEdit;

export interface AfterLanesInput {
  readonly run: Immutable<ValidationRequest>;
  readonly budget: RequestBudget;
  readonly onInternalError?: InternalErrorObserver | undefined;
  readonly buildEdit?: EditBuilder;
}

/** Inserts each value at its recorded position; positions are in nondecreasing order. */
function inserted<T>(base: readonly T[], additions: readonly { at: number; value: T }[]): T[] {
  if (!additions.length) return [...base];
  const result: T[] = [];
  let next = 0;
  for (const { at, value } of additions) {
    while (next < at) result.push(base[next++]!);
    result.push(value);
  }
  while (next < base.length) result.push(base[next++]!);
  return result;
}

/** The one walk after the lanes, in sorted subject order and rule order. */
class Settlement {
  private fixes = 0;
  private reported = 0;
  private assigning = true;
  private readonly indexes = new Map<string, SourceLineIndex>();
  private readonly buildEdit: EditBuilder;

  constructor(private readonly input: AfterLanesInput) {
    this.buildEdit = input.buildEdit ?? scalarConstEdit;
  }

  /** The internal-error finding, while the run's limit allows one, and the observer call. */
  report(
    rule: Rule,
    subject: RuleSubject,
    location: Immutable<Finding['location']>,
    activity: RuleActivity,
    error: unknown,
  ): Finding | undefined {
    if (this.reported >= INTERNAL_ERROR_FINDING_LIMIT) return undefined;
    this.reported++;
    notifyInternalError(this.input.onInternalError, {
      stage: 'rules',
      activity,
      ruleId: rule.id,
      subjectId: subject.id,
      location,
      error,
    });
    return internalErrorFinding(this.input.run, rule, subject.id, location, activity, error);
  }

  /**
   * Attaches a generated fix to the candidate's finding while fewer than the limit exist and the
   * budget is not interrupted. A `limit` contract error drops the fix; another contract error
   * propagates; any other error drops the fix and is returned to be reported.
   */
  assign(candidate: FixCandidate): { readonly error: unknown } | undefined {
    if (!this.assigning || this.fixes >= SCALAR_FIX_LIMITS.generated) return undefined;
    if (this.input.budget.interrupted) {
      this.assigning = false;
      return undefined;
    }
    try {
      const edit = this.buildEdit(
        this.input.run,
        candidate.document,
        candidate.subject.value,
        candidate.issue,
        candidate.substitutions,
        this.indexes,
      );
      if (!edit) return undefined;
      candidate.finding.edits = [edit];
      this.fixes++;
      return undefined;
    } catch (error) {
      if (error instanceof ContractError) {
        if (error.code === 'limit') return undefined;
        throw error;
      }
      return { error };
    }
  }

  /** Completes one subject: fixes, fix errors and evaluation faults, at their rule positions. */
  subject(report: SubjectReport): SubjectReport {
    const findings: { at: number; value: Finding }[] = [];
    const failures: { at: number; value: RuleFailure }[] = [];
    for (const work of report.deferred) {
      if (work.kind === 'fault') {
        const finding = this.report(
          work.rule,
          work.subject,
          work.subject.location,
          'rule_evaluation',
          work.error,
        );
        if (finding) findings.push({ at: work.findingsAt, value: finding });
        continue;
      }
      const { candidate } = work;
      const failed = this.assign(candidate);
      if (!failed) continue;
      const { rule, subject, finding } = candidate;
      failures.push({
        at: work.failuresAt,
        value: { subjectId: subject.id, ruleId: rule.id, code: 'internal_error' },
      });
      const internal = this.report(rule, subject, finding.location, 'fix_generation', failed.error);
      if (internal) findings.push({ at: report.findings.indexOf(finding) + 1, value: internal });
    }
    return {
      ...report,
      findings: inserted(report.findings, findings),
      failures: inserted(report.failures, failures),
      deferred: [],
    };
  }
}

/**
 * The step after the lanes. Walks the subject reports in sorted subject order and each subject's
 * deferred work in rule order: assigns generated fixes up to `SCALAR_FIX_LIMITS.generated`, and
 * adds internal-error findings up to `INTERNAL_ERROR_FINDING_LIMIT`, so that both choices are the
 * same whatever order the evaluations completed in.
 */
export function settleSubjects(
  reports: readonly SubjectReport[],
  input: AfterLanesInput,
): SubjectReport[] {
  const settlement = new Settlement(input);
  return reports.map((report) => settlement.subject(report));
}
