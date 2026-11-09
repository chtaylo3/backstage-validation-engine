import { CompletionItemKind, InsertTextFormat, MarkupKind } from 'vscode-languageserver/node';
import type {
  CompletionList,
  CompletionParams,
  Hover,
  Position,
  Location,
  TextEdit,
} from 'vscode-languageserver/node';
import type { Finding, ValidationRequest } from '../contracts/schemas.js';
import type { Immutable } from '../core/json.js';
import { digestText } from '../core/json.js';
import { BUILTIN_KINDS } from '../compatibility/types.js';
import { getSharedCelRuntime } from '../runtime/cel/index.js';
import { ParsingBudget } from '../parsing/budget.js';
import { SourceLineIndex, childPointer } from '../parsing/locations.js';
import { admitsKind } from '../policy/admission.js';
import { editorDocuments, editorTarget } from './editor-documents.js';
import type { EditorDocument, EditorFile } from './editor-documents.js';
import {
  nativeEditorSchemas,
  object,
  parts,
  primitive,
  resolveFields,
  fieldValues,
  fieldDescription,
  acceptsValue,
  forbidden,
} from './editor-schemas.js';
import type { EditorSchema, ResolvedField } from './editor-schemas.js';
import type { FixDocument, SuggestedFix } from './fixes.js';
import type { LspConfig } from './config.js';
import type { validatePolicySources } from '../core/policy-sources.js';

interface IndexedDocument {
  readonly document: EditorDocument;
  readonly schemas: readonly EditorSchema[];
  readonly basePath: string;
  readonly schemaValue: unknown;
}
interface IndexedFile {
  readonly file: EditorFile;
  readonly documents: readonly IndexedDocument[];
}
const empty = (): CompletionList => ({ isIncomplete: true, items: [] });
function initialValue(
  fields: readonly ResolvedField[],
  depth = 0,
  remaining = { nodes: 32 },
): unknown {
  if (--remaining.nodes < 0) return null;
  const required = fields.find(({ node }) => Object.hasOwn(node, 'const'))?.node.const;
  if (primitive(required)) return required;
  if (depth > 4) return null;
  if (fields.some(({ node }) => node.type === 'object' || object(node.properties))) {
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const names = new Set(
      fields.flatMap(({ node }) =>
        Array.isArray(node.required)
          ? node.required.filter((name): name is string => typeof name === 'string')
          : [],
      ),
    );
    for (const name of [...names].slice(0, 16)) {
      const children = fields.flatMap(({ node, schema }) =>
        object(node.properties) && object(node.properties[name])
          ? [{ node: node.properties[name], schema }]
          : [],
      );
      if (remaining.nodes <= 0) break;
      output[name] = initialValue(children, depth + 1, remaining);
    }
    return output;
  }
  if (fields.some(({ node }) => node.type === 'array')) return [];
  if (fields.some(({ node }) => node.type === 'number' || node.type === 'integer')) return 0;
  if (fields.some(({ node }) => node.type === 'boolean')) return false;
  if (fields.some(({ node }) => node.type === 'null')) return null;
  return '';
}
function encoded(value: unknown, raw: string, json: boolean): string {
  if (typeof value === 'string' && !json && raw.startsWith("'"))
    return `'${value.replace(/'/gu, "''")}'`;
  return JSON.stringify(value);
}

