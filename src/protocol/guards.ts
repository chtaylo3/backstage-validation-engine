import type {
  FilesystemObservationResult,
  RecordSelectionParams,
  ReloadConfigurationResult,
  SearchReferencesParams,
  SearchReferencesResult,
  ValidationCoverageParams,
} from './types.js';

/**
 * Validation for every custom payload that crosses the wire as `unknown`. Each parameter guard
 * accepts exactly what the server accepted before the guard existed; it neither widens nor narrows
 * that check. Result guards are what a client requires before it reads a response.
 */

/** A non-null object that is not an array. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `bve/validationCoverage` parameters: an object whose `uri` and `digest` are strings and whose
 * `version` is a number. Extra members are allowed. The server answers `null`, not an error, when
 * this guard fails; versions that no open document has (negative or fractional) also answer `null`
 * because they match no document.
 */
export function isValidationCoverageParams(value: unknown): value is ValidationCoverageParams {
  return (
    isRecord(value) &&
    typeof value.uri === 'string' &&
    typeof value.version === 'number' &&
    typeof value.digest === 'string'
  );
}

/** The longest selection, in UTF-16 code units, that `bve/recordSelection` accepts. */
export const RECORD_SELECTION_MAX_LENGTH = 512;
/** `bve/recordSelection` parameter: a string of at most 512 UTF-16 code units. */
export function isRecordSelectionParams(value: unknown): value is RecordSelectionParams {
  return typeof value === 'string' && value.length <= RECORD_SELECTION_MAX_LENGTH;
}

const SEARCH_KEYS: readonly string[] = ['kind', 'namespace', 'prefix'];
/**
 * `bve/searchReferences` parameters: an object with string `kind`, `namespace` and `prefix` and no
 * other own enumerable member. The server additionally requires a valid reference prefix and kind
 * and namespace, and answers an empty list when either check fails.
 */
export function isSearchReferencesParams(value: unknown): value is SearchReferencesParams {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => SEARCH_KEYS.includes(key)) &&
    typeof value.kind === 'string' &&
    typeof value.namespace === 'string' &&
    typeof value.prefix === 'string'
  );
}

/** `bve/reloadConfiguration` result: an object with a boolean `reloaded`. */
export function isReloadConfigurationResult(value: unknown): value is ReloadConfigurationResult {
  return isRecord(value) && typeof value.reloaded === 'boolean';
}

/** `bve/searchReferences` result: an array of objects with string `reference` and `source`. */
export function isSearchReferencesResult(value: unknown): value is SearchReferencesResult {
  return (
    Array.isArray(value) &&
    value.every(
      (row: unknown) =>
        isRecord(row) && typeof row.reference === 'string' && typeof row.source === 'string',
    )
  );
}

/** `bve/filesystemObservation` result: `null` or a complete filesystem observation. */
export function isFilesystemObservationResult(
  value: unknown,
): value is FilesystemObservationResult {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.sessionGeneration === 'number' &&
      typeof value.generation === 'number' &&
      Array.isArray(value.uris) &&
      value.uris.every((uri: unknown) => typeof uri === 'string') &&
      typeof value.truncated === 'boolean')
  );
}

/**
 * `bve/validationCoverage` result envelope: `null` or an object that is not an array. It does not
 * check the members of a `CoverageObservation`, so it narrows only to that envelope. A client that
 * forwards the observation, as the VS Code extension does, needs no more; a client that reads
 * members checks them itself.
 */
export function isValidationCoverageEnvelope(
  value: unknown,
): value is Readonly<Record<string, unknown>> | null {
  return value === null || isRecord(value);
}
