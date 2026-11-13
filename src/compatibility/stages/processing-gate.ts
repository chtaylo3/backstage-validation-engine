import type { DeploymentProfile, ValidationRequest } from '../../contracts/schemas.js';
import { reject } from '../../base/errors.js';
import { deepFreeze } from '../../base/json.js';
import type { Immutable } from '../../base/json.js';
import {
  processingCoverage,
  processingFinding,
  PROCESSING_UNAVAILABLE,
} from '../../core/processing.js';
import { CelError } from '../../runtime/cel/errors.js';
import type { RequestBudget } from '../../runtime/request-budget.js';
import type { BackstageCompatibilityReport } from '../types.js';

/**
 * The report of a profile whose required processors are unavailable: no source work runs, every
 * selected file (up to the entity limit) gets one processing finding, and the five source stages
 * are blocked.
 */
export function blockedProcessingReport(
  run: Immutable<ValidationRequest>,
  profile: Immutable<DeploymentProfile>,
  budget: RequestBudget,
  uris: readonly string[] | undefined,
): BackstageCompatibilityReport {
  if (
    uris &&
    (new Set(uris).size !== uris.length ||
      uris.some((uri) => !run.source.files.some((file) => file.uri === uri)))
  )
    reject('invalid_contract', '/uris', 'source selection contains duplicate or unavailable files');
  const selected = run.source.files
    .filter((file) => !uris || uris.includes(file.uri))
    .slice(0, profile.limits.entities);
  const interrupted = budget.interrupted
    ? budget.signal.reason instanceof CelError && budget.signal.reason.code === 'request_timeout'
      ? 'timeout'
      : 'cancelled'
    : 'none';
  return deepFreeze({
    adapterId: profile.adapterId,
    sourceDigest: run.source.digest,
    profileDigest: run.profile.digest,
    entities: [],
    references: [],
    sourceClaims: [],
    unresolvedSourceIdentities: true,
    findings: selected.map((file) =>
      processingFinding(
        run,
        {
          uri: file.uri,
          document: 0,
          path: '',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        },
        JSON.stringify([file.uri, 0]),
      ),
    ),
    coverage: [
      ...processingCoverage(profile),
      ...(['parse', 'substitution', 'compatibility', 'admission', 'overlay'] as const).map(
        (stage) => ({
          stage,
          subject: 'processing',
          required: true,
          status: 'blocked' as const,
          reason: PROCESSING_UNAVAILABLE,
        }),
      ),
    ],
    artifacts: [],
    interrupted,
  });
}
