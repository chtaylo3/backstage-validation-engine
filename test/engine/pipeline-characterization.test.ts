import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import {
  CatalogProviderError,
  catalogEntityKey,
  closeSharedCelRuntime,
  createDataSnapshot,
  createSourceSnapshot,
  digestJson,
  overlaySourceSnapshot,
  parseContract,
  prepareBackstageReferenceData,
  validateBackstageSources,
  validatePolicySources,
} from '../../src/index.js';
import type {
  CatalogProvider,
  DataEntry,
  JsonValue,
  PolicyBundle,
  SourceInput,
} from '../../src/index.js';
import {
  schemaArtifact,
  widgetArtifact,
  widgetDeclaration,
  widgetProfile,
  widgetText,
  widgetValue,
} from '../harness/custom-kind-fixture.js';
import {
  encodeScenario,
  expandRepeats,
  matchesEntry,
  summarize,
} from '../harness/golden-format.js';
import type { GoldenEntry } from '../harness/golden-format.js';
import { componentText, localTeam, ownerRule, policyRun } from '../harness/policy-fixture.js';
import { URI } from '../helpers.js';

/**
 * Characterization of the source, reference and rule pipeline. The golden file was generated from
 * the pipeline before it was split into stages; every scenario must keep producing the same
 * report, including array order and key order. A scenario whose report is small is stored as a
 * literal; a large one as the digest and length of its JSON text with a readable summary. On a
 * mismatch the observed reports are written under MISMATCHES for diffing against a known-good
 * checkout. Regenerate only with BVE_UPDATE_PIPELINE_GOLDEN=1 and only when a plan names the
 * behavior change.
 */
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const GOLDEN = path.join(repository, 'test/fixtures/pipeline-golden.json');
const MISMATCHES = path.join(repository, '.artifacts/tests/pipeline-characterization');
/** Scenarios whose shared literal form is longer than this are stored by digest. */
const LITERAL_LIMIT = 16 * 1024;
interface Golden {
  readonly format: 2;
  readonly literalLimit: number;
  readonly scenarios: Readonly<Record<string, GoldenEntry>>;
}
const ROOT = 'file:///workspace/';
type Mode = 'ci' | 'ide';
type Rule = PolicyBundle['rules'][number];
type Run = ReturnType<typeof policyRun>;
after(closeSharedCelRuntime);

// Wall-clock and run-identity fields that differ between runs of the same scenario.
const VOLATILE = new Set([
  'startedAt',
  'deadlineAt',
  'fetchedAt',
  'expiresAt',
  'collectionStartedAt',
  'elapsedMs',
  'wallElapsedMs',
  'deadlineRemainingMs',
]);
function sanitize(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, function (this: Record<string, unknown>, key, current: unknown) {
      if (current === undefined) return '<undefined>';
      if (VOLATILE.has(key) && typeof current === 'number') return '<volatile>';
      // The request's run identity and the digest of time-stamped data snapshots.
      if (key === 'run' && current && typeof current === 'object' && 'runId' in current)
        return '<volatile>';
      if (key === 'digest' && Array.isArray(this.entries)) return '<volatile>';
      // Bulk payloads are characterized by their length and digest rather than element by element.
      if (
        Array.isArray(current) &&
        current.length > 64 &&
        current.every((item) => item === null || typeof item !== 'object')
      )
        return { '<scalars>': current.length, digest: digestJson(current as JsonValue) };
      return current;
    }),
  ) as unknown;
}
async function outcome(action: () => Promise<unknown>): Promise<unknown> {
  try {
    return { report: sanitize(await action()) };
  } catch (error) {
    const failure = error as { name?: string; code?: string; message?: string; issues?: unknown };
    return {
      error: sanitize({
        name: failure.name,
        code: failure.code,
        message: failure.message,
        issues: failure.issues,
      }),
    };
  }
}

const cel = (id: string, expression: string, patch: Partial<Rule> = {}): Rule =>
  ({
    id,
    version: '1',
    kind: 'cel',
    mandatory: true,
    severity: 'error',
    requires: [],
    expression,
    ...patch,
  }) as Rule;
