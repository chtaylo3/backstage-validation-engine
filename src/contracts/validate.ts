import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import type {
  ActivationManifest,
  Coverage,
  DataSnapshot,
  DeploymentProfile,
  JsonValue,
  PolicyBundle,
  SourceSnapshot,
  ValidationRequest,
  ValidationResult,
} from './schemas.js';
import { contractSchemas } from './schemas.js';
import { ContractError, reject } from '../core/errors.js';
import { canonicalJson, deepFreeze, digestJson, digestText } from '../core/json.js';
import type { Immutable } from '../core/json.js';
import { orderRules } from '../policy/rule-graph.js';
import { compileReferenceContexts } from '../policy/reference-contexts.js';
import { isCanonicalSourceUri } from '../core/source-uris.js';
import { decideOutcome } from '../core/outcomes.js';

export interface ContractTypes {
  'json-value': JsonValue;
  'source-snapshot': SourceSnapshot;
  'data-snapshot': DataSnapshot;
  'deployment-profile': DeploymentProfile;
  'policy-bundle': PolicyBundle;
  'activation-manifest': ActivationManifest;
  'validation-request': ValidationRequest;
  coverage: Coverage;
  'validation-result': ValidationResult;
}

const ajv = new Ajv({ allErrors: true, strict: true, ownProperties: true });
for (const definition of Object.values(contractSchemas)) ajv.addSchema(definition);
const validators = new Map<string, ValidateFunction>();

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length)
    reject('invalid_contract', path, 'duplicate identities');
}

function checkSource(snapshot: SourceSnapshot): void {
  if (
    snapshot.rootUri !== undefined &&
    (!isCanonicalSourceUri(snapshot.rootUri, true) ||
      snapshot.files.some(
        (file) => !isCanonicalSourceUri(file.uri) || !file.uri.startsWith(snapshot.rootUri!),
      ) ||
      snapshot.changes.some(
        (change) => !isCanonicalSourceUri(change.uri) || !change.uri.startsWith(snapshot.rootUri!),
      ))
  ) {
    reject(
      'invalid_contract',
      '/rootUri',
      'local source files and changes must use canonical names inside the pinned root',
    );
  }
  if (snapshot.entrypoints?.some((uri) => !snapshot.files.some((file) => file.uri === uri)))
    reject(
      'invalid_contract',
      '/entrypoints',
      'catalog entrypoint is absent from the effective snapshot',
    );
  unique(
    snapshot.files.map((file) => file.uri),
    '/files',
  );
  unique(
    snapshot.changes.map((change) => change.uri),
    '/changes',
  );
  let total = 0;
  for (const file of snapshot.files) {
    const bytes = Buffer.byteLength(file.text, 'utf8');
    if (bytes > 1024 * 1024) reject('limit', '/files', 'file exceeds 1 MiB');
    total += bytes;
    if (digestText(file.text) !== file.digest)
      reject('integrity', '/files', 'file digest mismatch');
    if (file.origin === 'buffer' && file.version === undefined) {
      reject('invalid_contract', '/files', 'buffer sources require a document version');
    }
  }
  if (total > 16 * 1024 * 1024) reject('limit', '/files', 'request source exceeds 16 MiB');
  const files = new Set(snapshot.files.map((file) => file.uri));
  for (const change of snapshot.changes) {
    if ((change.kind === 'deleted') === files.has(change.uri)) {
      reject('invalid_contract', '/changes', 'change conflicts with effective source files');
    }
  }
  const { digest, ...content } = snapshot;
  if (digestJson(content) !== digest)
    reject('integrity', '/digest', 'source snapshot digest mismatch');
}

function checkData(snapshot: DataSnapshot): void {
  unique(
    snapshot.entries.map((entry) => entry.key),
    '/entries',
  );
  for (const entry of snapshot.entries) {
    if (entry.provenance.expiresAt <= entry.provenance.fetchedAt) {
      reject('invalid_contract', '/entries', 'data expiry must follow fetch time');
    }
  }
  const { digest, ...content } = snapshot;
  if (digestJson(content) !== digest)
    reject('integrity', '/digest', 'data snapshot digest mismatch');
}

