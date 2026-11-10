import { DiagnosticSeverity } from 'vscode-languageserver/node';
import type { Diagnostic } from 'vscode-languageserver/node';
import type { Finding } from '../contracts/schemas.js';
import type { Immutable } from '../core/json.js';
import type { FailureEvidence } from '../runtime/failure-evidence.js';

export function diagnostic(
  finding: Immutable<Finding>,
  digest: string,
  version: number,
  uri: string,
  evidence: readonly FailureEvidence[] = [],
  fixGeneration?: number,
): Diagnostic {
  const projected = finding.location.uri !== uri;
  const location = projected
    ? finding.relatedLocations.find((location) => location.uri === uri)!
    : finding.location;
  const related = [...(projected ? [finding.location] : []), ...finding.relatedLocations].filter(
    (item) => item !== location,
  );
  return {
    range: location.range,
    severity: finding.severity === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
    source: 'backstage-validation',
    code: finding.ruleId,
    message: finding.message,
    ...(related.length
      ? {
          relatedInformation: related.map((location) => ({
            location: { uri: location.uri, range: location.range },
            message: 'Related source location.',
          })),
        }
      : {}),
    data: {
      findingId: finding.id,
      ...(fixGeneration === undefined ? {} : { fixGeneration }),
      category: finding.category,
      sourceDigest: digest,
      version,
      ...(evidence.length ? { execution: evidence } : {}),
    },
  };
}

export function incomplete(
  digest: string | undefined,
  version: number,
  evidence: readonly FailureEvidence[] = [],
): Diagnostic {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    severity: DiagnosticSeverity.Warning,
    code: 'validation/incomplete',
    source: 'backstage-validation',
    message: 'Validation could not complete for this workspace snapshot.',
    data: {
      category: 'execution',
      ...(evidence.length ? { execution: evidence } : {}),
      ...(digest === undefined ? {} : { sourceDigest: digest }),
      version,
    },
  };
}
