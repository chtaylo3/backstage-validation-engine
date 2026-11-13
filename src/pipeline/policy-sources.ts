import type {
  ActivationManifest,
  DeploymentProfile,
  PolicyBundle,
  SchemaArtifact,
  ValidationRequest,
} from '../contracts/schemas.js';
import { validateBackstageSources } from '../compatibility/sources.js';
import type { CatalogAccessContext, CatalogProvider } from '../providers/types.js';
import { CatalogProviderError } from '../providers/types.js';
import type { CelRuntime } from '../runtime/cel/index.js';
import { systemClock } from '../base/clock.js';
import type { Clock } from '../base/clock.js';
import { executePolicyRules } from './cel-rules.js';
import { deepFreeze } from '../base/json.js';
import type { Immutable } from '../base/json.js';
import { runReferenceDataPreparation } from './reference-data.js';
import { SOURCE_INTERNAL_ERROR_RULE } from '../compatibility/stages/internal-error.js';
import type { LocalCatalogSources, ReferenceDataPreparation } from './reference-data.js';
import type { BackstageCompatibilityReport } from '../compatibility/types.js';
import type { InternalErrorObserver } from '../core/internal-errors.js';
import type { RuleExecutionReport } from './types.js';
import { verifyRequestBindings } from '../core/bindings.js';
import {
  FAILURE_EVIDENCE_LIMIT,
  FailureTimer,
  failureCause,
  sanitizeFailureEvidence,
} from '../runtime/failure-evidence.js';
import type { FailureEvidence, FailureStage } from '../runtime/failure-evidence.js';
import { reject } from '../base/errors.js';
import { mergeCoverage, mergeInterruption } from '../core/stage-report.js';

export interface PolicySourceContext {
  readonly profile: Immutable<DeploymentProfile>;
  readonly policy: Immutable<PolicyBundle>;
  readonly activation: Immutable<ActivationManifest>;
  readonly schemaArtifacts?: readonly Immutable<SchemaArtifact>[];
}

/** An unconfigured dependency still produces reference locations and incomplete rule coverage. */
function unconfiguredCatalog(
  request: Immutable<ValidationRequest>,
  context: PolicySourceContext,
): { readonly provider: CatalogProvider; readonly access: CatalogAccessContext } {
  const unavailable: CatalogProvider = {
    connectionId: 'unconfigured',
    adapterId: context.profile.adapterId,
    lookup: () => Promise.reject(new CatalogProviderError('closed')),
    stats: () => ({ active: 0, queued: 0, cacheEntries: 0, cacheBytes: 0 }),
    close: () => Promise.resolve(),
  };
  return {
    provider: unavailable,
    access: {
      installationId: request.identity.installationId,
      principalId: 'unconfigured',
      permissionRevision: request.identity.permissionRevision,
      credentialRevision: 'unconfigured',
      scope: [],
      policyDigest: request.policy.digest,
      profileDigest: request.profile.digest,
      maxAgeMs: 0,
    },
  };
}

/**
 * Structured failure evidence of a completed composition, in stage order: reference preparation,
 * catalog lookups, an interrupted source stage, contained internal errors of the source stage, an
 * interrupted rule stage, rule failures, and contained internal errors of the rule stage.
 * Sanitized and bounded by `FAILURE_EVIDENCE_LIMIT`.
 */
function collectFailureEvidence(
  timer: FailureTimer,
  request: Immutable<ValidationRequest>,
  preparation: ReferenceDataPreparation | undefined,
  compatibility: BackstageCompatibilityReport,
  rules: RuleExecutionReport,
): FailureEvidence[] {
  const ruleTimeoutCause =
    rules.failures.some(({ code }) => code === 'request_timeout' || code === 'queue_timeout') ||
    !rules.failures.some(({ code }) => code === 'execution_timeout')
      ? 'request_timeout'
      : 'attempt_timeout';
  return [
    ...(preparation?.failureEvidence ?? []),
    ...(preparation?.catalog?.failures.flatMap((failure) =>
      failure.evidence ? [failure.evidence] : [],
    ) ?? []),
    ...(compatibility.interrupted !== 'none'
      ? [
          timer.capture(
            'sources',
            compatibility.interrupted === 'timeout' ? 'request_timeout' : compatibility.interrupted,
            request.execution.deadlineAt,
          ),
        ]
      : []),
    // An unexpected error in a proposed or baseline source document was contained; one row per
    // run, and the cause stays `unknown`.
    ...(compatibility.findings.some((finding) => finding.ruleId === SOURCE_INTERNAL_ERROR_RULE) ||
    compatibility.coverage.some(
      (row) => row.stage === 'overlay' && row.subject === 'baseline-sources',
    )
      ? [timer.capture('sources', 'unknown', request.execution.deadlineAt)]
      : []),
    ...(rules.interrupted !== 'none'
      ? [
          timer.capture(
            'rules',
            rules.interrupted === 'timeout' ? ruleTimeoutCause : rules.interrupted,
            request.execution.deadlineAt,
          ),
        ]
      : []),
    ...(rules.failures.some(({ code }) => code !== 'internal_error') && rules.interrupted === 'none'
      ? [timer.capture('rules', 'rule_failure', request.execution.deadlineAt)]
      : []),
    // An unexpected error inside the rule stage was contained; the cause stays `unknown`.
    ...(rules.failures.some(({ code }) => code === 'internal_error')
      ? [timer.capture('rules', 'unknown', request.execution.deadlineAt)]
      : []),
  ]
    .map(sanitizeFailureEvidence)
    .filter((row) => row !== undefined)
    .slice(0, FAILURE_EVIDENCE_LIMIT);
}

