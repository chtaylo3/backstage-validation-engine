import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { DataEntry, ValidationRequest } from '../contracts/schemas.js';
import type {
  BackstageCompatibilityReport,
  CompatibleSourceEntity,
  SourceIdentityClaim,
} from '../compatibility/types.js';
import type { Immutable } from './json.js';
import { digestJson } from './json.js';
import { reject } from './errors.js';
import type { RequestBudget } from '../runtime/request-budget.js';

export const PROPOSED_CATALOG_PROVIDER = 'backstage-proposed-catalog';
export const proposedCatalogEntityKey = (entityRef: string) =>
  `${PROPOSED_CATALOG_PROVIDER}/${digestJson(entityRef)}`;
export type ProposedBlockReason =
  | 'local_source'
  | 'competing_claims'
  | 'unresolved_sources'
  | 'unresolved_deletions'
  | 'source_incomplete'
  | 'invalid_replacement';
export type ProposedCatalogFact =
  | { readonly status: 'present'; readonly entity: CompatibleSourceEntity }
  | { readonly status: 'missing'; readonly origins: readonly SourceIdentityClaim[] }
  | { readonly status: 'blocked'; readonly reason: ProposedBlockReason };

/** Derive facts only from pinned, qualified source reports; no catalog or filesystem reads. */
export async function buildProposedCatalog(
  run: Immutable<ValidationRequest>,
  current: BackstageCompatibilityReport,
  baseline: BackstageCompatibilityReport | undefined,
  budget: RequestBudget,
) {
  if (
    current.sourceDigest !== run.source.digest ||
    current.profileDigest !== run.profile.digest ||
    !!run.baseline !== !!baseline ||
    (baseline &&
      (baseline.sourceDigest !== run.baseline?.digest ||
        baseline.profileDigest !== run.profile.digest))
  )
    reject(
      'integrity',
      '/overlay',
      'source reports do not bind the proposed and baseline snapshots',
    );
  const entities = new Map(current.entities.map((entity) => [entity.entityRef, entity]));
  const known = new Map<string, SourceIdentityClaim[]>();
  const previous = new Map<string, SourceIdentityClaim[]>();
  const accepted = new Set(
    current.entities.map((entity) =>
      JSON.stringify([entity.document.uri, entity.document.document]),
    ),
  );
  const invalidUris = new Set<string>();
  let visits = 0;
  const step = async () => {
    budget.throwIfInterrupted();
    if (++visits % 128 === 0) await yieldTurn();
    budget.throwIfInterrupted();
  };
  for (const [report, claims] of [
    [current, known],
    [baseline, previous],
  ] as const) {
    if (!report) continue;
    for (const claim of report.sourceClaims) {
      await step();
      if (claim.entityRef) {
        const group = claims.get(claim.entityRef) ?? [];
        group.push(claim);
        claims.set(claim.entityRef, group);
      }
      if (report === current && !accepted.has(JSON.stringify([claim.uri, claim.document])))
        invalidUris.add(claim.uri);
    }
  }
  const incomplete = (report: BackstageCompatibilityReport) =>
    report.interrupted !== 'none' ||
    report.coverage.some((row) => row.stage === 'substitution' && row.status !== 'verified') ||
    report.sourceClaims.some(
      (claim) =>
        claim.entityRef?.startsWith('location:') &&
        !report.entities.some((entity) => entity.entityRef === claim.entityRef),
    );
  let globalBlock: ProposedBlockReason | undefined;
  if (incomplete(current)) globalBlock = 'source_incomplete';
  else if (current.unresolvedSourceIdentities) globalBlock = 'unresolved_sources';
  else if (
    (baseline && (baseline.unresolvedSourceIdentities || incomplete(baseline))) ||
    (!baseline && run.source.changes.some((change) => change.kind !== 'added'))
  )
    globalBlock = 'unresolved_deletions';
  const get = (targetRef: string): ProposedCatalogFact | undefined => {
    if (globalBlock === 'source_incomplete' || globalBlock === 'unresolved_sources')
      return { status: 'blocked', reason: globalBlock };
    const claims = known.get(targetRef);
    if (claims && claims.length > 1) return { status: 'blocked', reason: 'competing_claims' };
    if (claims) {
      const entity = entities.get(targetRef);
      return entity ? { status: 'present', entity } : { status: 'blocked', reason: 'local_source' };
    }
    if (globalBlock) return { status: 'blocked', reason: globalBlock };
    const before = previous.get(targetRef);
    if (before) {
      if (before.some((claim) => invalidUris.has(claim.uri)))
        return { status: 'blocked', reason: 'invalid_replacement' };
      return { status: 'missing', origins: before };
    }
    return undefined;
  };
  budget.throwIfInterrupted();
  return { get, globalBlock };
}

/** Source-derived data uses a separate provider identity and never claims backend visibility. */
export function proposedCatalogEntry(
  run: Immutable<ValidationRequest>,
  targetRef: string,
  fact: Exclude<ProposedCatalogFact, { readonly status: 'blocked' }>,
  collectedAt: number,
): Immutable<DataEntry> {
  const provenance = {
    providerId: PROPOSED_CATALOG_PROVIDER,
    connectionId: 'source-snapshot',
    installationId: run.identity.installationId,
    principalId: 'source-snapshot',
    permissionRevision: run.identity.permissionRevision,
    scope: ['catalog:proposed'],
    revision: digestJson({
      source: run.source.digest,
      baseline: run.baseline?.digest ?? null,
      profile: run.profile.digest,
    }),
    fetchedAt: collectedAt,
    expiresAt: collectedAt + 60_000,
  };
  const key = proposedCatalogEntityKey(targetRef);
  return fact.status === 'present'
    ? { key, status: 'present', value: fact.entity.normalized, provenance }
    : { key, status: 'missing', provenance };
}
