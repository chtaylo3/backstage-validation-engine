import type { Immutable } from '../../base/json.js';
import { BUILTIN_KINDS } from '../../compatibility/types.js';
import { admitsKind } from '../../contracts/admission.js';
import type { ValidationRequest } from '../../contracts/schemas.js';
import { ParsingBudget } from '../../parsing/budget.js';
import { SourceLineIndex } from '../../parsing/locations.js';
import type { validatePolicySources } from '../../pipeline/policy-sources.js';
import { editorDocuments } from '../editor-documents.js';
import type { EditorFile } from '../editor-documents.js';
import { forbidden, object } from '../editor-schemas.js';
import type { EditorSchema } from '../editor-schemas.js';
import type { EditorState, IndexedDocument, IndexedFile } from './state.js';

/** Forgets the index, the indexed request, and the rule contributions of every generation. */
export function invalidateIndex(state: EditorState): void {
  state.lifetime++;
  state.generation = -1;
  state.files.clear();
  state.request = undefined;
  state.rules = [];
  state.controller?.abort();
}

/** Indexes the entrypoint documents of `request` with their advisory schemas for `generation`. */
export async function updateIndex(
  state: EditorState,
  request: Immutable<ValidationRequest>,
  generation: number,
): Promise<void> {
  const { config } = state;
  state.rules = [];
  const lifetime = state.lifetime;
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  if (config.profile.requiredProcessors.length) return;
  const files = new Map<string, IndexedFile>();
  using budget = new ParsingBudget({
    mode: 'ide',
    deadlineAt: request.execution.deadlineAt,
    signal: controller.signal,
    clock: state.clock,
    limits: {
      fileBytes: config.profile.limits.fileBytes,
      requestBytes: config.profile.limits.requestBytes,
    },
  });
  try {
    let bytes = 0;
    for (const source of request.source.files) {
      // Opaque text includes and non-entrypoint payloads are never interpreted as entities.
      if (request.source.entrypoints && !request.source.entrypoints.includes(source.uri)) continue;
      bytes += Buffer.byteLength(source.text);
      if (
        bytes > budget.limits.requestBytes ||
        Buffer.byteLength(source.text) > budget.limits.fileBytes
      )
        return;
      const documents = await editorDocuments(source.text, budget);
      const indexed: IndexedDocument[] = [];
      for (const document of documents) {
        const value = object(document.value) ? document.value : {};
        const kind = typeof value.kind === 'string' ? value.kind : '';
        if (
          kind &&
          !admitsKind(config.profile, source.uri, kind) &&
          ![...BUILTIN_KINDS, ...config.profile.customKinds.map((row) => row.kind)].some(
            (candidate) =>
              candidate.toLowerCase().startsWith(kind.toLowerCase()) &&
              admitsKind(config.profile, source.uri, candidate),
          )
        )
          continue;
        const native = state.native.get(kind) ??
          state.native.get('') ?? {
            root: {},
            names: new Map(),
            label: 'Native schema unavailable',
          };
        const schemas: EditorSchema[] = [native];
        if (config.profile.nativePolicies.noForeignRootFields)
          schemas.push({
            root: {
              type: 'object',
              properties: { apiVersion: true, kind: true, metadata: true, spec: true },
              additionalProperties: false,
            },
            names: new Map(),
            label: 'Native no_foreign_root_fields',
          });
        const custom = config.profile.customKinds.find(
          (row) => row.kind === kind && row.apiVersion === value.apiVersion,
        );
        const add = (pin: { id: string; version: string; digest: string }, label: string) => {
          const artifact = config.schemaArtifacts.find(
            (row) => row.id === pin.id && row.version === pin.version && row.digest === pin.digest,
          );
          if (artifact)
            schemas.push({
              root: object(artifact.schema)
                ? artifact.schema
                : artifact.schema === false
                  ? forbidden
                  : {},
              names: new Map(),
              label,
              artifactIdentity: artifact.digest,
              ...(label.startsWith('Policy ') ? { ruleId: label.slice(7) } : {}),
            });
        };
        if (custom && !state.native.has(kind)) add(custom.schema, `Custom kind ${kind}`);
        for (const rule of config.policy.rules) {
          // Prerequisite-dependent rules cannot prescribe edits until their prerequisites pass.
          if (rule.kind !== 'schema' || rule.requires.length) continue;
          if (rule.selector) {
            try {
              if (
                !(await state.runtime.evaluate(rule.selector, document.value, {
                  requestId: `editor:${request.run.runId}`,
                  deadlineAt: request.execution.deadlineAt,
                  signal: controller.signal,
                  executionMs: config.profile.limits.celExecutionMs,
                }))
              )
                continue;
            } catch {
              continue;
            }
          }
          add(rule.schema, `Policy ${rule.id}`);
        }
        indexed.push({
          document,
          schemas,
          basePath: '',
          schemaValue: document.value,
          subjectStage: 'authored',
        });
      }
      files.set(source.uri, {
        file: {
          uri: source.uri,
          version: source.version,
          digest: source.digest,
          text: source.text,
          lines: new SourceLineIndex(source.text),
          documents,
          json: source.text.trimStart().startsWith('{'),
        },
        documents: indexed,
      });
    }
    if (lifetime === state.lifetime && !controller.signal.aborted) {
      state.files = files;
      state.request = request;
      state.generation = generation;
    }
  } catch {
    /* Recovery metadata cannot weaken or interrupt validation. */
  }
}

