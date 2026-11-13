import { internalErrorType } from '../core/internal-errors.js';
import type { InternalErrorReport } from '../core/internal-errors.js';

/** The environment switch that adds a contained error's message and stack to the host's log. */
export const INTERNAL_ERROR_DETAIL_VARIABLE = 'BVE_INTERNAL_ERROR_DETAIL';

export function internalErrorDetail(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[INTERNAL_ERROR_DETAIL_VARIABLE] === '1';
}

function detail(error: unknown): string {
  try {
    if (error instanceof Error)
      return ` message=${JSON.stringify(String(error.message))} stack=${JSON.stringify(String(error.stack))}`;
    return ` value=${JSON.stringify(String(error))}`;
  } catch {
    return ' detail=unavailable';
  }
}

/**
 * One log line for an internal error that a stage contained: the code `internal_error`, what was
 * running, the rule, the source URI and document, and the error's type name. Strings are quoted,
 * so that a value cannot start a new line. With `withDetail` it adds the error's message and
 * stack, which can contain entity content and therefore appear only on the operator's request.
 */
export function formatInternalError(report: InternalErrorReport, withDetail = false): string {
  const fields =
    report.stage === 'rules'
      ? [
          `activity=${report.activity}`,
          `rule=${JSON.stringify(report.ruleId)}`,
          `source=${JSON.stringify(report.location.uri)}`,
          `document=${report.location.document}`,
        ]
      : [
          `phase=${report.phase}`,
          `source=${JSON.stringify(report.uri)}`,
          `document=${report.document}`,
        ];
  return [
    'internal_error',
    `stage=${report.stage}`,
    ...fields,
    `type=${JSON.stringify(internalErrorType(report.error))}`,
  ]
    .join(' ')
    .concat(withDetail ? detail(report.error) : '');
}

/**
 * One log line for an unexpected error that escaped validation; the run's result is redacted and
 * labelled `internal_error`. Same format and detail switch as `formatInternalError`.
 */
export function formatEscapedError(error: unknown, withDetail = false): string {
  return `internal_error stage=validation type=${JSON.stringify(internalErrorType(error))}`.concat(
    withDetail ? detail(error) : '',
  );
}