function checkRequest(request: ValidationRequest): void {
  checkSource(request.source);
  checkData(request.data);
  if (request.run.generation !== request.activation.generation) {
    reject('invalid_contract', '/activation/generation', 'run and activation generations differ');
  }
  const duration = request.execution.deadlineAt - request.execution.startedAt;
  if (duration <= 0 || duration > 5000) {
    reject('limit', '/execution/deadlineAt', 'request deadline must be within 5 seconds of start');
  }
  for (const entry of request.data.entries) {
    const provenance = entry.provenance;
    if (provenance.installationId !== request.identity.installationId) {
      reject('invalid_contract', '/data', 'provider installation differs from request');
    }
    if (provenance.permissionRevision !== request.identity.permissionRevision) {
      reject('invalid_contract', '/data', 'provider permission revision differs from request');
    }
    if (
      provenance.fetchedAt > request.execution.startedAt ||
      provenance.expiresAt <= request.execution.startedAt
    ) {
      reject('invalid_contract', '/data', 'provider snapshot is not fresh at evaluation time');
    }
  }
}

function checkResult(result: ValidationResult): void {
  unique(
    result.findings.map((finding) => finding.id),
    '/findings',
  );
  unique(
    result.coverage.map((entry) => `${entry.stage}\0${entry.subject}`),
    '/coverage',
  );
  unique(
    result.ruleStates.map((state) => `${state.ruleId}\0${state.subjectId}`),
    '/ruleStates',
  );
  for (const finding of result.findings) {
    for (const location of [finding.location, ...finding.relatedLocations, ...finding.edits]) {
      const { start, end } = location.range;
      if (end.line < start.line || (end.line === start.line && end.character < start.character)) {
        reject('invalid_contract', '/findings', 'source range ends before it starts');
      }
    }
  }
  if (
    result.resources.completedAt < result.resources.startedAt ||
    result.resources.deadlineAt <= result.resources.startedAt ||
    result.resources.deadlineAt - result.resources.startedAt > 5000
  ) {
    reject('invalid_contract', '/resources', 'invalid execution timestamps');
  }
  if (
    result.resources.completedAt >= result.resources.deadlineAt &&
    result.resources.interrupted === 'none'
  ) {
    reject(
      'invalid_contract',
      '/resources',
      'elapsed request deadline requires an interruption state',
    );
  }
  if (
    result.freshness.publishBefore <= result.freshness.authorityCheckedAt ||
    result.freshness.publishBefore - result.freshness.authorityCheckedAt > 60_000 ||
    result.freshness.authorityCheckedAt > result.freshness.evaluatedAt ||
    result.freshness.evaluatedAt !== result.resources.completedAt
  ) {
    reject('invalid_contract', '/freshness', 'invalid authority freshness window');
  }
  if (result.bypass) {
    const receipt = result.bypass;
    if (
      receipt.installationId !== result.provenance.installationId ||
      receipt.repositoryId !== result.provenance.repositoryId ||
      receipt.issuedAt > receipt.verifiedAt ||
      receipt.verifiedAt >= receipt.expiresAt ||
      receipt.verifiedAt > result.resources.completedAt ||
      receipt.expiresAt <= result.resources.completedAt
    ) {
      reject(
        'invalid_contract',
        '/bypass',
        'bypass receipt scope or validity window differs from result',
      );
    }
    if (result.freshness.publishBefore > receipt.expiresAt) {
      reject('invalid_contract', '/freshness', 'publication must precede bypass expiry');
    }
  }
  const expected = decideOutcome({
    ...result,
    interrupted: result.resources.interrupted,
  });
  if (result.outcome !== expected.outcome || result.enforcement !== expected.enforcement) {
    reject('invalid_contract', '/outcome', 'decision disagrees with execution evidence');
  }
  if (result.outcome === 'bypassed') {
    if (
      !result.bypass ||
      result.bypass.type !== 'emergency' ||
      result.bypass.entityScope !== undefined ||
      result.enforcement !== 'allow'
    ) {
      reject(
        'invalid_contract',
        '/bypass',
        'whole-run bypass requires a repository emergency receipt',
      );
    }
    if (!result.coverage.some((entry) => entry.status === 'bypassed')) {
      reject('invalid_contract', '/coverage', 'bypassed result must record bypassed coverage');
    }
    if (
      result.ruleStates.length > 0 ||
      result.findings.length > 0 ||
      result.artifacts.length > 0 ||
      result.resources.interrupted !== 'none' ||
      result.coverage.some((entry) => entry.status !== 'verified' && entry.status !== 'bypassed')
    ) {
      reject(
        'invalid_contract',
        '/bypass',
        'early emergency bypass cannot claim rule execution or incomplete work',
      );
    }
  } else {
    if (
      result.coverage.some((entry) => entry.status === 'bypassed') ||
      result.findings.some((entry) => entry.enforcement === 'bypassed')
    ) {
      if (!result.bypass)
        reject('invalid_contract', '/bypass', 'waived work requires an authorization receipt');
    }
  }
}

