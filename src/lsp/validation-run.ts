import type { SessionOperations } from './request-context.js';
import type { Diagnostic } from 'vscode-languageserver/node';
import { digestText } from '../base/json.js';
import { overlaySourceSnapshot } from '../core/snapshots.js';
import { verifyRequestBindings } from '../core/bindings.js';
import type { BuiltinValidationService } from '../host/builtin-validation.js';
import type { CoverageObservation } from './coverage-observation.js';
import { CapabilityError } from '../capabilities/admission.js';
import type { LocalCatalogSources } from '../pipeline/reference-data.js';
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
import { diagnostic, incomplete, admissionTimeout } from './diagnostics.js';
import type { WorkspaceSnapshot, WorkspaceState } from './workspace-state.js';
import type { ValidationRun } from './validation-coordinator.js';
import { prepareRuleContributions } from '../host/rule-contributions.js';

interface ValidationInputs {
  readonly dependencyGeneration?: number;
  readonly refreshQueries?: (deadlineAt: number, signal: AbortSignal) => Promise<void>;
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
  readonly candidateCatalog?:
    { readonly provider: CatalogProvider; readonly access: CatalogAccessContext } | undefined;
  readonly completion: CompletionService;
  readonly editor: EditorService;
  readonly validation: BuiltinValidationService;
  readonly fixes: FixRegistry;
  readonly fixesEnabled: boolean;
  readonly configurationUnavailable: boolean;
  readonly observeCoverage?: (value: CoverageObservation) => void;
  readonly publish: (uri: string, version: number, diagnostics: Diagnostic[]) => Promise<void>;
}
type Report = Awaited<ReturnType<BuiltinValidationService['run']>>;
type Frame = WorkspaceSnapshot['documents'];
/** Failure evidence and the stage and deadline that a failure is attributed to. */
interface RunRecord {
  readonly timing: FailureTimer;
  readonly evidence: FailureEvidence[];
  phase: FailureStage;
  deadlineAt: number | undefined;
}
const STALE = Symbol('stale');

/**
 * Capture: admits the filesystem request before disk I/O and refreshes the captured disk
 * snapshot when it is behind. The refreshed request retains this exact budget.
 */
async function captureSources(
  context: ValidationRun,
  input: ValidationInputs,
  record: RunRecord,
): Promise<ReturnType<typeof createLspRequest> | undefined | typeof STALE> {
  const { config, workspace, filesystem } = input;
  const frame = input.snapshot.documents;
  const original = filesystem ? createLspRequest(config, workspace.source) : undefined;
  record.deadlineAt = original?.execution.deadlineAt;
  if (filesystem && workspace.capturedGeneration < workspace.diskGeneration) {
    const requested = workspace.diskGeneration;
    const sourceGeneration = workspace.generation;
    record.phase = 'filesystem';
    const refreshed = await filesystem.capture(workspace.source, {
      deadlineAt: original!.execution.deadlineAt,
      signal: context.signal,
      skip: frame.map((document) => document.uri).filter((uri) => workspace.approved(uri)),
    });
    if (!context.current()) return STALE;
    verifyRequestBindings(
      parseContract('validation-request', { ...original, source: refreshed }),
      config,
    );
    if (!workspace.commitCapture(refreshed, requested, sourceGeneration)) return STALE;
  }
  return original;
}
/** Publishes an incomplete diagnostic for each buffer while sources or configuration are unavailable. */
async function publishUnavailable(
  context: ValidationRun,
  input: ValidationInputs,
  timing: FailureTimer,
): Promise<void> {
  const { workspace } = input;
  for (const document of input.snapshot.documents) {
    if (!context.current()) return;
    await input.publish(document.uri, document.version, [
      incomplete(
        workspace.isUnavailable(document.uri) ? undefined : digestText(document.getText()),
        document.version,
        [timing.capture('buffer', 'buffer_unavailable')],
      ),
    ]);
  }
}
/** The validation request for the captured sources with the buffers laid over them. */
function proposedRequest(
  input: ValidationInputs,
  original: ReturnType<typeof createLspRequest> | undefined,
) {
  const { config, workspace } = input;
  let source = overlaySourceSnapshot(
    workspace.source,
    input.snapshot.documents.map((document) => ({
      uri: document.uri,
      text: document.getText(),
      origin: 'buffer',
      version: document.version,
    })),
  );
  if (input.filesystem) source = reconcileFilesystemSource(config, source);
  return original
    ? parseContract('validation-request', { ...original, source })
    : createLspRequest(config, source);
}
/**
 * Execute: starts the query refresh, completion indexing and editor indexing beside the
 * authoritative pipeline, then refines the editor index with the report. Undefined when the run
 * became stale.
 */
