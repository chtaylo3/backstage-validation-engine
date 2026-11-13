import type {
  ActivationManifest,
  DeploymentProfile,
  PolicyBundle,
  SchemaArtifact,
  ValidationRequest,
} from '../contracts/schemas.js';
import { parseContract } from '../contracts/validate.js';
import { verifyRequestBindings } from '../core/bindings.js';
import { deepFreeze } from '../base/json.js';
import type { Immutable } from '../base/json.js';
import { RequestBudget } from '../runtime/request-budget.js';
import type { Clock } from '../base/clock.js';
import { validateSourceDocument } from './stages/document.js';
import { resolveIdentityConflicts } from './stages/identity-conflicts.js';
import { prepareSourceRun } from './stages/prepare.js';
import { blockedProcessingReport } from './stages/processing-gate.js';
import { openSourceRun } from './stages/state.js';
import type { InternalErrorObserver } from '../core/internal-errors.js';
import { loadBackstageAdapter } from './adapter.js';
import type {
  BackstageAdapter,
  BackstageAdapterId,
  BackstageCompatibilityReport,
} from './types.js';

interface SourceStageContext {
  readonly profile: Immutable<DeploymentProfile>;
  readonly policy: Immutable<PolicyBundle>;
  readonly activation: Immutable<ActivationManifest>;
  readonly schemaArtifacts?: readonly Immutable<SchemaArtifact>[];
}
interface SourceStageOptions {
  readonly signal?: AbortSignal;
  readonly uris?: readonly string[];
  /**
   * Decides the stage's deadline, for parsing, source resolution and native checks alike.
   * Defaults to `systemClock`.
   */
  readonly clock?: Clock;
  /**
   * Observer of unexpected errors that the stage contained as a `backstage/internal_error`
   * finding. It receives the thrown value, which the report never contains, at most
   * `INTERNAL_ERROR_FINDING_LIMIT` times per run. An observer that throws is ignored.
   */
  readonly onInternalError?: InternalErrorObserver;
}

/** Executes parsing and declared BC-01 through BC-05 contexts; later stages are not attested. */
export async function validateBackstageSources(
  request: Immutable<ValidationRequest>,
  context: SourceStageContext,
  options: SourceStageOptions = {},
): Promise<BackstageCompatibilityReport> {
  return runBackstageSources(request, context, options, loadBackstageAdapter);
}

/**
 * `validateBackstageSources` with the adapter loader injected. Internal: the package does not
 * export it; tests use it to run the stage with a stub adapter.
 */
export async function runBackstageSources(
  request: Immutable<ValidationRequest>,
  context: SourceStageContext,
  options: SourceStageOptions,
  load: (id: BackstageAdapterId) => Promise<BackstageAdapter>,
): Promise<BackstageCompatibilityReport> {
  const run = parseContract('validation-request', request);
  using budget = new RequestBudget(run.execution.deadlineAt, options.signal, options.clock);
  verifyRequestBindings(run, context);
  const profile = parseContract('deployment-profile', context.profile);
  const uris = options.uris ?? run.source.entrypoints;
  if (profile.requiredProcessors.length) return blockedProcessingReport(run, profile, budget, uris);
  const state = await openSourceRun(run, profile, budget, uris, options.onInternalError);
  await prepareSourceRun(state, context.schemaArtifacts, load);
  // Location discovery appends to `documents` while this loop runs.
  for (const document of state.documents) await validateSourceDocument(state, document);
  if (!state.parsed.documents.length && !state.unavailable)
    state.coverage.push({
      stage: 'compatibility',
      subject: 'empty-input',
      required: true,
      status: 'verified',
    });
  const accepted = resolveIdentityConflicts(state);
  return deepFreeze({
    adapterId: profile.adapterId,
    sourceDigest: run.source.digest,
    profileDigest: run.profile.digest,
    entities: accepted.entities,
    references: accepted.references,
    sourceClaims: state.sourceClaims,
    unresolvedSourceIdentities:
      state.parsed.files.some((file) => file.status !== 'parsed') ||
      state.unresolvedIncludes ||
      state.sourceClaims.some((claim) => claim.entityRef === undefined),
    findings: state.findings,
    coverage: state.coverage,
    artifacts: accepted.artifacts,
    interrupted: state.interrupted,
  });
}
