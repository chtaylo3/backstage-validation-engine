import { CONTRACT_VERSION } from '../contracts/schemas.js';
import { parseContract } from '../contracts/validate.js';

/** Initial ceilings, not a claim that compatibility stages are implemented. */
export const DEFAULT_DEPLOYMENT_PROFILE = parseContract('deployment-profile', {
  contractVersion: CONTRACT_VERSION,
  id: 'backstage-default/1',
  profileVersion: '1',
  adapterId: '@backstage/catalog-model@1.10.2',
  celProfileId: 'bve-cel/1',
  schemaDialect: 'draft-07',
  nativePolicies: {
    defaultNamespace: true,
    fieldFormat: true,
    noForeignRootFields: true,
    schema: true,
    groupDefaultParent: false,
  },
  admission: {
    allowedKinds: ['Component', 'API', 'Group', 'User', 'Resource', 'System', 'Domain', 'Location'],
    locations: [],
  },
  referenceContexts: [
    { path: '/spec/owner', defaultKind: 'Group', namespace: 'entity' },
    { path: '/spec/providesApis/*', defaultKind: 'API', namespace: 'entity' },
    { path: '/spec/consumesApis/*', defaultKind: 'API', namespace: 'entity' },
    { path: '/spec/system', defaultKind: 'System', namespace: 'entity' },
  ],
  customKinds: [],
  readers: ['snapshot-local'],
  requiredProcessors: [],
  limits: {
    requestBytes: 16 * 1024 * 1024,
    fileBytes: 1024 * 1024,
    entities: 1000,
    rules: 256,
    graphDepth: 64,
    substitutionDepth: 8,
    expandedEntityBytes: 1024 * 1024,
    requestTimeoutMs: 5000,
    celWorkers: 2,
    celOutstandingJobs: 64,
    celExecutionMs: 100,
  },
});
