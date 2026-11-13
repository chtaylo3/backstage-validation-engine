import type {
  ActivationManifest,
  DataEntry,
  DataSnapshot,
  DeploymentProfile,
  PolicyBundle,
  SchemaArtifact,
  ValidationRequest,
} from '../contracts/schemas.js';
import { parseContract } from '../contracts/validate.js';
import { systemClock } from '../base/clock.js';
import type { Clock } from '../base/clock.js';
import { validateBackstageSources } from '../compatibility/sources.js';
import type { BackstageCompatibilityReport } from '../compatibility/types.js';
import { catalogEntityKey, normalizeCatalogAccess } from '../providers/catalog.js';
import { CatalogProviderError } from '../providers/types.js';
import type {
  CatalogAccessContext,
  CatalogLookupReport,
  CatalogProvider,
} from '../providers/types.js';
import { FailureTimer, failureCause } from '../runtime/failure-evidence.js';
import type { FailureEvidence } from '../runtime/failure-evidence.js';
import { RequestBudget } from '../runtime/request-budget.js';
import { CelError } from '../runtime/cel/errors.js';
import { verifyRequestBindings } from '../core/bindings.js';
import { ContractError, reject } from '../base/errors.js';
import { deepFreeze } from '../base/json.js';
import type { Immutable } from '../base/json.js';
import { createDataSnapshot } from '../core/snapshots.js';
import { mergeInterruption } from '../core/stage-report.js';
import type { Interruption } from '../core/stage-report.js';
import {
  buildProposedCatalog,
  proposedCatalogEntry,
  PROPOSED_CATALOG_PROVIDER,
} from './proposed-catalog.js';

export type ReferenceBlockReason =
  | 'local_source'
  | 'competing_claims'
  | 'unresolved_sources'
  | 'unresolved_deletions'
  | 'source_incomplete'
  | 'invalid_replacement'
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
  readonly baseline?: BackstageCompatibilityReport;
  readonly observations: readonly BackstageReferenceObservation[];
  readonly data: Immutable<DataSnapshot>;
  readonly catalog?: CatalogLookupReport;
  /** Present only when data and the remaining original deadline can be pinned for evaluation. */
  readonly evaluationRequest?: Immutable<ValidationRequest>;
  readonly pinFailure?: 'interrupted' | 'stale_data' | 'resource_limit';
  readonly interrupted: Interruption;
  readonly collectionStartedAt: number;
  readonly referencePaths: readonly string[];
  readonly failureEvidence?: readonly FailureEvidence[];
}
/** Immutable local work that advisory completion may reuse before catalog HTTP. */
export interface LocalCatalogSources {
  readonly compatibility: BackstageCompatibilityReport;
  readonly baseline?: BackstageCompatibilityReport;
}
type SourceContext = Parameters<typeof validateBackstageSources>[1];
type ProposedCatalog = Awaited<ReturnType<typeof buildProposedCatalog>>;
type PinFailure = ReferenceDataPreparation['pinFailure'];
/** Shared by the collection steps; each step merges the interruption it observes. */
interface Collection {
  readonly run: Immutable<ValidationRequest>;
  readonly clock: Clock;
  readonly budget: RequestBudget;
  readonly timer: FailureTimer;
  readonly failureEvidence: FailureEvidence[];
  interruption: Interruption;
}
function interrupted(budget: RequestBudget): 'timeout' | 'cancelled' {
  return budget.signal.reason instanceof CelError && budget.signal.reason.code === 'request_timeout'
    ? 'timeout'
    : 'cancelled';
}

/** The selected reference contexts, which must be distinct declared contexts, sorted. */
function selectReferencePaths(
  context: SourceContext,
  requested: readonly string[] | undefined,
): string[] {
  const referencePaths =
    requested === undefined
      ? context.profile.referenceContexts.map((row) => row.path)
      : [...requested];
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
  return referencePaths.sort();
}

/** The catalog access, which must bind this request's identity, pins and adapter. */
function bindCatalogAccess(
  run: Immutable<ValidationRequest>,
  context: SourceContext,
  provider: CatalogProvider,
  requested: CatalogAccessContext,
): CatalogAccessContext {
  const access = normalizeCatalogAccess(requested);
  if (
    access.installationId !== run.identity.installationId ||
    access.permissionRevision !== run.identity.permissionRevision ||
    access.profileDigest !== run.profile.digest ||
    access.policyDigest !== run.policy.digest ||
    provider.adapterId !== context.profile.adapterId
  ) {
    reject('integrity', '/catalog', 'catalog context does not bind this validation request');
  }
  return access;
}