/**
 * Structural + local semantic validation. This verifies integrity, not authority:
 * identity references and receipts must originate from trusted adapters/verifiers.
 */
export function parseContract<K extends keyof ContractTypes>(
  name: K,
  input: unknown,
): Immutable<ContractTypes[K]> {
  const value: unknown = JSON.parse(canonicalJson(input));
  let validate = validators.get(name);
  if (!validate) {
    const id = contractSchemas[name].$id;
    if (!id) throw new Error(`Missing built-in schema ID: ${name}`);
    validate = ajv.getSchema(id);
    if (!validate) throw new Error(`Missing built-in schema: ${name}`);
    validators.set(name, validate);
  }
  if (!validate(value)) {
    throw new ContractError(
      'invalid_contract',
      (validate.errors ?? []).map((error) => ({
        path: error.instancePath,
        message: error.message ?? 'schema validation failed',
      })),
    );
  }
  // AJV validates against the schema selected by K; the cases add cross-field checks.
  switch (name) {
    case 'source-snapshot':
      checkSource(value as SourceSnapshot);
      break;
    case 'data-snapshot':
      checkData(value as DataSnapshot);
      break;
    case 'validation-request':
      checkRequest(value as ValidationRequest);
      break;
    case 'validation-result':
      checkResult(value as ValidationResult);
      break;
    case 'deployment-profile': {
      const profile = value as DeploymentProfile;
      if (
        profile.nativePolicies.groupDefaultParent &&
        !profile.nativePolicies.groupDefaultParentRef
      ) {
        reject(
          'invalid_contract',
          '/nativePolicies/groupDefaultParentRef',
          'enabled group-parent defaulting requires a pinned parent reference',
        );
      }
      if (profile.limits.fileBytes > profile.limits.requestBytes)
        reject('invalid_contract', '/limits', 'file budget exceeds request budget');
      unique(
        profile.referenceContexts.map((context) => context.path),
        '/referenceContexts',
      );
      compileReferenceContexts(profile.referenceContexts);
      unique(
        profile.requiredProcessors.map((processor) =>
          JSON.stringify([processor.id, processor.stage]),
        ),
        '/requiredProcessors',
      );
      break;
    }
    case 'policy-bundle': {
      const bundle = value as PolicyBundle;
      unique(
        bundle.rules.map((rule) => rule.id),
        '/rules',
      );
      // Inherited prerequisite resolution belongs to the future policy resolver.
      if (bundle.extends.length === 0) orderRules(bundle.rules);
      break;
    }
    case 'json-value':
    case 'activation-manifest':
    case 'coverage':
      break;
  }
  return deepFreeze(value as ContractTypes[K]);
}
