import type {
  Coverage,
  Finding,
  PolicyBundle,
  RuleState,
  ValidationRequest,
} from '../../contracts/schemas.js';
import type { Clock } from '../../base/clock.js';
import type { Immutable } from '../../base/json.js';
import type {
  PolicySchemaValidator,
  SchemaValidationIssue,
} from '../../compatibility/custom-schemas.js';
import type { SourceSubstitution } from '../../compatibility/types.js';
import type { InternalErrorObserver } from '../../core/internal-errors.js';
import type { ParsedSourceDocument } from '../../parsing/types.js';
import type { CelRuntime } from '../../runtime/cel/index.js';
import type { CelErrorCode } from '../../runtime/cel/errors.js';
import type { EvaluationContext, RequestBudget } from '../../runtime/request-budget.js';
import type { CatalogBindings } from '../catalog-bindings.js';
import type { ReferenceDataPreparation } from '../reference-data.js';
import type { RuleExecutionReport, RuleSubject } from '../types.js';

export type Rule = Immutable<PolicyBundle['rules'][number]>;
export type RuleOfKind<K extends Rule['kind']> = Extract<Rule, { readonly kind: K }>;
export interface RuleFailure {
  subjectId: string;
  ruleId: string;
  code: CelErrorCode | 'unsupported_rule' | 'catalog_unavailable' | 'internal_error';
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
  /**
   * Unexpected-error observer, called after the lanes in sorted subject and rule order, at most
   * `INTERNAL_ERROR_FINDING_LIMIT` times per run. It receives the thrown value, which the report
   * never contains. An observer that throws is ignored.
   */
  readonly onInternalError?: InternalErrorObserver;
}

/** Run-level inputs shared by every lane. Lanes share no mutable state through it. */
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
}

/**
 * A failed schema finding that may receive a generated scalar fix. Fixes are assigned after the
 * lanes finish, in sorted subject order and rule order, so that the limit does not depend on the
 * order in which evaluations complete.
 */
export interface FixCandidate {
  readonly rule: Rule;
  readonly subject: RuleSubject;
  readonly finding: Finding;
  readonly issue: SchemaValidationIssue | undefined;
  readonly document: ParsedSourceDocument | undefined;
  readonly substitutions: readonly SourceSubstitution[];
}

/**
 * Work that the step after the lanes completes for one subject, in rule order: a fix candidate,
 * with the subject's failure count after its rule, or an unknown error thrown while a rule was
 * evaluated, with the subject's finding count at that point.
 */
export type DeferredWork =
  | { readonly kind: 'fix'; readonly candidate: FixCandidate; readonly failuresAt: number }
  | {
      readonly kind: 'fault';
      readonly rule: Rule;
      readonly subject: RuleSubject;
      readonly error: unknown;
      readonly findingsAt: number;
    };

/** One subject's results, before the step after the lanes. */
export interface SubjectReport extends RuleExecutionReport {
  readonly findings: Finding[];
  readonly failures: RuleFailure[];
  readonly deferred: readonly DeferredWork[];
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
  /** Findings that may receive a generated fix after the lanes finish. */
  readonly candidates: FixCandidate[];
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
