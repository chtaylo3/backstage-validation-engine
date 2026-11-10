import { createRequire } from 'node:module';
import path from 'node:path';
import { digestJson, immutableJson } from '../core/json.js';
import { BACKSTAGE_ADAPTER_IDS, BUILTIN_KINDS, BackstageRuntimeError } from './types.js';
import type { BackstageAdapterId } from './types.js';

const require = createRequire(import.meta.url);
export type NativeSchemaNode = Readonly<Record<string, unknown>>;
const object = (value: unknown): value is NativeSchemaNode =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export interface NativePackageIdentity {
  readonly adapterId: BackstageAdapterId;
  readonly packageName: string;
  readonly version: string;
  readonly directory: string;
}
export interface NativeArtifactReader {
  readonly metadata: (name: string) => unknown;
  readonly schema: (filename: string) => unknown;
}
const reader: NativeArtifactReader = {
  metadata: (name) => require(`${name}/package.json`) as unknown,
  schema: (filename) => require(filename) as unknown,
};
/** Pin admission is shared. It never reads optional presentation schemas. */
export function resolveNativePackage(
  id: BackstageAdapterId,
  readMetadata: NativeArtifactReader['metadata'] = reader.metadata,
): NativePackageIdentity {
  if (!(BACKSTAGE_ADAPTER_IDS as readonly string[]).includes(id))
    throw new BackstageRuntimeError('adapter_unavailable');
  const packageName =
    id === '@backstage/catalog-model@1.10.2'
      ? '@backstage/catalog-model'
      : 'backstage-catalog-model-older';
  const version = id.slice(id.lastIndexOf('@') + 1);
  const metadata = readMetadata(packageName);
  if (!object(metadata) || metadata.version !== version)
    throw new BackstageRuntimeError('adapter_unavailable');
  return Object.freeze({
    adapterId: id,
    packageName,
    version,
    directory: path.dirname(require.resolve(`${packageName}/package.json`)),
  });
}
export interface NativeSchemaArtifact {
  readonly root: NativeSchemaNode;
  readonly names: ReadonlyMap<string, NativeSchemaNode>;
  readonly identity: string;
}
export type NativeSchemaArtifacts =
  | {
      readonly status: 'ready';
      readonly adapterId: BackstageAdapterId;
      readonly identity: string;
      readonly schemas: ReadonlyMap<string, NativeSchemaArtifact>;
    }
  | { readonly status: 'unavailable'; readonly adapterId: BackstageAdapterId };
const cached = new Map<BackstageAdapterId, NativeSchemaArtifacts>();
function readonlyMap<K, V>(source: Map<K, V>): ReadonlyMap<K, V> {
  const view: ReadonlyMap<K, V> = Object.freeze({
    size: source.size,
    get: (key: K) => source.get(key),
    has: (key: K) => source.has(key),
    keys: () => source.keys(),
    values: () => source.values(),
    entries: () => source.entries(),
    [Symbol.iterator]: () => source[Symbol.iterator](),
    forEach: (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) => {
      for (const [key, value] of source) callback.call(thisArg, value, key, view);
    },
  });
  return view;
}
/** Optional immutable presentation metadata. Its failure cannot disable native validators. */
export function nativeSchemaArtifacts(
  id: BackstageAdapterId,
  access: NativeArtifactReader = reader,
): NativeSchemaArtifacts {
  if (access === reader && cached.has(id)) return cached.get(id)!;
  try {
    const native = resolveNativePackage(id, access.metadata);
    const names = new Map<string, NativeSchemaNode>();
    const roots = new Map<string, NativeSchemaNode>();
    const read = (name: string): NativeSchemaNode => {
      const loaded = access.schema(
        path.join(native.directory, 'dist/schema', name + '.schema.json.cjs.js'),
      );
      if (!object(loaded) || !object(loaded.default))
        throw new Error('Presentation schema unavailable.');
      const captured = immutableJson(loaded.default);
      if (!object(captured)) throw new Error('Presentation schema unavailable.');
      return captured;
    };
    for (const name of ['Entity', 'EntityMeta', 'EntityEnvelope', 'shared/common']) {
      const schema = read(name);
      if (typeof schema.$id === 'string') names.set(schema.$id, schema);
    }
    const entity = names.get('Entity');
    if (!entity) throw new Error('Presentation schema unavailable.');
    roots.set('', entity);
    for (const kind of BUILTIN_KINDS) {
      const root = read(`kinds/${kind}.v1alpha1`);
      if (typeof root.$id === 'string') names.set(root.$id, root);
      roots.set(kind, root);
    }
    const identity = digestJson({ adapterId: id, schemas: [...names] });
    const references = readonlyMap(names);
    const schemas = readonlyMap(
      new Map(
        [...roots].map(([kind, root]) => [
          kind,
          Object.freeze({ root, names: references, identity }),
        ]),
      ),
    );
    const result = Object.freeze({ status: 'ready' as const, adapterId: id, identity, schemas });
    if (access === reader) cached.set(id, result);
    return result;
  } catch {
    return Object.freeze({ status: 'unavailable', adapterId: id });
  }
}
