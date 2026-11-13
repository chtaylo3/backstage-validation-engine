import { ContractError } from '../../base/errors.js';
import { locateParsedPath } from '../../parsing/index.js';
import type { ParsedSourceDocument } from '../../parsing/index.js';
import { CelError } from '../../runtime/cel/errors.js';
import { SourceResolutionError } from '../substitutions.js';
import { BackstageRuntimeError } from '../types.js';
import type { SourceIdentityClaim } from '../types.js';
import { discoverIncludedSources } from './locations.js';
import { validateNativeEntity } from './native.js';
import { qualifyEntityReferences } from './references.js';
import { MESSAGES, sourceFinding } from './state.js';
import type { DocumentProgress, SourceRunState } from './state.js';
import { resolveDocumentSources } from './substitution.js';

/**
 * Validates one source document through substitution, native validation and admission, reference
 * qualification and Location discovery. Every document first records its identity claim; once the
 * run is unavailable a document receives only one blocked row. A contract error propagates; any
 * other failure maps to a finding and blocked coverage for the stage that was running.
 */
export async function validateSourceDocument(
  state: SourceRunState,
  authored: ParsedSourceDocument,
): Promise<void> {
  const subject = JSON.stringify([authored.uri, authored.document]);
  let claim: SourceIdentityClaim = {
    uri: authored.uri,
    document: authored.document,
    location: locateParsedPath(authored, '/metadata'),
    relatedLocations: authored.locations['/metadata']?.relatedLocations ?? [],
  };
  if (!state.unavailable && state.adapter) {
    try {
      const identity = state.adapter.resolveReference(
        state.adapter.entityReference(authored.value),
      ).entityRef;
      claim = { ...claim, entityRef: identity };
    } catch {
      /* Unresolved identities are retained as conservative blockers. */
    }
  }
  const claimIndex = state.sourceClaims.length;
  state.sourceClaims.push(claim);
  const { adapter, customKinds } = state;
  if (state.unavailable || !adapter || !customKinds) {
    state.coverage.push({
      stage: 'compatibility',
      subject,
      required: true,
      status: 'blocked',
      reason: state.blockedReason,
    });
    return;
  }
  const progress: DocumentProgress = {
    phase: 'substitution',
    document: authored,
    claim,
    subject,
    claimIndex,
    adapter,
    customKinds,
  };
  try {
    const resolved = await resolveDocumentSources(state, progress);
    const native = await validateNativeEntity(state, progress, resolved.value);
    const entityRef = native?.checked.status === 'valid' ? native.checked.entityRef : undefined;
    if (!native || !entityRef) return;
    const accepted = await qualifyEntityReferences(state, progress, {
      ...native,
      entityRef,
      resolved,
    });
    if (accepted) await discoverIncludedSources(state, progress, entityRef, native.checked);
  } catch (error) {
    if (error instanceof ContractError) throw error;
    recordDocumentFailure(state, progress, error);
  }
}

/** Maps a document failure to a finding, blocked coverage and the run's assigned interruption. */
function recordDocumentFailure(state: SourceRunState, progress: DocumentProgress, error: unknown) {
  const { document, phase, subject } = progress;
  if (error instanceof SourceResolutionError) {
    const resource = error.code === 'resource_limit';
    sourceFinding(
      state,
      document,
      error.code,
      error.path,
      error.unsupported ? 'dependency' : resource ? 'resource' : 'compatibility',
      `substitution/${error.code}`,
      error,
    );
    state.coverage.push({
      stage: 'substitution',
      subject,
      required: true,
      status: resource ? 'blocked' : error.unsupported ? 'unsupported' : 'verified',
      reason: error.message,
    });
    state.coverage.push({
      stage: 'compatibility',
      subject,
      required: resource || error.unsupported,
      status: 'blocked',
      reason: 'Source resolution did not produce a native-validation subject.',
    });
    if (resource) {
      state.interrupted = 'resource_limit';
      state.unavailable = true;
      state.blockedReason = MESSAGES.resource_limit;
    }
    return;
  }
  const code =
    error instanceof CelError
      ? error.code === 'request_timeout'
        ? 'timeout'
        : 'cancelled'
      : error instanceof BackstageRuntimeError
        ? error.code
        : 'adapter_unavailable';
  sourceFinding(
    state,
    document,
    code,
    '',
    code === 'adapter_unavailable' ? 'dependency' : 'resource',
  );
  state.coverage.push({
    stage: phase === 'substitution' || phase === 'locations' ? 'substitution' : 'compatibility',
    subject:
      phase === 'locations'
        ? JSON.stringify(['locations', document.uri, document.document])
        : phase === 'references'
          ? JSON.stringify(['references', document.uri, document.document])
          : subject,
    required: true,
    status: 'blocked',
    reason: MESSAGES[code],
  });
  if (code !== 'adapter_unavailable')
    state.interrupted =
      code === 'timeout' ? 'timeout' : code === 'cancelled' ? 'cancelled' : 'resource_limit';
  state.unavailable = true;
  if (phase === 'locations') state.unresolvedIncludes = true;
  state.blockedReason = MESSAGES[code];
}
