import type { Finding } from '../contracts/schemas.js';
import type { Immutable } from '../base/json.js';

/**
 * At most this many internal-error findings are added per stage in one run. Every internal error
 * still blocks its rule or document; only the findings and observer calls are bounded.
 */
export const INTERNAL_ERROR_FINDING_LIMIT = 64;

/** What the rule stage was doing when an unexpected error was thrown. */
export type RuleActivity = 'rule_evaluation' | 'fix_generation';
/** The source stage phase that was running when an unexpected error was thrown. */
export type SourceActivity = 'substitution' | 'native' | 'references' | 'locations';

/**
 * One unexpected error, for the host's operator. `error` is the thrown value itself: it may hold
 * entity content, so it never enters a result.
 */
export type InternalErrorReport =
  | {
      readonly stage: 'rules';
      readonly activity: RuleActivity;
      readonly ruleId: string;
      readonly subjectId: string;
      readonly location: Immutable<Finding['location']>;
      readonly error: unknown;
    }
  | {
      readonly stage: 'sources';
      readonly phase: SourceActivity;
      readonly uri: string;
      readonly document: number;
      readonly error: unknown;
    };
export type InternalErrorObserver = (report: InternalErrorReport) => void;

/** Calls the observer; an observer that throws cannot change the result. */
export function notifyInternalError(
  observer: InternalErrorObserver | undefined,
  report: InternalErrorReport,
): void {
  try {
    observer?.(report);
  } catch {
    // Telemetry must not change the result or its enforcement.
  }
}

/**
 * The type name of a thrown value, the only part of it that a result may carry. A name that is
 * not a plain identifier is replaced, because a name can be set to arbitrary text.
 */
export function internalErrorType(error: unknown): string {
  try {
    if (error instanceof Error)
      return /^[A-Za-z_$][\w$]{0,63}$/u.test(error.name) ? error.name : 'Error';
  } catch {
    return 'Error';
  }
  return `non-Error ${error === null ? 'null' : typeof error}`;
}
