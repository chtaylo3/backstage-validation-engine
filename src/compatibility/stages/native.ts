import type { JsonValue } from '../../contracts/schemas.js';
import { canonicalJson } from '../../base/json.js';
import type { Immutable } from '../../base/json.js';
import { BackstageRuntimeError } from '../types.js';
import type { NativeEntityCheck } from '../types.js';
import { admitEntity } from './admission.js';
import { sourceFinding } from './state.js';
import type { CustomSchema, DocumentProgress, SourceRunState } from './state.js';

/**
 * Normalizes the resolved value with the configured native policies, enforces the expanded entity
 * size, admits the kind, and validates it against the stock kind schema or its custom schema.
 * Returns `undefined` when admission stopped the document; native issues become findings.
 */
export async function validateNativeEntity(
  state: SourceRunState,
  progress: DocumentProgress,
  value: Immutable<JsonValue>,
): Promise<
  { readonly checked: NativeEntityCheck; readonly customSchema?: CustomSchema } | undefined
> {
  progress.phase = 'native';
  const { budget, profile, run } = state;
  const { adapter, customKinds } = progress;
  let checked: NativeEntityCheck = await adapter.normalizeEntity(value, profile.nativePolicies, {
    deadlineAt: run.execution.deadlineAt,
    signal: budget.signal,
    clock: budget.clock,
  });
  budget.throwIfInterrupted();
  if (
    Buffer.byteLength(canonicalJson(checked.normalized), 'utf8') >
    profile.limits.expandedEntityBytes
  )
    throw new BackstageRuntimeError('resource_limit');
  let customSchema: CustomSchema | undefined;
  if (checked.status === 'valid') {
    const { document } = progress;
    state.coverage.push({
      stage: 'compatibility',
      subject: JSON.stringify(['normalization', document.uri, document.document]),
      required: true,
      status: 'verified',
    });
    const normalized = checked.normalized as Readonly<Record<string, Immutable<JsonValue>>>;
    const kind = normalized.kind as string;
    const apiVersion = normalized.apiVersion as string;
    try {
      state.sourceClaims[progress.claimIndex] = {
        ...progress.claim,
        entityRef: adapter.entityReference(checked.normalized),
      };
    } catch {
      /* Preserve conservative identity guards until reference qualification. */
    }
    const admitted = admitEntity(state, progress, checked.normalized, kind, apiVersion);
    if (!admitted) return undefined;
    if (admitted.customSchema) customSchema = admitted.customSchema;
    else {
      const kindCheck = await adapter.validateKind(checked.normalized, {
        deadlineAt: run.execution.deadlineAt,
        signal: budget.signal,
        clock: budget.clock,
      });
      checked = { ...kindCheck, authored: checked.authored, changes: checked.changes };
      if (checked.status === 'unsupported' && customKinds.hasKind(kind))
        checked = {
          ...checked,
          issues: [{ code: 'unsupported_api_version', stage: 'kind', path: '/apiVersion' }],
        };
    }
  }
  if (!customSchema)
    state.coverage.push({
      stage: 'compatibility',
      subject: progress.subject,
      required: true,
      status: checked.status === 'unsupported' ? 'unsupported' : 'verified',
      ...(checked.status === 'unsupported'
        ? { reason: 'Native kind/API-version support is incomplete.' }
        : {}),
    });
  for (const issue of checked.issues)
    sourceFinding(
      state,
      progress.document,
      issue.code,
      issue.path,
      checked.status === 'unsupported' ? 'dependency' : 'compatibility',
      `${issue.stage}/${issue.code}`,
    );
  return { checked, ...(customSchema ? { customSchema } : {}) };
}
