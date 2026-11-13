import type { RuleState } from '../../contracts/schemas.js';
import type { Interruption } from '../../core/stage-report.js';
import type { CelErrorCode } from '../../runtime/cel/errors.js';

export type StateFailure = Pick<RuleState, 'status' | 'reason'>;

/** The interruption that a failed rule state contributes to its subject report. */
export function stateInterruption(reason: RuleState['reason']): Interruption {
  if (reason === 'timeout') return 'timeout';
  if (reason === 'cancelled') return 'cancelled';
  if (reason === 'worker_failure') return 'worker_failure';
  if (reason === 'resource_limit' || reason === 'queue_exhausted') return 'resource_limit';
  return 'none';
}

/** The rule state that a CEL failure code produces. */
export function failureState(code: CelErrorCode): StateFailure {
  switch (code) {
    case 'parse':
    case 'profile':
    case 'regex':
    case 'result_type':
      return { status: 'invalid_policy', reason: 'invalid_expression' };
    case 'evaluation':
    case 'input_type':
      return { status: 'error' };
    case 'input_limit':
    case 'regex_limit':
      return { status: 'incomplete', reason: 'resource_limit' };
    case 'queue_limit':
      return { status: 'incomplete', reason: 'queue_exhausted' };
    case 'cancelled':
      return { status: 'incomplete', reason: 'cancelled' };
    case 'queue_timeout':
    case 'request_timeout':
    case 'execution_timeout':
      return { status: 'incomplete', reason: 'timeout' };
    case 'worker_start':
    case 'worker_failure':
    case 'protocol':
    case 'closed':
      return { status: 'incomplete', reason: 'worker_failure' };
  }
}
