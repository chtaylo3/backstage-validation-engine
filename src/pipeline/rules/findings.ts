import type { Finding, ValidationRequest } from '../../contracts/schemas.js';
import type { Immutable } from '../../base/json.js';
import { internalErrorType } from '../../core/internal-errors.js';
import type { RuleActivity } from '../../core/internal-errors.js';
import { createFindingId } from '../../core/results.js';
import type { RuleSubject } from '../types.js';
import type { Rule } from './types.js';

export interface RuleFindingInput {
  /** The entity path that the finding identity covers. */
  readonly path: string;
  readonly message: string;
  /** A missing dependency is advisory in the IDE and blocks CI only for a mandatory rule. */
  readonly dependency: boolean;
  readonly location: Immutable<Finding['location']>;
  readonly relatedLocations: readonly Immutable<Finding['location']>[];
  readonly edits: Finding['edits'];
}

/**
 * The finding of a policy rule. Schema, catalog and expression rules share this formula; an
 * expression rule never reports a dependency, so for it the formula reduces to the rule severity
 * and `ci && (mandatory || severity === 'error')` enforcement.
 */
export function ruleFinding(
  run: Immutable<ValidationRequest>,
  rule: Rule,
  subject: RuleSubject,
  input: RuleFindingInput,
): Finding {
  const { dependency } = input;
  return {
    id: createFindingId({
      ruleId: rule.id,
      ruleVersion: rule.version,
      subjectId: subject.id,
      path: input.path,
      policyDigest: run.policy.digest,
      profileDigest: run.profile.digest,
    }),
    ruleId: rule.id,
    ruleVersion: rule.version,
    subjectId: subject.id,
    message: input.message,
    category: dependency ? 'dependency' : 'policy',
    severity: dependency && run.execution.mode === 'ide' ? 'warning' : rule.severity,
    enforcement:
      run.execution.mode === 'ci' &&
      (dependency ? rule.mandatory : rule.mandatory || rule.severity === 'error')
        ? 'blocking'
        : 'advisory',
    location: input.location,
    relatedLocations: [...input.relatedLocations],
    edits: input.edits,
  };
}

const ACTIVITY_TEXT = Object.freeze({
  rule_evaluation: (id: string) =>
    `The validation engine failed while evaluating rule \`${id}\`; the result for this rule is unknown.`,
  fix_generation: (id: string) =>
    `The validation engine failed while building a suggested fix for rule \`${id}\`; the fix is unavailable.`,
});

/**
 * The finding of an unexpected error in the rule stage. It names the activity, the policy rule and
 * the error's type, never its message or stack: an exception message can contain entity content.
 * The policy rule in `ruleVersion` keeps the identities of different rules on one subject apart.
 */
export function internalErrorFinding(
  run: Immutable<ValidationRequest>,
  rule: Rule,
  subjectId: string,
  location: Immutable<Finding['location']>,
  activity: RuleActivity,
  error: unknown,
): Finding {
  const ruleId = 'engine/internal_error';
  const ruleVersion = `${rule.id}@${rule.version}`;
  return {
    id: createFindingId({
      ruleId,
      ruleVersion,
      subjectId,
      path: location.path,
      policyDigest: run.policy.digest,
      profileDigest: run.profile.digest,
    }),
    ruleId,
    ruleVersion,
    subjectId,
    message: `${ACTIVITY_TEXT[activity](rule.id)} This is a fault in the validation engine (${internalErrorType(error)}).`,
    category: 'execution',
    severity: 'error',
    enforcement: run.execution.mode === 'ci' ? 'blocking' : 'advisory',
    location,
    relatedLocations: [],
    edits: [],
  };
}
