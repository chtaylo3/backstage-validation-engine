import type {
  DeploymentProfile,
  Finding,
  JsonValue,
  ValidationResult,
} from '../contracts/schemas.js';
import type { Immutable } from '../base/json.js';
import type { ParsedSourceDocument } from '../parsing/types.js';

export { BUILTIN_KINDS } from '../contracts/kinds.js';

export const BACKSTAGE_ADAPTER_IDS = Object.freeze([
  '@backstage/catalog-model@1.10.2',
  '@backstage/catalog-model@1.7.5',
] as const);
export type BackstageAdapterId = (typeof BACKSTAGE_ADAPTER_IDS)[number];
export type NativePolicyName =
  | 'schema'
  | 'default_namespace'
  | 'field_format'
  | 'no_foreign_root_fields'
  | 'group_default_parent';
export type NativeStage = 'envelope' | 'kind' | NativePolicyName;
export interface NativeIssue {
  readonly code:
    | 'invalid_envelope'
    | 'invalid_kind'
    | 'invalid_policy_value'
    | 'unsupported_kind'
    | 'unsupported_api_version';
  readonly stage: NativeStage;
  readonly path: string;
}

export interface NormalizationChange {
  readonly path: string;
  readonly policy: NativePolicyName;
  readonly before?: Immutable<JsonValue>;
  readonly after?: Immutable<JsonValue>;
}

export interface NativeEntityCheck {
  readonly status: 'valid' | 'invalid' | 'unsupported';
  readonly authored: Immutable<JsonValue>;
  readonly normalized: Immutable<JsonValue>;
  readonly entityRef?: string;
  readonly issues: readonly NativeIssue[];
  readonly changes: readonly NormalizationChange[];
}

export interface NativeExecutionContext {
  readonly deadlineAt: number;
  readonly signal?: AbortSignal;
}
export interface BackstageAdapter {
  readonly id: BackstageAdapterId;
  readonly kinds: readonly string[];
  /** Native reference parsing only; field-specific source contexts are supplied by the caller. */
  resolveReference(
    reference: string,
    context?: { readonly defaultKind?: string; readonly defaultNamespace?: string },
  ): {
    readonly kind: string;
    readonly namespace: string;
    readonly name: string;
    readonly entityRef: string;
  };
  /** Native envelope only, accepting catalog data for custom kinds without applying ingestion policies. */
  entityReference(value: Immutable<JsonValue>): string;
  validateSettings(settings: Immutable<DeploymentProfile['nativePolicies']>): void;
  /** Native envelope and configured policies, before kind/admission decisions. */
  normalizeEntity(
    value: Immutable<JsonValue>,
    settings: Immutable<DeploymentProfile['nativePolicies']>,
    context: NativeExecutionContext,
  ): Promise<NativeEntityCheck>;
  /** Stock kind check of a normalized envelope, without repeating configured policies. */
  validateKind(
    value: Immutable<JsonValue>,
    context: NativeExecutionContext,
  ): Promise<NativeEntityCheck>;
  /** Native Entity schema and stock kind checks, without configured policies. */
  checkEntity(
    value: Immutable<JsonValue>,
    context: NativeExecutionContext,
  ): Promise<NativeEntityCheck>;
  validate(
    value: Immutable<JsonValue>,
    settings: Immutable<DeploymentProfile['nativePolicies']>,
    context: NativeExecutionContext,
  ): Promise<NativeEntityCheck>;
}

export interface CompatibleSourceEntity {
  readonly document: ParsedSourceDocument;
  readonly entityRef: string;
  readonly authored: Immutable<JsonValue>;
  readonly resolved: Immutable<JsonValue>;
  readonly substitutions: readonly SourceSubstitution[];
  readonly normalized: Immutable<JsonValue>;
  readonly customSchema?: Immutable<DeploymentProfile['customKinds'][number]['schema']>;
  readonly changes: readonly (NormalizationChange & {
    readonly origin: Immutable<Finding['location']>;
  })[];
}

export interface BackstageCompatibilityReport {
  readonly adapterId: BackstageAdapterId;
  readonly sourceDigest: string;
  readonly profileDigest: string;
  readonly entities: readonly CompatibleSourceEntity[];
  readonly references: readonly BackstageSourceReference[];
  readonly sourceClaims: readonly SourceIdentityClaim[];
  /** Some proposed sources cannot yet be assigned a safe canonical identity. */
  readonly unresolvedSourceIdentities: boolean;
  readonly findings: readonly Immutable<Finding>[];
  readonly coverage: readonly Immutable<ValidationResult['coverage'][number]>[];
  readonly artifacts: Immutable<ValidationResult['artifacts']>;
  readonly interrupted: ValidationResult['resources']['interrupted'];
}

export interface BackstageSourceReference {
  readonly entityPath: string;
  readonly sourceEntityRef: string;
  readonly targetRef: string;
  readonly value: string;
  readonly contextPath: string;
  readonly sourceDigest: string;
  readonly version?: number;
  readonly location: Immutable<Finding['location']>;
  readonly relatedLocations: readonly Immutable<Finding['location']>[];
}

export interface SourceSubstitution {
  readonly path: string;
  readonly kind: '$text' | '$json' | '$yaml';
  readonly origin: Immutable<Finding['location']>;
  readonly target: {
    readonly uri: string;
    readonly sourceDigest: string;
    readonly version?: number;
  };
}

export interface SourceIdentityClaim {
  readonly uri: string;
  readonly document: number;
  readonly entityRef?: string;
  readonly location: Immutable<Finding['location']>;
  readonly relatedLocations: readonly Immutable<Finding['location']>[];
}

export class BackstageRuntimeError extends Error {
  override readonly name = 'BackstageRuntimeError';
  constructor(readonly code: 'resource_limit' | 'adapter_unavailable') {
    super(
      code === 'resource_limit'
        ? 'Native validation exceeds profile resource limits.'
        : 'Pinned native adapter is unavailable.',
    );
  }
}
