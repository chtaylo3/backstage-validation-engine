import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { DeploymentProfile, JsonValue, SourceSnapshot } from '../contracts/schemas.js';
import { deepFreeze } from '../base/json.js';
import type { Immutable } from '../base/json.js';
import { createSourceSnapshot } from '../core/snapshots.js';
import { isCanonicalSourceUri } from '../base/source-uris.js';
import { locateParsedPath, parseSourceSnapshot, SourceLineIndex } from '../parsing/index.js';
import { childPointer } from '../parsing/locations.js';
import type {
  NodeSourceSpan,
  ParsedSourceDocument,
  ParsingReport,
  SourceLocation,
} from '../parsing/index.js';
import type { RequestBudget } from '../runtime/request-budget.js';
import type { SourceSubstitution } from './types.js';

export const SUBSTITUTION_MESSAGES = Object.freeze({
  unsupported_substitution: 'A pinned local source root and snapshot-local reader are required.',
  unsupported_reader: 'This inclusion requires an unavailable source reader.',
  unsupported_target: 'Pattern-based Location targets are outside the declared reader surface.',
  invalid_substitution:
    'A substitution must contain exactly one supported marker with a path string.',
  unsafe_path: 'Inclusion path is outside the pinned local source boundary.',
  missing_inclusion: 'Required inclusion is absent from the proposed source snapshot.',
  invalid_inclusion: 'Included content does not satisfy the declared JSON/YAML source profile.',
  cyclic_inclusion: 'Source inclusions contain a cycle.',
  resource_limit: 'Source resolution exceeds configured resource limits.',
});
export type SubstitutionCode = keyof typeof SUBSTITUTION_MESSAGES;
export class SourceResolutionError extends Error {
  constructor(
    readonly code: SubstitutionCode,
    readonly path: string,
    readonly location: Immutable<SourceLocation>,
    readonly relatedLocations: readonly Immutable<SourceLocation>[] = [],
  ) {
    super(SUBSTITUTION_MESSAGES[code]);
  }
  get unsupported(): boolean {
    return ['unsupported_substitution', 'unsupported_reader', 'unsupported_target'].includes(
      this.code,
    );
  }
}
export interface SourceCandidate {
  readonly document: ParsedSourceDocument;
}
type Marker = SourceSubstitution['kind'];
const MARKERS: readonly string[] = ['$text', '$json', '$yaml'];
const VALUES = 100_000;
const uniqueLocations = (locations: readonly Immutable<SourceLocation>[]) => [
  ...new Map(locations.map((location) => [JSON.stringify(location), location])).values(),
];

/** Resolves only snapshot bytes. Live files, symlinks, environment and network are never read. */
export class SnapshotSourceResolver {
  private readonly files;
  private readonly cache = new Map<string, Promise<ParsingReport>>();
  private readonly loaded = new Set<string>();
  private readonly graph = new Map<string, Set<string>>();
  private readonly levels = new Map<string, number>();
  private visits = 0;
  private expansions = 0;
  private outputBytes = 0;
  private documents: number;

  constructor(
    private readonly source: Immutable<SourceSnapshot>,
    private readonly profile: Immutable<DeploymentProfile>,
    private readonly mode: 'ci' | 'ide',
    private readonly budget: RequestBudget,
    parsed: ParsingReport,
  ) {
    this.files = new Map(source.files.map((file) => [file.uri, file]));
    for (const file of parsed.files) this.loaded.add(file.uri);
    this.documents = parsed.documents.length;
  }
  private fail(
    code: SubstitutionCode,
    document: ParsedSourceDocument,
    path: string,
    related: readonly Immutable<SourceLocation>[] = [],
  ): never {
    throw new SourceResolutionError(
      code,
      path,
      locateParsedPath(document, path),
      uniqueLocations([...related, ...(document.locations[path]?.relatedLocations ?? [])]),
    );
  }
  private async step(document: ParsedSourceDocument, path: string) {
    this.budget.throwIfInterrupted();
    if (++this.visits > VALUES) this.fail('resource_limit', document, path);
    if (this.visits % 128 === 0) {
      await yieldTurn();
      this.budget.throwIfInterrupted();
    }
  }
  private target(
    document: ParsedSourceDocument,
    path: string,
    value: string,
    location = false,
  ): string {
    if (!this.source.rootUri || !this.profile.readers.includes('snapshot-local'))
      this.fail('unsupported_substitution', document, path);
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) this.fail('unsupported_reader', document, path);
    if (
      !value ||
      value.length > 4096 ||
      value.trim() !== value ||
      value.startsWith('/') ||
      value.startsWith('\\') ||
      /[\\%:#?\p{Cc}]/u.test(value)
    )
      this.fail('unsafe_path', document, path);
    if (location && /[*[\]{}!]/.test(value)) this.fail('unsupported_target', document, path);
    const target = new URL(value, locateParsedPath(document, path).uri).href;
    if (!isCanonicalSourceUri(target) || !target.startsWith(this.source.rootUri))
      this.fail('unsafe_path', document, path);
    return target;
  }
  private parsed(uri: string): Promise<ParsingReport> {
    let pending = this.cache.get(uri);
    if (!pending) {
      const file = this.files.get(uri)!;
      pending = parseSourceSnapshot(
        createSourceSnapshot({
          repository: this.source.repository,
          revision: this.source.revision,
          files: [file],
        }),
        {
          mode: this.mode,
          deadlineAt: this.budget.deadlineAt,
          signal: this.budget.signal,
          clock: this.budget.clock,
          limits: {
            fileBytes: this.profile.limits.fileBytes,
            requestBytes: this.profile.limits.requestBytes,
            documentBytes: this.profile.limits.expandedEntityBytes,
            documents: this.profile.limits.entities,
          },
        },
      );
      this.cache.set(uri, pending);
    }
    return pending;
  }

