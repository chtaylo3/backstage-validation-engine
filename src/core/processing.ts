import type {
  Coverage,
  DeploymentProfile,
  Finding,
  PolicyBundle,
  ValidationRequest,
} from '../contracts/schemas.js';
import type { Immutable } from './json.js';
import { createFindingId } from './results.js';
import type { RuleSubject, RuleExecutionReport } from './cel-rules.js';

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
export function blockedProcessorRules(
  run: Immutable<ValidationRequest>,
  profile: Immutable<DeploymentProfile>,
  policy: Immutable<PolicyBundle>,
  subjects: readonly RuleSubject[],
): RuleExecutionReport {
  const ids = subjects.length ? subjects.map((subject) => subject.id) : ['processing'];
  return {
    findings: subjects.map((subject) => processingFinding(run, subject.location, subject.id)),
    coverage: [
      ...processingCoverage(profile),
      {
        stage: 'rules',
        subject: 'processing',
        required: true,
        status: 'blocked',
        reason: PROCESSING_UNAVAILABLE,
      },
    ],
    ruleStates: ids.flatMap((subjectId) =>
      policy.rules.map((rule) => ({
        ruleId: rule.id,
        subjectId,
        required: rule.mandatory,
        status: 'blocked' as const,
        reason: 'dependency_unavailable' as const,
      })),
    ),
    failures: ids.flatMap((subjectId) =>
      policy.rules.map((rule) => ({
        subjectId,
        ruleId: rule.id,
        code: 'unsupported_processor' as const,
      })),
    ),
    interrupted: 'none',
  };
}
