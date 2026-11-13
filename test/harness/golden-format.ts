import { createHash } from 'node:crypto';

/**
 * Compact storage for characterization goldens. A scenario is characterized by the exact JSON text
 * of its observed report (array order and key order included). Small scenarios are stored as a
 * literal in which a repeated subtree refers to its first occurrence; large scenarios are stored as
 * the digest and length of that text plus a readable summary.
 */
export const SAME_AS = '<same-as>';
/** Subtrees shorter than this many characters of JSON text are always stored in place. */
const SHARED_MINIMUM = 256;

export interface GoldenSummary {
  readonly interrupted?: unknown;
  readonly error?: unknown;
  readonly findings?: Readonly<Record<string, number>>;
  readonly coverage?: Readonly<Record<string, number>>;
  readonly ruleStates?: Readonly<Record<string, number>>;
}
export type GoldenEntry =
  | { readonly literal: unknown }
  | { readonly digest: string; readonly bytes: number; readonly summary: GoldenSummary };

const pointer = (base: string, key: string | number) =>
  `${base}/${String(key).replace(/~/gu, '~0').replace(/\//gu, '~1')}`;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const textDigest = (text: string) =>
  `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

/** Replaces each repeated subtree with `{ "<same-as>": pointer }` to its first occurrence. */
export function shareRepeats(root: unknown): unknown {
  const seen = new Map<string, string>();
  const visit = (node: unknown, at: string): unknown => {
    if (node === null || typeof node !== 'object') return node;
    if (isRecord(node) && Object.hasOwn(node, SAME_AS))
      throw new Error(`Observed data already uses the reserved key ${SAME_AS} at ${at}`);
    const text = JSON.stringify(node);
    if (text.length >= SHARED_MINIMUM) {
      const first = seen.get(text);
      if (first !== undefined) return { [SAME_AS]: first };
      seen.set(text, at);
    }
    return Array.isArray(node)
      ? node.map((item, index) => visit(item, pointer(at, index)))
      : Object.fromEntries(
          Object.entries(node).map(([key, value]) => [key, visit(value, pointer(at, key))]),
        );
  };
  return visit(root, '');
}

/** The inverse of `shareRepeats`: every reference becomes a copy of the subtree it names. */
export function expandRepeats(root: unknown): unknown {
  const built = new Map<string, unknown>();
  const visit = (node: unknown, at: string): unknown => {
    if (node === null || typeof node !== 'object') return node;
    if (isRecord(node) && Object.hasOwn(node, SAME_AS)) {
      const target = String(node[SAME_AS]);
      if (!built.has(target)) throw new Error(`Golden reference ${at} names unknown ${target}`);
      return JSON.parse(JSON.stringify(built.get(target))) as unknown;
    }
    const result = Array.isArray(node)
      ? node.map((item, index) => visit(item, pointer(at, index)))
      : Object.fromEntries(
          Object.entries(node).map(([key, value]) => [key, visit(value, pointer(at, key))]),
        );
    built.set(at, result);
    return result;
  };
  return visit(root, '');
}

function countBy(rows: unknown, key: (row: Record<string, unknown>) => string) {
  const counts = new Map<string, number>();
  if (Array.isArray(rows))
    for (const row of rows)
      if (isRecord(row)) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Counts of findings by rule, coverage by stage and status, rule states by status. */
export function summarize(outcome: unknown): GoldenSummary {
  if (!isRecord(outcome)) return {};
  if (isRecord(outcome.error))
    return { error: { code: outcome.error.code, message: outcome.error.message } };
  let report = outcome.report;
  // A scenario may wrap the report with what it observed through callbacks.
  if (isRecord(report) && isRecord(report.report)) report = report.report;
  if (!isRecord(report)) return {};
  return {
    interrupted: report.interrupted,
    findings: countBy(report.findings, (row) => String(row.ruleId)),
    coverage: countBy(report.coverage, (row) => `${String(row.stage)} ${String(row.status)}`),
    ...(Array.isArray(report.ruleStates)
      ? { ruleStates: countBy(report.ruleStates, (row) => String(row.status)) }
      : {}),
  };
}

/** A literal while the shared form is at most `limit` characters, else digest and summary. */
export function encodeScenario(outcome: unknown, limit: number): GoldenEntry {
  const text = JSON.stringify(outcome);
  const literal = shareRepeats(outcome);
  if (JSON.stringify(literal).length <= limit) return { literal };
  return {
    digest: textDigest(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    summary: summarize(outcome),
  };
}

/** Whether `text`, the JSON text of an observed scenario, matches its stored entry. */
export function matchesEntry(entry: GoldenEntry, text: string): boolean {
  if ('literal' in entry) return JSON.stringify(expandRepeats(entry.literal)) === text;
  return entry.digest === textDigest(text) && entry.bytes === Buffer.byteLength(text, 'utf8');
}
