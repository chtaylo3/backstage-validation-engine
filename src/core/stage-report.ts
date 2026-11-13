import type { Coverage, Finding, ValidationResult } from '../contracts/schemas.js';
import { reject } from '../base/errors.js';
import { canonicalJson } from '../base/json.js';
import type { Immutable } from '../base/json.js';

/** Why a stage stopped before completing its work. */
export type Interruption = ValidationResult['resources']['interrupted'];

/** The one ranking of interruptions. A merged report keeps the highest-ranked one. */
export const INTERRUPTION_PRIORITY: Readonly<Record<Interruption, number>> = Object.freeze({
  none: 0,
  resource_limit: 1,
  worker_failure: 2,
  cancelled: 3,
  timeout: 4,
});

/** Returns the higher-priority interruption; on a tie the current value is kept. */
export function mergeInterruption(current: Interruption, next: Interruption): Interruption {
  return INTERRUPTION_PRIORITY[next] > INTERRUPTION_PRIORITY[current] ? next : current;
}

/** What every pipeline stage reports: ordered findings, ordered coverage, and its interruption. */
export interface StageReport {
  readonly findings: readonly Immutable<Finding>[];
  readonly coverage: readonly Immutable<Coverage>[];
  readonly interrupted: Interruption;
}

/**
 * Keeps one coverage row per `[stage, subject]` in first-seen order. Stages may repeat an
 * identical observation (both gates report a required unavailable processor); a duplicate that
 * disagrees rejects with `integrity` instead of hiding the disagreement.
 */
export function mergeCoverage(rows: Iterable<Immutable<Coverage>>): Immutable<Coverage>[] {
  const coverage = new Map<string, Immutable<Coverage>>();
  for (const row of rows) {
    const key = JSON.stringify([row.stage, row.subject]);
    const previous = coverage.get(key);
    if (previous && canonicalJson(previous) !== canonicalJson(row))
      reject('integrity', '/coverage', 'pipeline stages reported conflicting coverage');
    coverage.set(key, row);
  }
  return [...coverage.values()];
}
