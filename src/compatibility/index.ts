export { loadBackstageAdapter } from './adapter.js';
export { validateBackstageSources } from './sources.js';
export { BACKSTAGE_ADAPTER_IDS, BUILTIN_KINDS, BackstageRuntimeError } from './types.js';
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
} from './types.js';
export { REFERENCE_LIMITS } from '../policy/reference-contexts.js';
