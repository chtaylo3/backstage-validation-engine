import { systemClock } from '../base/clock.js';
import type { Clock } from '../base/clock.js';
import { ContractError } from '../base/errors.js';
import { CelError } from './cel/errors.js';
import { BudgetAdmissionError } from './request-budget.js';

const STAGES = [
  'buffer',
  'filesystem',
  'bindings',
  'sources',
  'rules',
  'validation',
  'catalog_admission',
  'catalog_credentials',
  'catalog_transport',
  'catalog_response',
  'catalog_freshness',
  'catalog_snapshot',
] as const;
const CAUSES = [
  'invalid_deadline',
  'deadline_out_of_range',
  'request_timeout',
  'attempt_timeout',
  'cancelled',
  'resource_limit',
  'worker_failure',
  'buffer_unavailable',
  'snapshot_unavailable',
  'source_changed',
  'invalid_json',
  'invalid_contract',
  'integrity',
  'invalid_policy',
  'rule_failure',
  'permission_denied',
  'credential_binding',
  'offline',
  'provider_error',
  'rate_limited',
  'invalid_response',
  'queue_limit',
  'future_observation',
  'observation_expired',
  'aggregate_limit',
  'unknown',
] as const;
export type FailureStage = (typeof STAGES)[number];
export type FailureCause = (typeof CAUSES)[number];

/** Fixed enums and bounded timing only. Never include rejected values or exception messages. */
export interface FailureEvidence {
  readonly stage: FailureStage;
  readonly cause: FailureCause;
  readonly elapsedMs: number;
  readonly wallElapsedMs: number;
  readonly deadlineRemainingMs?: number;
}
export const FAILURE_EVIDENCE_LIMIT = 64;
const bounded = (value: number, minimum = -60_000, maximum = 60_000) =>
  Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.trunc(value))) : minimum;

/** Elapsed time from construction: monotonic for `elapsedMs`, wall for the deadline comparison. */
export class FailureTimer {
  private readonly monotonic: number;
  private readonly wall: number;
  constructor(private readonly clock: Clock = systemClock) {
    this.monotonic = clock.monotonic();
    this.wall = clock.wall();
  }

  capture(stage: FailureStage, cause: FailureCause, deadlineAt?: number): FailureEvidence {
    const wall = this.clock.wall();
    return Object.freeze({
      stage,
      cause,
      elapsedMs: bounded(this.clock.monotonic() - this.monotonic, 0),
      wallElapsedMs: bounded(wall - this.wall),
      ...(deadlineAt === undefined ? {} : { deadlineRemainingMs: bounded(deadlineAt - wall) }),
    });
  }
}

export function failureCause(error: unknown): FailureCause {
  if (error instanceof BudgetAdmissionError) return error.reason;
  if (error instanceof ContractError) return error.code === 'limit' ? 'resource_limit' : error.code;
  if (error instanceof CelError) {
    switch (error.code) {
      case 'request_timeout':
      case 'queue_timeout':
        return 'request_timeout';
      case 'execution_timeout':
        return 'attempt_timeout';
      case 'cancelled':
        return 'cancelled';
      case 'input_limit':
      case 'regex_limit':
      case 'queue_limit':
        return 'resource_limit';
      case 'worker_start':
      case 'worker_failure':
      case 'protocol':
      case 'closed':
        return 'worker_failure';
      case 'parse':
      case 'profile':
      case 'regex':
      case 'result_type':
        return 'invalid_policy';
      case 'evaluation':
      case 'input_type':
        return 'rule_failure';
    }
  }
  return 'unknown';
}

/** Copy an allowlisted shape before external publication, including trusted adapter extensions. */
export function sanitizeFailureEvidence(input: unknown): FailureEvidence | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const row = input as Partial<FailureEvidence>;
  if (
    !STAGES.includes(row.stage as FailureStage) ||
    !CAUSES.includes(row.cause as FailureCause) ||
    typeof row.elapsedMs !== 'number' ||
    !Number.isFinite(row.elapsedMs) ||
    typeof row.wallElapsedMs !== 'number' ||
    !Number.isFinite(row.wallElapsedMs) ||
    (row.deadlineRemainingMs !== undefined &&
      (typeof row.deadlineRemainingMs !== 'number' || !Number.isFinite(row.deadlineRemainingMs)))
  )
    return undefined;
  return Object.freeze({
    stage: row.stage!,
    cause: row.cause!,
    elapsedMs: bounded(row.elapsedMs, 0),
    wallElapsedMs: bounded(row.wallElapsedMs),
    ...(row.deadlineRemainingMs === undefined
      ? {}
      : { deadlineRemainingMs: bounded(row.deadlineRemainingMs) }),
  });
}
