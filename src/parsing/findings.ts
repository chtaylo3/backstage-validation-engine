import type { Finding, ValidationRequest } from '../contracts/schemas.js';
import { parseContract } from '../contracts/validate.js';
import { reject } from '../base/errors.js';
import { deepFreeze } from '../base/json.js';
import type { Immutable } from '../base/json.js';
import { createFindingId } from '../core/results.js';
import type { ParsingReport } from './types.js';

/** Binds parser diagnostics to policy/profile provenance for canonical results. */
export function parsingFindings(
  request: Immutable<ValidationRequest>,
  report: ParsingReport,
): readonly Immutable<Finding>[] {
  const run = parseContract('validation-request', request);
  const sourceFiles = new Map(run.source.files.map((file) => [file.uri, file]));
  if (
    report.sourceDigest !== run.source.digest ||
    report.mode !== run.execution.mode ||
    report.files.some((file) => {
      const source = sourceFiles.get(file.uri);
      return !source || file.sourceDigest !== source.digest || file.version !== source.version;
    })
  )
    reject('integrity', '/parse', 'parser report does not match request source and mode');
  const findings = new Map<string, Finding>();
  for (const diagnostic of report.diagnostics) {
    if (!sourceFiles.has(diagnostic.location.uri))
      reject('integrity', '/parse', 'diagnostic source is not in the request');
    const ruleId = `yaml/${diagnostic.code}`;
    const subjectId = JSON.stringify([diagnostic.location.uri, diagnostic.location.document]);
    const id = createFindingId({
      ruleId,
      ruleVersion: 'yaml/1',
      subjectId,
      path: diagnostic.location.path,
      policyDigest: run.policy.digest,
      profileDigest: run.profile.digest,
    });
    const existing = findings.get(id);
    if (existing) {
      existing.relatedLocations.push(diagnostic.location, ...diagnostic.relatedLocations);
    } else {
      findings.set(id, {
        id,
        ruleId,
        ruleVersion: 'yaml/1',
        subjectId,
        message: diagnostic.message,
        category: diagnostic.category,
        severity: diagnostic.category === 'resource' && report.mode === 'ide' ? 'warning' : 'error',
        enforcement: report.mode === 'ci' ? 'blocking' : 'advisory',
        location: diagnostic.location,
        relatedLocations: [...diagnostic.relatedLocations],
        edits: [],
      });
    }
  }
  return deepFreeze([...findings.values()]);
}
