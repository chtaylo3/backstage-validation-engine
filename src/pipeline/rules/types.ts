import type {
  Coverage,
  Finding,
  PolicyBundle,
  RuleState,
  ValidationRequest,
} from '../../contracts/schemas.js';
import type { Clock } from '../../base/clock.js';
import type { Immutable } from '../../base/json.js';
import type { PolicySchemaValidator } from '../../compatibility/custom-schemas.js';
import type { SourceSubstitution } from '../../compatibility/types.js';
import type { SourceLineIndex } from '../../parsing/locations.js';
import type { ParsedSourceDocument } from '../../parsing/types.js';
import type { CelRuntime } from '../../runtime/cel/index.js';
import type { CelErrorCode } from '../../runtime/cel/errors.js';
import type { EvaluationContext, RequestBudget } from '../../runtime/request-budget.js';
import type { CatalogBindings } from '../catalog-bindings.js';
import type { ReferenceDataPreparation } from '../reference-data.js';
import type { RuleSubject } from '../types.js';

export type Rule = Immutable<PolicyBundle['rules'][number]>;
export type RuleOfKind<K extends Rule['kind']> = Extract<Rule, { readonly kind: K }>;
export interface RuleFailure {
  subjectId: string;
  ruleId: string;
  code: CelErrorCode | 'unsupported_rule' | 'catalog_unavailable';
}

export interface RuleExecutionOptions {
  readonly signal?: AbortSignal;
  readonly runtime?: CelRuntime;
  /** Reads the rule stage's deadline and catalog fact expiry. CEL workers keep real time. */
  readonly clock?: Clock;
  readonly referenceData?: ReferenceDataPreparation;
  readonly sourceDocuments?: readonly ParsedSourceDocument[];
  readonly sourceSubstitutions?: readonly {
    readonly subjectId: string;
    readonly substitutions: readonly SourceSubstitution[];
  }[];
}

/**
 * Run-level inputs shared by every lane. Only `fixes` is mutable: all lanes draw generated scalar
 * fixes from one budget and share one line index per source file.
 */
export interface RuleRunContext {
  readonly run: Immutable<ValidationRequest>;
  /** The run's budget. Its `clock` decides the deadline and catalog fact expiry. */
  readonly budget: RequestBudget;
  readonly runtime: CelRuntime;
  readonly evaluation: EvaluationContext;
  readonly schemaValidators: ReadonlyMap<string, PolicySchemaValidator | undefined>;
  readonly documents: ReadonlyMap<string, ParsedSourceDocument>;
  readonly substitutions: ReadonlyMap<string, readonly SourceSubstitution[]>;
  readonly catalogBindings: CatalogBindings;
  readonly fixes: { generated: number; readonly indexes: Map<string, SourceLineIndex> };
}

/**
 * The result of one rule for one subject. An evaluator records its state change, coverage change,
 * findings and failures here in place, so that whatever it recorded before an interruption is
 * thrown stays visible to the caller's failure mapping.
 */
export interface RuleRecord {
  readonly state: RuleState;
  readonly coverage: Coverage;
  readonly findings: Finding[];
  readonly failures: RuleFailure[];
}

/**
 * Evaluates one rule kind for a subject whose selector already applies. A synchronous evaluator
 * returns nothing, so that lanes do not yield where the unsplit loop did not.
 */
export type RuleEvaluator<R extends Rule = Rule> = (
  context: RuleRunContext,
  rule: R,
  subject: RuleSubject,
  record: RuleRecord,
) => Promise<void> | undefined;
export type RuleEvaluators = { readonly [K in Rule['kind']]: RuleEvaluator<RuleOfKind<K>> };
