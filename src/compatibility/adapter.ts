import { setImmediate as yieldTurn } from 'node:timers/promises';
import { createRequire } from 'node:module';
import type { Entity, EntityPolicy } from '@backstage/catalog-model';
import type * as NativeLibrary from '@backstage/catalog-model';
import type { JsonValue } from '../contracts/schemas.js';
import { ContractError, reject } from '../core/errors.js';
import { canonicalJson, deepFreeze, digestJson } from '../core/json.js';
import type { Immutable } from '../core/json.js';
import { childPointer } from '../parsing/locations.js';
import { RequestBudget } from '../runtime/request-budget.js';
import { nativeErrorPath } from './native-errors.js';
import { BACKSTAGE_ADAPTER_IDS, BUILTIN_KINDS, BackstageRuntimeError } from './types.js';
import type {
  BackstageAdapter,
  BackstageAdapterId,
  NativeEntityCheck,
  NativeExecutionContext,
  NativeIssue,
  NativePolicyName,
  NormalizationChange,
} from './types.js';

type Library = Pick<
  typeof NativeLibrary,
  | 'entityEnvelopeSchemaValidator'
  | 'entitySchemaValidator'
  | 'stringifyEntityRef'
  | 'componentEntityV1alpha1Validator'
  | 'apiEntityV1alpha1Validator'
  | 'groupEntityV1alpha1Validator'
  | 'userEntityV1alpha1Validator'
  | 'resourceEntityV1alpha1Validator'
  | 'systemEntityV1alpha1Validator'
  | 'domainEntityV1alpha1Validator'
  | 'locationEntityV1alpha1Validator'
> & {
  DefaultNamespaceEntityPolicy: new () => EntityPolicy;
  SchemaValidEntityPolicy: new () => EntityPolicy;
  FieldFormatEntityPolicy: new () => EntityPolicy;
  NoForeignRootFieldsEntityPolicy: new () => EntityPolicy;
  GroupDefaultParentEntityPolicy: new (parent: string) => EntityPolicy;
};

function snapshot(value: unknown): JsonValue {
  try {
    return JSON.parse(canonicalJson(value, { maxBytes: 1024 * 1024 })) as JsonValue;
  } catch (error) {
    if (error instanceof ContractError && error.code === 'limit')
      throw new BackstageRuntimeError('resource_limit');
    throw error;
  }
}

function changes(
  before: JsonValue,
  after: JsonValue,
  policy: NativePolicyName,
  path = '',
): NormalizationChange[] {
  if (digestJson(before) === digestJson(after)) return [];
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((key) => {
      const child = childPointer(path, key);
      if (!Object.hasOwn(before, key)) return [{ path: child, policy, after: after[key]! }];
      if (!Object.hasOwn(after, key)) return [{ path: child, policy, before: before[key]! }];
      return changes(before[key]!, after[key]!, policy, child);
    });
  }
  return [{ path, policy, before, after }];
}

