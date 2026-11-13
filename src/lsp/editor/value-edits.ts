import type { TextEdit } from 'vscode-languageserver/node';
import { object, parts } from '../editor-schemas.js';
import { encoded } from './state.js';
import type { IndexedDocument, IndexedFile } from './state.js';

/**
 * The text edit that sets the value at `path` in one indexed document, shared by rule candidates
 * and repairs. A present single-line scalar is replaced in its own style; an absent key is inserted
 * into its flow or block map. Undefined when no safe edit exists: a blocked node, a container, a
 * multi-line scalar, a missing or blocked parent map, or a flow map without its closing brace.
 */
export function valueEdit(
  indexed: IndexedFile,
  selected: IndexedDocument,
  path: string,
  value: unknown,
): TextEdit | undefined {
  const node = selected.document.nodes.get(path);
  if (node && !node.blocked && !node.container) {
    const raw = indexed.file.text.slice(node.start, node.end);
    return /[\r\n]/u.test(raw)
      ? undefined
      : {
          range: indexed.file.lines.range(node.start, node.end),
          newText: encoded(value, raw, indexed.file.json),
        };
  }
  if (node || !path) return undefined;
  const parent = selected.document.nodes.get(path.slice(0, path.lastIndexOf('/')));
  const name = parts(path).at(-1)!;
  if (parent?.container !== 'map' || parent.blocked) return undefined;
  if (parent.flow || indexed.file.json) {
    const offset = parent.end - 1;
    return indexed.file.text[offset] === '}'
      ? {
          range: indexed.file.lines.range(offset, offset),
          newText: `${object(parent.value) && Object.keys(parent.value).length ? ', ' : ''}${JSON.stringify(name)}: ${JSON.stringify(value)}`,
        }
      : undefined;
  }
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
  return {
    range: indexed.file.lines.range(offset, offset),
    newText: `${offset && !/[\r\n]/u.test(indexed.file.text[offset - 1]!) ? newline : ''}${' '.repeat(indent)}${JSON.stringify(name)}: ${JSON.stringify(value)}${newline}`,
  };
}
