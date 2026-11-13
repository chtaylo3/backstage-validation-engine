import { randomUUID } from 'node:crypto';
import type {
  CodeAction,
  CodeActionParams,
  Diagnostic,
  Range,
  WorkspaceEdit,
} from 'vscode-languageserver/node';
import type { Finding, SourceSnapshot } from '../contracts/schemas.js';
import type { Immutable } from '../base/json.js';
import { digestText } from '../base/json.js';
import { SourceLineIndex } from '../parsing/locations.js';

export const APPLY_FIX_COMMAND = 'bve.applyFix';
export const FIX_LIMITS = Object.freeze({
  candidates: 64,
  tokens: 128,
  actions: 32,
  edits: 16,
  textBytes: 16 * 1024,
  ttlMs: 60_000,
  applyMs: 5000,
});
export const FIX_TITLE = 'Apply policy-required scalar value';
export interface FixDocument {
  readonly uri: string;
  readonly version: number;
  getText(): string;
}
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function offsets(text: string, range: Immutable<Range>): readonly [number, number] | undefined {
  if (!range?.start || !range.end) return undefined;
  const index = new SourceLineIndex(text);
  const start = index.offset(range.start),
    end = index.offset(range.end);
  if (start === undefined || end === undefined || start > end) return undefined;
  for (const offset of [start, end]) {
    const before = text.charCodeAt(offset - 1),
      after = text.charCodeAt(offset);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
      return undefined;
  }
  return [start, end];
}

/** Versioned edits for one open document only; no filesystem/resource operations. */
export function checkedFixEdit(
  edits: Immutable<Finding['edits']>,
  documents: ReadonlyMap<string, FixDocument>,
  limits: {
    readonly fileBytes: number;
    readonly requestBytes: number;
    readonly sourceBytes: number;
    readonly atomicTextEdits: boolean;
  },
): WorkspaceEdit | undefined {
  if (
    !edits.length ||
    edits.length > FIX_LIMITS.edits ||
    (edits.length > 1 && !limits.atomicTextEdits)
  )
    return undefined;
  const first = edits[0]!;
  const document = documents.get(first.uri);
  if (
    !document ||
    edits.some(
      (edit) =>
        edit.uri !== first.uri || edit.version === undefined || edit.version !== document.version,
    )
  )
    return undefined;
  const text = document.getText();
  if (!wellFormed(text)) return undefined;
  const digest = digestText(text);
  let bytes = 0;
  const rows = [];
  for (const edit of edits) {
    bytes += Buffer.byteLength(edit.text);
    const span = offsets(text, edit.range);
    if (
      !span ||
      edit.sourceDigest !== digest ||
      bytes > FIX_LIMITS.textBytes ||
      !wellFormed(edit.text)
    )
      return undefined;
    rows.push({ edit, start: span[0], end: span[1] });
  }
  rows.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < rows.length; i++) {
    const before = rows[i - 1]!,
      current = rows[i]!;
    if (
      current.start < before.end ||
      (current.start === before.end &&
        (current.start === current.end || before.start === before.end))
    )
      return undefined;
  }
  let updated = text;
  for (const row of [...rows].reverse())
    updated = updated.slice(0, row.start) + row.edit.text + updated.slice(row.end);
  const updatedBytes = Buffer.byteLength(updated);
  if (
    updatedBytes > limits.fileBytes ||
    limits.sourceBytes - Buffer.byteLength(text) + updatedBytes > limits.requestBytes
  )
    return undefined;
  return {
    documentChanges: [
      {
        textDocument: { uri: document.uri, version: document.version },
        edits: rows.map(({ edit }) => ({ range: edit.range, newText: edit.text })),
      },
    ],
  };
}
export interface SuggestedFix {
  readonly title: string;
  readonly finding: Immutable<Finding>;
}
interface Candidate {
  readonly finding: Immutable<Finding>;
  readonly title: string;
}
interface State {
  readonly generation: number;
  readonly frames: ReadonlyMap<string, { readonly version: number; readonly digest: string }>;
  readonly candidates: readonly Candidate[];
  readonly sourceBytes: number;
  readonly wall: number;
  readonly monotonic: number;
  readonly expiresAt: number;
}
export type FixApplicationResult = {
  readonly applied: boolean;
  readonly reason?: 'stale' | 'invalid_request' | 'busy' | 'client_rejected' | 'client_error';
};