async function execute(
  context: ValidationRun,
  input: ValidationInputs,
  request: ReturnType<typeof createLspRequest>,
  evidence: FailureEvidence[],
): Promise<{ report: Report; refreshingQueries: Promise<void> | undefined } | undefined> {
  const { config, completion, editor, validation, catalog } = input;
  const { generation, current } = context;
  const deadlineAt = request.execution.deadlineAt;
  const refreshingQueries = input.refreshQueries?.(deadlineAt, context.signal);
  if (refreshingQueries)
    void (input.operations ? input.operations.track(refreshingQueries) : refreshingQueries).catch(
      () => undefined,
    );
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
  const report = await validation
    .run(
      request,
      {
        ...(deliver ? { onLocalSources: deliver } : {}),
        onFailure: (row) => {
          if (evidence.length < FAILURE_EVIDENCE_LIMIT) evidence.push(row);
        },
        signal: context.signal,
        ...(catalog ? { catalog: catalog } : {}),
      },
      {
        workspaceGeneration: generation,
        dependencyGeneration: input.dependencyGeneration ?? 0,
        current,
      },
    )
    .finally(() => deliver?.());
  if (!current()) return undefined;
  await prepared;
  if (!current()) return undefined;
  await editor.refine(report, generation);
  if (!current()) return undefined;
  return { report, refreshingQueries };
}
function observeCoverage(context: ValidationRun, input: ValidationInputs, report: Report): void {
  input.observeCoverage?.({
    sourceDigest: report.request.source.digest,
    policyDigest: report.request.policy.digest,
    profileDigest: report.request.profile.digest,
    activationDigest: report.request.activation.digest,
    generation: context.generation,
    dependencyGeneration: input.dependencyGeneration ?? 0,
    documents: input.snapshot.documents.map((document) => ({
      uri: document.uri,
      version: document.version,
      digest: digestText(document.getText()),
    })),
    coverage: report.coverage,
  });
}
/** Whether the report may offer repairs, and when the catalog data behind them expires. */
function fixEligibility(input: ValidationInputs, report: Report) {
  const repairEligible =
    report.interrupted === 'none' &&
    report.rules.failures.length === 0 &&
    report.coverage.every((row) => !row.required || row.status === 'verified') &&
    !report.findings.some((row) =>
      ['configuration', 'dependency', 'execution', 'resource'].includes(row.category),
    );
  const dataExpiresAt = Math.min(
    Infinity,
    ...report.request.data.entries.map((row) =>
      Math.min(
        row.provenance.expiresAt,
        row.provenance.fetchedAt + (input.catalog?.access.maxAgeMs || FIX_LIMITS.ttlMs / 2),
      ),
    ),
  );
  return { repairEligible, dataExpiresAt };
}
/** Publish: the findings of each buffer, with an incomplete marker when coverage is missing. */
async function publishFindings(
  context: ValidationRun,
  input: ValidationInputs,
  report: Report,
  evidence: readonly FailureEvidence[],
): Promise<boolean> {
  const { generation, current } = context;
  for (const document of input.snapshot.documents) {
    if (!current()) return false;
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
          input.fixesEnabled ? generation : undefined,
        ),
      );
    if (
      report.interrupted !== 'none' ||
      (report.coverage.some((row) => row.required && row.status !== 'verified') &&
        diagnostics.length === 0)
    )
      diagnostics.push(incomplete(digest, document.version, evidence));
    await input.publish(document.uri, document.version, diagnostics);
  }
  return true;
}
/** Optional rule hints after the required diagnostics. Their failure cannot replace them. */
async function prepareRuleHints(
  context: ValidationRun,
  input: ValidationInputs,
  report: Report,
  { repairEligible, dataExpiresAt }: ReturnType<typeof fixEligibility>,
): Promise<void> {
  const { config, editor, fixes, fixesEnabled, snapshot } = input;
  const { generation, current } = context;
  if (!config.editorArtifacts.length || !current()) return;
  try {
    const contributions = await prepareRuleContributions({
      report,
      context: config,
      artifacts: config.editorArtifacts,
      generation: input.dependencyGeneration ?? 0,
      signal: context.signal,
      current,
      ...(input.candidateCatalog ? { catalog: input.candidateCatalog } : {}),
      render: (subjectId, path, value, ruleId) =>
        editor.renderRuleCandidate(
          subjectId,
          path,
          value,
          ruleId,
          generation,
          snapshot.allDocuments,
          report.findings,
        ),
    });
    if (current()) {
      editor.installRuleContributions(contributions, generation);
      if (fixesEnabled && repairEligible)
        fixes.replace({
          generation,
          findings: report.findings,
          suggestions: [
            ...editor.repairs(report.findings, generation, snapshot.allDocuments),
            ...editor.ruleRepairs(generation, snapshot.allDocuments),
          ],
          source: report.request.source,
          ...(report.request.baseline ? { baseline: report.request.baseline } : {}),
          documents: snapshot.allDocuments,
          expiresAt: Math.min(Date.now() + FIX_LIMITS.ttlMs, editor.ruleExpiresAt, dataExpiresAt),
        });
    }
  } catch {
    // Admission pressure, cancellation and worker failure affect hints only.
  }
}
/** Publishes an incomplete diagnostic with the failure evidence for each buffer. */
async function publishFailure(
  context: ValidationRun,
  input: ValidationInputs,
  error: unknown,
  record: RunRecord,
): Promise<void> {
  const { evidence } = record;
  const { current } = context;
  input.fixes.invalidate();
  if (!evidence.length)
    evidence.push(
      record.timing.capture(
        record.phase,
        error instanceof FilesystemSnapshotError
          ? error.reason === 'limit'
            ? 'resource_limit'
            : error.reason === 'changed'
              ? 'source_changed'
              : 'snapshot_unavailable'
          : error instanceof CapabilityError && error.code === 'deadline'
            ? 'request_timeout'
            : failureCause(error),
        record.deadlineAt,
      ),
    );
  if (current())
    for (const document of input.snapshot.documents) {
      if (!current()) return;
      const digest = digestText(document.getText());
      await input.publish(document.uri, document.version, [
        incomplete(digest, document.version, evidence),
        ...(error instanceof CapabilityError &&
        error.code === 'deadline' &&
        error.phase === 'admission'
          ? [admissionTimeout(digest, document.version, evidence)]
          : []),
      ]);
    }
}

