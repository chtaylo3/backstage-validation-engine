import { parsingFindings } from '../../parsing/index.js';
import type { NativeEntityCheck } from '../types.js';
import { MESSAGES, sourceFinding } from './state.js';
import type { DocumentProgress, SourceRunState } from './state.js';

/**
 * For an accepted Location entity, discovers its included sources: included documents join the
 * run, and the included parsing reports contribute their findings and coverage. An interrupted
 * include or a resource-limited discovery makes the rest of the run unavailable.
 */
export async function discoverIncludedSources(
  state: SourceRunState,
  progress: DocumentProgress,
  entityRef: string,
  checked: NativeEntityCheck,
): Promise<void> {
  if (progress.adapter.resolveReference(entityRef).kind !== 'location') return;
  progress.phase = 'locations';
  const { document } = progress;
  const discovered = await state.resolver.discover(document, checked.normalized);
  state.documents.push(...discovered.documents.map((row) => row.document));
  for (const report of discovered.reports) {
    state.findings.push(...parsingFindings(state.run, report));
    state.coverage.push(...report.coverage);
    if (report.files.some((file) => file.status !== 'parsed')) state.unresolvedIncludes = true;
    for (const file of report.files)
      if (file.status !== 'parsed')
        state.coverage.push({
          stage: 'compatibility',
          subject: file.uri,
          required: file.status !== 'invalid',
          status: 'blocked',
          reason: 'Included source parsing did not complete.',
        });
    if (report.interrupted !== 'none') {
      state.interrupted = report.interrupted;
      state.unavailable = true;
      state.blockedReason =
        report.interrupted === 'timeout'
          ? MESSAGES.timeout
          : report.interrupted === 'cancelled'
            ? MESSAGES.cancelled
            : MESSAGES.resource_limit;
    }
  }
  const resource = discovered.issues.some((issue) => issue.code === 'resource_limit');
  const unsupported = discovered.issues.some((issue) => issue.unsupported);
  state.coverage.push({
    stage: 'substitution',
    subject: JSON.stringify(['locations', document.uri, document.document]),
    required: true,
    status: resource ? 'blocked' : unsupported ? 'unsupported' : 'verified',
  });
  for (const issue of discovered.issues)
    sourceFinding(
      state,
      document,
      issue.code,
      issue.path,
      issue.unsupported
        ? 'dependency'
        : issue.code === 'resource_limit'
          ? 'resource'
          : 'compatibility',
      `locations/${issue.code}`,
      issue,
    );
  if (discovered.issues.length) state.unresolvedIncludes = true;
  if (resource) {
    state.interrupted = 'resource_limit';
    state.unavailable = true;
    state.blockedReason = MESSAGES.resource_limit;
  }
}