function createAdapter(id: BackstageAdapterId, lib: Library): BackstageAdapter {
  const envelope = lib.entityEnvelopeSchemaValidator();
  const entitySchema = lib.entitySchemaValidator();
  const kinds = new Map([
    ['Component', lib.componentEntityV1alpha1Validator],
    ['API', lib.apiEntityV1alpha1Validator],
    ['Group', lib.groupEntityV1alpha1Validator],
    ['User', lib.userEntityV1alpha1Validator],
    ['Resource', lib.resourceEntityV1alpha1Validator],
    ['System', lib.systemEntityV1alpha1Validator],
    ['Domain', lib.domainEntityV1alpha1Validator],
    ['Location', lib.locationEntityV1alpha1Validator],
  ]);
  const policies: Record<Exclude<NativePolicyName, 'group_default_parent'>, EntityPolicy> = {
    schema: new lib.SchemaValidEntityPolicy(),
    default_namespace: new lib.DefaultNamespaceEntityPolicy(),
    field_format: new lib.FieldFormatEntityPolicy(),
    no_foreign_root_fields: new lib.NoForeignRootFieldsEntityPolicy(),
  };
  const configuredParent = (
    settings: Parameters<BackstageAdapter['validate']>[1],
  ): EntityPolicy | undefined => {
    if (!settings.groupDefaultParent) return undefined;
    if (!settings.groupDefaultParentRef)
      reject(
        'invalid_contract',
        '/nativePolicies/groupDefaultParentRef',
        'group parent reference is required',
      );
    try {
      return new lib.GroupDefaultParentEntityPolicy(settings.groupDefaultParentRef);
    } catch {
      reject(
        'invalid_contract',
        '/nativePolicies/groupDefaultParentRef',
        'group parent must be a valid native Group reference',
      );
    }
  };
  const execute = async (
    value: Immutable<JsonValue>,
    settings: Parameters<BackstageAdapter['validate']>[1] | undefined,
    context: NativeExecutionContext,
  ): Promise<NativeEntityCheck> => {
    using budget = new RequestBudget(context.deadlineAt, context.signal);
    budget.throwIfInterrupted();
    const parentPolicy = settings ? configuredParent(settings) : undefined;
    const authored = snapshot(value);
    let candidate = snapshot(authored) as unknown as Entity;
    const mutations: NormalizationChange[] = [];
    const result = (
      status: NativeEntityCheck['status'],
      issues: NativeIssue[] = [],
    ): NativeEntityCheck => {
      const checked = deepFreeze({
        status,
        authored,
        normalized: snapshot(candidate),
        issues,
        changes: mutations,
        ...(status === 'valid' ? { entityRef: lib.stringifyEntityRef(candidate) } : {}),
      });
      budget.throwIfInterrupted();
      return checked;
    };
    const call = async (
      stage: NativeIssue['stage'],
      operation: () => unknown,
    ): Promise<NativeIssue | undefined> => {
      await yieldTurn();
      budget.throwIfInterrupted();
      try {
        await operation();
      } catch (error) {
        budget.throwIfInterrupted();
        return {
          code:
            stage === 'envelope'
              ? 'invalid_envelope'
              : stage === 'kind'
                ? 'invalid_kind'
                : 'invalid_policy_value',
          stage,
          path: nativeErrorPath(error, stage, candidate as unknown as JsonValue),
        };
      }
      budget.throwIfInterrupted();
      return undefined;
    };
    const apply = async (
      name: NativePolicyName,
      policy: EntityPolicy,
    ): Promise<NativeIssue | undefined> => {
      const before = snapshot(candidate);
      const issue = await call(name, async () => {
        const next = await policy.enforce(candidate);
        if (!next) throw new Error('Stock native policy did not handle entity');
        candidate = next;
      });
      if (!issue) mutations.push(...changes(before, snapshot(candidate), name));
      return issue;
    };
    // An always-on native envelope protects policies that expect metadata to exist.
    const invalidEnvelope = await call('envelope', () =>
      settings ? envelope(candidate) : entitySchema(candidate),
    );
    if (invalidEnvelope) return result('invalid', [invalidEnvelope]);
    if (settings) {
      for (const [enabled, name] of [
        [settings.schema, 'schema'],
        [settings.defaultNamespace, 'default_namespace'],
        [settings.fieldFormat, 'field_format'],
        [settings.noForeignRootFields, 'no_foreign_root_fields'],
      ] as const) {
        if (enabled) {
          const issue = await apply(name, policies[name]);
          if (issue) return result('invalid', [issue]);
        }
      }
    }
    if (parentPolicy) {
      const issue = await apply('group_default_parent', parentPolicy);
      if (issue) return result('invalid', [issue]);
    }
    const validator = kinds.get(candidate.kind);
    if (!validator)
      return result('unsupported', [{ code: 'unsupported_kind', stage: 'kind', path: '/kind' }]);
    let recognized = false;
    const kindIssue = await call('kind', async () => {
      recognized = await validator.check(candidate);
    });
    if (kindIssue) return result('invalid', [kindIssue]);
    if (!recognized)
      return result('unsupported', [
        { code: 'unsupported_api_version', stage: 'kind', path: '/apiVersion' },
      ]);
    budget.throwIfInterrupted();
    return result('valid');
  };
  return Object.freeze<BackstageAdapter>({
    id,
    kinds: BUILTIN_KINDS,
    validateSettings: (settings) => {
      configuredParent(settings);
    },
    checkEntity: (value, context) => execute(value, undefined, context),
    validate: (value, settings, context) => execute(value, settings, context),
  });
}

const adapters = new Map<BackstageAdapterId, Promise<BackstageAdapter>>();
export async function loadBackstageAdapter(id: BackstageAdapterId): Promise<BackstageAdapter> {
  if (!(BACKSTAGE_ADAPTER_IDS as readonly string[]).includes(id))
    reject('invalid_contract', '/adapterId', 'unknown Backstage adapter ID');
  const cached = adapters.get(id);
  if (cached) return cached;
  const loading = (async () => {
    try {
      const packageName =
        id === '@backstage/catalog-model@1.10.2'
          ? '@backstage/catalog-model'
          : 'backstage-catalog-model-older';
      const metadata: unknown = createRequire(import.meta.url)(`${packageName}/package.json`);
      const expectedVersion = id.slice(id.lastIndexOf('@') + 1);
      if (
        !metadata ||
        typeof metadata !== 'object' ||
        !('version' in metadata) ||
        metadata.version !== expectedVersion
      )
        throw new BackstageRuntimeError('adapter_unavailable');
      const library: Library =
        id === '@backstage/catalog-model@1.10.2'
          ? await import('@backstage/catalog-model')
          : await import('backstage-catalog-model-older');
      return createAdapter(id, library);
    } catch {
      throw new BackstageRuntimeError('adapter_unavailable');
    }
  })();
  adapters.set(id, loading);
  try {
    return await loading;
  } catch (error) {
    adapters.delete(id);
    throw error;
  }
}