/** Validates the proposed and baseline sources and derives the proposed catalog from them. */
async function qualifySources(
  collection: Collection,
  context: SourceContext,
  onLocalSources: ((sources: LocalCatalogSources) => void) | undefined,
) {
  const { run, budget, clock } = collection;
  const compatibility = await validateBackstageSources(run, context, {
    signal: budget.signal,
    clock,
  });
  collection.interruption = compatibility.interrupted;
  let baseline: BackstageCompatibilityReport | undefined;
  if (run.baseline && collection.interruption === 'none' && !budget.interrupted) {
    const { baseline: sourceBaseline, ...withoutBaseline } = run;
    baseline = await validateBackstageSources(
      parseContract('validation-request', { ...withoutBaseline, source: sourceBaseline }),
      context,
      { signal: budget.signal, clock },
    );
    collection.interruption = mergeInterruption(collection.interruption, baseline.interrupted);
  }
  onLocalSources?.(Object.freeze({ compatibility, ...(baseline ? { baseline } : {}) }));
  let proposed: ProposedCatalog | undefined;
  try {
    if (!run.baseline || baseline)
      proposed = await buildProposedCatalog(run, compatibility, baseline, budget);
  } catch (error) {
    if (!(error instanceof CelError)) throw error;
    collection.interruption = mergeInterruption(collection.interruption, interrupted(budget));
  }
  return { compatibility, baseline, proposed };
}

/**
 * Sorts the referenced targets into blocked targets and proposed-catalog facts, and records the
 * proposed-catalog coverage on the compatibility report.
 */
function classifyTargets(
  collection: Collection,
  context: SourceContext,
  compatibility: BackstageCompatibilityReport,
  proposed: ProposedCatalog | undefined,
  referencePaths: readonly string[],
) {
  const { run, budget } = collection;
  const targets = [
    ...new Set(
      compatibility.references
        .filter((reference) => referencePaths.includes(reference.contextPath))
        .map((reference) => reference.targetRef),
    ),
  ].sort();
  const blocked = new Map<string, ReferenceBlockReason>();
  const received = new Map<string, Immutable<DataEntry>>();
  for (const target of targets) {
    if (collection.interruption !== 'none' || budget.interrupted || !proposed)
      blocked.set(target, 'source_incomplete');
    else {
      const fact = proposed.get(target);
      if (fact?.status === 'blocked') blocked.set(target, fact.reason);
      else if (fact)
        received.set(target, proposedCatalogEntry(run, target, fact, run.execution.startedAt));
    }
  }
  const covered: BackstageCompatibilityReport = {
    ...compatibility,
    coverage: [
      ...compatibility.coverage,
      {
        stage: 'overlay',
        subject: 'proposed-catalog',
        required: targets.length > 0,
        status:
          blocked.size || !proposed || context.profile.requiredProcessors.length
            ? 'blocked'
            : 'verified',
      },
    ],
  };
  return { compatibility: covered, targets, blocked, received };
}

/**
 * Looks up the targets that neither the sources nor a block decided. A failed lookup blocks
 * them as `provider_failure`; a returned snapshot must answer exactly them, with the request's
 * authority.
 */
async function lookupCatalog(
  collection: Collection,
  provider: CatalogProvider,
  access: CatalogAccessContext,
  eligible: readonly string[],
  blocked: Map<string, ReferenceBlockReason>,
  received: Map<string, Immutable<DataEntry>>,
): Promise<CatalogLookupReport | undefined> {
  const { run, budget } = collection;
  if (!eligible.length) return undefined;
  let catalog: CatalogLookupReport;
  try {
    catalog = await provider.lookup(eligible, access, {
      deadlineAt: run.execution.deadlineAt,
      signal: budget.signal,
    });
  } catch (error) {
    collection.failureEvidence.push(
      collection.timer.capture(
        'catalog_admission',
        error instanceof CatalogProviderError
          ? error.code === 'input_limit'
            ? 'resource_limit'
            : error.code === 'closed'
              ? 'provider_error'
              : 'invalid_contract'
          : failureCause(error),
        run.execution.deadlineAt,
      ),
    );
    if (budget.interrupted)
      collection.interruption = mergeInterruption(collection.interruption, interrupted(budget));
    else if (error instanceof CatalogProviderError && error.code === 'input_limit')
      collection.interruption = mergeInterruption(collection.interruption, 'resource_limit');
    for (const ref of eligible) blocked.set(ref, 'provider_failure');
    return undefined;
  }
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
  collection.interruption = mergeInterruption(collection.interruption, catalog.interrupted);
  return catalog;
}

/** One observation per target, in target order: its block reason or its received entry. */
function observeTargets(
  targets: readonly string[],
  blocked: ReadonlyMap<string, ReferenceBlockReason>,
  received: ReadonlyMap<string, Immutable<DataEntry>>,
): BackstageReferenceObservation[] {
  return targets.map((targetRef): BackstageReferenceObservation => {
    const reason = blocked.get(targetRef);
    if (reason !== undefined) return { targetRef, status: 'blocked', reason };
    const entry = received.get(targetRef);
    if (!entry) reject('integrity', '/catalog', 'catalog observation is missing');
    return { ...entry, targetRef };
  });
}

/**
 * Merges the received observations into the request's retained data and pins the evaluation
 * request at the current time, unless the data exceeds its limits, is not fresh, or the request
 * was interrupted. A pin failure is recorded as failure evidence.
 */