/** Opaque single-use commands, bound to the complete validated workspace generation. */
export class FixRegistry {
  private state: State | undefined;
  private readonly tokens = new Map<string, Candidate>();
  private applying = false;
  private awaitingChange = false;
  constructor(
    private readonly clock = { wall: () => Date.now(), monotonic: () => performance.now() },
  ) {}
  invalidate(): void {
    this.state = undefined;
    this.tokens.clear();
    this.awaitingChange = false;
  }
  replace(input: {
    readonly generation: number;
    readonly findings: readonly Immutable<Finding>[];
    readonly suggestions?: readonly SuggestedFix[];
    readonly source: Immutable<SourceSnapshot>;
    readonly baseline?: Immutable<SourceSnapshot>;
    readonly documents: ReadonlyMap<string, FixDocument>;
    readonly expiresAt: number;
  }): void {
    this.invalidate();
    const frames = new Map(
      [...input.documents].map(([uri, document]) => [
        uri,
        { version: document.version, digest: digestText(document.getText()) },
      ]),
    );
    const sources = new Map(input.source.files.map((file) => [file.uri, file]));
    const candidates = [
      ...input.findings.map((finding) => ({ finding, title: FIX_TITLE })),
      ...(input.suggestions ?? []),
    ]
      .filter(
        ({ finding }) =>
          finding.edits.length &&
          finding.edits.every((edit) => {
            const source = sources.get(edit.uri);
            return source && source.digest === edit.sourceDigest && source.version === edit.version;
          }),
      )
      .slice(0, FIX_LIMITS.candidates)
      .map(({ finding, title }) => ({ finding, title }));
    const wall = this.clock.wall();
    this.state = {
      generation: input.generation,
      frames,
      candidates,
      wall,
      monotonic: this.clock.monotonic(),
      expiresAt: Math.min(wall + FIX_LIMITS.ttlMs, input.expiresAt),
      sourceBytes: [...input.source.files, ...(input.baseline?.files ?? [])].reduce(
        (total, file) => total + Buffer.byteLength(file.text),
        0,
      ),
    };
  }
  private current(
    generation: number,
    documents: ReadonlyMap<string, FixDocument>,
  ): State | undefined {
    const state = this.state,
      now = this.clock.wall();
    if (
      !state ||
      this.awaitingChange ||
      state.generation !== generation ||
      state.frames.size !== documents.size ||
      now < state.wall ||
      now >= state.expiresAt ||
      this.clock.monotonic() - state.monotonic >= state.expiresAt - state.wall
    )
      return undefined;
    for (const [uri, expected] of state.frames) {
      const current = documents.get(uri);
      if (
        !current ||
        current.version !== expected.version ||
        digestText(current.getText()) !== expected.digest
      )
        return undefined;
    }
    return state;
  }
  actions(
    params: CodeActionParams,
    generation: number,
    documents: ReadonlyMap<string, FixDocument>,
    limits: { fileBytes: number; requestBytes: number; atomicTextEdits: boolean },
  ): CodeAction[] {
    const state = this.current(generation, documents),
      document = documents.get(params?.textDocument?.uri);
    if (
      !state ||
      this.applying ||
      !document ||
      !offsets(document.getText(), params.range) ||
      !Array.isArray(params?.context?.diagnostics) ||
      params.context.diagnostics.length > 1000 ||
      (params.context.only !== undefined &&
        (!Array.isArray(params.context.only) ||
          params.context.only.length > 64 ||
          params.context.only.some((kind) => typeof kind !== 'string' || kind.length > 128)))
    )
      return [];
    if (
      params.context.only?.length &&
      !params.context.only.some((kind) => kind === '' || kind === 'quickfix')
    )
      return [];
    const result: CodeAction[] = [];
    const query = offsets(document.getText(), params.range)!;
    for (const candidate of state.candidates) {
      const finding = candidate.finding;
      const location =
        finding.location.uri === document.uri
          ? finding.location
          : finding.relatedLocations.find((row) => row.uri === document.uri);
      if (!location) continue;
      const range = offsets(document.getText(), location.range);
      if (!range || query[0] > range[1] || query[1] < range[0]) continue;
      const shown: Diagnostic & {
        data: { findingId: string; sourceDigest: string; version: number; fixGeneration: number };
      } = {
        severity: finding.severity === 'error' ? 1 : 2,
        source: 'backstage-validation',
        code: finding.ruleId,
        message: finding.message,
        range: location.range,
        data: {
          findingId: finding.id,
          sourceDigest: digestText(document.getText()),
          version: document.version,
          fixGeneration: generation,
        },
      };
      if (
        params.context.diagnostics.length &&
        !params.context.diagnostics.some((row) => {
          if (!row || typeof row !== 'object') return false;
          const data: unknown = row.data;
          if (!data || typeof data !== 'object') return false;
          const value = data as Record<string, unknown>;
          return (
            value.findingId === finding.id &&
            value.version === document.version &&
            value.sourceDigest === digestText(document.getText()) &&
            value.fixGeneration === generation
          );
        })
      )
        continue;
      if (!checkedFixEdit(finding.edits, documents, { ...limits, sourceBytes: state.sourceBytes }))
        continue;
      const id = randomUUID();
      if (this.tokens.size >= FIX_LIMITS.tokens)
        this.tokens.delete(this.tokens.keys().next().value!);
      this.tokens.set(id, candidate);
      result.push({
        title: candidate.title,
        kind: 'quickfix',
        diagnostics: [shown],
        command: { title: candidate.title, command: APPLY_FIX_COMMAND, arguments: [id] },
      });
      if (result.length >= FIX_LIMITS.actions) break;
    }
    return result;
  }
  async apply(
    args: readonly unknown[] | undefined,
    generation: number,
    documents: ReadonlyMap<string, FixDocument>,
    limits: { fileBytes: number; requestBytes: number; atomicTextEdits: boolean },
    dispatch: (edit: WorkspaceEdit) => Promise<{ applied: boolean }>,
  ): Promise<FixApplicationResult> {
    if (!Array.isArray(args) || args.length !== 1 || typeof args[0] !== 'string')
      return { applied: false, reason: 'invalid_request' };
    if (this.applying) return { applied: false, reason: 'busy' };
    const state = this.current(generation, documents),
      candidate = this.tokens.get(args[0]);
    this.tokens.delete(args[0]);
    if (!state || !candidate) return { applied: false, reason: 'stale' };
    const edit = checkedFixEdit(candidate.finding.edits, documents, {
      ...limits,
      sourceBytes: state.sourceBytes,
    });
    if (!edit) return { applied: false, reason: 'stale' };
    this.tokens.clear();
    this.applying = true;
    try {
      const result = await dispatch(edit);
      if (result.applied === true) {
        if (this.state === state) this.awaitingChange = true;
        return { applied: true };
      }
      return { applied: false, reason: 'client_rejected' };
    } catch {
      if (this.state === state) this.awaitingChange = true;
      return { applied: false, reason: 'client_error' };
    } finally {
      this.applying = false;
    }
  }
}
