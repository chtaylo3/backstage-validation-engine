import type { CancellationToken } from 'vscode-languageserver/node';
import { verifyRequestBindings } from '../../core/bindings.js';
import { parseContract } from '../../contracts/validate.js';
import { createLspRequest } from '../config.js';
import type { ServerContext } from '../server-context.js';

/**
 * `bve/filesystemObservation`, `bve/validationCoverage`, `bve/recordSelection`,
 * `bve/searchReferences`, and `bve/reloadConfiguration`.
 */
export function registerCustomHandlers(context: ServerContext): void {
  const { connection, lifecycle, workspace, observations } = context;
  const { requests } = context;
  const sessions = () => context.sessions;
  connection.onRequest('bve/filesystemObservation', () => {
    lifecycle.admitted(() => undefined);
    return observations.filesystem({
      available: sessions().available,
      enabled: !!sessions().current.config.coverageObservation,
      generation: sessions().current.generation,
    });
  });
  connection.onRequest('bve/validationCoverage', (params: unknown) => {
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
  connection.onNotification('bve/recordSelection', (input: unknown) => {
    if (
      !lifecycle.initialized ||
      lifecycle.stopped ||
      typeof input !== 'string' ||
      input.length > 512
    )
      return;
    if (!sessions().available) return;
    sessions().current.completion.record(input);
    sessions().current.editor.record(input);
  });
  connection.onRequest('bve/searchReferences', (input: unknown, token: CancellationToken) =>
    lifecycle.admitted(() =>
      requests.execute<readonly { reference: string; source: string }[]>(
        token,
        undefined,
        () => [],
        async (request) => {
          const { config, completion, filesystem } = request.session;
          const generation = context.coordinator.generation;
          if (!request.snapshot.allDocuments.size) {
            const created = createLspRequest(config, workspace.source);
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
              if (!request.current()) return [];
              verifyRequestBindings(
                parseContract('validation-request', { ...original, source }),
                config,
              );
              if (!workspace.commitCapture(source, disk, sourceGeneration)) return [];
            }
            await completion.update(
              parseContract('validation-request', { ...original, source: workspace.source }),
              generation,
            );
            await completion.ready(generation, request.signal);
            if (!request.current()) return [];
          }
          return completion.searchReferences(input, generation, request.signal);
        },
      ),
    ),
  );
  connection.onRequest('bve/reloadConfiguration', () =>
    lifecycle.admitted(context.reloadConfiguration),
  );
}
