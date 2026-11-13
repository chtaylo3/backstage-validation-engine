import type { Finding, JsonValue, ValidationRequest } from '../contracts/schemas.js';
import type { SchemaValidationIssue } from '../compatibility/custom-schemas.js';
import type { SourceSubstitution } from '../compatibility/types.js';
import type { ParsedSourceDocument } from '../parsing/types.js';
import { SourceLineIndex } from '../parsing/locations.js';
import type { Immutable } from '../base/json.js';

export const SCALAR_FIX_LIMITS = Object.freeze({ generated: 64, scalarBytes: 4096 });
const scalar = (value: unknown): value is null | string | number | boolean =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);
function at(value: Immutable<JsonValue>, path: string): Immutable<JsonValue> | undefined {
  let current = value;
  for (const part of path ? path.slice(1).split('/') : []) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = (current as Readonly<Record<string, Immutable<JsonValue>>>)[key]!;
  }
  return current;
}
function matchesScalar(raw: string, actual: null | string | number | boolean): boolean {
  try {
    if (JSON.parse(raw) === actual) return true;
  } catch {
    /* Ordinary YAML scalars follow. */
  }
  if (typeof actual !== 'string') return false;
  if (raw.startsWith("'") && raw.endsWith("'"))
    return raw.slice(1, -1).replace(/''/g, "'") === actual;
  return raw === actual && !/^[\s[\]{}&*!|>#'"`]/u.test(raw);
}

/** Only an exact authored scalar with one policy-required value; no defaults or guessed repairs. */
export function scalarConstEdit(
  request: Immutable<ValidationRequest>,
  document: ParsedSourceDocument | undefined,
  value: Immutable<JsonValue>,
  issue: SchemaValidationIssue | undefined,
  substitutions: readonly SourceSubstitution[],
  indexes: Map<string, SourceLineIndex>,
): Finding['edits'][number] | undefined {
  if (!document || issue?.keyword !== 'const' || !scalar(issue.expected)) return undefined;
  const actual = at(value, issue.path);
  if (!scalar(actual)) return undefined;
  const span = document.locations[issue.path];
  if (!span || span.origin !== 'authored') return undefined;
  const uri = span.source?.uri ?? document.uri;
  if (span.source) {
    const selected = substitutions
      .filter((row) => issue.path === row.path || issue.path.startsWith(row.path + '/'))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!selected || selected.kind === '$text' || selected.target.uri !== uri) return undefined;
  }
  const file = request.source.files.find((row) => row.uri === uri);
  if (!file || file.digest !== (span.source?.sourceDigest ?? document.sourceDigest))
    return undefined;
  const index = indexes.get(uri) ?? new SourceLineIndex(file.text);
  indexes.set(uri, index);
  const start = index.offset(span.value.start),
    end = index.offset(span.value.end);
  if (start === undefined || end === undefined || end <= start) return undefined;
  const raw = file.text.slice(start, end);
  const text = JSON.stringify(issue.expected);
  if (
    /[\r\n]/u.test(raw) ||
    Buffer.byteLength(raw) > SCALAR_FIX_LIMITS.scalarBytes ||
    Buffer.byteLength(text) > SCALAR_FIX_LIMITS.scalarBytes ||
    !matchesScalar(raw, actual)
  )
    return undefined;
  return {
    uri,
    sourceDigest: file.digest,
    ...(file.version === undefined ? {} : { version: file.version }),
    range: span.value,
    text,
  };
}
