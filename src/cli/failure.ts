import { ContractError } from '../base/errors.js';
import { BudgetAdmissionError } from '../runtime/request-budget.js';
import { formatEscapedError } from '../host/internal-errors.js';
import { formatSarifError } from './sarif.js';

/**
 * Marks an error thrown while validating inputs that were already loaded. Nothing of the error
 * reaches the output; it is kept as `cause` for debugging.
 */
export class ValidationFault extends Error {
  override readonly name = 'ValidationFault';
  constructor(cause: unknown) {
    super('Validation failed with an internal error.', { cause });
  }
}

/**
 * Rethrows a non-contract error raised by validation as a `ValidationFault`. A request deadline
 * that budget admission rejects is an input problem and keeps its own label.
 */
export async function duringValidation<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw error instanceof ContractError || error instanceof BudgetAdmissionError
      ? error
      : new ValidationFault(error);
  }
}

const MESSAGES = Object.freeze({
  internal_error: 'Validation failed with an internal error.',
  input: 'Validation input or trusted configuration could not be loaded.',
});

/**
 * The redacted output of a failed CLI run: a contract error keeps its code; an error raised by
 * validation is `internal_error`; anything else happened while inputs were read or parsed, or the
 * output was written, and is `input_error`.
 */
export function failureOutput(error: unknown, format: string): unknown {
  const code =
    error instanceof ContractError
      ? error.code
      : error instanceof ValidationFault
        ? 'internal_error'
        : 'input_error';
  if (format === 'sarif') return formatSarifError(code);
  return {
    contractVersion: '0.2',
    outcome: 'error',
    enforcement: 'block',
    error: {
      code,
      message: code === 'internal_error' ? MESSAGES.internal_error : MESSAGES.input,
    },
  };
}

/**
 * The standard-error line for a failed CLI run, or `undefined`: only an error that escaped
 * validation is an engine fault worth an operator line. The cause's message and stack are added
 * only with `withDetail`.
 */
export function failureLog(error: unknown, withDetail: boolean): string | undefined {
  return error instanceof ValidationFault
    ? `bve: ${formatEscapedError(error.cause, withDetail)}`
    : undefined;
}
