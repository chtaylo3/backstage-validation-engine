import type {
  ActivationManifest,
  DeploymentProfile,
  PolicyBundle,
  SchemaArtifact,
  ValidationRequest,
} from '../contracts/schemas.js';
import { validateBackstageSources } from '../compatibility/sources.js';
import type { CatalogAccessContext, CatalogProvider } from '../providers/types.js';
import { CatalogProviderError } from '../providers/types.js';
import type { CelRuntime } from '../runtime/cel/index.js';
import { executePolicyRules } from './cel-rules.js';
import { deepFreeze } from './json.js';
import type { Immutable } from './json.js';
import { prepareBackstageReferenceData } from './reference-data.js';
import { verifyRequestBindings } from './bindings.js';
import { reject } from './errors.js';

export interface PolicySourceContext {
  readonly profile: Immutable<DeploymentProfile>;
  readonly policy: Immutable<PolicyBundle>;
  readonly activation: Immutable<ActivationManifest>;
  readonly schemaArtifacts?: readonly Immutable<SchemaArtifact>[];
}

/** Scoped native/source/rules composition; this does not qualify Backstage ingestion or authority. */
export async function validatePolicySources(
  request: Immutable<ValidationRequest>,
  context: PolicySourceContext,
  options: {
    readonly catalog?: {
      readonly provider: CatalogProvider;
      readonly access: CatalogAccessContext;
    };
    readonly signal?: AbortSignal;
    readonly runtime?: CelRuntime;
  } = {},
) {
  verifyRequestBindings(request, context);
  if (context.policy.extends.length)
    reject('invalid_policy', '/extends', 'inherited policies must be resolved before execution');
  const signal = options.signal ? { signal: options.signal } : {};
  const paths = [
    ...new Set(
      context.policy.rules
        .filter((rule) => rule.kind === 'catalog')
        .map((rule) => rule.referencePath),
    ),
  ];
  // An unconfigured dependency still produces reference locations and incomplete rule coverage.
  const unavailable: CatalogProvider = {
    connectionId: 'unconfigured',
    adapterId: context.profile.adapterId,
    lookup: () => Promise.reject(new CatalogProviderError('closed')),
    stats: () => ({ active: 0, queued: 0, cacheEntries: 0, cacheBytes: 0 }),
    close: () => Promise.resolve(),
  };
  const catalog = options.catalog ?? {
    provider: unavailable,
    access: {
      installationId: request.identity.installationId,
      principalId: 'unconfigured',
      permissionRevision: request.identity.permissionRevision,
      credentialRevision: 'unconfigured',
      scope: [],
      policyDigest: request.policy.digest,
      profileDigest: request.profile.digest,
      maxAgeMs: 0,
    },
  };
  const preparation = paths.length
    ? await prepareBackstageReferenceData(request, context, {
        ...catalog,
        ...signal,
        referencePaths: paths,
      })
    : undefined;
  const compatibility =
    preparation?.compatibility ?? (await validateBackstageSources(request, context, signal));
  const pinned = preparation?.evaluationRequest ?? request;
  const rules = await executePolicyRules(
    pinned,
    context,
    compatibility.entities.map((entity) => ({
      id: JSON.stringify([entity.document.uri, entity.document.document]),
      value: entity.normalized,
      location: {
        uri: entity.document.uri,
        document: entity.document.document,
        path: '',
        range: entity.document.range,
      },
    })),
    {
      ...signal,
      sourceDocuments: compatibility.entities.map((entity) => entity.document),
      ...(options.runtime ? { runtime: options.runtime } : {}),
      ...(preparation ? { referenceData: preparation } : {}),
    },
  );
  const priority = { none: 0, resource_limit: 1, worker_failure: 2, cancelled: 3, timeout: 4 };
  const interrupted = [
    preparation?.interrupted ?? 'none',
    compatibility.interrupted,
    rules.interrupted,
  ].reduce((a, b) => (priority[a] >= priority[b] ? a : b));
  return deepFreeze({
    request: pinned,
    compatibility,
    rules,
    findings: [...compatibility.findings, ...rules.findings],
    coverage: [...compatibility.coverage, ...rules.coverage],
    ruleStates: rules.ruleStates,
    interrupted,
    ...(preparation ? { preparation } : {}),
  });
}
