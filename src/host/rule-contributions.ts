import type { Finding, JsonValue } from '../contracts/schemas.js';
import type { EditorArtifact } from '../capabilities/editor-artifacts.js';
import { digestJson, deepFreeze } from '../core/json.js';
import type { Immutable } from '../core/json.js';
import { validatePolicySources } from '../core/policy-sources.js';
import type { PolicySourceContext } from '../core/policy-sources.js';
import { createDataSnapshot, overlaySourceSnapshot } from '../core/snapshots.js';
import { parseContract } from '../contracts/validate.js';
import { SourceLineIndex } from '../parsing/locations.js';
import type { CatalogAccessContext, CatalogProvider } from '../providers/types.js';
import { object } from '../capabilities/schema-metadata.js';
import { capabilityAuthorityDigest } from '../capabilities/bindings.js';
import { setImmediate as yieldTurn } from 'node:timers/promises';

export const RULE_EDITOR_LIMITS = Object.freeze({
  candidates: 16,
  contributions: 64,
  declarations: 1024,
  ttlMs: 30_000,
});
type Report = Awaited<ReturnType<typeof validatePolicySources>>;
export interface CandidateEvidence {
  readonly originalSourceDigest: string;
  readonly hypotheticalSourceDigest: string;
  readonly policyDigest: string;
  readonly profileDigest: string;
  readonly dataDigest: string;
  readonly originalDataDigest: string;
  readonly dependencyGeneration: number;
  readonly authorityContextDigest: string;
  readonly checkedRules: Report['ruleStates'];
  readonly coverage: Report['coverage'];
  readonly remainingFindings: number;
  readonly expiresAt: number;
}
export interface PreparedRuleMetadata {
  readonly subjectId: string;
  readonly path: string;
  readonly artifactDigest: string;
  readonly ruleId: string;
  readonly description: string;
  readonly candidates: readonly {
    readonly value: string | number | boolean | null;
    readonly label: string;
    readonly evidence: CandidateEvidence;
    readonly repair?: Immutable<Finding>;
  }[];
  readonly expiresAt: number;
}
/** Optional work shares the original deadline and the production supervised runtime. */
export async function prepareRuleContributions(input: {
  readonly report: Report;
  readonly context: PolicySourceContext;
  readonly artifacts: readonly Immutable<EditorArtifact>[];
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly current: () => boolean;
  readonly catalog?: { readonly provider: CatalogProvider; readonly access: CatalogAccessContext };
  readonly render: (
    subjectId: string,
    path: string,
    value: JsonValue,
    ruleId: string,
  ) => Immutable<Finding> | undefined;
}): Promise<readonly PreparedRuleMetadata[]> {
  const { report, signal } = input;
  const result: PreparedRuleMetadata[] = [];
  let admitted = 0;
  let visited = 0;
  const alive = () =>
    !signal.aborted && input.current() && Date.now() < report.request.execution.deadlineAt;
  const freshness = input.catalog?.access.maxAgeMs || RULE_EDITOR_LIMITS.ttlMs;
  const expiry = (row: Report['request']['data']['entries'][number]) =>
    Math.min(row.provenance.expiresAt, row.provenance.fetchedAt + freshness);
  const originalExpiry = Math.min(
    Date.now() + RULE_EDITOR_LIMITS.ttlMs,
    ...report.request.data.entries.map(expiry),
  );
  if (report.interrupted !== 'none') return [];
  for (const entity of report.compatibility.entities) {
    const subjectId = JSON.stringify([entity.document.uri, entity.document.document]);
    for (const artifact of input.artifacts)
      for (const declaration of artifact.contributions) {
        if (++visited > RULE_EDITOR_LIMITS.declarations) return result;
        if (visited % 8 === 0) await yieldTurn(undefined, { signal });
        if (!alive() || result.length >= RULE_EDITOR_LIMITS.contributions) return result;
        const value = entity.normalized;
        const state = report.ruleStates.find(
          (row) => row.subjectId === subjectId && row.ruleId === declaration.ruleId,
        );
        if (
          !object(value) ||
          value.kind !== declaration.kind ||
          value.apiVersion !== declaration.apiVersion ||
          !state ||
          !['passed', 'failed'].includes(state.status)
        )
          continue;
        const candidates: PreparedRuleMetadata['candidates'][number][] = [];
        const values = [
          ...(declaration.choices ?? []).map((value) => ({ value, label: 'Declared choice' })),
          ...(declaration.examples ?? []).map((value) => ({ value, label: 'Declared example' })),
          ...(Object.hasOwn(declaration, 'defaultValue')
            ? [{ value: declaration.defaultValue!, label: 'Declared default' }]
            : []),
        ];
        const seen = new Set<string>();
        for (const choice of values) {
          if (!alive() || admitted >= RULE_EDITOR_LIMITS.candidates) break;
          if (seen.has(JSON.stringify(choice.value))) continue;
          seen.add(JSON.stringify(choice.value));
          const rendered = input.render(
            subjectId,
            declaration.path,
            choice.value,
            declaration.ruleId,
          );
          if (!rendered || rendered.edits.length !== 1) continue;
          admitted++;
          const edit = rendered.edits[0]!;
          const file = report.request.source.files.find((file) => file.uri === edit.uri);
          if (!file || file.digest !== edit.sourceDigest || file.version !== edit.version) continue;
          const index = new SourceLineIndex(file.text),
            start = index.offset(edit.range.start),
            end = index.offset(edit.range.end);
          if (start === undefined || end === undefined || start > end) continue;
          const source = overlaySourceSnapshot(report.request.source, [
            {
              uri: file.uri,
              text: file.text.slice(0, start) + edit.text + file.text.slice(end),
              origin: file.origin,
              ...(file.version === undefined ? {} : { version: file.version }),
            },
          ]);
          const request = parseContract('validation-request', {
            ...report.request,
            source,
            data: createDataSnapshot([]),
            ...(!report.request.baseline && report.request.source.changes.length === 0
              ? { baseline: report.request.source }
              : {}),
          });
          try {
            // A new source must collect its own catalog bindings. No old observation is reused.
            const candidate = await validatePolicySources(request, input.context, {
              signal,
              ...(input.catalog
                ? {
                    catalog: { ...input.catalog, access: { ...input.catalog.access, maxAgeMs: 0 } },
                  }
                : {}),
            });
            if (
              !alive() ||
              candidate.interrupted !== 'none' ||
              candidate.rules.failures.length ||
              candidate.coverage.some((row) => row.required && row.status !== 'verified') ||
              candidate.ruleStates.find(
                (row) => row.subjectId === subjectId && row.ruleId === declaration.ruleId,
              )?.status !== 'passed'
            )
              continue;
            // Existing unrelated failures can remain. No new failure can be introduced by a proposal.
            const key = (finding: Immutable<Finding>) =>
              JSON.stringify([
                finding.subjectId,
                finding.ruleId,
                finding.location.path,
                finding.category,
              ]);
            const previous = new Set(
              report.findings
                .filter((row) => row.ruleId !== declaration.ruleId || row.subjectId !== subjectId)
                .map(key),
            );
            if (candidate.findings.some((row) => !previous.has(key(row)))) continue;
            const expiresAt = Math.min(
              originalExpiry,
              ...candidate.request.data.entries.map(expiry),
            );
            if (Date.now() >= expiresAt) continue;
            const evidence: CandidateEvidence = {
              originalSourceDigest: report.request.source.digest,
              hypotheticalSourceDigest: source.digest,
              policyDigest: request.policy.digest,
              profileDigest: request.profile.digest,
              originalDataDigest: report.request.data.digest,
              dataDigest: candidate.request.data.digest,
              dependencyGeneration: input.generation,
              authorityContextDigest: capabilityAuthorityDigest(request.identity, input.catalog),
              checkedRules: candidate.ruleStates,
              coverage: candidate.coverage,
              remainingFindings: candidate.findings.length,
              expiresAt,
            };
            candidates.push({
              value: choice.value,
              label: `${choice.label}; checked rule ${declaration.ruleId}; ${candidate.findings.length} other findings`,
              evidence,
              ...(declaration.repairs && state.status === 'failed' ? { repair: rendered } : {}),
            });
          } catch {
            // Optional candidate failure never replaces the authoritative validation report.
          }
        }
        result.push({
          subjectId,
          path: declaration.path,
          artifactDigest: artifact.digest,
          ruleId: declaration.ruleId,
          description: declaration.description,
          candidates,
          expiresAt: Math.min(originalExpiry, ...candidates.map((row) => row.evidence.expiresAt)),
        });
      }
  }
  return deepFreeze(result);
}

export function candidateEvidenceDigest(evidence: CandidateEvidence): string {
  return digestJson(evidence);
}
