import assert from 'node:assert/strict';
export interface DiagnosticPublication {
  uri: string;
  version?: number;
  diagnostics: Record<string, unknown>[];
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
/** Preserve every complete publication, including transient findings before a clear. */
export function diagnosticPublications(trace: string): DiagnosticPublication[] {
  assert(
    Buffer.byteLength(trace, 'utf8') <= 1024 * 1024,
    'Bound the complete diagnostic observation window.',
  );
  const rows: DiagnosticPublication[] = [];
  const blocks = trace.split(/(?=^\d{4}-\d{2}-\d{2}[^\n]*\[[a-z]+\] )/mu);
  for (const block of blocks) {
    const method =
      /\[trace\] Received notification 'textDocument\/publishDiagnostics'\.\r?\nParams: /u.exec(
        block,
      );
    if (!method) continue;
    const raw = block.slice(method.index + method[0].length).trim();
    const value: unknown = JSON.parse(raw);
    assert(
      record(value) && typeof value.uri === 'string' && Array.isArray(value.diagnostics),
      'Diagnostic trace must contain a complete publication.',
    );
    const diagnostics = value.diagnostics.map((entry: unknown) => {
      assert(record(entry), 'Diagnostic entries must remain inspectable records.');
      return entry;
    });
    rows.push({
      uri: value.uri,
      ...(typeof value.version === 'number' ? { version: value.version } : {}),
      diagnostics,
    });
    assert(rows.length <= 128, 'Never truncate a diagnostic publication history.');
  }
  return rows;
}
/**
 * The URIs of every complete watched-file notification that the client sent, in the server's
 * spelling. A trailing block that the editor is still writing is skipped: callers poll this as a
 * readiness check, and the complete block appears on a later read.
 */
export function watchedFileUris(trace: string): string[] {
  const uris: string[] = [];
  for (const block of trace.split(/(?=^\d{4}-\d{2}-\d{2}[^\n]*\[[a-z]+\] )/mu)) {
    const method =
      /\[trace\] Sending notification 'workspace\/didChangeWatchedFiles'\.\r?\nParams: /u.exec(
        block,
      );
    if (!method) continue;
    let value: unknown;
    try {
      value = JSON.parse(block.slice(method.index + method[0].length).trim());
    } catch {
      continue;
    }
    if (!record(value) || !Array.isArray(value.changes)) continue;
    for (const change of value.changes)
      if (record(change) && typeof change.uri === 'string') uris.push(change.uri);
  }
  return uris;
}
export function diagnosticGeneration(diagnostic: Record<string, unknown>): number | undefined {
  return record(diagnostic.data) && typeof diagnostic.data.fixGeneration === 'number'
    ? diagnostic.data.fixGeneration
    : undefined;
}
