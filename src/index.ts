// base: errors, canonical JSON, and the clock.
export { ContractError } from './base/errors.js';
export type { ContractIssue } from './base/errors.js';
export { canonicalJson, digestJson, digestText, immutableJson } from './base/json.js';
export type { Immutable, JsonLimits } from './base/json.js';
export { systemClock } from './base/clock.js';
export type { Clock } from './base/clock.js';

// contracts: the versioned wire schemas, contract parsing, and rule ordering.
export {
  CONTRACT_VERSION,
  SCHEMA_DIALECT,
  JsonValueSchema,
  SchemaArtifactSchema,
  SourceSnapshotSchema,
  DataSnapshotSchema,
  ResourceLimitsSchema,
  DeploymentProfileSchema,
  PolicyBundleSchema,
  ActivationManifestSchema,
  ValidationRequestSchema,
  PolicyTrustSchema,
  PolicyReleaseSchema,
  CoverageSchema,
  RuleStateSchema,
  BypassReceiptSchema,
  ValidationResultSchema,
  contractSchemas,
  parseContract,
} from './contracts/index.js';
export type {
  ContractTypes,
  JsonValue,
  SourceSnapshot,
  SchemaArtifact,
  SourceFile,
  SourceChange,
  DataSnapshot,
  DataEntry,
  DeploymentProfile,
  PolicyBundle,
  ActivationManifest,
  PolicyTrust,
  PolicyRelease,
  ValidationRequest,
  Coverage,
  Finding,
  RuleState,
  BypassReceipt,
  ValidationResult,
} from './contracts/index.js';
export { orderRules } from './contracts/rule-graph.js';

// core: snapshots, results, processors, and request bindings.
export {
  createSourceSnapshot,
  createDataSnapshot,
  overlaySourceSnapshot,
} from './core/snapshots.js';
export type { SourceInput } from './core/snapshots.js';
export { createFindingId, createValidationResult, resultExitCode } from './core/results.js';
export type { FindingIdentity, ResultInput } from './core/results.js';
export { SUPPORTED_DEPLOYMENT_PROCESSORS } from './core/processing.js';
export { verifyRequestBindings } from './core/bindings.js';

// runtime: the CEL runtime, request budgets, and failure evidence.
export {
  getSharedCelRuntime,
  closeSharedCelRuntime,
  CEL_LIMITS,
  CEL_PROFILE,
  CelError,
} from './runtime/cel/index.js';
export type { CelRuntime, CelRuntimeStats, CelErrorCode } from './runtime/cel/index.js';
export { RequestBudget, BudgetAdmissionError } from './runtime/request-budget.js';
export type { EvaluationContext } from './runtime/request-budget.js';
export type { FailureEvidence, FailureCause, FailureStage } from './runtime/failure-evidence.js';

// parsing: source-preserving YAML parsing and source locations.
export {
  parseSourceSnapshot,
  parsingFindings,
  locateParsedPath,
  SourceLineIndex,
  PARSING_LIMITS,
} from './parsing/index.js';
export type {
  ParsingLimits,
  ParsingOptions,
  ParsingReport,
  ParseDiagnostic,
  ParseCode,
  ParsedSourceDocument,
  ParsedSourceFile,
  NodeSourceSpan,
  SourceLocation,
  SourceRange,
} from './parsing/index.js';

// compatibility: the pinned Backstage adapter and native validation.
export {
  loadBackstageAdapter,
  validateBackstageSources,
  BACKSTAGE_ADAPTER_IDS,
  BUILTIN_KINDS,
  BackstageRuntimeError,
  REFERENCE_LIMITS,
  CUSTOM_SCHEMA_LIMITS,
} from './compatibility/index.js';
export type {
  BackstageAdapterId,
  BackstageAdapter,
  NativeExecutionContext,
  NativeStage,
  NativePolicyName,
  NativeIssue,
  NativeEntityCheck,
  NormalizationChange,
  CompatibleSourceEntity,
  BackstageSourceReference,
  SourceIdentityClaim,
  SourceSubstitution,
  BackstageCompatibilityReport,
} from './compatibility/index.js';

// policy: deployment profiles, policy bundles, and signed releases.
export { DEFAULT_DEPLOYMENT_PROFILE } from './policy/profile.js';
export { resolvePolicyBundles, POLICY_BUNDLE_LIMITS } from './policy/bundles.js';
export { verifyPolicyRelease, signPolicyRelease } from './policy/releases.js';
export type { PolicyReleasePayload } from './policy/releases.js';

// providers: the read-only catalog provider.
export {
  createCatalogProvider,
  catalogEntityKey,
  CATALOG_LIMITS,
  CATALOG_SUGGESTION_LIMITS,
  CatalogProviderError,
} from './providers/index.js';
export type {
  CatalogProvider,
  CatalogProviderOptions,
  CatalogAccessContext,
  CatalogCredentials,
  CatalogLimits,
  CatalogLimitOptions,
  CatalogExecutionContext,
  CatalogFailureCode,
  CatalogLookupReport,
  CatalogSuggestionQuery,
  CatalogSuggestionReport,
} from './providers/index.js';

// pipeline: rule execution, policy sources, reference data, and verified results.
export { executeCelRules, executePolicyRules } from './pipeline/cel-rules.js';
export type { RuleSubject, RuleExecutionReport } from './pipeline/cel-rules.js';
export { validatePolicySources } from './pipeline/policy-sources.js';
export type { PolicySourceContext } from './pipeline/policy-sources.js';
export { prepareBackstageReferenceData } from './pipeline/reference-data.js';
export type {
  ReferenceDataPreparation,
  BackstageReferenceObservation,
  ReferenceBlockReason,
} from './pipeline/reference-data.js';
export {
  proposedCatalogEntityKey,
  PROPOSED_CATALOG_PROVIDER,
} from './pipeline/proposed-catalog.js';
export { createVerifiedPolicyResult } from './pipeline/verified-result.js';

// reporting: SARIF output.
export { formatSarif, formatSarifError } from './reporting/sarif.js';
