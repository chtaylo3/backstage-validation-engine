import type { Connection, Diagnostic, Disposable } from 'vscode-languageserver/node';
import { BVE_METHODS } from '../protocol/index.js';
import type { LspConfig } from './config.js';
import type { CoverageObservation } from './coverage-observation.js';
import { registerCustomHandlers } from './handlers/custom.js';
import { registerDocumentHandlers, watchFiles } from './handlers/documents.js';
import { registerLanguageHandlers } from './handlers/language.js';
import { registerLifecycleHandlers } from './handlers/lifecycle.js';
import { RequestContexts } from './request-context.js';
import { ServerContext } from './server-context.js';
import type { LspServerOptions } from './server-context.js';
import { SessionResources } from './session-resources.js';
import type { SessionPorts } from './session-resources.js';
export type { LspServerResources } from './session-resources.js';
import { ValidationCoordinator } from './validation-coordinator.js';
import type { InvalidationReason, ValidationRun } from './validation-coordinator.js';
import { runValidation } from './validation-run.js';

function sessionPorts(context: ServerContext): SessionPorts {
  const { clientEdits, workspace, observations, options, connection } = context;
  return {
    dependencyChanged: () => {
      clientEdits.cancel();
      context.coordinator.invalidate('dependencies');
    },
    invalidate: () => {
      clientEdits.cancel();
      context.coordinator.invalidate('configuration');
    },
    pause: () => {
      context.coordinator.pause();
      return context.coordinator.cancelActive();
    },
    commit: (session) => {
      observations.clearFilesystem();
      workspace.replaceConfiguration(session.config);
      context.coordinator.invalidate('configuration');
    },
    activated: async (session) => {
      session.own(options.configurationChanged?.(session.config));
      for (const [uri, document] of workspace.documents)
        if (session.config.filesystem && !workspace.approved(uri))
          await context.clearDiagnostics(uri, document.version, document.lifetime);
    },
    resume: () => context.coordinator.resume(),
    ready: () => {
      watchFiles(context);
      void connection.sendNotification(BVE_METHODS.configurationReloaded).catch(() => undefined);
    },
  };
}
function validate(context: ServerContext, run: ValidationRun): Promise<void> {
  const { sessions, workspace, observations, publisher } = context;
  const session = sessions.current;
  const available = sessions.available;
  const refresh = available ? session.refresh?.begin() : undefined;
  const dependencyGeneration = session.refresh?.generation ?? 0;
  const input = {
    clock: context.clock,
    runtime: session.runtime,
    dependencyGeneration,
    observeCoverage: (value: CoverageObservation) => {
      if (run.current() && sessions.current === session && sessions.available)
        observations.recordCoverage(value);
    },
    refreshQueries: (deadlineAt: number, signal: AbortSignal) =>
      session.refresh?.refreshQueries({ deadlineAt, signal }) ?? Promise.resolve(),
    config: session.config,
    snapshot: workspace.snapshot(),
    workspace,
    filesystem: available ? session.filesystem : undefined,
    catalog: available ? (refresh?.catalog ?? session.catalog) : undefined,
    candidateCatalog: available ? session.candidateCatalog : undefined,
    completion: session.completion,
    editor: session.editor,
    validation: session.validation,
    fixes: context.fixes,
    fixesEnabled: context.features.fixesEnabled,
    configurationUnavailable: !available,
    operations: available ? session.operations : undefined,
    publish: (uri: string, version: number, diagnostics: Diagnostic[]) =>
      publisher.publish(
        {
          uri,
          version,
          generation: run.generation,
          lifetime: workspace.document(uri)?.lifetime ?? 0,
          current: run.current,
        },
        diagnostics,
      ),
  };
  const work = () => (run.current() ? runValidation(run, input) : Promise.resolve());
  return (available ? session.operations.run(work) : work()).finally(() =>
    refresh?.finish(run.current()),
  );
}
function invalidateState(context: ServerContext, reason: InvalidationReason): void {
  const { sessions } = context;
  context.observations.clearCoverage();
  if (reason === 'dependencies') sessions.current.completion.invalidateRemote();
  context.fixes.invalidate();
  sessions.current.completion.invalidate();
  if (reason === 'metadata') sessions.current.editor.expireRules(context.coordinator.generation);
  else sessions.current.editor.invalidate();
  context.workspace.invalidate();
}
/** Builds the owners of one connection and wires the ones that refer to each other. */
export function createServerContext(
  connection: Connection,
  config: LspConfig,
  options: LspServerOptions,
): ServerContext {
  const context = new ServerContext(connection, config, options);
  const sessions: SessionResources = new SessionResources(
    {
      config,
      ...(options.catalog ? { catalog: options.catalog } : {}),
      ...(options.filesystem ? { filesystem: options.filesystem } : {}),
      ...(options.dispose ? { dispose: options.dispose } : {}),
      ...(options.runtime ? { runtime: options.runtime } : {}),
    },
    sessionPorts(context),
    options.reload,
    undefined,
    context.clock,
  );
  const coordinator: ValidationCoordinator = new ValidationCoordinator(
    (run) => validate(context, run),
    () => sessions.current.config.debounceMs,
    (reason) => invalidateState(context, reason),
  );
  const requests = new RequestContexts(
    context.workspace,
    () => {
      sessions.current.refresh?.ensureFresh();
      if (sessions.available && sessions.current.editor.rulePreparationExpired)
        coordinator.invalidate('metadata');
      return {
        initialized: context.lifecycle.initialized,
        stopped: context.lifecycle.stopped,
        available: sessions.available,
        session: sessions.current,
      };
    },
    context.clock,
  );
  context.wire({ sessions, coordinator, requests });
  return context;
}

/** One active request and one latest workspace snapshot; host owns resources and immutable authority. */
export function attachLspServer(
  connection: Connection,
  config: LspConfig,
  options: LspServerOptions = {},
) {
  if (!!config.filesystem !== !!options.filesystem)
    throw new Error('Trusted filesystem reader configuration mismatch.');
  const context = createServerContext(connection, config, options);
  registerLifecycleHandlers(context);
  registerCustomHandlers(context);
  registerLanguageHandlers(context);
  registerDocumentHandlers(context);
  const { lifecycle, sessions } = context;
  return {
    close: lifecycle.close,
    get shutdownReceived() {
      return lifecycle.requestedShutdown;
    },
    reload: context.reloadConfiguration,
    own: (registration: Disposable | void) => sessions.current.own(registration),
  };
}
