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
import { prepareBackstageReferenceData } from './reference-data.js';
import type { LocalCatalogSources, ReferenceDataPreparation } from './reference-data.js';
import type { BackstageCompatibilityReport } from '../compatibility/types.js';
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
 * catalog lookups, an interrupted source stage, an interrupted rule stage, and rule failures.
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
    ...(rules.interrupted !== 'none'
      ? [
          timer.capture(
            'rules',
            rules.interrupted === 'timeout' ? ruleTimeoutCause : rules.interrupted,
            request.execution.deadlineAt,
          ),
        ]
      : []),
    ...(rules.failures.length && rules.interrupted === 'none'
      ? [timer.capture('rules', 'rule_failure', request.execution.deadlineAt)]
      : []),
  ]
    .map(sanitizeFailureEvidence)
    .filter((row) => row !== undefined)
    .slice(0, FAILURE_EVIDENCE_LIMIT);
}

/** Scoped native/source/rules composition; this does not qualify Backstage ingestion or authority. */
export async function validatePolicySources(
  request: Immutable<ValidationRequest>,
  context: PolicySourceContext,
  options: {
    readonly catalog?: {
      readonly provider: CatalogProvider;
      readonly access: CatalogAccessContext;
    };
    readonly signal?: AbortSignal;
    readonly runtime?: CelRuntime;
    /** Unexpected-exception observer. Structured failures remain in the returned report. */
    readonly onFailure?: (evidence: FailureEvidence) => void;
    readonly onLocalSources?: (sources: LocalCatalogSources) => void;
    /**
     * The run's clock: failure timing, the source and rule stage deadlines, reference pinning and
     * catalog fact expiry read it. The catalog provider reads its own clock, and CEL workers keep
     * real time (see `Clock`).
     */
    readonly clock?: Clock;
  } = {},
) {
  const clock = options.clock ?? systemClock;
  const timer = new FailureTimer(clock);
  let stage: FailureStage = 'bindings';
  try {
    verifyRequestBindings(request, context);
    if (context.policy.extends.length)
      reject('invalid_policy', '/extends', 'inherited policies must be resolved before execution');
    const signal = options.signal ? { signal: options.signal } : {};
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
      ? await prepareBackstageReferenceData(request, context, {
          ...catalog,
          ...signal,
          referencePaths: paths,
          clock,
          ...(options.onLocalSources ? { onLocalSources: options.onLocalSources } : {}),
        })
      : undefined;
    const compatibility =
      preparation?.compatibility ??
      (await validateBackstageSources(request, context, { ...signal, clock }));
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
