import { CompletionItemKind, InsertTextFormat, MarkupKind } from 'vscode-languageserver/node';
import type {
  CompletionList,
  CompletionParams,
  Hover,
  Position,
  Location,
  TextEdit,
} from 'vscode-languageserver/node';
import type { Finding, JsonValue, ValidationRequest } from '../contracts/schemas.js';
import type { Immutable } from '../core/json.js';
import { digestText, immutableJson } from '../core/json.js';
import { builtinMetadataSession } from '../capabilities/builtin-metadata.js';
import { capabilityBinding } from '../capabilities/bindings.js';
import type { CapabilitySession } from '../capabilities/session.js';
import type {
  CapabilityId,
  CapabilityInputs,
  CapabilityOutputs,
  Presence,
} from '../capabilities/schemas.js';
import { BUILTIN_KINDS } from '../compatibility/types.js';
import { getSharedCelRuntime } from '../runtime/cel/index.js';
import { ParsingBudget } from '../parsing/budget.js';
import { SourceLineIndex } from '../parsing/locations.js';
import { admitsKind } from '../policy/admission.js';
import { editorDocuments, editorTarget } from './editor-documents.js';
import type { EditorDocument, EditorFile } from './editor-documents.js';
import {
  nativeEditorSchemas,
  object,
  parts,
  resolveFields,
  acceptsValue,
  forbidden,
} from './editor-schemas.js';
import type { EditorSchema, ResolvedField } from './editor-schemas.js';
import type { FixDocument, SuggestedFix } from './fixes.js';
import type { LspConfig } from './config.js';
import type { validatePolicySources } from '../core/policy-sources.js';
import type { PreparedRuleMetadata } from '../host/rule-contributions.js';

