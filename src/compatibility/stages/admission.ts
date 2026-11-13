import type { JsonValue } from '../../contracts/schemas.js';
import { admitsKind } from '../../contracts/admission.js';
import type { Immutable } from '../../base/json.js';
import { sourceFinding } from './state.js';
import type { CustomSchema, DocumentProgress, SourceRunState } from './state.js';

/**
 * Admits the normalized kind for the document's source and, for a declared custom kind, validates
 * the pinned custom schema. Returns `undefined` when the document stops here with a finding; a
 * custom kind returns its schema, a stock kind returns no schema.
 */
export function admitEntity(
  state: SourceRunState,
  progress: DocumentProgress,
  normalized: Immutable<JsonValue>,
  kind: string,
  apiVersion: string,
): { readonly customSchema?: CustomSchema } | undefined {
  const { document, subject } = progress;
  state.coverage.push({ stage: 'admission', subject, required: true, status: 'verified' });
  if (!admitsKind(state.profile, document.uri, kind)) {
    sourceFinding(
      state,
      document,
      'disallowed_kind',
      '/kind',
      'compatibility',
      'admission/disallowed_kind',
    );
    return undefined;
  }
  const custom = progress.customKinds.get(kind, apiVersion);
  if (!custom) return {};
  state.coverage.push({
    stage: 'compatibility',
    subject,
    required: true,
    status: custom.validate ? 'verified' : 'unsupported',
  });
  if (!custom.validate) {
    sourceFinding(
      state,
      document,
      'unsupported_custom_schema',
      '/kind',
      'dependency',
      'custom_schema/unsupported_custom_schema',
    );
    return undefined;
  }
  const invalidPath = custom.validate(normalized);
  state.budget.throwIfInterrupted();
  if (invalidPath !== undefined) {
    sourceFinding(
      state,
      document,
      'invalid_custom_kind',
      invalidPath,
      'compatibility',
      'custom_schema/invalid_custom_kind',
    );
    return undefined;
  }
  return { customSchema: { ...custom.schema } };
}
