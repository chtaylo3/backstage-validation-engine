import type { Finding, ValidationRequest, ValidationResult } from '../contracts/schemas.js';
import { CONTRACT_VERSION } from '../contracts/schemas.js';
import { parseContract } from '../contracts/validate.js';
import { digestJson } from './json.js';
import type { Immutable } from './json.js';
import { decideOutcome } from './outcomes.js';

export interface FindingIdentity {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly subjectId: string;
  readonly path: string;
  readonly policyDigest: string;
  readonly profileDigest: string;
}

/** Messages, coordinates and document versions deliberately do not affect identity. */
export function createFindingId(identity: FindingIdentity): string {
  return digestJson({
    contractVersion: CONTRACT_VERSION,
    ruleId: identity.ruleId,
    ruleVersion: identity.ruleVersion,
    subjectId: identity.subjectId,
    path: identity.path,
    policyDigest: identity.policyDigest,
    profileDigest: identity.profileDigest,
  });
}

export interface ResultInput {
  readonly request: Immutable<ValidationRequest>;
  readonly coverage: Immutable<ValidationResult['coverage']>;
  readonly findings?: readonly Immutable<Finding>[];
  readonly artifacts?: Immutable<ValidationResult['artifacts']>;
  readonly ruleStates?: Immutable<ValidationResult['ruleStates']>;
  /** Must come from a trusted verifier. A receipt shape is not proof of authority. */
  readonly bypass?: Immutable<NonNullable<ValidationResult['bypass']>>;
  readonly completedAt: number;
  readonly authorityCheckedAt: number;
  readonly interrupted?: ValidationResult['resources']['interrupted'];
}

/** Aggregates execution evidence; it does not execute checks or authorize bypasses. */
export function createValidationResult(input: ResultInput): Immutable<ValidationResult> {
  const request = parseContract('validation-request', input.request);
  const ruleStates = input.ruleStates ?? [];
  const findings = input.findings ?? [];
  const interrupted =
    input.interrupted && input.interrupted !== 'none'
      ? input.interrupted
      : input.completedAt >= request.execution.deadlineAt
        ? 'timeout'
        : 'none';
  const decision = decideOutcome({
    mode: request.execution.mode,
    coverage: input.coverage,
    findings,
    ruleStates,
    interrupted,
    ...(input.bypass ? { bypass: input.bypass } : {}),
  });
  const publishBefore = Math.min(
    input.authorityCheckedAt + 60_000,
    input.bypass?.expiresAt ?? Number.MAX_SAFE_INTEGER,
    ...request.data.entries.map((entry) => entry.provenance.expiresAt),
  );
  return parseContract('validation-result', {
    contractVersion: CONTRACT_VERSION,
    run: request.run,
    mode: request.execution.mode,
    provenance: {
      sourceDigest: request.source.digest,
      ...(request.baseline ? { baselineDigest: request.baseline.digest } : {}),
      policyDigest: request.policy.digest,
      profileDigest: request.profile.digest,
      activationDigest: request.activation.digest,
      dataDigest: request.data.digest,
      installationId: request.identity.installationId,
      repositoryId: request.identity.repositoryId,
    },
    ...decision,
    coverage: input.coverage,
    findings,
    artifacts: input.artifacts ?? [],
    ruleStates,
    ...(input.bypass ? { bypass: input.bypass } : {}),
    resources: {
      startedAt: request.execution.startedAt,
      completedAt: input.completedAt,
      deadlineAt: request.execution.deadlineAt,
      interrupted,
    },
    freshness: {
      evaluatedAt: input.completedAt,
      authorityCheckedAt: input.authorityCheckedAt,
      publishBefore,
    },
  });
}

export function resultExitCode(result: Immutable<ValidationResult>): 0 | 1 | 2 {
  const verified = parseContract('validation-result', result);
  if (verified.outcome === 'error' || verified.outcome === 'incomplete') return 2;
  if (verified.enforcement === 'block') return 1;
  return 0;
}
