import { digestJson } from '../base/json.js';
import type { Immutable } from '../base/json.js';
import type { ValidationRequest } from '../contracts/schemas.js';
import { parseBinding } from './admission.js';
import type { ContextBinding } from './schemas.js';
import type { CatalogAccessContext, CatalogProvider } from '../providers/types.js';

export function capabilityAuthorityDigest(
  identity: ValidationRequest['identity'] | Immutable<ValidationRequest['identity']>,
  catalog?: {
    readonly provider: Pick<CatalogProvider, 'connectionId' | 'adapterId'>;
    readonly access: CatalogAccessContext;
  },
): string {
  return digestJson({
    identity,
    catalog: catalog
      ? {
          connectionId: catalog.provider.connectionId,
          adapterId: catalog.provider.adapterId,
          access: catalog.access,
        }
      : null,
  });
}

export function capabilityBinding(
  request: Immutable<ValidationRequest>,
  state: {
    readonly workspaceGeneration: number;
    readonly sessionGeneration?: number;
    readonly dependencyGeneration?: number;
    readonly dependencyDigest?: string;
    readonly authorityContextDigest?: string;
  },
): Immutable<ContextBinding> {
  const identity = {
    sourceDigest: request.source.digest,
    ...(request.baseline ? { baselineDigest: request.baseline.digest } : {}),
    policyDigest: request.policy.digest,
    profileDigest: request.profile.digest,
    activationDigest: request.activation.digest,
    dataDigest: request.data.digest,
    activationGeneration: request.activation.generation,
    workspaceGeneration: state.workspaceGeneration,
    sessionGeneration: state.sessionGeneration ?? 0,
    dependencyGeneration: state.dependencyGeneration ?? 0,
    dependencyDigest: state.dependencyDigest ?? digestJson({ dataDigest: request.data.digest }),
    authorityContextDigest: state.authorityContextDigest ?? digestJson(request.identity),
  };
  return parseBinding({ ...identity, contextId: digestJson(identity) });
}
