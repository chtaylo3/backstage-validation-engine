import type { Coverage, Finding, RuleState } from '../../contracts/schemas.js';
import { mergeInterruption } from '../../core/stage-report.js';
import type { Interruption } from '../../core/stage-report.js';
import { CelError } from '../../runtime/cel/errors.js';
import type { RuleExecutionReport, RuleSubject } from '../types.js';
import { evaluateRule } from './dispatch.js';
import { failureState, stateInterruption } from './failure-state.js';
import type { Rule, RuleFailure, RuleRunContext } from './types.js';

/**
 * Evaluates the ordered rules for one subject. A rule whose prerequisite did not pass is blocked;
 * a thrown failure maps to the rule state, blocked coverage and the subject's interruption.
 */
export async function evaluateSubject(
  context: RuleRunContext,
  rules: readonly Rule[],
  subject: RuleSubject,
): Promise<RuleExecutionReport> {
  const states = new Map<string, RuleState>();
  const findings: Finding[] = [];
  const coverage: Coverage[] = [];
  const failures: RuleFailure[] = [];
  let interrupted: Interruption = 'none';
  for (const rule of rules) {
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
      try {
        // Synchronous rule kinds complete without yielding, as the unsplit loop did.
        const pending = evaluateRule(context, rule, subject, {
          state,
          coverage: covered,
          findings,
          failures,
        });
        if (pending) await pending;
      } catch (failure) {
        const error = failure instanceof CelError ? failure : new CelError('worker_failure');
        Object.assign(state, failureState(error.code));
        covered.status = 'blocked';
        covered.reason = error.message;
        failures.push({ subjectId: subject.id, ruleId: rule.id, code: error.code });
        interrupted = mergeInterruption(interrupted, stateInterruption(state.reason));
      }
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
  return { findings, coverage, ruleStates: [...states.values()], failures, interrupted };
}