const component = (name: string, spec: Record<string, JsonValue> = {}, extra = {}) => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name },
  spec: { type: 'service', lifecycle: 'production', owner: 'team', ...spec },
  ...extra,
});
const group = (name: string) => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Group',
  metadata: { name },
  spec: { type: 'team', children: [] },
});
const location = (spec: JsonValue, name = 'sources') =>
  stringify({ apiVersion: 'backstage.io/v1alpha1', kind: 'Location', metadata: { name }, spec });
const documents = (...values: readonly unknown[]) =>
  values.map((value) => (typeof value === 'string' ? value : stringify(value))).join('---\n');

const lifecycleArtifact = schemaArtifact({
  type: 'object',
  required: ['spec'],
  properties: {
    spec: {
      type: 'object',
      required: ['lifecycle'],
      properties: { lifecycle: { const: 'production' } },
    },
  },
});
const requiredArtifact = parseContract('schema-artifact', {
  ...schemaArtifact({
    type: 'object',
    required: ['spec'],
    properties: { spec: { type: 'object', required: ['tier'] } },
  }),
  id: 'example/required-tier',
});
const schemaRule = (
  id: string,
  artifact: { id: string; version: string; digest: string },
  patch: Partial<Rule> = {},
): Rule =>
  ({
    id,
    version: '1',
    kind: 'schema',
    mandatory: true,
    severity: 'error',
    requires: [],
    schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
    ...patch,
  }) as Rule;
const missingArtifact = {
  id: 'example/absent',
  version: '1',
  digest: 'sha256:' + '0'.repeat(64),
};

type Fact = 'present' | 'missing' | 'unavailable';
/** A deterministic in-memory catalog that answers each reference with a configured status. */
function stubCatalog(
  state: Run,
  facts: Readonly<Record<string, Fact>>,
  options: {
    readonly fail?: Error;
    readonly clock?: 'expired' | 'future';
    readonly value?: JsonValue;
  } = {},
) {
  const access = {
    installationId: state.request.identity.installationId,
    principalId: 'reader',
    permissionRevision: state.request.identity.permissionRevision,
    credentialRevision: '1',
    scope: ['catalog:read'],
    profileDigest: state.request.profile.digest,
    policyDigest: state.request.policy.digest,
    maxAgeMs: 0,
  };
  const provider: CatalogProvider = {
    connectionId: 'stub',
    adapterId: state.context.profile.adapterId,
    lookup: (refs) => {
      if (options.fail) return Promise.reject(options.fail);
      const now = Date.now();
      const fetchedAt =
        options.clock === 'future' ? now + 30_000 : options.clock === 'expired' ? now - 2000 : now;
      const expiresAt = options.clock === 'expired' ? now - 1000 : now + 60_000;
      const provenance = {
        providerId: 'backstage-catalog',
        connectionId: 'stub',
        installationId: access.installationId,
        principalId: access.principalId,
        permissionRevision: access.permissionRevision,
        scope: access.scope,
        revision: 'stub-1',
        fetchedAt,
        expiresAt,
      };
      const entries = refs.map((ref): DataEntry => {
        const key = catalogEntityKey('stub', ref);
        const status = facts[ref] ?? 'missing';
        if (status === 'present')
          return { key, status, value: options.value ?? { kind: 'Group', ref }, provenance };
        if (status === 'unavailable') return { key, status, reason: 'offline', provenance };
        return { key, status, provenance };
      });
      return Promise.resolve({
        data: createDataSnapshot(entries),
        failures: [],
        interrupted: 'none',
      });
    },
    stats: () => ({ active: 0, queued: 0, cacheEntries: 0, cacheBytes: 0 }),
    close: () => Promise.resolve(),
  };
  return { provider, access };
}

const policy = (state: Run, options: Parameters<typeof validatePolicySources>[2] = {}) =>
  validatePolicySources(state.request, state.context, options);
const aborted = () => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};
const catalogSource = documents(
  component('present-owner'),
  component('missing-owner', { owner: 'missing' }),
  component('down-owner', { owner: 'down' }),
  group('other'),
);
const catalogRules: readonly Rule[] = [
  ownerRule,
  {
    id: 'any-owner-exists',
    version: '1',
    kind: 'catalog',
    check: 'exists',
    referencePath: '/spec/owner',
    mandatory: false,
    severity: 'warning',
    requires: [],
  },
];
const catalogFacts = {
  'group:default/team': 'present',
  'group:default/missing': 'missing',
  'group:default/down': 'unavailable',
} as const;

