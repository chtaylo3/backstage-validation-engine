import type { Immutable } from '../base/json.js';
import type { ValidationResult } from '../contracts/schemas.js';
import type { CoverageObservation as WireCoverageObservation } from '../protocol/index.js';
import type { MutuallyAssignable } from '../base/types.js';

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

/** Bounded latest admitted notification. It has no engine counterpart, so the wire type is used as is. */
export type { FilesystemObservation } from '../protocol/index.js';

// Compile-time check that the engine-derived observation and the protocol wire shape agree.
const coverageMatchesProtocol: MutuallyAssignable<CoverageObservation, WireCoverageObservation> =
  true;
void coverageMatchesProtocol;
