import type { Coverage } from '../contracts/schemas.js';
import type { validatePolicySources } from '../core/policy-sources.js';
import { verifyRequestBindings } from '../core/bindings.js';
import { canonicalJson } from '../core/json.js';
import { reject } from '../core/errors.js';
import { createValidationResult } from '../core/results.js';
import type { verifyPolicyRelease } from './releases.js';

/** Bind execution evidence to a verified release and narrow publication to its validity window. */
export function createVerifiedPolicyResult(
  report: Awaited<ReturnType<typeof validatePolicySources>>,
  context: ReturnType<typeof verifyPolicyRelease>,
  completedAt = Date.now(),
) {
  verifyRequestBindings(report.request, context);
  if (canonicalJson(report.request.identity) !== canonicalJson(context.identity))
    reject('integrity', '/identity', 'request identity differs from verified host trust');
  const coverage: Coverage = {
    stage: 'policy',
    subject: 'signed-release',
    required: true,
    status: completedAt < context.verification.expiresAt ? 'verified' : 'blocked',
    ...(completedAt < context.verification.expiresAt
      ? {}
      : { reason: 'The verified policy release expired during execution.' }),
  };
  return createValidationResult({
    request: report.request,
    coverage: [...report.coverage, coverage],
    findings: report.findings,
    artifacts: report.compatibility.artifacts,
    ruleStates: report.ruleStates,
    interrupted: report.interrupted,
    completedAt,
    authorityCheckedAt: context.verification.verifiedAt,
    authorityExpiresAt: context.verification.expiresAt,
  });
}
