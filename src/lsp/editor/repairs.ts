import type { Immutable } from '../../base/json.js';
import { immutableJson } from '../../base/json.js';
import type { Finding, JsonValue } from '../../contracts/schemas.js';
import { parts } from '../editor-schemas.js';
import type { FixDocument, SuggestedFix } from '../fixes.js';
import type { EditorState } from './state.js';
import { valueEdit } from './value-edits.js';

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
      // A choice equal to the present value is no repair.
      const edit =
        node && JSON.stringify(node.value) === JSON.stringify(choice.value)
          ? undefined
          : valueEdit(indexed, selected, path, choice.value);
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
