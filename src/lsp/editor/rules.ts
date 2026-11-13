import type { Immutable } from '../../base/json.js';
import { digestText, immutableJson } from '../../base/json.js';
import type { Finding, JsonValue } from '../../contracts/schemas.js';
import type { PreparedRuleMetadata } from '../../host/rule-contributions.js';
import { parts } from '../editor-schemas.js';
import type { FixDocument, SuggestedFix } from '../fixes.js';
import { ruleSegments } from './state.js';
import type { EditorState } from './state.js';
import { valueEdit } from './value-edits.js';

/** Installs the rule contributions prepared for the indexed generation, and starts their clocks. */
export function installRuleContributions(
  state: EditorState,
  rows: readonly PreparedRuleMetadata[],
  generation: number,
): void {
  if (state.generation === generation) {
    state.rules = rows;
    state.rulesWall = state.clock.wall();
    state.rulesMonotonic = state.clock.monotonic();
  }
}
/** Whether an installed rule contribution has expired since it was installed. */
export function rulePreparationExpired(state: EditorState): boolean {
  return state.rules.length > 0 && state.currentRules().length !== state.rules.length;
}
/** A new request can renew optional proofs while pure local metadata remains advisory. */
export function expireRules(state: EditorState, generation: number): void {
  state.lifetime++;
  state.controller?.abort();
  state.rules = [];
  state.generation = generation;
  state.files = new Map(
    [...state.files].map(([uri, indexed]) => [
      uri,
      {
        ...indexed,
        documents: indexed.documents.map((selected) => ({
          ...selected,
          schemas: selected.schemas.filter((schema) => !schema.label.startsWith('Policy ')),
        })),
      },
    ]),
  );
}
/** The earliest expiry of the installed rule contributions. */
export function ruleExpiresAt(state: EditorState): number {
  return Math.min(Infinity, ...state.rules.map((row) => row.expiresAt));
}
export function ruleRepairs(
  state: EditorState,
  generation: number,
  documents: ReadonlyMap<string, FixDocument>,
): SuggestedFix[] {
  return state.currentRules().flatMap((row) =>
    row.candidates.flatMap((candidate) => {
      const finding = candidate.repair;
      const indexed = finding && state.current(finding.location.uri, generation, documents);
      const selected = indexed?.documents.find(
        (selected) => selected.document.ordinal === finding?.location.document,
      );
      if (!finding || !selected) return [];
      const node = selected.document.nodes.get(finding.location.path);
      const logical = state
        .contribution(
          'repairs',
          {
            ...state.metadata(selected, finding.location.path),
            findingId: finding.id,
            subjectId: row.subjectId,
            current: node
              ? { state: 'present', value: immutableJson(node.value) as JsonValue }
              : { state: 'absent' },
            required: false,
          },
          generation,
        )
        ?.proposals.some(
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
export function renderRuleCandidate(
  state: EditorState,
  subjectId: string,
  path: string,
  value: JsonValue,
  ruleId: string,
  generation: number,
  documents: ReadonlyMap<string, FixDocument>,
  findings: readonly Immutable<Finding>[],
): Immutable<Finding> | undefined {
  const targets = [...state.files.values()].flatMap((file) =>
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
    !state.current(target.file.file.uri, generation, documents) ||
    !target.selected.document.valid
  )
    return undefined;
  const { file: indexed, selected } = target;
  if (!ruleSegments(selected.schemaValue, path)) return undefined;
  const edit = valueEdit(indexed, selected, target.path, value);
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
