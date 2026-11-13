import { setImmediate as yieldTurn } from 'node:timers/promises';
import { locateParsedPath } from '../../parsing/index.js';
import type { DocumentProgress, SourceRunState } from './state.js';

/**
 * Resolves snapshot-local substitutions. On success the document and its identity claim switch to
 * the resolved locations and substitution coverage is verified; a resolution error propagates to
 * the document driver.
 */
export async function resolveDocumentSources(state: SourceRunState, progress: DocumentProgress) {
  await yieldTurn();
  state.budget.throwIfInterrupted();
  const resolved = await state.resolver.resolve(progress.document);
  const document = resolved.document;
  progress.document = document;
  progress.claim = {
    ...progress.claim,
    location: locateParsedPath(document, '/metadata'),
    relatedLocations: document.locations['/metadata']?.relatedLocations ?? [],
  };
  state.sourceClaims[progress.claimIndex] = progress.claim;
  state.coverage.push({
    stage: 'substitution',
    subject: progress.subject,
    required: true,
    status: 'verified',
  });
  return resolved;
}
