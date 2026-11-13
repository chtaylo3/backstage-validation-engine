import { CompletionItemKind, InsertTextFormat, MarkupKind } from 'vscode-languageserver/node';
import type { CompletionList, CompletionParams } from 'vscode-languageserver/node';
import { BUILTIN_KINDS } from '../../compatibility/types.js';
import { admitsKind } from '../../contracts/admission.js';
import { editorTarget } from '../editor-documents.js';
import { acceptsValue, object } from '../editor-schemas.js';
import type { FixDocument } from '../fixes.js';
import { encoded } from './state.js';
import type { EditorState } from './state.js';

const empty = (): CompletionList => ({ isIncomplete: true, items: [] });
/** The values the user selected most recently rank first. At most 128 are kept. */
export class SelectionHistory {
  private readonly history = new Map<string, number>();
  private clock = 0;
  record(value: string): void {
    if (value.length > 512) return;
    this.history.delete(value);
    this.history.set(value, ++this.clock);
    if (this.history.size > 128) this.history.delete(this.history.keys().next().value!);
  }
  /** The recency of `value`, higher when more recent; undefined when it is not kept. */
  get(value: string): number | undefined {
    return this.history.get(value);
  }
  get size(): number {
    return this.history.size;
  }
}

export function complete(
  state: EditorState,
  history: SelectionHistory,
  params: CompletionParams,
  generation: number,
  documents: ReadonlyMap<string, FixDocument>,
  rulesOnly = false,
): CompletionList {
  const { config } = state;
  const indexed = state.current(params.textDocument.uri, generation, documents);
  if (!indexed) return empty();
  const target = editorTarget(indexed.file, params.position);
  const selected = indexed.documents.find((row) => row.document === target?.document);
  if (!target || !selected) return empty();
  if (target.key) {
    const existing = selected.document.nodes.get(target.path)?.value;
    const metadata = state.contribution(
      'fields',
      {
        ...state.metadata(selected, target.path, true, rulesOnly),
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
  const supplied = state.contribution(
    'values',
    {
      ...state.metadata(selected, target.path, true, rulesOnly),
      ...(!selected.basePath && target.path === '/kind'
        ? {
            kinds: [...BUILTIN_KINDS, ...config.profile.customKinds.map((row) => row.kind)].filter(
              (kind) => admitsKind(config.profile, indexed.file.uri, kind),
            ),
          }
        : {}),
    },
    generation,
  );
  const values = (supplied?.candidates ?? []).filter(({ value }) =>
    acceptsValue(state.fields(selected, target.path), value),
  );
  const description =
    state.contribution('hover', state.metadata(selected, target.path, true, rulesOnly), generation)
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
          (history.get(typeof b.value === 'string' ? b.value : JSON.stringify(b.value)) ?? 0) -
          (history.get(typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) ?? 0),
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
export function acceptsReference(
  state: EditorState,
  params: CompletionParams,
  value: string,
  generation: number,
  documents: ReadonlyMap<string, FixDocument>,
): boolean {
  const indexed = state.current(params.textDocument.uri, generation, documents);
  if (!indexed) return true;
  const target = editorTarget(indexed.file, params.position);
  const selected = indexed.documents.find((row) => row.document === target?.document);
  return !target || !selected || acceptsValue(state.fields(selected, target.path), value);
}
