import { MarkupKind } from 'vscode-languageserver/node';
import type { Hover, Location, Position } from 'vscode-languageserver/node';
import { editorTarget } from '../editor-documents.js';
import { object, parts } from '../editor-schemas.js';
import type { FixDocument } from '../fixes.js';
import type { EditorState } from './state.js';

export function hover(
  state: EditorState,
  uri: string,
  position: Position,
  generation: number,
  documents: ReadonlyMap<string, FixDocument>,
): Hover | null {
  const indexed = state.current(uri, generation, documents);
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
      const value = state.contribution(
        'hover',
        state.metadata(selected, node.path),
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
/** The one entity that a reference value names, among the indexed files. */
export function definition(
  state: EditorState,
  uri: string,
  position: Position,
  generation: number,
  documents: ReadonlyMap<string, FixDocument>,
): Location[] {
  const indexed = state.current(uri, generation, documents);
  if (!indexed) return [];
  const target = editorTarget(indexed.file, position);
  if (!target || target.key) return [];
  const value = target.document.nodes.get(target.path)?.value;
  if (typeof value !== 'string') return [];
  const selected = indexed.documents.find((row) => row.document === target.document);
  if (!selected) return [];
  const pattern = state.config.profile.referenceContexts.find((row) => {
    const expected = parts(row.path),
      actual = parts(selected.basePath + target.path);
    return (
      expected.length === actual.length &&
      expected.every((part, i) => part === actual[i] || (part === '*' && /^\d+$/u.test(actual[i]!)))
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
  const reference = state.contribution(
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
  for (const row of state.files.values())
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
