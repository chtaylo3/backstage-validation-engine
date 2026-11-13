import type { Coverage, Finding, RuleState } from '../../contracts/schemas.js';
import { ContractError } from '../../base/errors.js';
import { mergeInterruption } from '../../core/stage-report.js';
import type { Interruption } from '../../core/stage-report.js';
import { CelError } from '../../runtime/cel/errors.js';
import type { RuleSubject } from '../types.js';
import { evaluateRule } from './dispatch.js';
import { failureState, stateInterruption } from './failure-state.js';
import type {
  DeferredWork,
  FixCandidate,
  Rule,
  RuleFailure,
  RuleRunContext,
  SubjectReport,
} from './types.js';

/** The coverage reason of a rule whose evaluation threw an unexpected error. */
export const INTERNAL_ERROR_REASON = 'An internal error occurred while evaluating this rule.';

/**
 * Maps a failure thrown while one rule was evaluated. A `CelError` maps by its code. A `limit`
 * contract error is a resource limit, recorded as a CEL `input_limit`; any other contract error
 * propagates. Any other error is an internal error: the rule state is `error`, its coverage is
 * blocked, and the fault is returned for the step after the lanes, which reports it.
 */
function containFailure(
  failure: unknown,
  rule: Rule,
  subject: RuleSubject,
  record: {
    readonly state: RuleState;
    readonly covered: Coverage;
    readonly failures: RuleFailure[];
  },
): { readonly interruption: Interruption; readonly fault: boolean } {
  const { state, covered, failures } = record;
  if (failure instanceof ContractError && failure.code !== 'limit') throw failure;
  covered.status = 'blocked';
  if (!(failure instanceof CelError) && !(failure instanceof ContractError)) {
    state.status = 'error';
    delete state.reason;
    covered.reason = INTERNAL_ERROR_REASON;
    failures.push({ subjectId: subject.id, ruleId: rule.id, code: 'internal_error' });
    return { interruption: 'none', fault: true };
  }
  const error = failure instanceof CelError ? failure : new CelError('input_limit');
  Object.assign(state, failureState(error.code));
  covered.reason = error.message;
  failures.push({ subjectId: subject.id, ruleId: rule.id, code: error.code });
  return { interruption: stateInterruption(state.reason), fault: false };
}

/**
 * Evaluates the ordered rules for one subject. A rule whose prerequisite did not pass is blocked;
 * a thrown failure maps to the rule state, blocked coverage and the subject's interruption. Fix
 * candidates and internal errors are deferred, in rule order, to the step after the lanes. Once
 * `stopped()` is true (another lane failed), no further rule starts.
 */
export async function evaluateSubject(
  context: RuleRunContext,
  rules: readonly Rule[],
  subject: RuleSubject,
  stopped: () => boolean = () => false,
): Promise<SubjectReport> {
  const states = new Map<string, RuleState>();
  const findings: Finding[] = [];
  const coverage: Coverage[] = [];
  const failures: RuleFailure[] = [];
  const deferred: DeferredWork[] = [];
  let interrupted: Interruption = 'none';
  for (const rule of rules) {
    if (stopped()) break;
    const state: RuleState = {
      ruleId: rule.id,
      subjectId: subject.id,
      required: rule.mandatory,
      status: 'passed',
    };
    const covered: Coverage = {
      stage: 'rules',
      subject: JSON.stringify([subject.id, rule.id]),
      required: rule.mandatory,
      status: 'verified',
    };
    if (rule.requires.some((id) => states.get(id)?.status !== 'passed')) {
      state.status = 'blocked';
      state.reason = 'prerequisite_blocked';
      covered.status = 'blocked';
      covered.reason = 'A prerequisite did not pass.';
    } else {
      const candidates: FixCandidate[] = [];
      let fault: { readonly error: unknown } | undefined;
      try {
        // Synchronous rule kinds complete without yielding, as the unsplit loop did.
        const pending = evaluateRule(context, rule, subject, {
          state,
          coverage: covered,
          findings,
          failures,
          candidates,
        });
        if (pending) await pending;
      } catch (failure) {
        const contained = containFailure(failure, rule, subject, { state, covered, failures });
        interrupted = mergeInterruption(interrupted, contained.interruption);
        if (contained.fault) fault = { error: failure };
      }
      for (const candidate of candidates)
        deferred.push({ kind: 'fix', candidate, failuresAt: failures.length });
      if (fault)
        deferred.push({
          kind: 'fault',
          rule,
          subject,
          error: fault.error,
          findingsAt: findings.length,
        });
    }
    states.set(rule.id, state);
    coverage.push(covered);
  }
  // A required summary records stage completion even for optional/empty rule sets.
  const incomplete = [...states.values()].some(
    (state) => state.required && !['passed', 'failed', 'not_applicable'].includes(state.status),
  );
  coverage.push({
    stage: 'rules',
    subject: JSON.stringify([subject.id]),
    required: true,
    status: incomplete ? 'blocked' : 'verified',
  });
  return {
    findings,
    coverage,
    ruleStates: [...states.values()],
    failures,
    interrupted,
    deferred,
  };
}
