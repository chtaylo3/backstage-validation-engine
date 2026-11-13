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
import { validateSourceDocument } from './stages/document.js';
import { resolveIdentityConflicts } from './stages/identity-conflicts.js';
import { prepareSourceRun } from './stages/prepare.js';
import { blockedProcessingReport } from './stages/processing-gate.js';
import { openSourceRun } from './stages/state.js';
import type { BackstageCompatibilityReport } from './types.js';

/** Executes parsing and declared BC-01 through BC-05 contexts; later stages are not attested. */
export async function validateBackstageSources(
  request: Immutable<ValidationRequest>,
  context: {
    readonly profile: Immutable<DeploymentProfile>;
    readonly policy: Immutable<PolicyBundle>;
    readonly activation: Immutable<ActivationManifest>;
    readonly schemaArtifacts?: readonly Immutable<SchemaArtifact>[];
  },
  options: { readonly signal?: AbortSignal; readonly uris?: readonly string[] } = {},
): Promise<BackstageCompatibilityReport> {
  const run = parseContract('validation-request', request);
  using budget = new RequestBudget(run.execution.deadlineAt, options.signal);
  verifyRequestBindings(run, context);
  const profile = parseContract('deployment-profile', context.profile);
  const uris = options.uris ?? run.source.entrypoints;
  if (profile.requiredProcessors.length) return blockedProcessingReport(run, profile, budget, uris);
  const state = await openSourceRun(run, profile, budget, uris);
  await prepareSourceRun(state, context.schemaArtifacts);
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
