import type { SessionOperations } from './request-context.js';
import type { Diagnostic } from 'vscode-languageserver/node';
import { digestText } from '../core/json.js';
import { overlaySourceSnapshot } from '../core/snapshots.js';
import { verifyRequestBindings } from '../core/bindings.js';
import { validatePolicySources } from '../core/policy-sources.js';
import type { LocalCatalogSources } from '../core/reference-data.js';
import type { CatalogAccessContext, CatalogProvider } from '../providers/types.js';
import { FAILURE_EVIDENCE_LIMIT, FailureTimer, failureCause } from '../runtime/failure-evidence.js';
import type { FailureEvidence, FailureStage } from '../runtime/failure-evidence.js';
import { parseContract } from '../contracts/validate.js';
import { FilesystemSnapshotError, reconcileFilesystemSource } from './filesystem.js';
import type { FilesystemSource } from './filesystem.js';
import { FIX_LIMITS } from './fixes.js';
import type { FixRegistry } from './fixes.js';
import { createLspRequest } from './config.js';
import type { LspConfig } from './config.js';
import type { CompletionService } from './completion.js';
import type { EditorService } from './editor.js';
import { diagnostic, incomplete } from './diagnostics.js';
import type { WorkspaceSnapshot, WorkspaceState } from './workspace-state.js';
import type { ValidationRun } from './validation-coordinator.js';