/** The options of `validatePolicySources`. */
interface PolicySourceOptions {
  readonly catalog?: {
    readonly provider: CatalogProvider;
    readonly access: CatalogAccessContext;
  };
  readonly signal?: AbortSignal;
  readonly runtime?: CelRuntime;
  /** Unexpected-exception observer. Structured failures remain in the returned report. */
  readonly onFailure?: (evidence: FailureEvidence) => void;
  /**
   * Observer of unexpected errors that a stage contained and reported as an internal-error
   * finding. It receives the thrown value, which the report never contains, at most
   * `INTERNAL_ERROR_FINDING_LIMIT` times per stage. An observer that throws is ignored.
   */
  readonly onInternalError?: InternalErrorObserver;
  readonly onLocalSources?: (sources: LocalCatalogSources) => void;
  /**
   * The run's clock: failure timing, the source and rule stage deadlines, reference pinning and
   * catalog fact expiry read it. The catalog provider reads its own clock, and CEL workers keep
   * real time (see `Clock`).
   */
  readonly clock?: Clock;
}

/** Scoped native/source/rules composition; this does not qualify Backstage ingestion or authority. */
export async function validatePolicySources(
  request: Immutable<ValidationRequest>,
  context: PolicySourceContext,
  options: PolicySourceOptions = {},
) {
  return runPolicySources(request, context, options, validateBackstageSources);
}

/**
 * `validatePolicySources` with the source stage injected, for the direct source run and for the
 * proposed and baseline runs of reference preparation. Internal: the package does not export it;
 * tests use it to run the composition over a stub adapter.
 */
export async function runPolicySources(
  request: Immutable<ValidationRequest>,
  context: PolicySourceContext,
  options: PolicySourceOptions,
  sourceStage: typeof validateBackstageSources,
) {
  const clock = options.clock ?? systemClock;
  const timer = new FailureTimer(clock);
  let stage: FailureStage = 'bindings';
  try {
    verifyRequestBindings(request, context);
    if (context.policy.extends.length)
      reject('invalid_policy', '/extends', 'inherited policies must be resolved before execution');
    const signal = options.signal ? { signal: options.signal } : {};
    const observer = options.onInternalError ? { onInternalError: options.onInternalError } : {};
    const paths = [
      ...new Set(
        context.policy.rules
          .filter((rule) => rule.kind === 'catalog')
          .map((rule) => rule.referencePath),
      ),
    ];
    const catalog = options.catalog ?? unconfiguredCatalog(request, context);
    stage = 'sources';
    const preparation = paths.length
      ? await runReferenceDataPreparation(
          request,
          context,
          {
            ...catalog,
            ...signal,
            referencePaths: paths,
            clock,
            ...(options.onLocalSources ? { onLocalSources: options.onLocalSources } : {}),
            ...observer,
          },
          sourceStage,
        )
      : undefined;
    const compatibility =
      preparation?.compatibility ??
      (await sourceStage(request, context, { ...signal, clock, ...observer }));
    const pinned = preparation?.evaluationRequest ?? request;
    stage = 'rules';
    const rules = await executePolicyRules(
      pinned,
      context,
      compatibility.entities.map((entity) => ({
        id: JSON.stringify([entity.document.uri, entity.document.document]),
        value: entity.normalized,
        location: {
          uri: entity.document.uri,
          document: entity.document.document,
          path: '',
          range: entity.document.range,
        },
      })),
      {
        ...signal,
        sourceDocuments: compatibility.entities.map((entity) => entity.document),
        sourceSubstitutions: compatibility.entities.map((entity) => ({
          subjectId: JSON.stringify([entity.document.uri, entity.document.document]),
          substitutions: entity.substitutions,
        })),
        ...(options.runtime ? { runtime: options.runtime } : {}),
        ...(preparation ? { referenceData: preparation } : {}),
        ...observer,
        clock,
      },
    );
    const interrupted = [
      preparation?.interrupted ?? 'none',
      compatibility.interrupted,
      rules.interrupted,
    ].reduce(mergeInterruption);
    const failureEvidence = collectFailureEvidence(
      timer,
      request,
      preparation,
      compatibility,
      rules,
    );
    // Source and rule gates both report a required unavailable processor.
    const coverage = mergeCoverage([...compatibility.coverage, ...rules.coverage]);
    return deepFreeze({
      request: pinned,
      failureEvidence,
      compatibility,
      rules,
      findings: [...compatibility.findings, ...rules.findings],
      coverage,
      ruleStates: rules.ruleStates,
      interrupted,
      ...(preparation ? { preparation } : {}),
    });
  } catch (error) {
    try {
      options.onFailure?.(timer.capture(stage, failureCause(error), request.execution.deadlineAt));
    } catch {
      // Telemetry must not change the original failure or its enforcement.
    }
    throw error;
  }
}
