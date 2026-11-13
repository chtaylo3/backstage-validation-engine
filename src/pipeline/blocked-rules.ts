import type { DeploymentProfile, PolicyBundle, ValidationRequest } from '../contracts/schemas.js';
import type { Immutable } from '../base/json.js';
import {
  PROCESSING_UNAVAILABLE,
  processingCoverage,
  processingFinding,
} from '../core/processing.js';
import type { RuleExecutionReport, RuleSubject } from './types.js';

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