/** Refine advisory schemas with actual rule applicability and qualified structured includes. */
export async function refineIndex(
  state: EditorState,
  report: Awaited<ReturnType<typeof validatePolicySources>>,
  generation: number,
): Promise<void> {
  if (state.generation !== generation || report.interrupted !== 'none') return;
  const original = state.files;
  const files = new Map(original);
  const payloads = new Map<
    string,
    { context: string; indexed: IndexedDocument; path: string } | undefined
  >();
  for (const entity of report.compatibility.entities) {
    const file = files.get(entity.document.uri);
    const selected = file?.documents.find(
      (row) => row.document.ordinal === entity.document.document,
    );
    if (!file || !selected) continue;
    const schemas = selected.schemas.filter((schema) => !schema.label.startsWith('Policy '));
    const subject = JSON.stringify([entity.document.uri, entity.document.document]);
    for (const rule of state.config.policy.rules) {
      if (
        rule.kind !== 'schema' ||
        !report.ruleStates.some(
          (row) =>
            row.subjectId === subject &&
            row.ruleId === rule.id &&
            (row.status === 'passed' || row.status === 'failed'),
        )
      )
        continue;
      const artifact = state.config.schemaArtifacts.find(
        (artifact) =>
          artifact.id === rule.schema.id &&
          artifact.version === rule.schema.version &&
          artifact.digest === rule.schema.digest,
      );
      if (artifact)
        schemas.push({
          root: object(artifact.schema)
            ? artifact.schema
            : artifact.schema === false
              ? forbidden
              : {},
          names: new Map(),
          label: `Policy ${rule.id}`,
          artifactIdentity: artifact.digest,
          ruleId: rule.id,
        });
    }
    const indexed: IndexedDocument = {
      ...selected,
      subjectId: subject,
      schemas,
      schemaValue: entity.normalized,
      subjectStage: 'normalized',
    };
    files.set(file.file.uri, {
      ...file,
      documents: file.documents.map((row) => (row === selected ? indexed : row)),
    });
    for (const inclusion of entity.substitutions) {
      if (inclusion.kind === '$text') continue;
      const uri = inclusion.target.uri;
      const context = JSON.stringify([subject, inclusion.path]);
      if (payloads.has(uri) && payloads.get(uri)?.context !== context) payloads.set(uri, undefined);
      else if (!payloads.has(uri)) payloads.set(uri, { context, indexed, path: inclusion.path });
    }
  }
  try {
    using budget = new ParsingBudget({
      mode: 'ide',
      deadlineAt: report.request.execution.deadlineAt,
      clock: state.clock,
      ...(state.controller ? { signal: state.controller.signal } : {}),
    });
    for (const [uri, payload] of payloads) {
      if (!payload) {
        files.delete(uri);
        continue;
      }
      const source = report.request.source.files.find((file) => file.uri === uri);
      if (!source) continue;
      const documents =
        files.get(uri)?.file.documents ?? (await editorDocuments(source.text, budget));
      if (documents.length !== 1 || !documents[0]!.valid) continue;
      const file: EditorFile = {
        uri,
        version: source.version,
        digest: source.digest,
        text: source.text,
        lines: new SourceLineIndex(source.text),
        documents,
        json: source.text.trimStart().startsWith('{'),
      };
      files.set(uri, {
        file,
        documents: [
          {
            document: documents[0]!,
            schemas: payload.indexed.schemas,
            schemaValue: payload.indexed.schemaValue,
            subjectStage: payload.indexed.subjectStage,
            basePath: payload.path,
            ...(payload.indexed.subjectId ? { subjectId: payload.indexed.subjectId } : {}),
          },
        ],
      });
    }
  } catch {
    /* The original deadline also bounds include metadata. */
  }
  if (state.generation === generation && state.files === original) {
    state.files = files;
    state.request = report.request;
  }
}
