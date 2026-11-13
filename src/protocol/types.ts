/**
 * Wire shapes of the custom methods in `methods.ts`. They are plain structural types, so any client
 * can use them without the engine. `src/lsp` checks at compile time that the engine types it sends
 * are mutually assignable with these.
 */

/** Result of `bve/reloadConfiguration`. */
export interface ReloadConfigurationResult {
  readonly reloaded: boolean;
}

/** Parameter of `bve/recordSelection`: an accepted entity reference, at most 512 characters. */
export type RecordSelectionParams = string;

/** Parameters of `bve/searchReferences`. The server applies its own reference rules as well. */
export interface SearchReferencesParams {
  readonly kind: string;
  readonly namespace: string;
  readonly prefix: string;
}
export interface SearchReferencesRow {
  readonly reference: string;
  readonly source: string;
}
/** Result of `bve/searchReferences`. */
export type SearchReferencesResult = readonly SearchReferencesRow[];

/** Bounded latest admitted notification. Not a filesystem existence or OS-origin claim. */
export interface FilesystemObservation {
  readonly sessionGeneration: number;
  readonly generation: number;
  readonly uris: readonly string[];
  readonly truncated: boolean;
}
/** Result of `bve/filesystemObservation`. */
export type FilesystemObservationResult = FilesystemObservation | null;

/** Parameters of `bve/validationCoverage`: the exact document binding that is observed. */
export interface ValidationCoverageParams {
  readonly uri: string;
  readonly version: number;
  readonly digest: string;
}
export type CoverageStage =
  | 'identity'
  | 'bypass'
  | 'policy'
  | 'parse'
  | 'substitution'
  | 'compatibility'
  | 'admission'
  | 'overlay'
  | 'rules'
  | 'publication';
export type CoverageStatus =
  'verified' | 'unsupported' | 'unavailable' | 'blocked' | 'skipped' | 'bypassed';
export interface CoverageRow {
  readonly stage: CoverageStage;
  readonly subject: string;
  readonly required: boolean;
  readonly status: CoverageStatus;
  readonly reason?: string;
}
/** Read-only host-approved projection. It contains no catalog access or credential configuration. */
export interface CoverageObservation {
  readonly sourceDigest: string;
  readonly policyDigest: string;
  readonly profileDigest: string;
  readonly activationDigest: string;
  readonly generation: number;
  readonly dependencyGeneration: number;
  readonly documents: readonly {
    readonly uri: string;
    readonly version: number;
    readonly digest: string;
  }[];
  readonly coverage: readonly CoverageRow[];
}
/** Result of `bve/validationCoverage`. */
export type ValidationCoverageResult = CoverageObservation | null;
