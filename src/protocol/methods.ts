/**
 * The custom JSON-RPC methods that the language server and its clients exchange. The names are
 * wire identifiers: renaming one breaks every installed client.
 */
export const BVE_METHODS = Object.freeze({
  /** Client to server request. No parameters; the result is `ReloadConfigurationResult`. */
  reloadConfiguration: 'bve/reloadConfiguration',
  /** Client to server notification. The parameter is `RecordSelectionParams`. */
  recordSelection: 'bve/recordSelection',
  /**
   * Client to server request: `SearchReferencesParams` to `SearchReferencesResult`. A search that
   * a source change or a configuration reload overtook is refused with the LSP `ContentModified`
   * error (-32801), and the client may ask again.
   */
  searchReferences: 'bve/searchReferences',
  /** Client to server request. No parameters; the result is `FilesystemObservationResult`. */
  filesystemObservation: 'bve/filesystemObservation',
  /** Client to server request: `ValidationCoverageParams` to `ValidationCoverageResult`. */
  validationCoverage: 'bve/validationCoverage',
  /** Server to client notification without parameters, sent after a configuration reload. */
  configurationReloaded: 'bve/configurationReloaded',
} as const);

export type BveMethodName = keyof typeof BVE_METHODS;
export type BveMethod = (typeof BVE_METHODS)[BveMethodName];

export interface BveMethodShape {
  readonly direction: 'clientToServer' | 'serverToClient';
  readonly kind: 'request' | 'notification';
}
/**
 * The direction and message kind of every custom method.
 *
 * Admission rule for client-to-server methods. A request outside the initialized state is rejected:
 * with `-32002` (not initialized) before `initialize`, and with `-32600` (invalid request) after
 * `shutdown`. A notification outside the initialized state, or with parameters that fail its guard,
 * is dropped without effect and without a response: JSON-RPC gives a notification no response, and
 * the server may send nothing before it has answered `initialize`.
 */
export const BVE_METHOD_SHAPES: Readonly<Record<BveMethod, BveMethodShape>> = Object.freeze({
  [BVE_METHODS.reloadConfiguration]: Object.freeze({
    direction: 'clientToServer',
    kind: 'request',
  }),
  [BVE_METHODS.recordSelection]: Object.freeze({
    direction: 'clientToServer',
    kind: 'notification',
  }),
  [BVE_METHODS.searchReferences]: Object.freeze({ direction: 'clientToServer', kind: 'request' }),
  [BVE_METHODS.filesystemObservation]: Object.freeze({
    direction: 'clientToServer',
    kind: 'request',
  }),
  [BVE_METHODS.validationCoverage]: Object.freeze({
    direction: 'clientToServer',
    kind: 'request',
  }),
  [BVE_METHODS.configurationReloaded]: Object.freeze({
    direction: 'serverToClient',
    kind: 'notification',
  }),
} as const);
