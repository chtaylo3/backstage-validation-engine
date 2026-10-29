import { setImmediate as yieldTurn } from 'node:timers/promises';
import type {
  ActivationManifest,
  Coverage,
  DeploymentProfile,
  Finding,
  JsonValue,
  PolicyBundle,
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
  unsupported_substitution: 'Required source substitution has not been resolved.',
  resource_limit: 'Native validation exceeds configured resource limits.',
  cancelled: 'Native validation cancelled.',
  timeout: 'Validation request deadline exceeded during native validation.',
  adapter_unavailable: 'Pinned native adapter is unavailable.',
  invalid_reference: 'Reference does not satisfy the configured native reference context.',
  invalid_reference_shape: 'Reference field does not have the configured scalar/array structure.',
  invalid_identity: 'Entity identity cannot be represented by an unambiguous native reference.',
});

async function substitutionPath(
  value: Immutable<JsonValue>,
  budget: RequestBudget,
): Promise<string | undefined> {
  const stack: { value: Immutable<JsonValue>; path: string }[] = [{ value, path: '' }];
  let visited = 0;
  while (stack.length) {
    budget.throwIfInterrupted();
    if (++visited % 128 === 0) await yieldTurn();
    const item = stack.pop()!;
    if (item.value && typeof item.value === 'object') {
      for (const [key, child] of Object.entries(item.value)) {
        const path = `${item.path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
        if (['$text', '$json', '$yaml'].includes(key)) return path;
        stack.push({ value: child, path });
      }
    }
  }
  return undefined;
}

/** Executes parsing and declared BC-01/BC-02/BC-03 contexts; later stages are not attested. */
export async function validateBackstageSources(
  request: Immutable<ValidationRequest>,
  context: {
    readonly profile: Immutable<DeploymentProfile>;
    readonly policy: Immutable<PolicyBundle>;
    readonly activation: Immutable<ActivationManifest>;
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
    ...(options.uris ? { uris: options.uris } : {}),
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
  const artifacts: ValidationResult['artifacts'] = [];
  let interrupted = parsed.interrupted;
  const diagnostic = (
    document: ParsedSourceDocument,
    code: keyof typeof MESSAGES,
    path: string,
    category: Finding['category'],
    stage: string = code,
  ): void => {
    const ruleId = `backstage/${stage}`;
    const location = locateParsedPath(document, path);
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
      relatedLocations: [...(document.locations[path]?.relatedLocations ?? [])],
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
  for (const document of parsed.documents) {
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
    if (unavailable || !adapter || profile.requiredProcessors.length) {
      coverage.push({
        stage: 'compatibility',
        subject,
        required: true,
        status: 'blocked',
        reason: profile.requiredProcessors.length ? MESSAGES.unsupported_processor : blockedReason,
      });
      continue;
    }
    let phase: 'native' | 'references' = 'native';
    try {
      await yieldTurn();
      budget.throwIfInterrupted();
      const unresolved = await substitutionPath(document.value, budget);
      if (unresolved !== undefined) {
        diagnostic(document, 'unsupported_substitution', unresolved, 'dependency');
        coverage.push({
          stage: 'substitution',
          subject,
          required: true,
          status: 'unsupported',
          reason: MESSAGES.unsupported_substitution,
        });
        coverage.push({
          stage: 'compatibility',
          subject,
          required: true,
          status: 'blocked',
          reason: MESSAGES.unsupported_substitution,
        });
        continue;
      }
      const checked: NativeEntityCheck = await adapter.validate(
        document.value,
        profile.nativePolicies,
        { deadlineAt: run.execution.deadlineAt, signal: budget.signal },
      );
      budget.throwIfInterrupted();
      if (
        Buffer.byteLength(canonicalJson(checked.normalized), 'utf8') >
        profile.limits.expandedEntityBytes
      )
        throw new BackstageRuntimeError('resource_limit');
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
          authored: checked.authored,
          normalized: checked.normalized,
          changes,
        });
        artifacts.push({
          entityRef: checked.entityRef,
          sourceUri: document.uri,
          document: document.document,
          sourceDigest: document.sourceDigest,
          value: checked.normalized as JsonValue,
          provenance: changes.map((change) => ({
            path: change.path,
            origin: change.origin,
            transformation: `${profile.adapterId}/${change.policy}`,
          })),
        });
      }
    } catch (error) {
      if (error instanceof ContractError) throw error;
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
        stage: 'compatibility',
        subject:
          phase === 'references'
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
      unparsedSources || sourceClaims.some((claim) => claim.entityRef === undefined),
    findings,
    coverage,
    artifacts,
    interrupted,
  });
}
