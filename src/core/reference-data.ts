import type {
  ActivationManifest,
  DataEntry,
  DataSnapshot,
  DeploymentProfile,
  PolicyBundle,
  ValidationRequest,
  ValidationResult,
} from '../contracts/schemas.js';
import { parseContract } from '../contracts/validate.js';
import { validateBackstageSources } from '../compatibility/sources.js';
import type { BackstageCompatibilityReport } from '../compatibility/types.js';
import { catalogEntityKey, normalizeCatalogAccess } from '../providers/catalog.js';
import { CatalogProviderError } from '../providers/types.js';
import type {
  CatalogAccessContext,
  CatalogLookupReport,
  CatalogProvider,
} from '../providers/types.js';
import { RequestBudget } from '../runtime/request-budget.js';
import { CelError } from '../runtime/cel/errors.js';
import { verifyRequestBindings } from './bindings.js';
import { ContractError, reject } from './errors.js';
import { deepFreeze } from './json.js';
import type { Immutable } from './json.js';
import { createDataSnapshot } from './snapshots.js';

export type ReferenceBlockReason =
  | 'local_source'
  | 'competing_claims'
  | 'unresolved_sources'
  | 'unresolved_deletions'
  | 'source_incomplete'
  | 'provider_failure';
export type BackstageReferenceObservation =
  | {
      readonly targetRef: string;
      readonly status: 'blocked';
      readonly reason: ReferenceBlockReason;
    }
  | (Immutable<DataEntry> & { readonly targetRef: string });
export interface ReferenceDataPreparation {
  readonly compatibility: BackstageCompatibilityReport;
  readonly observations: readonly BackstageReferenceObservation[];
  readonly data: Immutable<DataSnapshot>;
  readonly catalog?: CatalogLookupReport;
  /** Present only when data and the remaining original deadline can be pinned for evaluation. */
  readonly evaluationRequest?: Immutable<ValidationRequest>;
  readonly pinFailure?: 'interrupted' | 'stale_data' | 'resource_limit';
  readonly interrupted: ValidationResult['resources']['interrupted'];
  readonly collectionStartedAt: number;
  readonly referencePaths: readonly string[];
}
type Interruption = ReferenceDataPreparation['interrupted'];
const priority: Record<Interruption, number> = {
  none: 0,
  resource_limit: 1,
  worker_failure: 2,
  cancelled: 3,
  timeout: 4,
};
function merge(a: Interruption, b: Interruption): Interruption {
  return priority[a] >= priority[b] ? a : b;
}
function interrupted(budget: RequestBudget): 'timeout' | 'cancelled' {
  return budget.signal.reason instanceof CelError && budget.signal.reason.code === 'request_timeout'
    ? 'timeout'
    : 'cancelled';
}

/**
 * Prepare immutable external observations for declared source references. Local targets are
 * blocked until proposed-state overlay qualification; missing is not an existence-rule verdict.
 */
