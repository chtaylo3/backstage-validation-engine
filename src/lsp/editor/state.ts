import type { Immutable } from '../../base/json.js';
import { digestText, immutableJson } from '../../base/json.js';
import { capabilityBinding } from '../../capabilities/bindings.js';
import type { CapabilitySession } from '../../capabilities/session.js';
import type {
  CapabilityId,
  CapabilityInputs,
  CapabilityOutputs,
  Presence,
} from '../../capabilities/schemas.js';
import type { JsonValue, ValidationRequest } from '../../contracts/schemas.js';
import type { PreparedRuleMetadata } from '../../host/rule-contributions.js';
import { RULE_EDITOR_LIMITS } from '../../host/rule-contributions.js';
import type { LspConfig } from '../config.js';
import type { EditorDocument, EditorFile } from '../editor-documents.js';
import { object, parts, resolveFields } from '../editor-schemas.js';
import type { EditorSchema, ResolvedField } from '../editor-schemas.js';
import type { FixDocument } from '../fixes.js';

export interface IndexedDocument {
  readonly subjectId?: string;
  readonly document: EditorDocument;
  readonly schemas: readonly EditorSchema[];
  readonly basePath: string;
  readonly schemaValue: unknown;
  readonly subjectStage: 'authored' | 'resolved' | 'normalized';
}
export interface IndexedFile {
  readonly file: EditorFile;
  readonly documents: readonly IndexedDocument[];
}
export interface CapabilityOptions {
  readonly provider?: CapabilitySession;
  readonly sessionGeneration?: number;
  readonly dependencyGeneration?: () => number;
  readonly authorityContextDigest?: string;
}

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
/** A replacement scalar in the quoting style of the text it replaces. */
export function encoded(value: unknown, raw: string, json: boolean): string {
  if (typeof value === 'string' && !json && raw.startsWith("'"))
    return `'${value.replace(/'/gu, "''")}'`;
  return JSON.stringify(value);
}
/** Exact normalized array indices cannot turn one candidate proof into an item-wide hint. */
export function ruleSegments(
  value: unknown,
  path: string,
): { name: string; index?: number }[] | undefined {
  const segments: { name: string; index?: number }[] = [];
  for (const name of parts(path)) {
    if (Array.isArray(value)) {
      const index = Number(name);
      if (!/^(?:0|[1-9][0-9]*)$/u.test(name) || index >= RULE_EDITOR_LIMITS.arrayItems)
        return undefined;
      segments.push({ name, index });
      value = value[index];
    } else {
      segments.push({ name });
      value = object(value) ? value[name] : undefined;
    }
  }
  return segments;
}

/**
 * The state that the editor features share: the generation-scoped index, the installed rule
 * contributions, and the capability session that answers metadata queries. The `EditorService`
 * facade owns one instance; the feature modules read it and the index and rule modules write it.
 */
export class EditorState {
  native: ReadonlyMap<string, EditorSchema> = new Map();
  files = new Map<string, IndexedFile>();
  generation = -1;
  lifetime = 0;
  controller: AbortController | undefined;
  request: Immutable<ValidationRequest> | undefined;
  rules: readonly PreparedRuleMetadata[] = [];
  rulesWall = 0;
  rulesMonotonic = 0;
  constructor(
    readonly config: LspConfig,
    readonly capabilities: CapabilitySession,
    readonly capabilityOptions: CapabilityOptions,
  ) {}
  fields(selected: IndexedDocument, path: string): ResolvedField[] {
    return resolveFields(selected.schemas, selected.basePath + path, selected.schemaValue);
  }
  /** The indexed file when it matches the open document of the same generation. */
  current(
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
  /** Installed rule contributions that have not expired by wall or monotonic time. */
  currentRules(): readonly PreparedRuleMetadata[] {
    const now = Date.now(),
      elapsed = performance.now() - this.rulesMonotonic;
    return now < this.rulesWall
      ? []
      : this.rules.filter((row) => now < row.expiresAt && elapsed < row.expiresAt - this.rulesWall);
  }
  metadata(
    selected: IndexedDocument,
    path: string,
    includeRules = true,
    rulesOnly = false,
  ): CapabilityInputs['hover'] {
    const schemas: EditorSchema[] = rulesOnly ? [] : [...selected.schemas];
    for (const row of this.currentRules()) {
      if (!includeRules || row.subjectId !== selected.subjectId) continue;
      const segments = ruleSegments(selected.schemaValue, row.path);
      if (!segments) continue;
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
      for (const segment of segments.reverse()) {
        if (segment.index !== undefined) {
          const items: (Record<string, unknown> | true)[] = Array.from(
            { length: segment.index + 1 },
            () => true as const,
          );
          items[segment.index] = root;
          root = { items };
        } else root = { properties: { [segment.name]: root } };
      }
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
  /** A prepared capability answer for the indexed request of `generation`, else undefined. */
  contribution<K extends CapabilityId>(
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
}
