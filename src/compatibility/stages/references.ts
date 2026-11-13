import type { JsonValue } from '../../contracts/schemas.js';
import { locateParsedPath } from '../../parsing/index.js';
import { extractEntityReferences } from '../references.js';
import type { NativeEntityCheck, SourceSubstitution } from '../types.js';
import { sourceFinding } from './state.js';
import type { CustomSchema, DocumentProgress, SourceRunState } from './state.js';

interface QualifiedEntity {
  readonly checked: NativeEntityCheck;
  readonly entityRef: string;
  readonly customSchema?: CustomSchema;
  readonly resolved: {
    readonly value: NativeEntityCheck['authored'];
    readonly substitutions: readonly SourceSubstitution[];
  };
}

/**
 * Checks that the valid entity has an unambiguous identity and that its configured reference
 * fields resolve. A qualified entity is accepted with its references and its normalized artifact;
 * returns whether the document was accepted.
 */
export async function qualifyEntityReferences(
  state: SourceRunState,
  progress: DocumentProgress,
  entity: QualifiedEntity,
): Promise<boolean> {
  progress.phase = 'references';
  const { adapter, document } = progress;
  const { checked } = entity;
  const subject = JSON.stringify(['references', document.uri, document.document]);
  try {
    state.sourceClaims[progress.claimIndex] = {
      ...progress.claim,
      entityRef: adapter.entityReference(checked.normalized),
    };
  } catch {
    sourceFinding(
      state,
      document,
      'invalid_identity',
      '/metadata',
      'compatibility',
      'references/invalid_identity',
    );
    state.coverage.push({ stage: 'compatibility', subject, required: true, status: 'verified' });
    return false;
  }
  const extracted = await extractEntityReferences(
    document,
    checked.normalized,
    entity.entityRef,
    state.referencePatterns,
    adapter,
    state.budget,
    state.referenceCounter,
  );
  state.coverage.push({ stage: 'compatibility', subject, required: true, status: 'verified' });
  for (const issue of extracted.issues)
    sourceFinding(
      state,
      document,
      issue.code,
      issue.path,
      'compatibility',
      `references/${issue.code}`,
    );
  if (extracted.issues.length) return false;
  state.references.push(...extracted.references);
  acceptEntity(state, progress, entity);
  return true;
}

/** Records the accepted entity and its artifact with substitution and normalization provenance. */
function acceptEntity(state: SourceRunState, progress: DocumentProgress, entity: QualifiedEntity) {
  const { document } = progress;
  const { checked, customSchema, entityRef, resolved } = entity;
  const changes = checked.changes.map((change) => ({
    ...change,
    origin: locateParsedPath(document, change.path),
  }));
  state.entities.push({
    document,
    entityRef,
    authored: document.value,
    resolved: resolved.value,
    substitutions: resolved.substitutions,
    normalized: checked.normalized,
    ...(customSchema ? { customSchema } : {}),
    changes,
  });
  state.artifacts.push({
    entityRef,
    sourceUri: document.uri,
    document: document.document,
    sourceDigest: document.sourceDigest,
    value: checked.normalized as JsonValue,
    provenance: [
      ...(customSchema
        ? [
            {
              path: '',
              origin: locateParsedPath(document, '/kind'),
              transformation: `custom-schema/${customSchema.digest}`,
            },
          ]
        : []),
      ...resolved.substitutions.map((substitution) => ({
        path: substitution.path,
        origin: substitution.origin,
        transformation: `snapshot-local/${substitution.kind}`,
      })),
      ...changes.map((change) => ({
        path: change.path,
        origin: change.origin,
        transformation: `${state.profile.adapterId}/${change.policy}`,
      })),
    ],
  });
}