export async function prepareBackstageReferenceData(
  request: Immutable<ValidationRequest>,
  context: {
    readonly profile: Immutable<DeploymentProfile>;
    readonly policy: Immutable<PolicyBundle>;
    readonly activation: Immutable<ActivationManifest>;
  },
  options: {
    readonly provider: CatalogProvider;
    readonly access: CatalogAccessContext;
    readonly signal?: AbortSignal;
    readonly referencePaths?: readonly string[];
  },
): Promise<ReferenceDataPreparation> {
  const run = parseContract('validation-request', request);
  using budget = new RequestBudget(run.execution.deadlineAt, options.signal);
  verifyRequestBindings(run, context);
  const referencePaths =
    options.referencePaths === undefined
      ? context.profile.referenceContexts.map((row) => row.path)
      : [...options.referencePaths];
  if (
    referencePaths.length > 256 ||
    new Set(referencePaths).size !== referencePaths.length ||
    referencePaths.some(
      (path) => !context.profile.referenceContexts.some((row) => row.path === path),
    )
  ) {
    reject(
      'invalid_contract',
      '/referencePaths',
      'reference collection must select declared contexts',
    );
  }
  referencePaths.sort();
  const access = normalizeCatalogAccess(options.access);
  const provider = options.provider;
  if (
    access.installationId !== run.identity.installationId ||
    access.permissionRevision !== run.identity.permissionRevision ||
    access.profileDigest !== run.profile.digest ||
    access.policyDigest !== run.policy.digest ||
    provider.adapterId !== context.profile.adapterId
  ) {
    reject('integrity', '/catalog', 'catalog context does not bind this validation request');
  }
  const compatibility = await validateBackstageSources(run, context, { signal: budget.signal });
  let interruption: Interruption = compatibility.interrupted;
  const targets = [
    ...new Set(
      compatibility.references
        .filter((reference) => referencePaths.includes(reference.contextPath))
        .map((reference) => reference.targetRef),
    ),
  ].sort();
  const claims = new Map<string, number>();
  for (const claim of compatibility.sourceClaims)
    if (claim.entityRef) claims.set(claim.entityRef, (claims.get(claim.entityRef) ?? 0) + 1);
  const blocked = new Map<string, ReferenceBlockReason>();
  const hasDeletions = run.source.changes.some((change) => change.kind === 'deleted');
  for (const target of targets) {
    if (
      compatibility.interrupted !== 'none' ||
      budget.interrupted ||
      compatibility.coverage.some(
        (row) => row.stage === 'substitution' && row.status !== 'verified',
      )
    )
      blocked.set(target, 'source_incomplete');
    else if (hasDeletions) blocked.set(target, 'unresolved_deletions');
    else if (compatibility.unresolvedSourceIdentities) blocked.set(target, 'unresolved_sources');
    else if (claims.has(target))
      blocked.set(target, claims.get(target)! > 1 ? 'competing_claims' : 'local_source');
  }
  const eligible = targets.filter((target) => !blocked.has(target));
  let catalog: CatalogLookupReport | undefined;
  if (eligible.length) {
    try {
      catalog = await provider.lookup(eligible, access, {
        deadlineAt: run.execution.deadlineAt,
        signal: budget.signal,
      });
    } catch (error) {
      if (budget.interrupted) interruption = merge(interruption, interrupted(budget));
      else if (error instanceof CatalogProviderError && error.code === 'input_limit')
        interruption = merge(interruption, 'resource_limit');
      for (const ref of eligible) blocked.set(ref, 'provider_failure');
    }
  }
  const received = new Map<string, Immutable<DataEntry>>();
  if (catalog) {
    const snapshot = parseContract('data-snapshot', catalog.data);
    const expected = new Map(
      eligible.map((ref) => [catalogEntityKey(provider.connectionId, ref), ref]),
    );
    if (snapshot.entries.length !== eligible.length)
      reject('integrity', '/catalog', 'catalog observation set differs from request');
    for (const entry of snapshot.entries) {
      const ref = expected.get(entry.key);
      const provenance = entry.provenance;
      if (
        !ref ||
        provenance.providerId !== 'backstage-catalog' ||
        provenance.connectionId !== provider.connectionId ||
        provenance.installationId !== access.installationId ||
        provenance.principalId !== access.principalId ||
        provenance.permissionRevision !== access.permissionRevision ||
        JSON.stringify([...provenance.scope].sort()) !== JSON.stringify(access.scope)
      ) {
        reject('integrity', '/catalog', 'catalog observation authority differs from request');
      }
      received.set(ref, entry);
    }
    interruption = merge(interruption, catalog.interrupted);
  }
  const observations = targets.map((targetRef): BackstageReferenceObservation => {
    const reason = blocked.get(targetRef);
    if (reason !== undefined) return { targetRef, status: 'blocked', reason };
    const entry = received.get(targetRef);
    if (!entry) reject('integrity', '/catalog', 'catalog observation is missing');
    return { ...entry, targetRef };
  });
  const retained = run.data.entries.filter(
    (entry) =>
      !(
        entry.provenance.providerId === 'backstage-catalog' &&
        entry.provenance.connectionId === provider.connectionId
      ),
  );
  const retainedKeys = new Set(retained.map((entry) => entry.key));
  for (const entry of received.values())
    if (retainedKeys.has(entry.key))
      reject('integrity', '/data', 'catalog observation conflicts with retained data');
  let data: Immutable<DataSnapshot>;
  let pinFailure: ReferenceDataPreparation['pinFailure'];
  let evaluationRequest: Immutable<ValidationRequest> | undefined;
  try {
    data = createDataSnapshot([...retained, ...received.values()]);
  } catch (error) {
    if (!(error instanceof ContractError) || error.code !== 'limit') throw error;
    data = createDataSnapshot([]);
    pinFailure = 'resource_limit';
    interruption = merge(interruption, 'resource_limit');
  }
  const pinnedAt = Date.now();
  if (budget.interrupted || pinnedAt >= run.execution.deadlineAt) {
    pinFailure = 'interrupted';
    interruption = merge(interruption, budget.interrupted ? interrupted(budget) : 'timeout');
  } else if (
    !pinFailure &&
    data.entries.some(
      (entry) => entry.provenance.fetchedAt > pinnedAt || entry.provenance.expiresAt <= pinnedAt,
    )
  ) {
    pinFailure = 'stale_data';
    interruption = merge(interruption, 'timeout');
  } else if (!pinFailure) {
    try {
      evaluationRequest = parseContract('validation-request', {
        ...run,
        execution: { ...run.execution, startedAt: pinnedAt },
        data,
      });
      verifyRequestBindings(evaluationRequest, context);
    } catch (error) {
      if (!(error instanceof ContractError) || error.code !== 'limit') throw error;
      evaluationRequest = undefined;
      pinFailure = 'resource_limit';
      interruption = merge(interruption, 'resource_limit');
    }
  }
  if (budget.interrupted) {
    evaluationRequest = undefined;
    pinFailure = 'interrupted';
    interruption = merge(interruption, interrupted(budget));
  }
  return deepFreeze({
    compatibility,
    observations,
    data,
    ...(catalog ? { catalog } : {}),
    ...(evaluationRequest ? { evaluationRequest } : {}),
    ...(pinFailure ? { pinFailure } : {}),
    interrupted: interruption,
    collectionStartedAt: run.execution.startedAt,
    referencePaths,
  });
}
