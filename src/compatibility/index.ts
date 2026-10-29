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
  BackstageCompatibilityReport,
} from './types.js';
