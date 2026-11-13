import type { Finding, JsonValue, RuleState } from '../contracts/schemas.js';
import type { Immutable } from '../base/json.js';
import type { StageReport } from '../core/stage-report.js';
import type { CelErrorCode } from '../runtime/cel/errors.js';

export interface RuleSubject {
  readonly id: string;
  readonly value: Immutable<JsonValue>;
  readonly location: Immutable<Finding['location']>;
}

export interface RuleExecutionReport extends StageReport {
  readonly ruleStates: readonly Immutable<RuleState>[];
  readonly failures: readonly {
    readonly subjectId: string;
    readonly ruleId: string;
    readonly code:
      | CelErrorCode
      | 'unsupported_rule'
      | 'unsupported_processor'
      | 'catalog_unavailable'
      | 'internal_error';
  }[];
}