interface IndexedDocument {
  readonly subjectId?: string;
  readonly document: EditorDocument;
  readonly schemas: readonly EditorSchema[];
  readonly basePath: string;
  readonly schemaValue: unknown;
  readonly subjectStage: 'authored' | 'resolved' | 'normalized';
}
interface IndexedFile {
  readonly file: EditorFile;
  readonly documents: readonly IndexedDocument[];
}
const empty = (): CompletionList => ({ isIncomplete: true, items: [] });
/** Incomplete object values are absent, never converted into explicit JSON null. */
function metadataSubject(input: unknown): Presence {
  let nodes = 0;
  const visit = (value: unknown, depth: number): JsonValue => {
    if (++nodes > 100_000 || depth > 64) throw new Error('Metadata projection exceeds limits.');
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      return value;
    if (Array.isArray(value)) return value.map((child: unknown) => visit(child, depth + 1));
    if (object(value)) {
      const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      for (const [key, child] of Object.entries(value))
        if (child !== undefined) result[key] = visit(child, depth + 1);
      return result;
    }
    throw new Error('Metadata projection is incomplete.');
  };
  try {
    return input === undefined ? { state: 'absent' } : { state: 'present', value: visit(input, 0) };
  } catch {
    return { state: 'absent' };
  }
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
  private request: Immutable<ValidationRequest> | undefined;
  private rules: readonly PreparedRuleMetadata[] = [];
  private rulesWall = 0;
  private rulesMonotonic = 0;
  readonly capabilities: CapabilitySession;
  constructor(
    private readonly config: LspConfig,
    schemaLoader: typeof nativeEditorSchemas = nativeEditorSchemas,
    private readonly capabilityOptions: {
      readonly provider?: CapabilitySession;
      readonly sessionGeneration?: number;
      readonly dependencyGeneration?: () => number;
      readonly authorityContextDigest?: string;
    } = {},
  ) {
    this.capabilities =
      capabilityOptions.provider ??
      builtinMetadataSession([
        config.profile.adapterId,
        ...config.schemaArtifacts.map(
          (artifact) => `${artifact.id}@${artifact.version}:${artifact.digest}`,
        ),
        ...config.editorArtifacts.map((artifact) => `${artifact.id}:${artifact.digest}`),
      ]);
    try {
      this.native = schemaLoader(config);
    } catch {
      this.native = new Map();
    }
  }
  invalidate(): void {
    this.lifetime++;
    this.generation = -1;
    this.files.clear();
    this.request = undefined;
    this.rules = [];
    this.controller?.abort();
  }
  record(value: string): void {
    if (value.length > 512) return;
    this.history.delete(value);
    this.history.set(value, ++this.clock);
    if (this.history.size > 128) this.history.delete(this.history.keys().next().value!);
  }
  async update(request: Immutable<ValidationRequest>, generation: number): Promise<void> {
    this.rules = [];
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
                artifactIdentity: artifact.digest,
                ...(label.startsWith('Policy ') ? { ruleId: label.slice(7) } : {}),
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
      if (lifetime === this.lifetime && !controller.signal.aborted) {
        this.files = files;
        this.request = request;
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
    if (this.generation === generation && this.files === original) {
      this.files = files;
      this.request = report.request;
    }
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
  private metadata(
    selected: IndexedDocument,
    path: string,
    includeRules = true,
    rulesOnly = false,
  ): CapabilityInputs['hover'] {
    const schemas: EditorSchema[] = rulesOnly ? [] : [...selected.schemas];
    for (const row of this.currentRules()) {
      if (!includeRules || row.subjectId !== selected.subjectId) continue;
      let root: Record<string, unknown> = {
        description: `${row.description}\nRule: ${row.ruleId}. Candidates pass the checked rule after the full pipeline runs. Other findings can remain.`,
        examples: row.candidates.map((candidate) => candidate.value),
        $bveEditorCandidates: row.candidates.map((candidate) => ({
          value: candidate.value,
          label: candidate.label.replace('; checked rule ', '; Checked rule '),
          classification: candidate.label.startsWith('Declared default')
            ? 'default'
            : candidate.label.startsWith('Declared example')
              ? 'example'
              : 'suggestion',
        })),
      };
      for (const name of parts(row.path).reverse()) root = { properties: { [name]: root } };
      schemas.push({
        root,
        names: new Map(),
        label: `Editor rule ${row.ruleId}`,
        artifactIdentity: row.artifactDigest,
        ruleId: row.ruleId,
      });
    }
    return {
      path: selected.basePath + path,
      subjectStage: selected.subjectStage,
      scope:
        object(selected.schemaValue) &&
        typeof selected.schemaValue.kind === 'string' &&
        typeof selected.schemaValue.apiVersion === 'string'
          ? {
              status: 'known',
              kind: selected.schemaValue.kind,
              apiVersion: selected.schemaValue.apiVersion,
            }
          : { status: 'unknown' },
      subject: metadataSubject(selected.schemaValue),
      schemas: schemas.map((schema) => ({
        root: immutableJson(schema.root) as JsonValue,
        definitions: Object.fromEntries(
          [...schema.names].map(([name, value]) => [name, immutableJson(value) as JsonValue]),
        ),
        label: schema.label,
        ...(schema.artifactIdentity ? { artifactDigest: schema.artifactIdentity } : {}),
        ...(schema.ruleId ? { ruleId: schema.ruleId } : {}),
      })),
    };
  }
  installRuleContributions(rows: readonly PreparedRuleMetadata[], generation: number): void {
    if (this.generation === generation) {
      this.rules = rows;
      this.rulesWall = Date.now();
      this.rulesMonotonic = performance.now();
    }
  }
  private currentRules(): readonly PreparedRuleMetadata[] {
    const now = Date.now(),
      elapsed = performance.now() - this.rulesMonotonic;
    return now < this.rulesWall
      ? []
      : this.rules.filter((row) => now < row.expiresAt && elapsed < row.expiresAt - this.rulesWall);
  }
  get ruleExpiresAt(): number {
    return Math.min(Infinity, ...this.rules.map((row) => row.expiresAt));
  }
  ruleRepairs(generation: number, documents: ReadonlyMap<string, FixDocument>): SuggestedFix[] {
    return this.currentRules().flatMap((row) =>
      row.candidates.flatMap((candidate) => {
        const finding = candidate.repair;
        const indexed = finding && this.current(finding.location.uri, generation, documents);
        const selected = indexed?.documents.find(
          (selected) => selected.document.ordinal === finding?.location.document,
        );
        if (!finding || !selected) return [];
        const node = selected.document.nodes.get(finding.location.path);
        const logical = this.contribution(
          'repairs',
          {
            ...this.metadata(selected, finding.location.path),
            findingId: finding.id,
            subjectId: row.subjectId,
            current: node
              ? { state: 'present', value: immutableJson(node.value) as JsonValue }
              : { state: 'absent' },
            required: false,
          },
          generation,
        )?.proposals.some(
          (proposal) =>
            proposal.subjectId === row.subjectId &&
            proposal.findingId === finding.id &&
            proposal.path === row.path &&
            proposal.operation === (node ? 'setValue' : 'insertProperty') &&
            JSON.stringify(proposal.value) === JSON.stringify(candidate.value),
        );
        return logical
          ? [
              {
                title: `Set ${parts(row.path).at(-1)} to ${JSON.stringify(candidate.value)} (checked rule ${row.ruleId})`,
                finding,
              },
            ]
          : [];
      }),
    );
  }
  /** Render only a qualified scalar or an unambiguous map insertion in one authored file. */
  renderRuleCandidate(
    subjectId: string,
    path: string,
    value: JsonValue,
    ruleId: string,
    generation: number,
    documents: ReadonlyMap<string, FixDocument>,
    findings: readonly Immutable<Finding>[],
  ): Immutable<Finding> | undefined {
    const targets = [...this.files.values()].flatMap((file) =>
      file.documents.flatMap((selected) =>
        selected.subjectId === subjectId &&
        (path === selected.basePath || path.startsWith(selected.basePath + '/'))
          ? [{ file, selected, path: path.slice(selected.basePath.length) }]
          : [],
      ),
    );
    // A payload takes precedence over its substitution marker in the entrypoint.
    targets.sort((a, b) => b.selected.basePath.length - a.selected.basePath.length);
    const target = targets[0];
    if (
      !target ||
      !this.current(target.file.file.uri, generation, documents) ||
      !target.selected.document.valid
    )
      return undefined;
    const { file: indexed, selected } = target;
    const node = selected.document.nodes.get(target.path);
    let edit: TextEdit | undefined;
    if (node && !node.blocked && !node.container) {
      const raw = indexed.file.text.slice(node.start, node.end);
      if (!/[\r\n]/u.test(raw))
        edit = {
          range: indexed.file.lines.range(node.start, node.end),
          newText: encoded(value, raw, indexed.file.json),
        };
    } else if (!node && target.path) {
      const parent = selected.document.nodes.get(
        target.path.slice(0, target.path.lastIndexOf('/')),
      );
      const name = parts(target.path).at(-1)!;
      if (parent?.container === 'map' && !parent.blocked) {
        if (parent.flow || indexed.file.json) {
          const offset = parent.end - 1;
          if (indexed.file.text[offset] === '}')
            edit = {
              range: indexed.file.lines.range(offset, offset),
              newText: `${object(parent.value) && Object.keys(parent.value).length ? ', ' : ''}${JSON.stringify(name)}: ${JSON.stringify(value)}`,
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
            const next = /\r\n|\r|\n/u.exec(indexed.file.text.slice(offset));
            offset = next ? offset + next.index + next[0].length : indexed.file.text.length;
          }
          edit = {
            range: indexed.file.lines.range(offset, offset),
            newText: `${offset && !/[\r\n]/u.test(indexed.file.text[offset - 1]!) ? newline : ''}${' '.repeat(indent)}${JSON.stringify(name)}: ${JSON.stringify(value)}${newline}`,
          };
        }
      }
    }
    const finding = findings.find((row) => row.subjectId === subjectId && row.ruleId === ruleId);
    if (!edit) return undefined;
    const location = {
      uri: indexed.file.uri,
      document: selected.document.ordinal,
      path: target.path,
      range: edit.range,
    };
    return {
      ...(finding ?? {
        id: digestText(JSON.stringify([subjectId, ruleId, path])),
        ruleId,
        ruleVersion: 'editor',
        subjectId,
        message: 'Declared editor candidate.',
        category: 'policy' as const,
        severity: 'warning' as const,
        enforcement: 'advisory' as const,
        relatedLocations: [],
      }),
      location,
      edits: [
        {
          uri: indexed.file.uri,
          sourceDigest: indexed.file.digest,
          ...(indexed.file.version === undefined ? {} : { version: indexed.file.version }),
          range: edit.range,
          text: edit.newText,
        },
      ],
    };
  }
  private contribution<K extends CapabilityId>(
    id: K,
    input: CapabilityInputs[K],
    generation: number,
  ): Immutable<CapabilityOutputs[K]> | undefined {
    const request = this.request,
      lifetime = this.lifetime;
    if (!request || this.generation !== generation) return undefined;
    try {
      const result = this.capabilities.providePrepared(id, input, {
        requestId: request.run.runId,
        binding: capabilityBinding(request, {
          workspaceGeneration: generation,
          sessionGeneration: this.capabilityOptions.sessionGeneration ?? 0,
          dependencyGeneration: this.capabilityOptions.dependencyGeneration?.() ?? 0,
          ...(this.capabilityOptions.authorityContextDigest
            ? { authorityContextDigest: this.capabilityOptions.authorityContextDigest }
            : {}),
        }),
        deadlineAt: Date.now() + Math.min(50, this.config.profile.limits.requestTimeoutMs),
        current: () =>
          this.request === request && this.lifetime === lifetime && this.generation === generation,
      });
      return result.status === 'ready' ? result.value : undefined;
    } catch {
      return undefined;
    }
  }
  async close(): Promise<void> {
    this.invalidate();
    await this.capabilities.close();
  }
  complete(
    params: CompletionParams,
    generation: number,
    documents: ReadonlyMap<string, FixDocument>,
    rulesOnly = false,
  ): CompletionList {
    const indexed = this.current(params.textDocument.uri, generation, documents);
    if (!indexed) return empty();
    const target = editorTarget(indexed.file, params.position);
    const selected = indexed.documents.find((row) => row.document === target?.document);
    if (!target || !selected) return empty();
    if (target.key) {
      const existing = selected.document.nodes.get(target.path)?.value;
      const metadata = this.contribution(
        'fields',
        {
          ...this.metadata(selected, target.path, true, rulesOnly),
          prefix: target.prefix,
          existing: object(existing) ? Object.keys(existing) : [],
        },
        generation,
      );
      if (!metadata) return empty();
      return {
        isIncomplete: true,
        items: metadata.fields.map((field, index) => {
          const key = field.name,
            required = field.required;
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
          const value = field.initialValue;
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
            documentation: { kind: MarkupKind.PlainText, value: field.description },
            sortText: String(index).padStart(3, '0'),
            insertTextFormat: InsertTextFormat.PlainText,
            textEdit: { range: target.range, newText: name + suffix },
          };
        }),
      };
    }
    const supplied = this.contribution(
      'values',
      {
        ...this.metadata(selected, target.path, true, rulesOnly),
        ...(!selected.basePath && target.path === '/kind'
          ? {
              kinds: [
                ...BUILTIN_KINDS,
                ...this.config.profile.customKinds.map((row) => row.kind),
              ].filter((kind) => admitsKind(this.config.profile, indexed.file.uri, kind)),
            }
          : {}),
      },
      generation,
    );
    const values = (supplied?.candidates ?? []).filter(({ value }) =>
      acceptsValue(this.fields(selected, target.path), value),
    );
    const description =
      this.contribution('hover', this.metadata(selected, target.path, true, rulesOnly), generation)
        ?.text ?? '';
    const raw = indexed.file.text.slice(
      indexed.file.lines.offset(target.range.start),
      indexed.file.lines.offset(target.range.end),
    );
    return {
      isIncomplete: true,
      items: values
        .filter(({ value }) =>
          (typeof value === 'string' ? value : JSON.stringify(value))
            .toLowerCase()
            .startsWith(target.prefix.toLowerCase()),
        )
        .sort(
          (a, b) =>
            (this.history.get(typeof b.value === 'string' ? b.value : JSON.stringify(b.value)) ??
              0) -
            (this.history.get(typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) ??
              0),
        )
        .slice(0, 100)
        .map(({ value, label }, index) => ({
          label: typeof value === 'string' ? value : JSON.stringify(value),
          kind: CompletionItemKind.Value,
          detail: label,
          documentation: { kind: MarkupKind.PlainText, value: description },
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
        const value = this.contribution(
          'hover',
          this.metadata(selected, node.path),
          generation,
        )?.text;
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
    const reference = this.contribution(
      'references',
      {
        path: selected.basePath + target.path,
        value,
        defaultKind: pattern.defaultKind,
        namespace,
      },
      generation,
    )?.references[0]?.identity;
    if (!reference) return [];
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
      const node = selected.document.nodes.get(path);
      const name = parts(path).at(-1);
      const parentFields = this.fields(selected, path.slice(0, path.lastIndexOf('/')));
      const supplied = this.contribution(
        'repairs',
        {
          ...this.metadata(selected, path, false),
          findingId: finding.id,
          subjectId: JSON.stringify([finding.location.uri, finding.location.document]),
          current: node
            ? { state: 'present', value: immutableJson(node.value) as JsonValue }
            : { state: 'absent' },
          required: parentFields.some(
            ({ node }) => Array.isArray(node.required) && node.required.includes(name),
          ),
        },
        generation,
      );
      const choices = supplied?.proposals ?? [];
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
