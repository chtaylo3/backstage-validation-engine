import type { DataEntry, DeploymentProfile, ValidationRequest } from '../contracts/schemas.js';
import type { BackstageSourceReference } from '../compatibility/types.js';
import { loadBackstageAdapter } from '../compatibility/adapter.js';
import { extractEntityReferences } from '../compatibility/references.js';
import { compileReferenceContexts } from '../contracts/reference-contexts.js';
import { catalogEntityKey } from '../providers/catalog.js';
import type { RequestBudget } from '../runtime/request-budget.js';
import type { ReferenceDataPreparation } from './reference-data.js';
import type { RuleSubject } from './types.js';
import { digestJson, immutableJson } from '../base/json.js';
import type { Immutable } from '../base/json.js';
import { reject } from '../base/errors.js';
import {
  buildProposedCatalog,
  proposedCatalogEntry,
  PROPOSED_CATALOG_PROVIDER,
} from './proposed-catalog.js';

export interface CatalogBoundReference {
  readonly reference: BackstageSourceReference;
  readonly status: 'present' | 'missing' | 'unavailable' | 'blocked';
  readonly expiresAt?: number;
}
export type CatalogBindings = ReadonlyMap<
  string,
  ReadonlyMap<string, readonly CatalogBoundReference[]>
>;
const frame = (run: Immutable<ValidationRequest>) =>
  digestJson({
    run: run.run,
    execution: run.execution,
    identity: run.identity,
    source: run.source.digest,
    baseline: run.baseline?.digest ?? null,
    data: run.data.digest,
    policy: run.policy,
    profile: run.profile,
    activation: run.activation,
  });

/** Bind only qualified source subjects and observations present in the exact pinned request. */
export async function bindCatalogReferences(
  run: Immutable<ValidationRequest>,
  profile: Immutable<DeploymentProfile>,
  subjects: readonly RuleSubject[],
  paths: readonly string[],
  preparation: ReferenceDataPreparation | undefined,
  budget: RequestBudget,
): Promise<CatalogBindings> {
  const result = new Map<string, ReadonlyMap<string, readonly CatalogBoundReference[]>>();
  if (!preparation?.evaluationRequest) return result;
  if (
    frame(preparation.evaluationRequest) !== frame(run) ||
    preparation.compatibility.sourceDigest !== run.source.digest ||
    preparation.compatibility.profileDigest !== run.profile.digest
  )
    reject('integrity', '/catalog', 'catalog preparation does not bind this rule request');
  const adapter = await loadBackstageAdapter(profile.adapterId);
  budget.throwIfInterrupted();
  const proposed = await buildProposedCatalog(
    run,
    preparation.compatibility,
    preparation.baseline,
    budget,
  );
  const patterns = compileReferenceContexts(profile.referenceContexts).filter(
    (pattern) => paths.includes(pattern.path) && preparation.referencePaths.includes(pattern.path),
  );
  const records = new Map<string, (typeof preparation.compatibility.entities)[number]>();
  for (const entity of preparation.compatibility.entities)
    records.set(JSON.stringify([entity.document.uri, entity.document.document]), entity);
  const data = new Map(run.data.entries.map((entry) => [entry.key, entry]));
  const observations = new Map(
    preparation.observations.map((observation) => [observation.targetRef, observation]),
  );
  const counter = { visits: 0, occurrences: 0 };
  const checked = new Map<string, Immutable<DataEntry> | undefined>();
  for (const subject of subjects) {
    budget.throwIfInterrupted();
    const entity = records.get(JSON.stringify([subject.location.uri, subject.location.document]));
    const file = run.source.files.find((file) => file.uri === subject.location.uri);
    if (
      !entity ||
      !file ||
      entity.document.sourceDigest !== file.digest ||
      entity.document.version !== file.version ||
      digestJson(entity.normalized) !== digestJson(subject.value)
    )
      continue;
    const extracted = await extractEntityReferences(
      entity.document,
      subject.value,
      entity.entityRef,
      patterns,
      adapter,
      budget,
      counter,
    );
    if (extracted.issues.length) continue;
    const groups = new Map(
      patterns.map((pattern) => [pattern.path, [] as CatalogBoundReference[]]),
    );
    for (const reference of extracted.references) {
      const observation = observations.get(reference.targetRef);
      let status: CatalogBoundReference['status'] = 'unavailable';
      let expiresAt: number | undefined;
      if (observation?.status === 'blocked') status = 'blocked';
      else if (observation) {
        if (!checked.has(observation.key)) {
          const pinned = data.get(observation.key);
          const { targetRef: ignored, ...entry } = observation;
          if (observation.provenance.providerId === PROPOSED_CATALOG_PROVIDER) {
            const fact = proposed.get(reference.targetRef);
            if (
              !fact ||
              fact.status === 'blocked' ||
              !pinned ||
              digestJson(
                proposedCatalogEntry(
                  run,
                  reference.targetRef,
                  fact,
                  preparation.collectionStartedAt,
                ),
              ) !== digestJson(entry) ||
              digestJson(pinned) !== digestJson(entry)
            )
              reject(
                'integrity',
                '/overlay',
                'proposed catalog observation differs from the qualified source state',
              );
            checked.set(observation.key, pinned);
          } else {
            if (proposed.get(reference.targetRef))
              reject(
                'integrity',
                '/overlay',
                'catalog observation bypasses proposed source precedence',
              );
            if (
              ignored !== reference.targetRef ||
              observation.key !== catalogEntityKey(observation.provenance.connectionId, ignored) ||
              observation.provenance.providerId !== 'backstage-catalog' ||
              !pinned ||
              digestJson(pinned) !== digestJson(entry)
            ) {
              reject('integrity', '/catalog', 'catalog observation differs from pinned data');
            }
            checked.set(observation.key, pinned);
          }
        }
        const pinned = checked.get(observation.key)!;
        status = pinned.status;
        expiresAt = pinned.provenance.expiresAt;
      }
      groups
        .get(reference.contextPath)!
        .push({ reference, status, ...(expiresAt === undefined ? {} : { expiresAt }) });
    }
    result.set(
      subject.id,
      new Map(
        [...groups].map(([path, facts]) => [
          path,
          immutableJson(facts) as unknown as readonly CatalogBoundReference[],
        ]),
      ),
    );
  }
  return result;
}