interface ValidationInputs {
  readonly operations: SessionOperations | undefined;
  readonly config: LspConfig;
  readonly snapshot: WorkspaceSnapshot;
  readonly workspace: Pick<
    WorkspaceState,
    | 'source'
    | 'generation'
    | 'diskGeneration'
    | 'capturedGeneration'
    | 'commitCapture'
    | 'approved'
    | 'unavailableSources'
    | 'capacityExceeded'
    | 'isUnavailable'
  >;
  readonly filesystem: FilesystemSource | undefined;
  readonly catalog:
    { readonly provider: CatalogProvider; readonly access: CatalogAccessContext } | undefined;
  readonly completion: CompletionService;
  readonly editor: EditorService;
  readonly fixes: FixRegistry;
  readonly fixesEnabled: boolean;
  readonly configurationUnavailable: boolean;
  readonly publish: (uri: string, version: number, diagnostics: Diagnostic[]) => Promise<void>;
}
/** Run the existing authoritative pipeline against one captured context and service generation. */
export async function runValidation(
  context: ValidationRun,
  input: ValidationInputs,
): Promise<void> {
  const {
    config,
    snapshot,
    workspace,
    filesystem,
    catalog,
    completion,
    editor,
    fixes,
    fixesEnabled,
    configurationUnavailable,
    publish,
  } = input;
  const { generation, current } = context;
  const frame = snapshot.documents;

  if (!frame.length) return;
  const timing = new FailureTimer();
  const evidence: FailureEvidence[] = [];
  let deadlineAt: number | undefined;
  let phase: FailureStage = 'validation';
  try {
    // Admission precedes disk I/O; the refreshed request retains this exact budget.
    const original = filesystem ? createLspRequest(config, workspace.source) : undefined;
    deadlineAt = original?.execution.deadlineAt;
    if (filesystem && workspace.capturedGeneration < workspace.diskGeneration) {
      const requested = workspace.diskGeneration;
      const sourceGeneration = workspace.generation;
      phase = 'filesystem';
      const refreshed = await filesystem.capture(workspace.source, {
        deadlineAt: original!.execution.deadlineAt,
        signal: context.signal,
        skip: frame.map((document) => document.uri).filter((uri) => workspace.approved(uri)),
      });
      if (!current()) return;
      verifyRequestBindings(
        parseContract('validation-request', { ...original, source: refreshed }),
        config,
      );
      if (!workspace.commitCapture(refreshed, requested, sourceGeneration)) return;
    }
    phase = 'validation';
    if (workspace.unavailableSources || workspace.capacityExceeded || configurationUnavailable) {
      for (const document of frame) {
        if (!current()) return;
        await publish(document.uri, document.version, [
          incomplete(
            workspace.isUnavailable(document.uri) ? undefined : digestText(document.getText()),
            document.version,
            [timing.capture('buffer', 'buffer_unavailable')],
          ),
        ]);
      }
      return;
    }
    let source = overlaySourceSnapshot(
      workspace.source,
      frame.map((document) => ({
        uri: document.uri,
        text: document.getText(),
        origin: 'buffer',
        version: document.version,
      })),
    );
    if (filesystem) source = reconcileFilesystemSource(config, source);
    const request = original
      ? parseContract('validation-request', { ...original, source })
      : createLspRequest(config, source);
    deadlineAt = request.execution.deadlineAt;
    let deliver: ((sources?: LocalCatalogSources) => void) | undefined;
    const local = config.policy.rules.some((rule) => rule.kind === 'catalog')
      ? new Promise<LocalCatalogSources | undefined>((resolve) => {
          deliver = resolve;
        })
      : undefined;
    const indexing = completion.update(request, generation, local);
    void (input.operations ? input.operations.track(indexing) : indexing);
    const preparing = editor.update(request, generation);
    const prepared = input.operations ? input.operations.track(preparing) : preparing;
    const report = await validatePolicySources(request, config, {
      ...(deliver ? { onLocalSources: deliver } : {}),
      onFailure: (row) => {
        if (evidence.length < FAILURE_EVIDENCE_LIMIT) evidence.push(row);
      },
      signal: context.signal,
      ...(catalog ? { catalog: catalog } : {}),
    }).finally(() => deliver?.());
    if (!current()) return;
    await prepared;
    if (!current()) return;
    await editor.refine(report, generation);
    if (!current()) return;
    evidence.push(...report.failureEvidence.slice(0, FAILURE_EVIDENCE_LIMIT - evidence.length));
    if (
      fixesEnabled &&
      report.interrupted === 'none' &&
      report.rules.failures.length === 0 &&
      report.coverage.every((row) => !row.required || row.status === 'verified') &&
      !report.findings.some((row) =>
        ['configuration', 'dependency', 'execution', 'resource'].includes(row.category),
      )
    ) {
      fixes.replace({
        generation,
        findings: report.findings,
        suggestions: editor.repairs(report.findings, generation, snapshot.allDocuments),
        source: report.request.source,
        ...(report.request.baseline ? { baseline: report.request.baseline } : {}),
        documents: snapshot.allDocuments,
        expiresAt: Math.min(
          Date.now() + FIX_LIMITS.ttlMs,
          ...report.request.data.entries.map((row) => row.provenance.expiresAt),
        ),
      });
    }
    for (const document of frame) {
      if (!current()) return;
      const digest = digestText(document.getText());
      const diagnostics = report.findings
        .filter(
          (finding) =>
            finding.location.uri === document.uri ||
            finding.relatedLocations.some((location) => location.uri === document.uri),
        )
        .map((finding) =>
          diagnostic(
            finding,
            digest,
            document.version,
            document.uri,
            evidence,
            fixesEnabled ? generation : undefined,
          ),
        );
      if (
        report.interrupted !== 'none' ||
        (report.coverage.some((row) => row.required && row.status !== 'verified') &&
          diagnostics.length === 0)
      )
        diagnostics.push(incomplete(digest, document.version, evidence));
      await publish(document.uri, document.version, diagnostics);
    }
  } catch (error) {
    fixes.invalidate();
    if (!evidence.length)
      evidence.push(
        timing.capture(
          phase,
          error instanceof FilesystemSnapshotError
            ? error.reason === 'limit'
              ? 'resource_limit'
              : error.reason === 'changed'
                ? 'source_changed'
                : 'snapshot_unavailable'
            : failureCause(error),
          deadlineAt,
        ),
      );
    if (current())
      for (const document of frame) {
        if (!current()) return;
        await publish(document.uri, document.version, [
          incomplete(digestText(document.getText()), document.version, evidence),
        ]);
      }
  }
}
