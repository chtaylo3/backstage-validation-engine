import type {
  CodeAction,
  CompletionItem,
  CompletionList,
  ExecuteCommandParams,
  Hover,
  Location,
} from 'vscode-languageserver/node';
import { APPLY_FIX_COMMAND } from '../fixes.js';
import type { FixApplicationResult } from '../fixes.js';
import type { ServerContext } from '../server-context.js';

/** Declared items first, then catalog references, de-duplicated by label, at most 100. */
export function mergeCompletionItems(
  declared: readonly CompletionItem[],
  references: readonly CompletionItem[],
): CompletionItem[] {
  return [...declared, ...references]
    .filter(
      (item, index, items) => items.findIndex((other) => other.label === item.label) === index,
    )
    .slice(0, 100);
}
/** Whether `workspace/executeCommand` names the fix command with one string argument. */
export function isFixCommand(
  params: ExecuteCommandParams | undefined,
  fixesEnabled: boolean,
): boolean {
  return !(
    !fixesEnabled ||
    params?.command !== APPLY_FIX_COMMAND ||
    !Array.isArray(params.arguments) ||
    params.arguments.length !== 1 ||
    typeof params.arguments[0] !== 'string'
  );
}

/** Completion, hover, definition, code action, and execute command. */
export function registerLanguageHandlers(context: ServerContext): void {
  const { connection, lifecycle, requests, features, fixes, clientEdits } = context;
  const generation = () => context.coordinator.generation;
  const fixLimits = () => ({
    fileBytes: context.sessions.current.config.profile.limits.fileBytes,
    requestBytes: context.sessions.current.config.profile.limits.requestBytes,
    atomicTextEdits: features.atomicTextEdits,
  });
  connection.onCompletion((params, token) =>
    lifecycle.admitted(() =>
      requests.execute<CompletionList>(
        token,
        params?.textDocument?.uri,
        () => ({ isIncomplete: true, items: [] }),
        async (request) => {
          const current = generation();
          const { completion, editor } = request.session;
          const documents = request.snapshot.allDocuments;
          const references = await completion.complete(params, current, documents, request.signal);
          if (!request.current()) return { isIncomplete: true, items: [] };
          references.items = references.items.filter((item) =>
            editor.acceptsReference(params, item.label, current, documents),
          );
          if (request.signal.aborted) return references;
          if (references.items.length) {
            const declared = editor.complete(params, current, documents, true);
            references.items = mergeCompletionItems(declared.items, references.items);
            return references;
          }
          return editor.complete(params, current, documents);
        },
      ),
    ),
  );
  connection.onHover((params, token) =>
    lifecycle.admitted(() =>
      requests.execute<Hover | null>(
        token,
        params?.textDocument?.uri,
        () => null,
        (request) =>
          request.session.editor.hover(
            params.textDocument.uri,
            params.position,
            generation(),
            request.snapshot.allDocuments,
          ),
      ),
    ),
  );
  connection.onDefinition((params, token) =>
    lifecycle.admitted(() =>
      requests.execute<Location[]>(
        token,
        params?.textDocument?.uri,
        () => [],
        (request) =>
          request.session.editor.definition(
            params.textDocument.uri,
            params.position,
            generation(),
            request.snapshot.allDocuments,
          ),
      ),
    ),
  );
  connection.onCodeAction((params, token) =>
    lifecycle.admitted(() =>
      requests.execute<CodeAction[]>(
        token,
        params?.textDocument?.uri,
        () => [],
        (request) => {
          if (!features.fixesEnabled || clientEdits.busy) return [];
          return fixes.actions(params, generation(), request.snapshot.allDocuments, fixLimits());
        },
      ),
    ),
  );
  connection.onExecuteCommand((params, token) => {
    lifecycle.admitted(() => undefined);
    if (!isFixCommand(params, features.fixesEnabled))
      return { applied: false, reason: 'invalid_request' };
    return requests.execute<FixApplicationResult>(
      token,
      undefined,
      () => ({ applied: false, reason: 'stale' }),
      (request) => {
        if (clientEdits.busy) return { applied: false, reason: 'busy' };
        return fixes.apply(
          params.arguments,
          generation(),
          request.snapshot.allDocuments,
          fixLimits(),
          (edit) => clientEdits.apply(edit, token),
        );
      },
      false,
    );
  });
}