interface Scenario {
  readonly name: string;
  readonly modes?: readonly Mode[];
  run(mode: Mode): Promise<unknown>;
}
const scenarios: readonly Scenario[] = [
  {
    name: '01-valid-cel-pass',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          files: [localTeam],
          rules: [
            cel('named', 'has(entity.metadata.name)'),
            cel('stock-api', 'entity.apiVersion == "backstage.io/v1alpha1"', { mandatory: false }),
          ],
        }),
      ),
  },
  {
    name: '02-cel-fail-mandatory-advisory',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          rules: [
            cel('mandatory-error', 'entity.spec.lifecycle == "experimental"'),
            cel('advisory-warning', 'entity.spec.type == "website"', {
              mandatory: false,
              severity: 'warning',
            }),
            cel('advisory-error', 'entity.metadata.name == "other"', { mandatory: false }),
          ],
        }),
      ),
  },
  {
    name: '03-selector-not-applicable',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          rules: [
            cel('groups-only', 'false', { selector: 'entity.kind == "Group"' }),
            cel('components', 'true', { selector: 'entity.kind == "Component"' }),
          ],
        }),
      ),
  },
  {
    name: '04-prerequisite-blocked',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          rules: [
            cel('base', 'entity.spec.lifecycle == "experimental"'),
            cel('dependent', 'true', { requires: ['base'] }),
            cel('independent', 'true'),
            cel('after-not-applicable', 'true', { requires: ['skipped'] }),
            cel('skipped', 'true', { selector: 'false' }),
          ],
        }),
      ),
  },
  {
    name: '05-schema-rules',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          text: componentText('team').replace('production', 'experimental'),
          schemaArtifacts: [lifecycleArtifact, requiredArtifact],
          rules: [
            schemaRule('schema-pass', requiredArtifact, { selector: 'false' }),
            schemaRule('schema-fix', lifecycleArtifact),
            schemaRule('schema-no-fix', requiredArtifact, { mandatory: false }),
            schemaRule('schema-unavailable', missingArtifact),
            schemaRule('schema-unavailable-advisory', missingArtifact, {
              mandatory: false,
              severity: 'warning',
            }),
          ],
        }),
      ),
  },
  {
    name: '05b-schema-pass',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          schemaArtifacts: [lifecycleArtifact],
          rules: [schemaRule('schema-pass', lifecycleArtifact)],
        }),
      ),
  },
  {
    name: '06-schema-fix-limit',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          text: documents(
            ...Array.from({ length: 66 }, (_, index) =>
              component(`service-${index}`, { lifecycle: 'experimental' }),
            ),
          ),
          schemaArtifacts: [lifecycleArtifact],
          rules: [schemaRule('schema-fix', lifecycleArtifact)],
        }),
      ),
  },
  {
    name: '07a-catalog-facts',
    run: async (mode) => {
      const state = policyRun({ mode, text: catalogSource, rules: catalogRules });
      const local: unknown[] = [];
      const report = await policy(state, {
        catalog: stubCatalog(state, catalogFacts),
        onLocalSources: (sources) => local.push(sources),
      });
      return { report, local };
    },
  },
  {
    name: '07b-catalog-unconfigured',
    run: (mode) => policy(policyRun({ mode, text: catalogSource, rules: catalogRules })),
  },
  {
    name: '07c-catalog-local-target',
    run: (mode) => policy(policyRun({ mode, files: [localTeam], rules: catalogRules })),
  },
  {
    name: '07d-catalog-provider-input-limit',
    run: (mode) => {
      const state = policyRun({ mode, text: catalogSource, rules: catalogRules });
      return policy(state, {
        catalog: stubCatalog(state, catalogFacts, {
          fail: new CatalogProviderError('input_limit'),
        }),
      });
    },
  },
  {
    name: '07e-catalog-provider-error',
    run: (mode) => {
      const state = policyRun({ mode, text: catalogSource, rules: catalogRules });
      return policy(state, {
        catalog: stubCatalog(state, catalogFacts, { fail: new Error('stub provider failure') }),
      });
    },
  },
  {
    name: '07f-catalog-expired-observation',
    run: (mode) => {
      const state = policyRun({ mode, text: catalogSource, rules: catalogRules });
      return policy(state, { catalog: stubCatalog(state, catalogFacts, { clock: 'expired' }) });
    },
  },
  {
    name: '07g-catalog-future-observation',
    run: (mode) => {
      const state = policyRun({ mode, text: catalogSource, rules: catalogRules });
      return policy(state, { catalog: stubCatalog(state, catalogFacts, { clock: 'future' }) });
    },
  },
  {
    name: '07h-catalog-baseline-deletion',
    run: (mode) => {
      const baseline = createSourceSnapshot({
        repository: 'repository',
        revision: 'base',
        rootUri: ROOT,
        files: [
          { uri: URI, text: componentText() },
          { uri: ROOT + 'team.yaml', text: stringify(group('team')) },
        ],
      });
      const state = policyRun({
        mode,
        baseline,
        source: overlaySourceSnapshot(baseline, [{ uri: ROOT + 'team.yaml', deleted: true }]),
        rules: catalogRules,
      });
      return policy(state, { catalog: stubCatalog(state, catalogFacts) });
    },
  },
  {
    name: '07i-catalog-aborted',
    run: (mode) => {
      const state = policyRun({ mode, text: catalogSource, rules: catalogRules });
      return policy(state, { catalog: stubCatalog(state, catalogFacts), signal: aborted() });
    },
  },
  {
    name: '08-cel-invalid-and-evaluation-error',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          rules: [
            cel('parse-error', 'entity.spec.owner =='),
            cel('evaluation-error', 'entity.spec.absent == "x"'),
            cel('non-boolean', 'entity.spec.owner'),
            cel('bad-selector', 'true', { selector: 'entity.(' }),
            cel('after-error', 'true', { requires: ['evaluation-error'] }),
          ],
        }),
      ),
  },
  {
    name: '09-parse-failures',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          rules: [cel('owner-required', 'has(entity.spec.owner)')],
          text: documents(component('first'), 'metadata: [broken\n', component('third')),
          files: [{ uri: ROOT + 'invalid.yaml', text: 'kind: [\n  - : :\n' }],
        }),
      ),
  },
  {
    name: '10-substitutions',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          rootUri: ROOT,
          entrypoints: [URI],
          rules: [cel('owner-required', 'has(entity.spec.owner)')],
          text: documents(
            component('resolved', { description: { $text: './payload.txt' } }),
            component('unsupported', { description: { $text: 'https://example.com/payload' } }),
            component('missing', { description: { $text: './absent.txt' } }),
            component('invalid', { description: { $text: './payload.txt', extra: 1 } }),
            { ...component('structured'), spec: { $yaml: './spec.yaml' } },
            component('after'),
          ),
          files: [
            { uri: ROOT + 'payload.txt', text: 'payload text\n', version: 3, origin: 'buffer' },
            {
              uri: ROOT + 'spec.yaml',
              text: stringify({ type: 'service', lifecycle: 'experimental', owner: 'team' }),
            },
          ],
        }),
      ),
  },
  {
    name: '10b-substitution-without-root',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          rules: [],
          text: documents(component('rootless', { description: { $text: './payload.txt' } })),
          files: [{ uri: ROOT + 'payload.txt', text: 'payload' }],
        }),
      ),
  },
  {
    name: '10c-substitution-resource-limit',
    run: (mode) => {
      const base = policyRun();
      return policy(
        policyRun({
          mode,
          rootUri: ROOT,
          entrypoints: [URI],
          rules: [cel('owner-required', 'has(entity.spec.owner)')],
          profile: { limits: { ...base.context.profile.limits, expandedEntityBytes: 1024 } },
          text: documents(
            component('first'),
            component('large', { description: { $text: './large.txt' } }),
            component('blocked-after'),
            component('blocked-again'),
          ),
          files: [{ uri: ROOT + 'large.txt', text: 'x'.repeat(2000) }],
        }),
      );
    },
  },
  {
    name: '11a-location-includes',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          rootUri: ROOT,
          entrypoints: [URI],
          rules: [
            cel('owner-required', 'has(entity.spec.owner)', {
              selector: 'entity.kind == "Component"',
            }),
          ],
          text: location({
            type: 'file',
            targets: ['./service.yaml', './broken.yaml', './absent.yaml'],
          }),
          files: [
            { uri: ROOT + 'service.yaml', text: componentText() },
            { uri: ROOT + 'broken.yaml', text: 'metadata: [broken\n' },
          ],
        }),
      ),
  },
  {
    name: '11b-location-cycle',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          rootUri: ROOT,
          entrypoints: [URI],
          rules: [],
          text: location({ target: './nested.yaml' }),
          files: [
            {
              uri: ROOT + 'nested.yaml',
              text: location({ target: './catalog-info.yaml' }, 'nested'),
            },
          ],
        }),
      ),
  },
  {
    name: '11c-location-unsupported-targets',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          rootUri: ROOT,
          entrypoints: [URI],
          rules: [],
          text: documents(
            location({ type: 'url', target: './service.yaml' }, 'remote'),
            location({ type: 'file', target: './*.yaml' }, 'glob'),
            location({ type: 'file', target: './optional.yaml', presence: 'optional' }, 'optional'),
          ),
        }),
      ),
  },
  {
    name: '11d-location-entity-limit',
    run: (mode) => {
      const base = policyRun();
      return policy(
        policyRun({
          mode,
          rootUri: ROOT,
          entrypoints: [URI],
          rules: [],
          profile: { limits: { ...base.context.profile.limits, entities: 2 } },
          text: location({ type: 'file', targets: ['./a.yaml', './b.yaml'] }),
          files: [
            { uri: ROOT + 'a.yaml', text: componentText() },
            { uri: ROOT + 'b.yaml', text: stringify(group('team')) },
          ],
        }),
      );
    },
  },
  {
    name: '11e-location-include-document-limit',
    run: (mode) => {
      const base = policyRun();
      return policy(
        policyRun({
          mode,
          rootUri: ROOT,
          entrypoints: [URI],
          rules: [],
          profile: { limits: { ...base.context.profile.limits, entities: 2 } },
          text: documents(location({ type: 'file', target: './groups.yaml' }), component('later')),
          files: [
            {
              uri: ROOT + 'groups.yaml',
              text: documents(group('one'), group('two'), group('three')),
            },
          ],
        }),
      );
    },
  },
  {
    name: '12-admission-and-custom-kinds',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          rules: [cel('owner-required', 'has(entity.spec.owner)')],
          profile: {
            ...widgetProfile,
            admission: {
              allowedKinds: [...(widgetProfile.admission?.allowedKinds ?? []), 'Gadget', 'Gizmo'],
              locations: [
                { sourcePrefix: ROOT + 'templates/', allowedKinds: ['Template'] },
                { sourcePrefix: ROOT + 'exact.yaml', allowedKinds: ['Template'] },
              ],
            },
            customKinds: [
              widgetDeclaration,
              {
                ...widgetDeclaration,
                kind: 'Gadget',
                schema: { ...widgetDeclaration.schema, id: 'example/gadget' },
              },
            ],
          },
          schemaArtifacts: [widgetArtifact],
          text: documents(
            widgetText(),
            { ...widgetValue({ owner: 'Not Valid', tier: 0 }), metadata: { name: 'invalid' } },
            { ...widgetValue(), kind: 'Gadget', metadata: { name: 'gadget' } },
            { ...component('template'), kind: 'Template' },
            { ...component('gizmo'), kind: 'Gizmo' },
          ),
          files: [
            {
              uri: ROOT + 'exact.yaml',
              text: stringify({ ...component('exact'), kind: 'Template' }),
            },
            {
              uri: ROOT + 'exact.yaml.d/nested.yaml',
              text: stringify({ ...component('nested'), kind: 'Template' }),
            },
            {
              uri: ROOT + 'templates/template.yaml',
              text: stringify({
                apiVersion: 'scaffolder.backstage.io/v1beta3',
                kind: 'template',
                metadata: { name: 'admitted' },
                spec: { owner: 'team' },
              }),
            },
          ],
        }),
      ),
  },
  {
    name: '13-native-checks',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          rules: [cel('owner-required', 'has(entity.spec.owner)')],
          profile: widgetProfile,
          schemaArtifacts: [widgetArtifact],
          text: documents(
            { ...component('future'), apiVersion: 'backstage.io/v2' },
            { ...widgetValue(), apiVersion: 'example.com/v2' },
            component('bad name'),
            component('foreign', {}, { status: 'unexpected' }),
            { ...component('namespaced'), metadata: { name: 'namespaced', namespace: 'Payments' } },
            component('normalized'),
          ),
        }),
      ),
  },
  {
    name: '14-references-and-identity',
    run: (mode) => {
      const base = policyRun();
      return policy(
        policyRun({
          mode,
          rules: [cel('owner-required', 'has(entity.spec.owner)')],
          profile: {
            nativePolicies: {
              ...base.context.profile.nativePolicies,
              schema: false,
              fieldFormat: false,
            },
            referenceContexts: [
              ...base.context.profile.referenceContexts,
              { path: '/spec/details/*/target', defaultKind: 'Group', namespace: 'entity' },
            ],
          },
          text: documents(
            component('bad-reference', { owner: 'group:/private-value' }),
            component('bad-shape', { details: { target: 'team' } }),
            component('bad-value', { details: [{ target: 'team' }, { target: 9 }] }),
            { ...component('identity'), metadata: { name: 'identity', namespace: 'x/y' } },
            component('good', { providesApis: ['api-a'], system: 'ledger' }),
          ),
        }),
      );
    },
  },
  {
    name: '15a-competing-claims',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          rules: [cel('owner-required', 'has(entity.spec.owner)')],
          text: documents(component('twin'), component('twin', { lifecycle: 'experimental' })),
          files: [{ uri: ROOT + 'other.yaml', text: stringify(component('twin')) }],
        }),
      ),
  },
  {
    name: '15b-dense-competing-claims',
    modes: ['ci'],
    run: (mode) =>
      policy(
        policyRun({
          mode,
          rules: [],
          files: [
            {
              uri: ROOT + 'team.yaml',
              text: Array.from({ length: 66 }, () => stringify(group('team'))).join('---\n'),
            },
          ],
        }),
      ),
  },
  {
    name: '15c-conflicted-location',
    run: (mode) => {
      const descriptor = (target: string) =>
        stringify({
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'Location',
          metadata: { name: 'same' },
          spec: { type: 'file', target },
        });
      return policy(
        policyRun({
          mode,
          rootUri: ROOT,
          entrypoints: [URI, ROOT + 'a.yaml', ROOT + 'b.yaml'],
          rules: [
            cel('owner-required', 'has(entity.spec.owner)', {
              selector: 'entity.kind == "Component"',
            }),
          ],
          files: [
            { uri: ROOT + 'a.yaml', text: descriptor('./team.yaml') },
            { uri: ROOT + 'b.yaml', text: descriptor('./other.yaml') },
            { uri: ROOT + 'team.yaml', text: stringify(group('team')) },
            { uri: ROOT + 'other.yaml', text: stringify(group('other')) },
          ],
        }),
      );
    },
  },
  {
    name: '16a-required-processors-policy',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          profile: { requiredProcessors: [{ id: 'example-processor', stage: 'before-native' }] },
          rules: [cel('owner-required', 'has(entity.spec.owner)'), ownerRule],
          files: [localTeam],
        }),
      ),
  },
  {
    name: '16b-required-processors-sources-selection',
    run: (mode) => {
      const state = policyRun({
        mode,
        profile: { requiredProcessors: [{ id: 'example-processor', stage: 'before-native' }] },
        rules: [],
        files: [localTeam, { uri: ROOT + 'third.yaml', text: componentText('team') }],
      });
      return validateBackstageSources(state.request, state.context, {
        uris: [localTeam.uri, URI],
      });
    },
  },
  {
    name: '16c-required-processors-invalid-selection',
    modes: ['ci'],
    run: (mode) => {
      const state = policyRun({
        mode,
        profile: { requiredProcessors: [{ id: 'example-processor', stage: 'before-native' }] },
        rules: [],
      });
      return validateBackstageSources(state.request, state.context, { uris: [URI, URI] });
    },
  },
  {
    name: '16d-required-processors-entity-limit',
    modes: ['ci'],
    run: (mode) => {
      const base = policyRun();
      const files: SourceInput[] = Array.from({ length: 4 }, (_, index) => ({
        uri: `${ROOT}extra-${index}.yaml`,
        text: componentText(),
      }));
      return policy(
        policyRun({
          mode,
          profile: {
            requiredProcessors: [{ id: 'example-processor', stage: 'before-native' }],
            limits: { ...base.context.profile.limits, entities: 3 },
          },
          rules: [],
          files,
        }),
      );
    },
  },
  {
    name: '17-empty-snapshot',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          rules: [cel('owner-required', 'has(entity.spec.owner)')],
          source: createSourceSnapshot({ repository: 'repository', revision: '1', files: [] }),
        }),
      ),
  },
  {
    name: '17b-empty-snapshot-no-rules',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          rules: [],
          source: createSourceSnapshot({ repository: 'repository', revision: '1', files: [] }),
        }),
      ),
  },
  {
    name: '18-expanded-entity-limit',
    run: (mode) => {
      const base = policyRun();
      const large = component('large', { description: 'd'.repeat(300) });
      return policy(
        policyRun({
          mode,
          rules: [cel('owner-required', 'has(entity.spec.owner)')],
          profile: {
            limits: {
              ...base.context.profile.limits,
              // The authored entity fits; the normalized one adds a default namespace.
              expandedEntityBytes: Buffer.byteLength(JSON.stringify(large)) + 4,
            },
          },
          text: documents(component('first'), large, component('blocked-after')),
        }),
      );
    },
  },
  {
    name: '19-aborted-sources',
    run: (mode) => {
      const state = policyRun({ mode, rules: [cel('owner-required', 'has(entity.spec.owner)')] });
      return policy(state, { signal: aborted() });
    },
  },
  {
    name: '20-ambiguous-reference-context',
    modes: ['ci'],
    run: (mode) =>
      policy(
        policyRun({
          mode,
          rules: [],
          profile: {
            referenceContexts: [{ path: '/spec/owner', defaultKind: 'Group', namespace: 'a/b' }],
          },
        }),
      ),
  },
  {
    name: '16e-required-processors-aborted',
    run: (mode) =>
      policy(
        policyRun({
          mode,
          profile: { requiredProcessors: [{ id: 'example-processor', stage: 'before-native' }] },
          rules: [ownerRule],
        }),
        { signal: aborted() },
      ),
  },
  {
    name: '21a-reference-paths-undeclared',
    modes: ['ci'],
    run: (mode) => {
      const state = policyRun({ mode, text: catalogSource, rules: catalogRules });
      return prepareBackstageReferenceData(state.request, state.context, {
        ...stubCatalog(state, catalogFacts),
        referencePaths: ['/spec/undeclared'],
      });
    },
  },
  {
    name: '21b-reference-access-mismatch',
    modes: ['ci'],
    run: (mode) => {
      const state = policyRun({ mode, text: catalogSource, rules: catalogRules });
      const catalog = stubCatalog(state, catalogFacts);
      return prepareBackstageReferenceData(state.request, state.context, {
        ...catalog,
        access: { ...catalog.access, permissionRevision: 'other' },
      });
    },
  },
  {
    name: '21c-reference-observation-authority',
    modes: ['ci'],
    run: (mode) => {
      const state = policyRun({ mode, text: catalogSource, rules: catalogRules });
      const catalog = stubCatalog(state, catalogFacts);
      return policy(state, {
        catalog: {
          ...catalog,
          provider: {
            ...catalog.provider,
            lookup: async (refs, access, execution) => {
              const report = await catalog.provider.lookup(refs, access, execution);
              return {
                ...report,
                data: createDataSnapshot(
                  report.data.entries.map((entry) => ({
                    ...entry,
                    provenance: { ...entry.provenance, principalId: 'wrong' },
                  })),
                ),
              };
            },
          },
        },
      });
    },
  },
  {
    name: '21d-reference-retained-conflict',
    modes: ['ci'],
    run: (mode) => {
      const state = policyRun({ mode, text: catalogSource, rules: catalogRules });
      const now = state.request.execution.startedAt;
      const request = parseContract('validation-request', {
        ...state.request,
        data: createDataSnapshot([
          {
            key: catalogEntityKey('stub', 'group:default/team'),
            status: 'missing',
            provenance: {
              providerId: 'backstage-catalog',
              connectionId: 'retained',
              installationId: state.request.identity.installationId,
              principalId: 'reader',
              permissionRevision: state.request.identity.permissionRevision,
              scope: ['catalog:read'],
              revision: 'retained-1',
              fetchedAt: now,
              expiresAt: now + 60_000,
            },
          },
        ]),
      });
      return validatePolicySources(request, state.context, {
        catalog: stubCatalog(state, catalogFacts),
      });
    },
  },
  {
    name: '21e-reference-aggregate-data-limit',
    modes: ['ci'],
    run: (mode) => {
      const state = policyRun({ mode, rules: catalogRules });
      const now = state.request.execution.startedAt;
      const large = Array.from({ length: 60_000 }, () => 0);
      const request = parseContract('validation-request', {
        ...state.request,
        data: createDataSnapshot([
          {
            key: 'retained/large',
            status: 'present',
            value: large,
            provenance: {
              providerId: 'backstage-catalog',
              connectionId: 'retained',
              installationId: state.request.identity.installationId,
              principalId: 'reader',
              permissionRevision: state.request.identity.permissionRevision,
              scope: ['catalog:read'],
              revision: 'retained-1',
              fetchedAt: now,
              expiresAt: now + 60_000,
            },
          },
        ]),
      });
      return validatePolicySources(request, state.context, {
        catalog: stubCatalog(state, catalogFacts, { value: large }),
      });
    },
  },
];

