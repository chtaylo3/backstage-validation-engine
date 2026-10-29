import type {
  ActivationManifest,
  Coverage,
  DeploymentProfile,
  Finding,
  JsonValue,
  PolicyBundle,
  RuleState,
  ValidationRequest,
  ValidationResult,
} from '../contracts/schemas.js';
import { parseContract } from '../contracts/validate.js';
import { orderRules } from '../policy/rule-graph.js';
import { getSharedCelRuntime } from '../runtime/cel/index.js';
import type { CelRuntime } from '../runtime/cel/index.js';
import { CelError, cancellationError } from '../runtime/cel/errors.js';
import type { CelErrorCode } from '../runtime/cel/errors.js';
import { RequestBudget } from '../runtime/request-budget.js';
import { verifyRequestBindings } from './bindings.js';
import { reject } from './errors.js';
import { deepFreeze, immutableJson } from './json.js';
import type { Immutable } from './json.js';
import { createFindingId } from './results.js';
import { bindCatalogReferences } from './catalog-bindings.js';
import type { CatalogBindings } from './catalog-bindings.js';
import type { ReferenceDataPreparation } from './reference-data.js';

export interface RuleSubject {
  readonly id: string;
  readonly value: Immutable<JsonValue>;
  readonly location: Immutable<Finding['location']>;
}

export interface RuleExecutionReport {
  readonly findings: readonly Immutable<Finding>[];
  readonly coverage: readonly Immutable<Coverage>[];
  readonly ruleStates: readonly Immutable<RuleState>[];
  readonly failures: readonly {
    readonly subjectId: string;
    readonly ruleId: string;
    readonly code: CelErrorCode | 'unsupported_rule' | 'catalog_unavailable';
  }[];
  readonly interrupted: ValidationResult['resources']['interrupted'];
}

type StateFailure = Pick<RuleState, 'status' | 'reason'>;
type Interruption = RuleExecutionReport['interrupted'];
const INTERRUPTION_PRIORITY: Record<Interruption, number> = {
  none: 0,
  resource_limit: 1,
  worker_failure: 2,
  cancelled: 3,
  timeout: 4,
};

function mergeInterruption(current: Interruption, next: Interruption): Interruption {
  return INTERRUPTION_PRIORITY[next] > INTERRUPTION_PRIORITY[current] ? next : current;
}

function stateInterruption(reason: RuleState['reason']): Interruption {
  if (reason === 'timeout') return 'timeout';
  if (reason === 'cancelled') return 'cancelled';
  if (reason === 'worker_failure') return 'worker_failure';
  if (reason === 'resource_limit' || reason === 'queue_exhausted') return 'resource_limit';
  return 'none';
}

