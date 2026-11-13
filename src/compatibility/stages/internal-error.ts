import {
  INTERNAL_ERROR_FINDING_LIMIT,
  internalErrorType,
  notifyInternalError,
} from '../../core/internal-errors.js';
import { MESSAGES, sourceFinding } from './state.js';
import type { DocumentProgress, SourcePhase, SourceRunState } from './state.js';

/** The rule ID of a source document's internal-error finding. */
export const SOURCE_INTERNAL_ERROR_RULE = 'backstage/internal_error';

const PHASE_TEXT: Readonly<Record<SourcePhase, string>> = Object.freeze({
  substitution: 'substitution',
  native: 'native validation',
  references: 'reference extraction',
  locations: 'Location discovery',
});

/** The coverage stage and subject that a document failure blocks, by the phase that was running. */
export function failedCoverage(progress: DocumentProgress) {
  const { document, phase, subject } = progress;
  return {
    stage:
      phase === 'substitution' || phase === 'locations'
        ? ('substitution' as const)
        : ('compatibility' as const),
    subject:
      phase === 'locations'
        ? JSON.stringify(['locations', document.uri, document.document])
        : phase === 'references'
          ? JSON.stringify(['references', document.uri, document.document])
          : subject,
  };
}

/**
 * Records an unexpected error while one document was validated. The document gets a
 * `backstage/internal_error` finding (the first `INTERNAL_ERROR_FINDING_LIMIT` per run) and
 * blocked coverage for the phase that was running. The run stays available and its interruption
 * is unchanged, so the documents that follow are validated; the faulty document produces no
 * entity and keeps its identity claim as it stands. The finding carries the error's type name,
 * never its message or stack.
 */
export function recordInternalError(
  state: SourceRunState,
  progress: DocumentProgress,
  error: unknown,
): void {
  const { document, phase } = progress;
  if (state.internalErrors < INTERNAL_ERROR_FINDING_LIMIT) {
    sourceFinding(
      state,
      document,
      'internal_error',
      '',
      'execution',
      'internal_error',
      undefined,
      `${MESSAGES.internal_error} Phase: ${PHASE_TEXT[phase]}. Error type: ${internalErrorType(error)}.`,
    );
    notifyInternalError(state.onInternalError, {
      stage: 'sources',
      phase,
      uri: document.uri,
      document: document.document,
      error,
    });
  }
  state.internalErrors++;
  state.coverage.push({
    ...failedCoverage(progress),
    required: true,
    status: 'blocked',
    reason: MESSAGES.internal_error,
  });
  if (phase === 'locations') state.unresolvedIncludes = true;
}