function pinEvaluationRequest(
  collection: Collection,
  context: SourceContext,
  provider: CatalogProvider,
  received: ReadonlyMap<string, Immutable<DataEntry>>,
) {
  const { run, budget, clock } = collection;
  const retained = run.data.entries.filter(
    (entry) =>
      !(
        entry.provenance.providerId === PROPOSED_CATALOG_PROVIDER ||
        (entry.provenance.providerId === 'backstage-catalog' &&
          entry.provenance.connectionId === provider.connectionId)
      ),
  );
  const retainedKeys = new Set(retained.map((entry) => entry.key));
  for (const entry of received.values())
    if (retainedKeys.has(entry.key))
      reject('integrity', '/data', 'catalog observation conflicts with retained data');
  let data: Immutable<DataSnapshot>;
  let pinFailure: PinFailure;
  let evaluationRequest: Immutable<ValidationRequest> | undefined;
  try {
    data = createDataSnapshot([...retained, ...received.values()]);
  } catch (error) {
    if (!(error instanceof ContractError) || error.code !== 'limit') throw error;
    data = createDataSnapshot([]);
    pinFailure = 'resource_limit';
    collection.interruption = mergeInterruption(collection.interruption, 'resource_limit');
  }
  const pinnedAt = clock.wall();
  if (budget.interrupted || pinnedAt >= run.execution.deadlineAt) {
    pinFailure = 'interrupted';
    collection.interruption = mergeInterruption(
      collection.interruption,
      budget.interrupted ? interrupted(budget) : 'timeout',
    );
  } else if (
    !pinFailure &&
    data.entries.some(
      (entry) => entry.provenance.fetchedAt > pinnedAt || entry.provenance.expiresAt <= pinnedAt,
    )
  ) {
    pinFailure = 'stale_data';
    collection.interruption = mergeInterruption(collection.interruption, 'timeout');
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
      collection.interruption = mergeInterruption(collection.interruption, 'resource_limit');
    }
  }
  if (budget.interrupted) {
    evaluationRequest = undefined;
    pinFailure = 'interrupted';
    collection.interruption = mergeInterruption(collection.interruption, interrupted(budget));
  }
  if (pinFailure)
    collection.failureEvidence.push(
      collection.timer.capture(
        'catalog_snapshot',
        pinFailure === 'resource_limit'
          ? 'aggregate_limit'
          : pinFailure === 'stale_data'
            ? data.entries.some((entry) => entry.provenance.fetchedAt > pinnedAt)
              ? 'future_observation'
              : 'observation_expired'
            : collection.interruption === 'cancelled'
              ? 'cancelled'
              : 'request_timeout',
        run.execution.deadlineAt,
      ),
    );
  return { data, pinFailure, evaluationRequest };
}

/**
 * Qualify the proposed source overlay before collecting eligible external observations.
 */
export async function prepareBackstageReferenceData(
  request: Immutable<ValidationRequest>,
  context: {
    readonly profile: Immutable<DeploymentProfile>;
    readonly policy: Immutable<PolicyBundle>;
    readonly activation: Immutable<ActivationManifest>;
    readonly schemaArtifacts?: readonly Immutable<SchemaArtifact>[];
  },
  options: {
    readonly provider: CatalogProvider;
    readonly access: CatalogAccessContext;
    readonly signal?: AbortSignal;
    readonly referencePaths?: readonly string[];
    readonly onLocalSources?: (sources: LocalCatalogSources) => void;
    /**
     * Decides the collection and source-stage deadlines and the pin time. Catalog lookups read the
     * provider's clock.
     */
    readonly clock?: Clock;
  },
): Promise<ReferenceDataPreparation> {
  const clock = options.clock ?? systemClock;
  const timer = new FailureTimer(clock);
  const failureEvidence: FailureEvidence[] = [];
  const run = parseContract('validation-request', request);
  using budget = new RequestBudget(run.execution.deadlineAt, options.signal, clock);
  verifyRequestBindings(run, context);
  const referencePaths = selectReferencePaths(context, options.referencePaths);
  const provider = options.provider;
  const access = bindCatalogAccess(run, context, provider, options.access);
  const collection: Collection = {
    run,
    clock,
    budget,
    timer,
    failureEvidence,
    interruption: 'none',
  };
  const sources = await qualifySources(collection, context, options.onLocalSources);
  const { baseline } = sources;
  const { compatibility, targets, blocked, received } = classifyTargets(
    collection,
    context,
    sources.compatibility,
    sources.proposed,
    referencePaths,
  );
  const eligible = targets.filter((target) => !blocked.has(target) && !received.has(target));
  const catalog = await lookupCatalog(collection, provider, access, eligible, blocked, received);
  const observations = observeTargets(targets, blocked, received);
  const pinned = pinEvaluationRequest(collection, context, provider, received);
  return deepFreeze({
    compatibility,
    ...(baseline ? { baseline } : {}),
    observations,
    data: pinned.data,
    ...(catalog ? { catalog } : {}),
    ...(pinned.evaluationRequest ? { evaluationRequest: pinned.evaluationRequest } : {}),
    ...(pinned.pinFailure ? { pinFailure: pinned.pinFailure } : {}),
    interrupted: collection.interruption,
    collectionStartedAt: run.execution.startedAt,
    referencePaths,
    failureEvidence,
  });
}
