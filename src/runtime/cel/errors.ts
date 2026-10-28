export const CEL_ERROR_MESSAGES = Object.freeze({
  input_limit: 'CEL input exceeds the profile resource limits.',
  input_type: 'CEL input must contain only supported JSON values.',
  parse: 'CEL compilation failed.',
  profile: 'Expression is outside the supported CEL profile.',
  regex: 'Invalid or unsupported RE2 pattern.',
  regex_limit: 'CEL pattern exceeds the profile resource limit.',
  evaluation: 'CEL expression could not be evaluated.',
  result_type: 'CEL selectors and rules must return boolean.',
  execution_timeout: 'CEL execution deadline exceeded.',
  request_timeout: 'Validation request deadline exceeded.',
  cancelled: 'CEL evaluation cancelled.',
  queue_limit: 'CEL queue is full.',
  queue_timeout: 'CEL queue deadline exceeded.',
  worker_start: 'CEL worker failed to start.',
  worker_failure: 'CEL worker failed.',
  protocol: 'Invalid CEL worker response.',
  closed: 'CEL runtime is closed.',
});

export type CelErrorCode = keyof typeof CEL_ERROR_MESSAGES;

/** Safe across trust boundaries: never includes expression or entity contents. */
export class CelError extends Error {
  override readonly name = 'CelError';

  constructor(readonly code: CelErrorCode) {
    super(CEL_ERROR_MESSAGES[code]);
  }
}

export function isCelErrorCode(value: unknown): value is CelErrorCode {
  return typeof value === 'string' && Object.hasOwn(CEL_ERROR_MESSAGES, value);
}

export function cancellationError(signal: AbortSignal): CelError {
  return signal.reason instanceof CelError && signal.reason.code === 'request_timeout'
    ? signal.reason
    : new CelError('cancelled');
}