function failureState(code: CelErrorCode): StateFailure {
  switch (code) {
    case 'parse':
    case 'profile':
    case 'regex':
    case 'result_type':
      return { status: 'invalid_policy', reason: 'invalid_expression' };
    case 'evaluation':
    case 'input_type':
      return { status: 'error' };
    case 'input_limit':
    case 'regex_limit':
      return { status: 'incomplete', reason: 'resource_limit' };
    case 'queue_limit':
      return { status: 'incomplete', reason: 'queue_exhausted' };
    case 'cancelled':
      return { status: 'incomplete', reason: 'cancelled' };
    case 'queue_timeout':
    case 'request_timeout':
    case 'execution_timeout':
      return { status: 'incomplete', reason: 'timeout' };
    case 'worker_start':
    case 'worker_failure':
    case 'protocol':
    case 'closed':
      return { status: 'incomplete', reason: 'worker_failure' };
  }
}

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
  },
  subjects: readonly RuleSubject[],
  options: {
    readonly signal?: AbortSignal;
    readonly runtime?: CelRuntime;
    readonly referenceData?: ReferenceDataPreparation;
  } = {},
): Promise<RuleExecutionReport> {
  const run = parseContract('validation-request', request);
  using budget = new RequestBudget(run.execution.deadlineAt, options.signal);
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
  const rulesById = new Map(policy.rules.map((rule) => [rule.id, rule]));
  const rules = orderRules(policy.rules, profile.limits.graphDepth).map((id) => {
    const rule = rulesById.get(id);
    if (!rule) throw new Error('Rule graph invariant violated');
    return rule;
  });
  const runtime = options.runtime ?? getSharedCelRuntime();
  const catalogPaths = [
    ...new Set(
      policy.rules.filter((rule) => rule.kind === 'catalog').map((rule) => rule.referencePath),
    ),
  ];
  let catalogBindings: CatalogBindings = new Map();
  try {
    if (catalogPaths.length)
      catalogBindings = await bindCatalogReferences(
        run,
        profile,
        sorted,
        catalogPaths,
        options.referenceData,
        budget,
      );
  } catch (error) {
    if (!(error instanceof CelError) || !budget.interrupted) throw error;
  }
  const evaluationContext = {
    requestId: JSON.stringify([
      run.identity.installationId,
      run.identity.repositoryId,
      run.run.runId,
      run.run.attemptId,
      run.run.generation,
    ]),
    deadlineAt: run.execution.deadlineAt,
    signal: budget.signal,
    executionMs: profile.limits.celExecutionMs,
  };
  const reports = new Array<RuleExecutionReport>(sorted.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < sorted.length) {
      const index = next++;
      const subject = sorted[index];
      if (!subject) throw new Error('Subject scheduling invariant violated');
      const states = new Map<string, RuleState>();
      const findings: Finding[] = [];
      const coverage: Coverage[] = [];
      const failures: {
        subjectId: string;
        ruleId: string;
        code: CelErrorCode | 'unsupported_rule' | 'catalog_unavailable';
      }[] = [];
      let interrupted: RuleExecutionReport['interrupted'] = 'none';
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
        } else if (rule.kind === 'schema') {
          state.status = 'incomplete';
          state.reason = 'dependency_unavailable';
          covered.status = 'unsupported';
          covered.reason = 'Schema rule runtime is not implemented.';
          failures.push({ subjectId: subject.id, ruleId: rule.id, code: 'unsupported_rule' });
        } else {
          try {
            budget.throwIfInterrupted();
            if (
              rule.selector &&
              !(await runtime.evaluate(rule.selector, subject.value, evaluationContext))
            ) {
              state.status = 'not_applicable';
            } else if (rule.kind === 'catalog') {
              const facts = catalogBindings.get(subject.id)?.get(rule.referencePath);
              const unavailable = facts?.find(
                (fact) =>
                  fact.status === 'unavailable' ||
                  fact.status === 'blocked' ||
                  (fact.expiresAt !== undefined && fact.expiresAt <= Date.now()),
              );
              const addFinding = (
                location: Finding['location'],
                relatedLocations: readonly Immutable<Finding['location']>[],
                dependency: boolean,
              ) =>
                findings.push({
                  id: createFindingId({
                    ruleId: rule.id,
                    ruleVersion: rule.version,
                    subjectId: subject.id,
                    path: location.path,
                    policyDigest: run.policy.digest,
                    profileDigest: run.profile.digest,
                  }),
                  ruleId: rule.id,
                  ruleVersion: rule.version,
                  subjectId: subject.id,
                  message: dependency
                    ? 'Catalog data is unavailable for this policy rule.'
                    : 'Referenced catalog entity was not found in the authorized view.',
                  category: dependency ? 'dependency' : 'policy',
                  severity: dependency && run.execution.mode === 'ide' ? 'warning' : rule.severity,
                  enforcement:
                    run.execution.mode === 'ci' &&
                    (dependency ? rule.mandatory : rule.mandatory || rule.severity === 'error')
                      ? 'blocking'
                      : 'advisory',
                  location,
                  relatedLocations: [...relatedLocations],
                  edits: [],
                });
              if (!facts || unavailable) {
                state.status = 'incomplete';
                state.reason = 'dependency_unavailable';
                covered.status = unavailable?.status === 'unavailable' ? 'unavailable' : 'blocked';
                covered.reason = 'Catalog observations required by the policy are unavailable.';
                failures.push({
                  subjectId: subject.id,
                  ruleId: rule.id,
                  code: 'catalog_unavailable',
                });
                addFinding(
                  unavailable?.reference.location ?? subject.location,
                  unavailable?.reference.relatedLocations ?? [],
                  true,
                );
              } else if (!facts.length) state.status = 'not_applicable';
              else {
                const missing = facts.filter((fact) => fact.status === 'missing');
                if (missing.length) state.status = 'failed';
                for (const fact of missing)
                  addFinding(fact.reference.location, fact.reference.relatedLocations, false);
              }
            } else if (
              !(await runtime.evaluate(rule.expression, subject.value, evaluationContext))
            ) {
              state.status = 'failed';
              findings.push({
                id: createFindingId({
                  ruleId: rule.id,
                  ruleVersion: rule.version,
                  subjectId: subject.id,
                  path: subject.location.path,
                  policyDigest: run.policy.digest,
                  profileDigest: run.profile.digest,
                }),
                ruleId: rule.id,
                ruleVersion: rule.version,
                subjectId: subject.id,
                message: 'Entity does not satisfy the policy rule.',
                category: 'policy',
                severity: rule.severity,
                enforcement:
                  run.execution.mode === 'ci' && (rule.mandatory || rule.severity === 'error')
                    ? 'blocking'
                    : 'advisory',
                location: subject.location,
                relatedLocations: [],
                edits: [],
              });
            }
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
      reports[index] = {
        findings,
        coverage,
        ruleStates: [...states.values()],
        failures,
        interrupted,
      };
    }
  };
  const concurrency = Math.min(
    profile.limits.celWorkers,
    profile.limits.celOutstandingJobs,
    sorted.length,
  );
  await Promise.all(Array.from({ length: concurrency }, lane));
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