async function observe(): Promise<Record<string, unknown>> {
  const observed: Record<string, unknown> = {};
  for (const scenario of scenarios)
    for (const mode of scenario.modes ?? (['ci', 'ide'] as const))
      observed[`${scenario.name}/${mode}`] = await outcome(() => scenario.run(mode));
  return observed;
}

async function recordMismatch(name: string, value: unknown, entry: GoldenEntry | undefined) {
  const observed = path.join(MISMATCHES, `${name}.json`);
  await mkdir(path.dirname(observed), { recursive: true });
  await writeFile(observed, JSON.stringify(value, null, 2) + '\n');
  if (entry && 'literal' in entry)
    await writeFile(
      path.join(MISMATCHES, `${name}.expected.json`),
      JSON.stringify(expandRepeats(entry.literal), null, 2) + '\n',
    );
  return observed;
}

void test('pipeline reports match the characterization recorded before the stage split', async () => {
  const observed = await observe();
  if (process.env.BVE_UPDATE_PIPELINE_GOLDEN === '1') {
    const prettier = await import('prettier');
    const options = (await prettier.resolveConfig(GOLDEN)) ?? {};
    const golden: Golden = {
      format: 2,
      literalLimit: LITERAL_LIMIT,
      scenarios: Object.fromEntries(
        Object.entries(observed).map(([name, value]) => [
          name,
          encodeScenario(value, LITERAL_LIMIT),
        ]),
      ),
    };
    await writeFile(
      GOLDEN,
      await prettier.format(JSON.stringify(golden), { ...options, parser: 'json' }),
    );
  }
  const golden = JSON.parse(await readFile(GOLDEN, 'utf8')) as Golden;
  assert.equal(golden.format, 2);
  assert.deepEqual(Object.keys(observed), Object.keys(golden.scenarios), 'scenario set changed');
  await rm(MISMATCHES, { recursive: true, force: true });
  const failures: string[] = [];
  for (const [name, value] of Object.entries(observed)) {
    const entry = golden.scenarios[name];
    // Compare serialized text so that both array order and key order are characterized.
    if (entry && matchesEntry(entry, JSON.stringify(value))) continue;
    const file = await recordMismatch(name, value, entry);
    failures.push(
      `scenario ${name} changed; observed report: ${path.relative(repository, file)}` +
        (entry && 'summary' in entry
          ? `\n  stored summary:   ${JSON.stringify(entry.summary)}` +
            `\n  observed summary: ${JSON.stringify(summarize(value))}`
          : ''),
    );
  }
  assert.deepEqual(failures, []);
});
