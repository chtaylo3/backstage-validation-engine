import type {
  Coverage,
  Finding,
  JsonValue,
  RuleState,
  ValidationResult,
} from '../contracts/schemas.js';
import type { Immutable } from '../base/json.js';
import type { CelErrorCode } from '../runtime/cel/errors.js';

export interface RuleSubject {
  readonly id: string;
  readonly value: Immutable<JsonValue>;
  readonly location: Immutable<Finding['location']>;
}

export interface RuleExecutionReport {
  readonly findings: readonly Immutable<Finding>[];
  readonly coverage: readonly Immutable<Coverage>[];
  readonly ruleStates: readonly Immutable<RuleState>[];
  readonly failures: readonly {
    readonly subjectId: string;
    readonly ruleId: string;
    readonly code:
      CelErrorCode | 'unsupported_rule' | 'unsupported_processor' | 'catalog_unavailable';
  }[];
  readonly interrupted: ValidationResult['resources']['interrupted'];
}
