import type { Finding, ValidationResult } from '../contracts/schemas.js';
import { parseContract } from '../contracts/validate.js';
import { deepFreeze } from '../core/json.js';
import type { Immutable } from '../core/json.js';

const header = {
  $schema: 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/cos02/schemas/sarif-schema-2.1.0.json',
  version: '2.1.0',
};
const driver = { name: 'Backstage Validation Engine', semanticVersion: '0.1.0-dev.0' };
const location = (value: Immutable<Finding['location']>) => ({
  physicalLocation: {
    artifactLocation: { uri: value.uri },
    region: {
      startLine: value.range.start.line + 1,
      startColumn: value.range.start.character + 1,
      endLine: value.range.end.line + 1,
      endColumn: value.range.end.character + 1,
    },
  },
  properties: { document: value.document, path: value.path },
});

/** SARIF columns retain the contract's UTF-16 units; no source or entity bodies are embedded. */
export function formatSarif(input: Immutable<ValidationResult>) {
  const result = parseContract('validation-result', input);
  const ids = [...new Set(result.findings.map((finding) => finding.ruleId))].sort();
  const successful = result.outcome === 'completed' || result.outcome === 'bypassed';
  return deepFreeze({
    ...header,
    runs: [
      {
        tool: { driver: { ...driver, rules: ids.map((id) => ({ id })) } },
        columnKind: 'utf16CodeUnits',
        invocations: [
          {
            executionSuccessful: successful,
            ...(!successful
              ? {
                  toolExecutionNotifications: [
                    {
                      level: 'error',
                      message: { text: 'Validation could not complete all required work.' },
                    },
                  ],
                }
              : {}),
          },
        ],
        results: result.findings.map((finding) => ({
          ruleId: finding.ruleId,
          ruleIndex: ids.indexOf(finding.ruleId),
          level: finding.severity === 'info' ? 'note' : finding.severity,
          message: { text: finding.message },
          locations: [location(finding.location)],
          relatedLocations: finding.relatedLocations.map((related, index) => ({
            id: index + 1,
            ...location(related),
          })),
          partialFingerprints: { 'bveFindingId/v1': finding.id },
          properties: {
            category: finding.category,
            subjectId: finding.subjectId,
            enforcement: finding.enforcement,
          },
        })),
        properties: {
          outcome: result.outcome,
          enforcement: result.enforcement,
          provenance: result.provenance,
          coverage: result.coverage,
          freshness: result.freshness,
        },
      },
    ],
  });
}

export function formatSarifError(code: string) {
  return deepFreeze({
    ...header,
    runs: [
      {
        tool: { driver },
        columnKind: 'utf16CodeUnits',
        invocations: [
          {
            executionSuccessful: false,
            toolExecutionNotifications: [
              {
                level: 'error',
                descriptor: { id: code },
                message: { text: 'Validation input or trusted configuration could not be loaded.' },
              },
            ],
          },
        ],
        results: [],
      },
    ],
  });
}
