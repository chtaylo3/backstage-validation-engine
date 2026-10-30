import { setImmediate as yieldTurn } from 'node:timers/promises';
import type {
  ActivationManifest,
  Coverage,
  DeploymentProfile,
  Finding,
  JsonValue,
  PolicyBundle,
  SchemaArtifact,
  ValidationRequest,
  ValidationResult,
} from '../contracts/schemas.js';
import { parseContract } from '../contracts/validate.js';
import { verifyRequestBindings } from '../core/bindings.js';
import { ContractError } from '../core/errors.js';
import { canonicalJson, deepFreeze } from '../core/json.js';
import type { Immutable } from '../core/json.js';
import { createFindingId } from '../core/results.js';
import { locateParsedPath, parseSourceSnapshot, parsingFindings } from '../parsing/index.js';
import type { ParsedSourceDocument } from '../parsing/index.js';
import { CelError } from '../runtime/cel/errors.js';
import { RequestBudget } from '../runtime/request-budget.js';
import { compileReferenceContexts } from '../policy/reference-contexts.js';
import { extractEntityReferences } from './references.js';
import { loadBackstageAdapter } from './adapter.js';
import { BackstageRuntimeError } from './types.js';
import { admitsKind } from '../policy/admission.js';
import { createCustomKindRegistry } from './custom-schemas.js';
import {
  SnapshotSourceResolver,
  SourceResolutionError,
  SUBSTITUTION_MESSAGES,
} from './substitutions.js';
import type {
  BackstageCompatibilityReport,
  CompatibleSourceEntity,
  NativeEntityCheck,
  BackstageSourceReference,
  SourceIdentityClaim,
} from './types.js';

const MESSAGES = Object.freeze({
  invalid_envelope: 'Entity does not satisfy the selected native Backstage envelope schema.',
  invalid_kind: 'Entity does not satisfy the selected native Backstage kind schema.',
  invalid_policy_value: 'Entity does not satisfy the configured native Backstage policy.',
  unsupported_kind: 'Kind is outside the implemented native adapter surface.',
  unsupported_api_version: 'API version is not recognized by the selected native kind validator.',
  unsupported_processor: 'Required deployment processor is unavailable.',
  cancelled: 'Native validation cancelled.',
  timeout: 'Validation request deadline exceeded during native validation.',
  adapter_unavailable: 'Pinned native adapter is unavailable.',
  invalid_reference: 'Reference does not satisfy the configured native reference context.',
  invalid_reference_shape: 'Reference field does not have the configured scalar/array structure.',
  invalid_identity: 'Entity identity cannot be represented by an unambiguous native reference.',
  disallowed_kind: 'Entity kind is not allowed by the configured global or source admission rules.',
  invalid_custom_kind: 'Entity does not satisfy the pinned custom kind schema.',
  unsupported_custom_schema: 'The schema artifact required by this custom kind is unavailable.',
  ...SUBSTITUTION_MESSAGES,
});

