import { LSPErrorCodes, ResponseError } from 'vscode-languageserver/node';
import type { CancellationToken } from 'vscode-languageserver/node';
import { verifyRequestBindings } from '../../core/bindings.js';
import { parseContract } from '../../contracts/validate.js';
import { BVE_METHODS, isRecordSelectionParams } from '../../protocol/index.js';
import type {
  BveMethod,
  ReloadConfigurationResult,
  SearchReferencesParams,
  SearchReferencesResult,
} from '../../protocol/index.js';
import type { CatalogSuggestionQuery } from '../../providers/types.js';
import { createLspRequest } from '../config.js';
import type { ServerContext } from '../server-context.js';
import type { MutuallyAssignable } from '../../base/types.js';

// Compile-time checks that the engine types these handlers receive and answer with are the wire types.
const searchMatchesProtocol: MutuallyAssignable<SearchReferencesParams, CatalogSuggestionQuery> =
  true;
const searchResultMatchesProtocol: MutuallyAssignable<
  SearchReferencesResult,
  Awaited<ReturnType<ServerContext['sessions']['current']['completion']['searchReferences']>>
> = true;
const reloadMatchesProtocol: MutuallyAssignable<
  ReloadConfigurationResult,
  Awaited<ReturnType<ServerContext['reloadConfiguration']>>
> = true;
void searchMatchesProtocol;
void searchResultMatchesProtocol;
void reloadMatchesProtocol;

/**
 * Registers a custom client-to-server notification under the admission rule of
 * `BVE_METHOD_SHAPES`: outside the initialized state, or when `guard` rejects the parameters, the
 * notification is dropped without effect and without a response. Every custom notification is
 * registered here, so none can follow a different rule.
 */
function onAdmittedNotification<T>(
  context: ServerContext,
  method: BveMethod,
  guard: (input: unknown) => input is T,
  handle: (params: T) => void,
): void {
  const { connection, lifecycle } = context;
  connection.onNotification(method, (input: unknown) => {
    if (!lifecycle.initialized || lifecycle.stopped || !guard(input)) return;
    handle(input);
  });
}

/**
 * The client to server methods of `src/protocol`: `bve/filesystemObservation`,
 * `bve/validationCoverage`, `bve/recordSelection`, `bve/searchReferences`, and
 * `bve/reloadConfiguration`.
 */
export function registerCustomHandlers(context: ServerContext): void {
  const { connection, lifecycle, workspace, observations } = context;
  const { requests } = context;
  const sessions = () => context.sessions;
  connection.onRequest(BVE_METHODS.filesystemObservation, () => {
    lifecycle.admitted(() => undefined);
    return observations.filesystem({
      available: sessions().available,
      enabled: !!sessions().current.config.coverageObservation,
      generation: sessions().current.generation,
    });
  });
  connection.onRequest(BVE_METHODS.validationCoverage, (params: unknown) => {
    lifecycle.admitted(() => undefined);
    if (lifecycle.initialized && !lifecycle.stopped && sessions().available)
      sessions().current.refresh?.ensureFresh();
    return observations.coverage(params, {
      initialized: lifecycle.initialized,
      stopped: lifecycle.stopped,
      available: sessions().available,
      enabled: !!sessions().current.config.coverageObservation,
      workspace,
      generation: context.coordinator.generation,
      dependencyGeneration: sessions().current.refresh?.generation ?? 0,
    });
  });
  onAdmittedNotification(context, BVE_METHODS.recordSelection, isRecordSelectionParams, (input) => {
    if (!sessions().available) return;
    sessions().current.completion.record(input);
    sessions().current.editor.record(input);
  });
  connection.onRequest(BVE_METHODS.searchReferences, (input: unknown, token: CancellationToken) =>
    lifecycle.admitted(() => {
      /**
       * The answer of a search without a result. A search that a source change or a configuration
       * reload overtook has no answer, and an empty list would say that nothing matches. It gets
       * the LSP `ContentModified` error, which tells the client to ask again. A search that the
       * client cancelled, or that the server cannot run, keeps the empty list.
       */
      const unanswered = (
        request?: Parameters<Parameters<typeof requests.execute>[3]>[0],
      ): SearchReferencesResult | ResponseError<void> =>
        request &&
        !token.isCancellationRequested &&
        !lifecycle.stopped &&
        sessions().available &&
        (workspace.generation !== request.snapshot.generation ||
          sessions().current.generation !== request.session.generation)
          ? new ResponseError(
              LSPErrorCodes.ContentModified,
              'The workspace changed during the search.',
            )
          : [];
      return requests.execute<SearchReferencesResult | ResponseError<void>>(
        token,
        undefined,
        unanswered,
        async (request) => {
          const { config, completion, filesystem } = request.session;
          const generation = context.coordinator.generation;
          if (!request.snapshot.allDocuments.size) {
            const created = createLspRequest(config, workspace.source, context.clock);
            const original = parseContract('validation-request', {
              ...created,
              execution: { ...created.execution, deadlineAt: request.deadlineAt },
            });
            if (filesystem && workspace.capturedGeneration < workspace.diskGeneration) {
              const disk = workspace.diskGeneration;
              const sourceGeneration = workspace.generation;
              const source = await filesystem.capture(workspace.source, {
                deadlineAt: request.deadlineAt,
                signal: request.signal,
              });
              if (!request.current()) return unanswered(request);
              verifyRequestBindings(
                parseContract('validation-request', { ...original, source }),
                config,
              );
              if (!workspace.commitCapture(source, disk, sourceGeneration))
                return unanswered(request);
            }
            await completion.update(
              parseContract('validation-request', { ...original, source: workspace.source }),
              generation,
            );
            await completion.ready(generation, request.signal);
            if (!request.current()) return unanswered(request);
          }
          return completion.searchReferences(input, generation, request.signal);
        },
      );
    }),
  );
  connection.onRequest(BVE_METHODS.reloadConfiguration, () =>
    lifecycle.admitted(context.reloadConfiguration),
  );
}
