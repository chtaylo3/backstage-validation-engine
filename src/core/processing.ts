import type {
  Coverage,
  DeploymentProfile,
  Finding,
  ValidationRequest,
} from '../contracts/schemas.js';
import type { Immutable } from '../base/json.js';
import { createFindingId } from './results.js';

/** Executable deployment integrations require separate approval and qualification. */
export const SUPPORTED_DEPLOYMENT_PROCESSORS: readonly string[] = Object.freeze([]);
export const PROCESSING_UNAVAILABLE =
  'Required deployment processing is unavailable; dependent validation was not executed.';
export function processingCoverage(profile: Immutable<DeploymentProfile>): Coverage[] {
  return profile.requiredProcessors.map((processor) => ({
    stage: 'compatibility',
    subject: JSON.stringify(['processor', processor.id, processor.stage]),
    required: true,
    status: 'unsupported',
    reason: PROCESSING_UNAVAILABLE,
  }));
}
export function processingFinding(
  run: Immutable<ValidationRequest>,
  location: Immutable<Finding['location']>,
  subjectId: string,
): Finding {
  const ruleId = 'backstage/processors/unavailable';
  return {
    id: createFindingId({
      ruleId,
      ruleVersion: run.profile.digest,
      subjectId,
      path: '',
      policyDigest: run.policy.digest,
      profileDigest: run.profile.digest,
    }),
    ruleId,
    ruleVersion: run.profile.digest,
    subjectId,
    message: PROCESSING_UNAVAILABLE,
    category: 'dependency',
    severity: run.execution.mode === 'ide' ? 'warning' : 'error',
    enforcement: run.execution.mode === 'ci' ? 'blocking' : 'advisory',
    location,
    relatedLocations: [],
    edits: [],
  };
}
