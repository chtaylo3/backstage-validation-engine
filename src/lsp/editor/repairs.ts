import type { TextEdit } from 'vscode-languageserver/node';
import type { Immutable } from '../../base/json.js';
import { immutableJson } from '../../base/json.js';
import type { Finding, JsonValue } from '../../contracts/schemas.js';
import { object, parts } from '../editor-schemas.js';
import type { FixDocument, SuggestedFix } from '../fixes.js';
import { encoded } from './state.js';
import type { EditorState } from './state.js';

/** At most 16 proposals per finding and 64 repairs per call, from the local metadata. */
export function repairs(
  state: EditorState,
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
    const indexed = state.current(finding.location.uri, generation, documents);
    if (!indexed) continue;
    const selected = indexed.documents.find(
      (row) => row.document.ordinal === finding.location.document,
    );
    if (!selected?.document.valid) continue;
    const path = finding.location.path;
    const node = selected.document.nodes.get(path);
    const name = parts(path).at(-1);
    const parentFields = state.fields(selected, path.slice(0, path.lastIndexOf('/')));
    const supplied = state.contribution(
      'repairs',
      {
        ...state.metadata(selected, path, false),
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
