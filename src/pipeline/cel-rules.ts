import type {
  ActivationManifest,
  DeploymentProfile,
  PolicyBundle,
  SchemaArtifact,
  ValidationRequest,
} from '../contracts/schemas.js';
import { parseContract } from '../contracts/validate.js';
import { CelError, cancellationError } from '../runtime/cel/errors.js';
import { RequestBudget } from '../runtime/request-budget.js';
import { verifyRequestBindings } from '../core/bindings.js';
import { reject } from '../base/errors.js';
import { deepFreeze, immutableJson } from '../base/json.js';
import type { Immutable } from '../base/json.js';
import { mergeInterruption } from '../core/stage-report.js';
import type { Interruption } from '../core/stage-report.js';
import { blockedProcessorRules } from './blocked-rules.js';
import { prepareRuleRun } from './rules/context.js';
import { scheduleLanes } from './rules/lanes.js';
import { evaluateSubject } from './rules/subject.js';
import type { RuleExecutionOptions } from './rules/types.js';
import type { RuleExecutionReport, RuleSubject } from './types.js';

export type { RuleSubject, RuleExecutionReport } from './types.js';

/**
 * Runs policy rules over already-normalized entities. This is a rules-stage API,
 * not a Backstage ingestion/validation API. Identity/activation authority must
 * already have been verified by the calling adapter.
 */
export async function executePolicyRules(
  request: Immutable<ValidationRequest>,
  context: {
    readonly profile: Immutable<DeploymentProfile>;
    readonly policy: Immutable<PolicyBundle>;
    readonly activation: Immutable<ActivationManifest>;
    readonly schemaArtifacts?: readonly Immutable<SchemaArtifact>[];
  },
  subjects: readonly RuleSubject[],
  options: RuleExecutionOptions = {},
): Promise<RuleExecutionReport> {
  const run = parseContract('validation-request', request);
  using budget = new RequestBudget(run.execution.deadlineAt, options.signal, options.clock);
  verifyRequestBindings(run, context);
  const profile = parseContract('deployment-profile', context.profile);
  const policy = parseContract('policy-bundle', context.policy);
  if (policy.extends.length)
    reject('invalid_policy', '/extends', 'inherited policies must be resolved before execution');
  if (subjects.length > profile.limits.entities)
    reject('limit', '/subjects', 'entity count exceeds profile');
  const snapshots = immutableJson(subjects) as unknown as readonly RuleSubject[];
  const sorted = [...snapshots].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (
    sorted.some((subject) => !subject.id) ||
    new Set(sorted.map((subject) => subject.id)).size !== sorted.length
  ) {
    reject('invalid_contract', '/subjects', 'subject identities must be nonempty and unique');
  }
  if (profile.requiredProcessors.length) {
    const report = blockedProcessorRules(run, profile, policy, sorted);
    return deepFreeze({
      ...report,
      interrupted: budget.interrupted
        ? budget.signal.reason instanceof CelError &&
          budget.signal.reason.code === 'request_timeout'
          ? 'timeout'
          : 'cancelled'
        : 'none',
    });
  }
  const prepared = await prepareRuleRun(
    run,
    profile,
    policy,
    sorted,
    budget,
    context.schemaArtifacts,
    options,
  );
  const concurrency = Math.min(
    profile.limits.celWorkers,
    profile.limits.celOutstandingJobs,
    sorted.length,
  );
  // Reports are indexed by sorted subject ID; lanes share the run context's fix budget.
  const reports = await scheduleLanes(sorted.length, concurrency, (index) => {
    const subject = sorted[index];
    if (!subject) throw new Error('Subject scheduling invariant violated');
    return evaluateSubject(prepared.context, prepared.rules, subject);
  });
  const interrupted = budget.interrupted
    ? cancellationError(budget.signal).code === 'request_timeout'
      ? 'timeout'
      : 'cancelled'
    : reports.reduce<Interruption>(
        (current, report) => mergeInterruption(current, report.interrupted),
        'none',
      );
  return deepFreeze({
    findings: reports.flatMap((report) => report.findings),
    ruleStates: reports.flatMap((report) => report.ruleStates),
    coverage: sorted.length
      ? reports.flatMap((report) => report.coverage)
      : [
          {
            stage: 'rules' as const,
            subject: 'repository',
            required: true,
            status: 'verified' as const,
          },
        ],
    failures: reports.flatMap((report) => report.failures),
    interrupted,
  });
}

/** Compatibility entry point; pure CEL behavior is unchanged. */
export const executeCelRules = executePolicyRules;