/** Executes parsing and declared BC-01 through BC-05 contexts; later stages are not attested. */
export async function validateBackstageSources(
  request: Immutable<ValidationRequest>,
  context: {
    readonly profile: Immutable<DeploymentProfile>;
    readonly policy: Immutable<PolicyBundle>;
    readonly activation: Immutable<ActivationManifest>;
    readonly schemaArtifacts?: readonly Immutable<SchemaArtifact>[];
  },
  options: { readonly signal?: AbortSignal; readonly uris?: readonly string[] } = {},
): Promise<BackstageCompatibilityReport> {
  const run = parseContract('validation-request', request);
  using budget = new RequestBudget(run.execution.deadlineAt, options.signal);
  verifyRequestBindings(run, context);
  const profile = parseContract('deployment-profile', context.profile);
  const referencePatterns = compileReferenceContexts(profile.referenceContexts);
  const referenceCounter = { visits: 0, occurrences: 0 };
  const parsed = await parseSourceSnapshot(run.source, {
    mode: run.execution.mode,
    deadlineAt: run.execution.deadlineAt,
    signal: budget.signal,
    ...((options.uris ?? run.source.entrypoints) === undefined
      ? {}
      : { uris: options.uris ?? run.source.entrypoints! }),
    limits: {
      files: profile.limits.entities,
      documents: profile.limits.entities,
      fileBytes: profile.limits.fileBytes,
      requestBytes: profile.limits.requestBytes,
      documentBytes: profile.limits.expandedEntityBytes,
    },
  });
  const findings: Immutable<Finding>[] = [...parsingFindings(run, parsed)];
  const coverage: Immutable<Coverage>[] = [...parsed.coverage];
  const entities: CompatibleSourceEntity[] = [];
  const references: BackstageSourceReference[] = [];
  const sourceClaims: SourceIdentityClaim[] = [];
  const unparsedSources = parsed.files.some((file) => file.status !== 'parsed');
  let unresolvedIncludes = false;
  const resolver = new SnapshotSourceResolver(
    run.source,
    profile,
    run.execution.mode,
    budget,
    parsed,
  );
  const documents = [...parsed.documents];
  const artifacts: ValidationResult['artifacts'] = [];
  let interrupted = parsed.interrupted;
  const diagnostic = (
    document: ParsedSourceDocument,
    code: keyof typeof MESSAGES,
    path: string,
    category: Finding['category'],
    stage: string = code,
    override?: SourceResolutionError,
  ): void => {
    const ruleId = `backstage/${stage}`;
    const location = override?.location ?? locateParsedPath(document, path);
    let authoredPath = path;
    while (!document.locations[authoredPath] && authoredPath)
      authoredPath = authoredPath.slice(0, authoredPath.lastIndexOf('/'));
    findings.push({
      id: createFindingId({
        ruleId,
        ruleVersion: profile.adapterId,
        subjectId: JSON.stringify([document.uri, document.document]),
        path,
        policyDigest: run.policy.digest,
        profileDigest: run.profile.digest,
      }),
      ruleId,
      ruleVersion: profile.adapterId,
      subjectId: JSON.stringify([document.uri, document.document]),
      message: MESSAGES[code],
      category,
      severity: category === 'dependency' && run.execution.mode === 'ide' ? 'warning' : 'error',
      enforcement: run.execution.mode === 'ci' ? 'blocking' : 'advisory',
      location,
      relatedLocations: [
        ...(override?.relatedLocations ?? document.locations[authoredPath]?.relatedLocations ?? []),
      ],
      edits: [],
    });
  };
  for (const file of parsed.files) {
    if (file.status !== 'parsed')
      coverage.push({
        stage: 'compatibility',
        subject: file.uri,
        required: file.status !== 'invalid',
        status: 'blocked',
        reason:
          file.status === 'invalid'
            ? 'Invalid parsed documents were excluded.'
            : 'Parsing did not complete.',
      });
  }
  for (const processor of profile.requiredProcessors) {
    coverage.push({
      stage: 'compatibility',
      subject: JSON.stringify(['processor', processor.id, processor.stage]),
      required: true,
      status: 'unsupported',
      reason: MESSAGES.unsupported_processor,
    });
  }
  let adapter: Awaited<ReturnType<typeof loadBackstageAdapter>> | undefined;
  let customKinds: ReturnType<typeof createCustomKindRegistry> | undefined;
  let unavailable = parsed.interrupted !== 'none';
  let blockedReason: string =
    parsed.interrupted === 'resource_limit'
      ? MESSAGES.resource_limit
      : parsed.interrupted === 'timeout'
        ? MESSAGES.timeout
        : parsed.interrupted === 'cancelled'
          ? MESSAGES.cancelled
          : MESSAGES.unsupported_processor;
  try {
    if (!unavailable) {
      budget.throwIfInterrupted();
      adapter = await loadBackstageAdapter(profile.adapterId);
      budget.throwIfInterrupted();
      adapter.validateSettings(profile.nativePolicies);
      customKinds = createCustomKindRegistry(profile, context.schemaArtifacts);
      budget.throwIfInterrupted();
      for (const pattern of referencePatterns) {
        try {
          adapter.resolveReference('context-check', {
            defaultKind: pattern.defaultKind,
            defaultNamespace: pattern.namespace === 'entity' ? 'default' : pattern.namespace,
          });
        } catch {
          throw new ContractError('invalid_contract', [
            {
              path: '/referenceContexts',
              message: 'reference context defaults must form an unambiguous native reference',
            },
          ]);
        }
      }
    }
  } catch (error) {
    if (error instanceof ContractError) throw error;
    unavailable = true;
    const code =
      error instanceof CelError
        ? error.code === 'request_timeout'
          ? 'timeout'
          : 'cancelled'
        : 'adapter_unavailable';
    blockedReason = MESSAGES[code];
    coverage.push({
      stage: 'compatibility',
      subject: 'adapter',
      required: true,
      status: code === 'adapter_unavailable' ? 'unavailable' : 'blocked',
      reason: blockedReason,
    });
    if (error instanceof CelError) interrupted = code === 'timeout' ? 'timeout' : 'cancelled';
  }
  for (let document of documents) {
    const subject = JSON.stringify([document.uri, document.document]);
    let claim: SourceIdentityClaim = { uri: document.uri, document: document.document };
    if (!unavailable && adapter && !profile.requiredProcessors.length) {
      try {
        const identity = adapter.resolveReference(
          adapter.entityReference(document.value),
        ).entityRef;
        claim = { ...claim, entityRef: identity };
      } catch {
        /* Unresolved identities are retained as conservative blockers. */
      }
    }
    const claimIndex = sourceClaims.length;
    sourceClaims.push(claim);
    if (unavailable || !adapter || !customKinds || profile.requiredProcessors.length) {
      coverage.push({
        stage: 'compatibility',
        subject,
        required: true,
        status: 'blocked',
        reason: profile.requiredProcessors.length ? MESSAGES.unsupported_processor : blockedReason,
      });
      continue;
    }
    let phase: 'substitution' | 'native' | 'references' | 'locations' = 'substitution';
    try {
      await yieldTurn();
      budget.throwIfInterrupted();
      const resolved = await resolver.resolve(document);
      document = resolved.document;
      coverage.push({ stage: 'substitution', subject, required: true, status: 'verified' });
      phase = 'native';
      let checked: NativeEntityCheck = await adapter.normalizeEntity(
        resolved.value,
        profile.nativePolicies,
        { deadlineAt: run.execution.deadlineAt, signal: budget.signal },
      );
      budget.throwIfInterrupted();
      if (
        Buffer.byteLength(canonicalJson(checked.normalized), 'utf8') >
        profile.limits.expandedEntityBytes
      )
        throw new BackstageRuntimeError('resource_limit');
      let customSchema: DeploymentProfile['customKinds'][number]['schema'] | undefined;
      if (checked.status === 'valid') {
        coverage.push({
          stage: 'compatibility',
          subject: JSON.stringify(['normalization', document.uri, document.document]),
          required: true,
          status: 'verified',
        });
        const value = checked.normalized as Readonly<Record<string, Immutable<JsonValue>>>;
        const kind = value.kind as string;
        const apiVersion = value.apiVersion as string;
        try {
          sourceClaims[claimIndex] = {
            ...claim,
            entityRef: adapter.entityReference(checked.normalized),
          };
        } catch {
          /* Preserve conservative identity guards until reference qualification. */
        }
        coverage.push({ stage: 'admission', subject, required: true, status: 'verified' });
        if (!admitsKind(profile, document.uri, kind)) {
          diagnostic(
            document,
            'disallowed_kind',
            '/kind',
            'compatibility',
            'admission/disallowed_kind',
          );
          continue;
        }
        const custom = customKinds.get(kind, apiVersion);
        if (custom) {
          coverage.push({
            stage: 'compatibility',
            subject,
            required: true,
            status: custom.validate ? 'verified' : 'unsupported',
          });
          if (!custom.validate) {
            diagnostic(
              document,
              'unsupported_custom_schema',
              '/kind',
              'dependency',
              'custom_schema/unsupported_custom_schema',
            );
            continue;
          }
          const invalidPath = custom.validate(checked.normalized);
          budget.throwIfInterrupted();
          if (invalidPath !== undefined) {
            diagnostic(
              document,
              'invalid_custom_kind',
              invalidPath,
              'compatibility',
              'custom_schema/invalid_custom_kind',
            );
            continue;
          }
          customSchema = { ...custom.schema };
        } else {
          const kindCheck = await adapter.validateKind(checked.normalized, {
            deadlineAt: run.execution.deadlineAt,
            signal: budget.signal,
          });
          checked = { ...kindCheck, authored: checked.authored, changes: checked.changes };
          if (checked.status === 'unsupported' && customKinds.hasKind(kind))
            checked = {
              ...checked,
              issues: [{ code: 'unsupported_api_version', stage: 'kind', path: '/apiVersion' }],
            };
        }
      }
      if (!customSchema)
        coverage.push({
          stage: 'compatibility',
          subject,
          required: true,
          status: checked.status === 'unsupported' ? 'unsupported' : 'verified',
          ...(checked.status === 'unsupported'
            ? { reason: 'Native kind/API-version support is incomplete.' }
            : {}),
        });
      for (const issue of checked.issues)
        diagnostic(
          document,
          issue.code,
          issue.path,
          checked.status === 'unsupported' ? 'dependency' : 'compatibility',
          `${issue.stage}/${issue.code}`,
        );
      if (checked.status === 'valid' && checked.entityRef) {
        phase = 'references';
        try {
          sourceClaims[claimIndex] = {
            ...claim,
            entityRef: adapter.entityReference(checked.normalized),
          };
        } catch {
          diagnostic(
            document,
            'invalid_identity',
            '/metadata',
            'compatibility',
            'references/invalid_identity',
          );
          coverage.push({
            stage: 'compatibility',
            subject: JSON.stringify(['references', document.uri, document.document]),
            required: true,
            status: 'verified',
          });
          continue;
        }
        const extracted = await extractEntityReferences(
          document,
          checked.normalized,
          checked.entityRef,
          referencePatterns,
          adapter,
          budget,
          referenceCounter,
        );
        coverage.push({
          stage: 'compatibility',
          subject: JSON.stringify(['references', document.uri, document.document]),
          required: true,
          status: 'verified',
        });
        for (const issue of extracted.issues)
          diagnostic(document, issue.code, issue.path, 'compatibility', `references/${issue.code}`);
        if (extracted.issues.length) continue;
        references.push(...extracted.references);
        const changes = checked.changes.map((change) => ({
          ...change,
          origin: locateParsedPath(document, change.path),
        }));
        entities.push({
          document,
          entityRef: checked.entityRef,
          authored: document.value,
          resolved: resolved.value,
          substitutions: resolved.substitutions,
          normalized: checked.normalized,
          ...(customSchema ? { customSchema } : {}),
          changes,
        });
        artifacts.push({
          entityRef: checked.entityRef,
          sourceUri: document.uri,
          document: document.document,
          sourceDigest: document.sourceDigest,
          value: checked.normalized as JsonValue,
          provenance: [
            ...(customSchema
              ? [
                  {
                    path: '',
                    origin: locateParsedPath(document, '/kind'),
                    transformation: `custom-schema/${customSchema.digest}`,
                  },
                ]
              : []),
            ...resolved.substitutions.map((substitution) => ({
              path: substitution.path,
              origin: substitution.origin,
              transformation: `snapshot-local/${substitution.kind}`,
            })),
            ...changes.map((change) => ({
              path: change.path,
              origin: change.origin,
              transformation: `${profile.adapterId}/${change.policy}`,
            })),
          ],
        });
        if (adapter.resolveReference(checked.entityRef).kind === 'location') {
          phase = 'locations';
          const discovered = await resolver.discover(document, checked.normalized);
          documents.push(...discovered.documents.map((row) => row.document));
          for (const report of discovered.reports) {
            findings.push(...parsingFindings(run, report));
            coverage.push(...report.coverage);
            if (report.files.some((file) => file.status !== 'parsed')) unresolvedIncludes = true;
            for (const file of report.files)
              if (file.status !== 'parsed')
                coverage.push({
                  stage: 'compatibility',
                  subject: file.uri,
                  required: file.status !== 'invalid',
                  status: 'blocked',
                  reason: 'Included source parsing did not complete.',
                });
            if (report.interrupted !== 'none') {
              interrupted = report.interrupted;
              unavailable = true;
              blockedReason =
                report.interrupted === 'timeout'
                  ? MESSAGES.timeout
                  : report.interrupted === 'cancelled'
                    ? MESSAGES.cancelled
                    : MESSAGES.resource_limit;
            }
          }
          const resource = discovered.issues.some((issue) => issue.code === 'resource_limit');
          const unsupported = discovered.issues.some((issue) => issue.unsupported);
          coverage.push({
            stage: 'substitution',
            subject: JSON.stringify(['locations', document.uri, document.document]),
            required: true,
            status: resource ? 'blocked' : unsupported ? 'unsupported' : 'verified',
          });
          for (const issue of discovered.issues)
            diagnostic(
              document,
              issue.code,
              issue.path,
              issue.unsupported
                ? 'dependency'
                : issue.code === 'resource_limit'
                  ? 'resource'
                  : 'compatibility',
              `locations/${issue.code}`,
              issue,
            );
          if (discovered.issues.length) unresolvedIncludes = true;
          if (resource) {
            interrupted = 'resource_limit';
            unavailable = true;
            blockedReason = MESSAGES.resource_limit;
          }
        }
      }
    } catch (error) {
      if (error instanceof ContractError) throw error;
      if (error instanceof SourceResolutionError) {
        const resource = error.code === 'resource_limit';
        diagnostic(
          document,
          error.code,
          error.path,
          error.unsupported ? 'dependency' : resource ? 'resource' : 'compatibility',
          `substitution/${error.code}`,
          error,
        );
        coverage.push({
          stage: 'substitution',
          subject,
          required: true,
          status: resource ? 'blocked' : error.unsupported ? 'unsupported' : 'verified',
          reason: error.message,
        });
        coverage.push({
          stage: 'compatibility',
          subject,
          required: resource || error.unsupported,
          status: 'blocked',
          reason: 'Source resolution did not produce a native-validation subject.',
        });
        if (resource) {
          interrupted = 'resource_limit';
          unavailable = true;
          blockedReason = MESSAGES.resource_limit;
        }
        continue;
      }
      const code =
        error instanceof CelError
          ? error.code === 'request_timeout'
            ? 'timeout'
            : 'cancelled'
          : error instanceof BackstageRuntimeError
            ? error.code
            : 'adapter_unavailable';
      diagnostic(document, code, '', code === 'adapter_unavailable' ? 'dependency' : 'resource');
      coverage.push({
        stage: phase === 'substitution' || phase === 'locations' ? 'substitution' : 'compatibility',
        subject:
          phase === 'locations'
            ? JSON.stringify(['locations', document.uri, document.document])
            : phase === 'references'
              ? JSON.stringify(['references', document.uri, document.document])
              : subject,
        required: true,
        status: 'blocked',
        reason: MESSAGES[code],
      });
      if (code !== 'adapter_unavailable')
        interrupted =
          code === 'timeout' ? 'timeout' : code === 'cancelled' ? 'cancelled' : 'resource_limit';
      unavailable = true;
      if (phase === 'locations') unresolvedIncludes = true;
      blockedReason = MESSAGES[code];
    }
  }
  if (!parsed.documents.length && !unavailable)
    coverage.push({
      stage: 'compatibility',
      subject: 'empty-input',
      required: true,
      status: 'verified',
    });
  return deepFreeze({
    adapterId: profile.adapterId,
    sourceDigest: run.source.digest,
    profileDigest: run.profile.digest,
    entities,
    references,
    sourceClaims,
    unresolvedSourceIdentities:
      unparsedSources ||
      unresolvedIncludes ||
      sourceClaims.some((claim) => claim.entityRef === undefined),
    findings,
    coverage,
    artifacts,
    interrupted,
  });
}
