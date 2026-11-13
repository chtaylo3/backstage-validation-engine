import type { Immutable } from '../base/json.js';
import type { ValidationResult } from '../contracts/schemas.js';

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
  readonly coverage: Immutable<ValidationResult['coverage']>;
}

/** Bounded latest admitted notification. Not a filesystem existence or OS-origin claim. */
export interface FilesystemObservation {
  readonly sessionGeneration: number;
  readonly generation: number;
  readonly uris: readonly string[];
  readonly truncated: boolean;
}