/** Bounded, generation-scoped editor metadata, separate from authoritative validation. */
export class EditorService {
  private readonly native: ReadonlyMap<string, EditorSchema>;
  private files = new Map<string, IndexedFile>();
  private generation = -1;
  private lifetime = 0;
  private controller: AbortController | undefined;
  private readonly history = new Map<string, number>();
  private clock = 0;
  constructor(private readonly config: LspConfig) {
    try {
      this.native = nativeEditorSchemas(config);
    } catch {
      this.native = new Map();
    }
  }
  invalidate(): void {
    this.lifetime++;
    this.generation = -1;
    this.files.clear();
    this.controller?.abort();
  }
  record(value: string): void {
    if (value.length > 512) return;
    this.history.delete(value);
    this.history.set(value, ++this.clock);
    if (this.history.size > 128) this.history.delete(this.history.keys().next().value!);
  }
  async update(request: Immutable<ValidationRequest>, generation: number): Promise<void> {
    const lifetime = this.lifetime;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    if (this.config.profile.requiredProcessors.length) return;
    const files = new Map<string, IndexedFile>();
    using budget = new ParsingBudget({
      mode: 'ide',
      deadlineAt: request.execution.deadlineAt,
      signal: controller.signal,
      limits: {
        fileBytes: this.config.profile.limits.fileBytes,
        requestBytes: this.config.profile.limits.requestBytes,
      },
    });
    try {
      let bytes = 0;
      for (const source of request.source.files) {
        // Opaque text includes and non-entrypoint payloads are never interpreted as entities.
        if (request.source.entrypoints && !request.source.entrypoints.includes(source.uri))
          continue;
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
            !admitsKind(this.config.profile, source.uri, kind) &&
            ![...BUILTIN_KINDS, ...this.config.profile.customKinds.map((row) => row.kind)].some(
              (candidate) =>
                candidate.toLowerCase().startsWith(kind.toLowerCase()) &&
                admitsKind(this.config.profile, source.uri, candidate),
            )
          )
            continue;
          const native = this.native.get(kind) ??
            this.native.get('') ?? {
              root: {},
              names: new Map(),
              label: 'Native schema unavailable',
            };
          const schemas: EditorSchema[] = [native];
          if (this.config.profile.nativePolicies.noForeignRootFields)
            schemas.push({
              root: {
                type: 'object',
                properties: { apiVersion: true, kind: true, metadata: true, spec: true },
                additionalProperties: false,
              },
              names: new Map(),
              label: 'Native no_foreign_root_fields',
            });
          const custom = this.config.profile.customKinds.find(
            (row) => row.kind === kind && row.apiVersion === value.apiVersion,
          );
          const add = (pin: { id: string; version: string; digest: string }, label: string) => {
            const artifact = this.config.schemaArtifacts.find(
              (row) =>
                row.id === pin.id && row.version === pin.version && row.digest === pin.digest,
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
              });
          };
          if (custom && !this.native.has(kind)) add(custom.schema, `Custom kind ${kind}`);
          for (const rule of this.config.policy.rules) {
            // Prerequisite-dependent rules cannot prescribe edits until their prerequisites pass.
            if (rule.kind !== 'schema' || rule.requires.length) continue;
            if (rule.selector) {
              try {
                if (
                  !(await getSharedCelRuntime().evaluate(rule.selector, document.value, {
                    requestId: `editor:${request.run.runId}`,
                    deadlineAt: request.execution.deadlineAt,
                    signal: controller.signal,
                    executionMs: this.config.profile.limits.celExecutionMs,
                  }))
                )
                  continue;
              } catch {
                continue;
              }
            }
            add(rule.schema, `Policy ${rule.id}`);
          }
          indexed.push({ document, schemas, basePath: '', schemaValue: document.value });
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
      if (lifetime === this.lifetime && !controller.signal.aborted) {
        this.files = files;
        this.generation = generation;
      }
    } catch {
      /* Recovery metadata cannot weaken or interrupt validation. */
    }
  }
  /** Refine advisory schemas with actual rule applicability and qualified structured includes. */
  async refine(
    report: Awaited<ReturnType<typeof validatePolicySources>>,
    generation: number,
  ): Promise<void> {
    if (this.generation !== generation || report.interrupted !== 'none') return;
    const original = this.files;
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
      for (const rule of this.config.policy.rules) {
        if (
          rule.kind !== 'schema' ||
          !report.ruleStates.some(
            (state) =>
              state.subjectId === subject &&
              state.ruleId === rule.id &&
              (state.status === 'passed' || state.status === 'failed'),
          )
        )
          continue;
        const artifact = this.config.schemaArtifacts.find(
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
          });
      }
      const indexed = { ...selected, schemas, schemaValue: entity.normalized };
      files.set(file.file.uri, {
        ...file,
        documents: file.documents.map((row) => (row === selected ? indexed : row)),
      });
      for (const inclusion of entity.substitutions) {
        if (inclusion.kind === '$text') continue;
        const uri = inclusion.target.uri;
        const context = JSON.stringify([subject, inclusion.path]);
        if (payloads.has(uri) && payloads.get(uri)?.context !== context)
          payloads.set(uri, undefined);
        else if (!payloads.has(uri)) payloads.set(uri, { context, indexed, path: inclusion.path });
      }
    }
    try {
      using budget = new ParsingBudget({
        mode: 'ide',
        deadlineAt: report.request.execution.deadlineAt,
        ...(this.controller ? { signal: this.controller.signal } : {}),
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
              basePath: payload.path,
            },
          ],
        });
      }
    } catch {
      /* The original deadline also bounds include metadata. */
    }
    if (this.generation === generation && this.files === original) this.files = files;
  }
  private fields(selected: IndexedDocument, path: string): ResolvedField[] {
    return resolveFields(selected.schemas, selected.basePath + path, selected.schemaValue);
  }
  private current(
    uri: string,
    generation: number,
    documents: ReadonlyMap<string, FixDocument>,
  ): IndexedFile | undefined {
    const file = this.files.get(uri),
      document = documents.get(uri);
    return this.generation === generation &&
      file &&
      document &&
      file.file.version === document.version &&
      file.file.digest === digestText(document.getText())
      ? file
      : undefined;
  }
  complete(
    params: CompletionParams,
    generation: number,
    documents: ReadonlyMap<string, FixDocument>,
  ): CompletionList {
    const indexed = this.current(params.textDocument.uri, generation, documents);
    if (!indexed) return empty();
    const target = editorTarget(indexed.file, params.position);
    const selected = indexed.documents.find((row) => row.document === target?.document);
    if (!target || !selected) return empty();
    const fields = this.fields(selected, target.path);
    if (target.key) {
      const existing = selected.document.nodes.get(target.path)?.value;
      const keys = new Map<string, boolean>();
      const required = new Set(
        fields.flatMap(({ node }) =>
          Array.isArray(node.required)
            ? node.required.filter((name: unknown): name is string => typeof name === 'string')
            : [],
        ),
      );
      for (const { node } of fields)
        if (object(node.properties))
          for (const key of Object.keys(node.properties)) {
            if (
              !key.startsWith(target.prefix) ||
              (object(existing) && Object.hasOwn(existing, key) && key !== target.prefix)
            )
              continue;
            if (
              !this.fields(selected, childPointer(target.path, key)).some(
                ({ node }) => node.$bveForbidden,
              )
            )
              keys.set(key, required.has(key));
          }
      return {
        isIncomplete: true,
        items: [...keys]
          .sort(([a, ar], [b, br]) => Number(br) - Number(ar) || a.localeCompare(b))
          .slice(0, 100)
          .map(([key, required], index) => {
            const children = this.fields(selected, childPointer(target.path, key));
            const raw = indexed.file.text.slice(
              indexed.file.lines.offset(target.range.start),
              indexed.file.lines.offset(target.range.end),
            );
            const name =
              target.flow || raw.startsWith('"')
                ? JSON.stringify(key)
                : raw.startsWith("'")
                  ? `'${key.replace(/'/gu, "''")}'`
                  : /^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(key) && !/^(?:true|false|null)$/iu.test(key)
                    ? key
                    : JSON.stringify(key);
            const value = initialValue(children);
            let suffix = target.colon
              ? ''
              : target.flow
                ? `: ${JSON.stringify(value)}`
                : `: ${typeof value === 'object' && value !== null ? JSON.stringify(value) : ''}`;
            if (!target.colon && target.flow) {
              const end = indexed.file.lines.offset(target.range.end)!;
              if (!/^\s*[,}]/u.test(indexed.file.text.slice(end))) suffix += ',';
            }
            return {
              label: key,
              kind: CompletionItemKind.Property,
              detail: required ? 'Required field' : 'Optional field',
              documentation: { kind: MarkupKind.PlainText, value: fieldDescription(children) },
              sortText: String(index).padStart(3, '0'),
              insertTextFormat: InsertTextFormat.PlainText,
              textEdit: { range: target.range, newText: name + suffix },
            };
          }),
      };
    }
    let values = fieldValues(fields);
    if (!selected.basePath && target.path === '/kind')
      values = [...BUILTIN_KINDS, ...this.config.profile.customKinds.map((row) => row.kind)]
        .filter((kind) => admitsKind(this.config.profile, indexed.file.uri, kind))
        .filter((kind) => acceptsValue(fields, kind))
        .map((value) => ({ value, label: 'Entity kind' }));
    const raw = indexed.file.text.slice(
      indexed.file.lines.offset(target.range.start),
      indexed.file.lines.offset(target.range.end),
    );
    return {
      isIncomplete: true,
      items: values
        .filter(({ value }) => String(value).toLowerCase().startsWith(target.prefix.toLowerCase()))
        .sort(
          (a, b) =>
            (this.history.get(String(b.value)) ?? 0) - (this.history.get(String(a.value)) ?? 0),
        )
        .slice(0, 100)
        .map(({ value, label }, index) => ({
          label: typeof value === 'string' ? value : JSON.stringify(value),
          kind: CompletionItemKind.Value,
          detail: label,
          documentation: { kind: MarkupKind.PlainText, value: fieldDescription(fields) },
          sortText: String(index).padStart(3, '0'),
          insertTextFormat: InsertTextFormat.PlainText,
          textEdit: { range: target.range, newText: encoded(value, raw, indexed.file.json) },
        })),
    };
  }
  acceptsReference(
    params: CompletionParams,
    value: string,
    generation: number,
    documents: ReadonlyMap<string, FixDocument>,
  ): boolean {
    const indexed = this.current(params.textDocument.uri, generation, documents);
    if (!indexed) return true;
    const target = editorTarget(indexed.file, params.position);
    const selected = indexed.documents.find((row) => row.document === target?.document);
    return !target || !selected || acceptsValue(this.fields(selected, target.path), value);
  }
  hover(
    uri: string,
    position: Position,
    generation: number,
    documents: ReadonlyMap<string, FixDocument>,
  ): Hover | null {
    const indexed = this.current(uri, generation, documents);
    if (!indexed) return null;
    const offset = indexed.file.lines.offset(position);
    if (offset === undefined) return null;
    for (const selected of indexed.documents)
      for (const node of selected.document.nodes.values()) {
        if (
          node.blocked ||
          offset < (node.keyStart ?? node.start) ||
          offset > node.end ||
          node.container
        )
          continue;
        const fields = this.fields(selected, node.path);
        const value = fieldDescription(fields);
        if (value)
          return {
            contents: { kind: MarkupKind.PlainText, value },
            range: indexed.file.lines.range(node.keyStart ?? node.start, node.end),
          };
      }
    return null;
  }
  definition(
    uri: string,
    position: Position,
    generation: number,
    documents: ReadonlyMap<string, FixDocument>,
  ): Location[] {
    const indexed = this.current(uri, generation, documents);
    if (!indexed) return [];
    const target = editorTarget(indexed.file, position);
    if (!target || target.key) return [];
    const value = target.document.nodes.get(target.path)?.value;
    if (typeof value !== 'string') return [];
    const selected = indexed.documents.find((row) => row.document === target.document);
    if (!selected) return [];
    const pattern = this.config.profile.referenceContexts.find((row) => {
      const expected = parts(row.path),
        actual = parts(selected.basePath + target.path);
      return (
        expected.length === actual.length &&
        expected.every(
          (part, i) => part === actual[i] || (part === '*' && /^\d+$/u.test(actual[i]!)),
        )
      );
    });
    if (!pattern) return [];
    const root = selected.schemaValue;
    const namespace =
      pattern.namespace === 'entity'
        ? object(root) && object(root.metadata) && typeof root.metadata.namespace === 'string'
          ? root.metadata.namespace
          : 'default'
        : pattern.namespace;
    const match = /^(?:([^:/]+):)?(?:([^/]+)\/)?([^/]+)$/u.exec(value);
    if (!match) return [];
    const reference =
      `${match[1] ?? pattern.defaultKind}:${match[2] ?? namespace}/${match[3]}`.toLowerCase();
    const locations: Location[] = [];
    for (const row of this.files.values())
      for (const { document } of row.documents) {
        const entity = document.value;
        if (
          !document.valid ||
          !object(entity) ||
          typeof entity.kind !== 'string' ||
          !object(entity.metadata) ||
          typeof entity.metadata.name !== 'string'
        )
          continue;
        const ref =
          `${entity.kind}:${typeof entity.metadata.namespace === 'string' ? entity.metadata.namespace : 'default'}/${entity.metadata.name}`.toLowerCase();
        if (ref !== reference) continue;
        const node = document.nodes.get('/metadata/name');
        if (node)
          locations.push({ uri: row.file.uri, range: row.file.lines.range(node.start, node.end) });
      }
    return locations.length === 1 ? locations : [];
  }
  repairs(
    findings: readonly Immutable<Finding>[],
    generation: number,
    documents: ReadonlyMap<string, FixDocument>,
  ): SuggestedFix[] {
    const repairs: SuggestedFix[] = [];
    for (const finding of findings) {
      if (
        finding.edits.length ||
        !['schema', 'compatibility', 'policy', 'input'].includes(finding.category)
      )
        continue;
      const indexed = this.current(finding.location.uri, generation, documents);
      if (!indexed) continue;
      const selected = indexed.documents.find(
        (row) => row.document.ordinal === finding.location.document,
      );
      if (!selected?.document.valid) continue;
      const path = finding.location.path;
      const fields = this.fields(selected, path);
      const node = selected.document.nodes.get(path);
      const choices: { value: unknown; label: string }[] = fieldValues(fields);
      if (!node && fields.length && !choices.length) {
        const name = parts(path).at(-1);
        const parentFields = this.fields(selected, path.slice(0, path.lastIndexOf('/')));
        if (
          parentFields.some(
            ({ node }) => Array.isArray(node.required) && node.required.includes(name),
          )
        )
          choices.push({ value: initialValue(fields), label: 'Placeholder; complete this field' });
      }
      for (const choice of choices.slice(0, 16)) {
        let edit: TextEdit | undefined;
        if (
          node &&
          !node.blocked &&
          !node.container &&
          JSON.stringify(node.value) !== JSON.stringify(choice.value)
        ) {
          const raw = indexed.file.text.slice(node.start, node.end);
          if (!/[\r\n]/u.test(raw))
            edit = {
              range: indexed.file.lines.range(node.start, node.end),
              newText: encoded(choice.value, raw, indexed.file.json),
            };
        } else if (!node && path) {
          const parent = selected.document.nodes.get(path.slice(0, path.lastIndexOf('/')));
          const name = parts(path).at(-1)!;
          if (parent?.container === 'map' && !parent.blocked) {
            if (parent.flow || indexed.file.json) {
              const offset = parent.end - 1;
              if (indexed.file.text[offset] === '}')
                edit = {
                  range: indexed.file.lines.range(offset, offset),
                  newText: `${object(parent.value) && Object.keys(parent.value).length ? ', ' : ''}${JSON.stringify(name)}: ${JSON.stringify(choice.value)}`,
                };
            } else {
              const newline = indexed.file.text.includes('\r\n') ? '\r\n' : '\n';
              const children = [...selected.document.nodes.values()].filter(
                (child) =>
                  child.keyStart !== undefined &&
                  child.path.slice(0, child.path.lastIndexOf('/')) === parent.path,
              );
              const indent = children.length
                ? indexed.file.lines.position(children[0]!.keyStart!).character
                : parent.path
                  ? parent.indent + 2
                  : 0;
              let offset = parent.end;
              if (indexed.file.lines.position(offset).character > 0) {
                const rest = indexed.file.text.slice(offset);
                const next = /\r\n|\r|\n/u.exec(rest);
                offset = next ? offset + next.index + next[0].length : indexed.file.text.length;
              }
              edit = {
                range: indexed.file.lines.range(offset, offset),
                newText: `${offset && !/[\r\n]/u.test(indexed.file.text[offset - 1]!) ? newline : ''}${' '.repeat(indent)}${JSON.stringify(name)}: ${JSON.stringify(choice.value)}${newline}`,
              };
            }
          }
        }
        if (!edit) continue;
        repairs.push({
          title: `${node ? 'Set' : 'Insert'} ${parts(path).at(-1)} to ${JSON.stringify(choice.value)} (${choice.label.toLowerCase()})`,
          finding: {
            ...finding,
            edits: [
              {
                uri: indexed.file.uri,
                range: edit.range,
                text: edit.newText,
                sourceDigest: indexed.file.digest,
                ...(indexed.file.version === undefined ? {} : { version: indexed.file.version }),
              },
            ],
          },
        });
        if (repairs.length >= 64) return repairs;
      }
    }
    return repairs;
  }
}
