import { TextDocument } from 'vscode-languageserver-textdocument';
import type {
  TextDocumentContentChangeEvent,
  TextDocumentItem,
  VersionedTextDocumentIdentifier,
} from 'vscode-languageserver/node';
import type { SourceSnapshot } from '../contracts/schemas.js';
import { digestText } from '../core/json.js';
import type { Immutable } from '../core/json.js';
import { createSourceSnapshot, overlaySourceSnapshot } from '../core/snapshots.js';
import type { SourceInput } from '../core/snapshots.js';
import { isCanonicalSourceUri } from '../core/source-uris.js';
import { verifyRequestBindings } from '../core/bindings.js';
import { createLspRequest } from './config.js';
import type { LspConfig } from './config.js';
import { approvedFilesystemUri } from './discovery.js';

const validVersion = (version: number) => Number.isSafeInteger(version) && version >= 0;
const validUri = (uri: string) =>
  typeof uri === 'string' && uri.length <= 4096 && /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(uri);
export interface WorkspaceDocument {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  readonly lifetime: number;
  readonly digest: string;
  readonly getText: () => string;
}
export interface WorkspaceSnapshot {
  readonly generation: number;
  readonly diskGeneration: number;
  readonly capturedGeneration: number;
  readonly source: Immutable<SourceSnapshot>;
  readonly documents: readonly WorkspaceDocument[];
  readonly allDocuments: ReadonlyMap<string, WorkspaceDocument>;
}
export interface SourceFileOperation {
  readonly oldUri: string;
  readonly newUri?: string;
}
/** Sole mutable buffer owner. Features receive immutable document views, not TextDocument objects. */
export class WorkspaceState {
  private readonly openDocuments = new Map<string, TextDocument>();
  private readonly lifetimes = new Map<string, number>();
  private readonly unavailable = new Set<string>();
  private nextLifetime = 0;
  private revision = 0;
  private diskRevision: number;
  private capturedRevision = 0;
  private sourceValue: Immutable<SourceSnapshot>;
  private capacityValue = false;
  private stopped = false;
  private readonly views = new WeakMap<TextDocument, WorkspaceDocument>();
  private documentViews: ReadonlyMap<string, WorkspaceDocument> | undefined;
  constructor(private config: LspConfig) {
    this.sourceValue = config.source;
    this.diskRevision = config.filesystem ? 1 : 0;
  }
  get generation() {
    return this.revision;
  }
  get diskGeneration() {
    return this.diskRevision;
  }
  get capturedGeneration() {
    return this.capturedRevision;
  }
  get source() {
    return this.sourceValue;
  }
  get capacityExceeded() {
    return this.capacityValue;
  }
  get unavailableSources() {
    return [...this.unavailable].some((uri) => this.selected(uri));
  }
  isUnavailable(uri: string) {
    return this.unavailable.has(uri);
  }
  approved(uri: string) {
    return approvedFilesystemUri(this.config, uri);
  }
  selected(uri: string) {
    return !this.config.filesystem || this.approved(uri);
  }
  get documents(): ReadonlyMap<string, WorkspaceDocument> {
    if (!this.documentViews) {
      const documents = new Map(
        [...this.openDocuments.values()].map((document) => {
          const cached = this.views.get(document);
          if (cached) return [document.uri, cached] as const;
          const text = document.getText();
          const view = Object.freeze({
            uri: document.uri,
            languageId: document.languageId,
            version: document.version,
            lifetime: this.lifetimes.get(document.uri)!,
            digest: digestText(text),
            getText: () => text,
          });
          this.views.set(document, view);
          return [document.uri, view] as const;
        }),
      );
      const view: ReadonlyMap<string, WorkspaceDocument> = Object.freeze({
        size: documents.size,
        get: (uri: string) => documents.get(uri),
        has: (uri: string) => documents.has(uri),
        keys: () => documents.keys(),
        values: () => documents.values(),
        entries: () => documents.entries(),
        [Symbol.iterator]: () => documents[Symbol.iterator](),
        forEach: (
          callback: (
            value: WorkspaceDocument,
            key: string,
            map: ReadonlyMap<string, WorkspaceDocument>,
          ) => void,
          thisArg?: unknown,
        ) => {
          for (const [key, value] of documents) callback.call(thisArg, value, key, view);
        },
      });
      this.documentViews = view;
    }
    return this.documentViews;
  }
  document(uri: string) {
    return this.documents.get(uri);
  }
  snapshot(): WorkspaceSnapshot {
    return Object.freeze({
      generation: this.revision,
      diskGeneration: this.diskRevision,
      capturedGeneration: this.capturedRevision,
      source: this.sourceValue,
      documents: Object.freeze(
        [...this.documents.values()].filter((document) => this.selected(document.uri)),
      ),
      allDocuments: this.documents,
    });
  }
  invalidate() {
    this.revision++;
  }
  invalidateDisk() {
    this.diskRevision++;
    this.invalidate();
  }
  commitCapture(source: Immutable<SourceSnapshot>, disk: number, generation: number): boolean {
    if (this.stopped || generation !== this.revision || disk !== this.diskRevision) return false;
    this.sourceValue = source;
    this.capturedRevision = disk;
    return true;
  }
  replaceConfiguration(config: LspConfig): void {
    this.config = config;
    this.sourceValue = config.source;
    this.diskRevision++;
    this.capturedRevision = 0;
    this.invalidate();
  }
  open(item: TextDocumentItem): boolean {
    if (
      this.stopped ||
      !item ||
      !validUri(item.uri) ||
      (this.config.filesystem && !this.approved(item.uri)) ||
      !validVersion(item.version) ||
      this.openDocuments.has(item.uri) ||
      typeof item.text !== 'string'
    )
      return false;
    if (this.openDocuments.size >= 1000) {
      this.capacityValue = true;
      this.invalidate();
      return true;
    }
    const seed = TextDocument.create(item.uri, 'yaml', item.version, '');
    const document = this.changed(seed, [{ text: item.text }], item.version);
    if (!document) this.unavailable.add(item.uri);
    this.openDocuments.set(item.uri, document ?? seed);
    this.lifetimes.set(item.uri, ++this.nextLifetime);
    this.documentViews = undefined;
    this.invalidate();
    return true;
  }
  change(
    item: VersionedTextDocumentIdentifier,
    changes: TextDocumentContentChangeEvent[],
  ): boolean {
    if (this.stopped || !item) return false;
    const previous = this.openDocuments.get(item.uri);
    if (!previous || !validVersion(item.version) || item.version <= previous.version) return false;
    const first = Array.isArray(changes) ? changes[0] : undefined;
    const resynchronizing = first && typeof first === 'object' && !('range' in first);
    const document =
      this.unavailable.has(item.uri) && !resynchronizing
        ? undefined
        : this.changed(previous, changes, item.version);
    if (document) this.unavailable.delete(item.uri);
    else this.unavailable.add(item.uri);
    this.openDocuments.set(
      item.uri,
      document ?? TextDocument.create(item.uri, previous.languageId, item.version, ''),
    );
    this.documentViews = undefined;
    this.invalidate();
    return true;
  }
  closeDocument(uri: string): WorkspaceDocument | undefined {
    const previous = this.document(uri);
    if (!previous || this.stopped) return undefined;
    this.openDocuments.delete(uri);
    this.lifetimes.delete(uri);
    this.unavailable.delete(uri);
    this.documentViews = undefined;
    this.invalidate();
    return previous;
  }
  close(): void {
    this.stopped = true;
    this.openDocuments.clear();
    this.lifetimes.clear();
    this.unavailable.clear();
    this.documentViews = undefined;
    this.invalidate();
  }
  // Validate notification edits before TextDocument.update (which deliberately clamps positions).
  private changed(
    document: TextDocument,
    changes: TextDocumentContentChangeEvent[],
    version: number,
  ): TextDocument | undefined {
    if (!Array.isArray(changes) || !changes.length || changes.length > 1000) return undefined;
    let updated = TextDocument.create(
      document.uri,
      document.languageId,
      document.version,
      document.getText(),
    );
    for (const change of changes) {
      if (
        !change ||
        typeof change !== 'object' ||
        typeof change.text !== 'string' ||
        Buffer.byteLength(change.text) > this.config.profile.limits.fileBytes
      )
        return undefined;
      if ('range' in change) {
        const range = change.range;
        if (!range?.start || !range.end) return undefined;
        for (const position of [range.start, range.end]) {
          if (
            !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) ||
            position.line < 0 ||
            position.character < 0
          )
            return undefined;
          const actual = updated.positionAt(updated.offsetAt(position));
          if (actual.line !== position.line || actual.character !== position.character)
            return undefined;
        }
        if (updated.offsetAt(range.start) > updated.offsetAt(range.end)) return undefined;
      }
      updated = TextDocument.update(updated, [change], version);
      if (Buffer.byteLength(updated.getText()) > this.config.profile.limits.fileBytes)
        return undefined;
    }
    const files = new Map(
      this.sourceValue.files.map((file) => [file.uri, Buffer.byteLength(file.text)]),
    );
    for (const item of this.openDocuments.values())
      files.set(item.uri, Buffer.byteLength(item.getText()));
    files.set(updated.uri, Buffer.byteLength(updated.getText()));
    if (
      files.size > 1000 ||
      [...files.values()].reduce((a, b) => a + b, 0) > this.config.profile.limits.requestBytes
    )
      return undefined;
    return updated;
  }

  private fileUri = (uri: string) =>
    validUri(uri) &&
    isCanonicalSourceUri(uri) &&
    (!this.config.source.rootUri || uri.startsWith(this.config.source.rootUri));
  applyOperations(rows: readonly SourceFileOperation[]): readonly WorkspaceDocument[] {
    if (this.stopped) return [];
    const cleared: WorkspaceDocument[] = [];
    try {
      if (!Array.isArray(rows) || rows.length === 0 || rows.length > 1000)
        throw new Error('Invalid file operations');
      const seen = new Set<string>();
      const updates: (SourceInput | { uri: string; deleted: true })[] = [];
      const renamed = new Map<string, string>();
      for (const row of rows as readonly SourceFileOperation[]) {
        if (
          !row ||
          !this.fileUri(row.oldUri) ||
          (this.config.filesystem &&
            (!this.approved(row.oldUri) ||
              (row.newUri !== undefined && !this.approved(row.newUri)))) ||
          seen.has(row.oldUri) ||
          (row.newUri !== undefined &&
            (!this.fileUri(row.newUri) || seen.has(row.newUri) || row.newUri === row.oldUri))
        )
          throw new Error('Invalid file operation');
        seen.add(row.oldUri);
        if (row.newUri !== undefined) seen.add(row.newUri);
        const open = this.document(row.oldUri);
        const file = this.sourceValue.files.find((file) => file.uri === row.oldUri);
        if (!open && !file) throw new Error('Source bytes are unavailable');
        if (file) updates.push({ uri: row.oldUri, deleted: true });
        if (row.newUri !== undefined) {
          if (this.unavailable.has(row.oldUri))
            throw new Error('Source buffer is not synchronized');
          if (
            this.openDocuments.has(row.newUri) ||
            this.sourceValue.files.some((file) => file.uri === row.newUri)
          )
            throw new Error('Conflicting rename');
          updates.push(
            open
              ? { uri: row.newUri, text: open.getText(), origin: 'buffer', version: open.version }
              : { ...file!, uri: row.newUri },
          );
          renamed.set(row.oldUri, row.newUri);
        }
        if (open) cleared.push(open);
      }
      let next = overlaySourceSnapshot(this.sourceValue, updates);
      if (!this.config.filesystem && this.sourceValue.entrypoints !== undefined)
        next = createSourceSnapshot({
          ...next,
          entrypoints: this.sourceValue.entrypoints
            .map((uri) => renamed.get(uri) ?? uri)
            .filter((uri) => next.files.some((file) => file.uri === uri)),
        });
      if (next.files.length > 1000) throw new Error('Source limit exceeded');
      verifyRequestBindings(createLspRequest(this.config, next), this.config);
      this.sourceValue = next;
      for (const document of cleared) {
        this.openDocuments.delete(document.uri);
        this.lifetimes.delete(document.uri);
        this.unavailable.delete(document.uri);
      }
    } catch {
      this.capacityValue = true;
    }
    this.invalidate();
    this.documentViews = undefined;
    return this.capacityValue ? [] : cleared;
  }
}