  async resolve(document: ParsedSourceDocument) {
    const locations: Record<string, NodeSourceSpan> = {};
    const substitutions: SourceSubstitution[] = [];
    let bytes = 0;
    const charge = (text: string, owner: ParsedSourceDocument, path: string) => {
      const count = Buffer.byteLength(text, 'utf8');
      bytes += count;
      this.outputBytes += count;
      if (
        bytes > this.profile.limits.expandedEntityBytes ||
        this.outputBytes > this.profile.limits.requestBytes
      )
        this.fail('resource_limit', owner, path);
    };
    const visit = async (
      value: Immutable<JsonValue>,
      owner: ParsedSourceDocument,
      path: string,
      output: string,
      stack: readonly string[],
      trail: readonly Immutable<SourceLocation>[],
      depth: number,
    ): Promise<JsonValue> => {
      await this.step(owner, path);
      if (depth > 64) this.fail('resource_limit', owner, path, trail);
      const span = owner.locations[path];
      if (span)
        locations[output] = {
          ...span,
          ...(owner.uri === document.uri && owner.document === document.document && path === output
            ? {}
            : {
                source: {
                  uri: owner.uri,
                  document: owner.document,
                  path,
                  sourceDigest: owner.sourceDigest,
                  ...(owner.version === undefined ? {} : { version: owner.version }),
                },
              }),
          relatedLocations: uniqueLocations([...span.relatedLocations, ...trail]),
        };
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const keys = Object.keys(value);
        const markers = keys.filter((key) => MARKERS.includes(key));
        if (markers.length) {
          const marker = markers[0]! as Marker;
          const markerPath = childPointer(path, marker);
          const reference = (value as Readonly<Record<string, Immutable<JsonValue>>>)[marker];
          if (keys.length !== 1 || typeof reference !== 'string' || !reference)
            this.fail('invalid_substitution', owner, markerPath, trail);
          if (++this.expansions > 1000 || stack.length > this.profile.limits.substitutionDepth)
            this.fail('resource_limit', owner, markerPath, trail);
          const uri = this.target(owner, markerPath, reference);
          const file = this.files.get(uri);
          if (!file) this.fail('missing_inclusion', owner, markerPath, trail);
          const origin = locateParsedPath(owner, markerPath);
          const related = uniqueLocations([
            ...trail,
            origin,
            ...(owner.locations[markerPath]?.relatedLocations ?? []),
          ]);
          substitutions.push({
            path: output,
            kind: marker,
            origin,
            target: {
              uri,
              sourceDigest: file.digest,
              ...(file.version === undefined ? {} : { version: file.version }),
            },
          });
          if (marker === '$text') {
            charge(JSON.stringify(file.text), owner, markerPath);
            locations[output] = {
              value: new SourceLineIndex(file.text).range(0, file.text.length),
              origin: 'authored',
              relatedLocations: related,
              source: {
                uri,
                document: 0,
                path: '',
                sourceDigest: file.digest,
                ...(file.version === undefined ? {} : { version: file.version }),
              },
            };
            return file.text;
          }
          if (stack.includes(uri)) this.fail('cyclic_inclusion', owner, markerPath, trail);
          if (marker === '$json') {
            try {
              JSON.parse(file.text);
            } catch {
              throw new SourceResolutionError(
                'invalid_inclusion',
                output,
                {
                  uri,
                  document: 0,
                  path: '',
                  range: new SourceLineIndex(file.text).range(0, file.text.length),
                },
                related,
              );
            }
          }
          const parsed = await this.parsed(uri);
          this.budget.throwIfInterrupted();
          if (parsed.interrupted !== 'none')
            this.fail('resource_limit', owner, markerPath, related);
          if (
            parsed.files[0]?.status !== 'parsed' ||
            parsed.documents.length !== 1 ||
            parsed.files[0].documentsScanned !== 1
          ) {
            const issue = parsed.diagnostics[0];
            if (issue)
              throw new SourceResolutionError(
                'invalid_inclusion',
                output,
                issue.location,
                uniqueLocations([...related, ...issue.relatedLocations]),
              );
            this.fail('invalid_inclusion', owner, markerPath, related);
          }
          return visit(
            parsed.documents[0]!.value,
            parsed.documents[0]!,
            '',
            output,
            [...stack, uri],
            related,
            depth,
          );
        }
      }
      if (Array.isArray(value)) {
        const items = value as readonly Immutable<JsonValue>[];
        charge('[', owner, path);
        const result: JsonValue[] = [];
        for (let index = 0; index < value.length; index++) {
          if (index) charge(',', owner, path);
          result.push(
            await visit(
              items[index]!,
              owner,
              childPointer(path, index),
              childPointer(output, index),
              stack,
              trail,
              depth + 1,
            ),
          );
        }
        charge(']', owner, path);
        return result;
      }
      if (value !== null && typeof value === 'object') {
        charge('{', owner, path);
        const result: Record<string, JsonValue> = {};
        let index = 0;
        for (const [key, child] of Object.entries(value)) {
          charge((index++ ? ',' : '') + JSON.stringify(key) + ':', owner, path);
          Object.defineProperty(result, key, {
            value: await visit(
              child,
              owner,
              childPointer(path, key),
              childPointer(output, key),
              stack,
              trail,
              depth + 1,
            ),
            enumerable: true,
          });
        }
        charge('}', owner, path);
        return result;
      }
      charge(JSON.stringify(value), owner, path);
      return value;
    };
    const value = await visit(document.value, document, '', '', [document.uri], [], 0);
    this.budget.throwIfInterrupted();
    return deepFreeze({ document: { ...document, locations }, value, substitutions });
  }

  private async edge(document: ParsedSourceDocument, path: string, target: string) {
    const parents = [target];
    const seen = new Set<string>();
    while (parents.length) {
      await this.step(document, path);
      const uri = parents.pop()!;
      if (uri === document.uri) this.fail('cyclic_inclusion', document, path);
      if (seen.has(uri)) continue;
      seen.add(uri);
      parents.push(...(this.graph.get(uri) ?? []));
    }
    const children = this.graph.get(document.uri) ?? new Set<string>();
    children.add(target);
    this.graph.set(document.uri, children);
    const queue = [{ uri: target, level: (this.levels.get(document.uri) ?? 0) + 1 }];
    while (queue.length) {
      await this.step(document, path);
      const next = queue.pop()!;
      if (next.level > this.profile.limits.substitutionDepth)
        this.fail('resource_limit', document, path);
      if ((this.levels.get(next.uri) ?? 0) >= next.level) continue;
      this.levels.set(next.uri, next.level);
      for (const uri of this.graph.get(next.uri) ?? []) queue.push({ uri, level: next.level + 1 });
    }
  }

  async discover(document: ParsedSourceDocument, value: Immutable<JsonValue>) {
    const documents: SourceCandidate[] = [];
    const reports: ParsingReport[] = [];
    const issues: SourceResolutionError[] = [];
    const spec = (value as Readonly<Record<string, Immutable<JsonValue>>>).spec as Readonly<
      Record<string, Immutable<JsonValue>>
    >;
    const targets: { value: string; path: string }[] = [];
    if (typeof spec.target === 'string') targets.push({ value: spec.target, path: '/spec/target' });
    if (Array.isArray(spec.targets))
      for (const [index, target] of spec.targets.entries())
        targets.push({ value: target as string, path: `/spec/targets/${index}` });
    for (const target of targets) {
      try {
        await this.step(document, target.path);
        if (spec.type !== undefined && spec.type !== 'file')
          this.fail('unsupported_reader', document, target.path);
        const uri = this.target(document, target.path, target.value, true);
        const file = this.files.get(uri);
        if (!file) {
          if (spec.presence === 'optional') continue;
          this.fail('missing_inclusion', document, target.path);
        }
        await this.edge(document, target.path, uri);
        if (this.loaded.has(uri)) continue;
        this.loaded.add(uri);
        if (this.loaded.size > this.profile.limits.entities)
          this.fail('resource_limit', document, target.path);
        const parsed = await this.parsed(uri);
        const parent = locateParsedPath(document, target.path);
        const related = uniqueLocations([
          parent,
          ...(document.locations[target.path]?.relatedLocations ?? []),
        ]);
        reports.push({
          ...parsed,
          sourceDigest: this.source.digest,
          diagnostics: parsed.diagnostics.map((issue) => ({
            ...issue,
            relatedLocations: uniqueLocations([...issue.relatedLocations, ...related]),
          })),
        });
        for (const child of parsed.documents) {
          if (++this.documents > this.profile.limits.entities)
            this.fail('resource_limit', document, target.path);
          documents.push({
            document: {
              ...child,
              locations: Object.fromEntries(
                Object.entries(child.locations).map(([path, span]) => [
                  path,
                  {
                    ...span,
                    relatedLocations: uniqueLocations([...span.relatedLocations, ...related]),
                  },
                ]),
              ),
            },
          });
        }
      } catch (error) {
        if (!(error instanceof SourceResolutionError)) throw error;
        issues.push(error);
        if (error.code === 'resource_limit') break;
      }
    }
    return { documents, reports, issues };
  }
}