/** Run the existing authoritative pipeline against one captured context and service generation. */
export async function runValidation(
  context: ValidationRun,
  input: ValidationInputs,
): Promise<void> {
  const { config, snapshot, workspace, editor, fixes, fixesEnabled } = input;
  const { generation } = context;
  const frame: Frame = snapshot.documents;

  if (!frame.length) {
    if (input.refreshQueries)
      await input.refreshQueries(
        Date.now() + config.profile.limits.requestTimeoutMs,
        context.signal,
      );
    return;
  }
  const record: RunRecord = {
    timing: new FailureTimer(),
    evidence: [],
    phase: 'validation',
    deadlineAt: undefined,
  };
  try {
    const original = await captureSources(context, input, record);
    // Each step boundary adds microtask turns, so the run is checked again before its effects.
    if (original === STALE || !context.current()) return;
    record.phase = 'validation';
    if (
      workspace.unavailableSources ||
      workspace.capacityExceeded ||
      input.configurationUnavailable
    ) {
      await publishUnavailable(context, input, record.timing);
      return;
    }
    const request = proposedRequest(input, original);
    record.deadlineAt = request.execution.deadlineAt;
    const executed = await execute(context, input, request, record.evidence);
    if (!executed || !context.current()) return;
    const { report, refreshingQueries } = executed;
    record.evidence.push(
      ...report.failureEvidence.slice(0, FAILURE_EVIDENCE_LIMIT - record.evidence.length),
    );
    observeCoverage(context, input, report);
    const eligibility = fixEligibility(input, report);
    if (fixesEnabled && eligibility.repairEligible) {
      fixes.replace({
        generation,
        findings: report.findings,
        suggestions: editor.repairs(report.findings, generation, snapshot.allDocuments),
        source: report.request.source,
        ...(report.request.baseline ? { baseline: report.request.baseline } : {}),
        documents: snapshot.allDocuments,
        expiresAt: Math.min(Date.now() + FIX_LIMITS.ttlMs, eligibility.dataExpiresAt),
      });
    }
    if (!(await publishFindings(context, input, report, record.evidence))) return;
    await prepareRuleHints(context, input, report, eligibility);
    await refreshingQueries;
  } catch (error) {
    await publishFailure(context, input, error, record);
  }
}
