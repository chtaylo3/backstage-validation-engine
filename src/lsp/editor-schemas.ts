import { createRequire } from 'node:module';
import path from 'node:path';
import { RE2JS } from 're2js';
import { BUILTIN_KINDS } from '../compatibility/types.js';
import type { LspConfig } from './config.js';

export type SchemaNode = Readonly<Record<string, unknown>>;
export interface EditorSchema {
  readonly root: SchemaNode;
  readonly names: ReadonlyMap<string, SchemaNode>;
  readonly label: string;
}
export const forbidden: SchemaNode = Object.freeze({ $bveForbidden: true });
export const object = (value: unknown): value is SchemaNode =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const primitive = (value: unknown): value is null | string | boolean | number =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));
export const parts = (pointer: string) =>
  pointer === ''
    ? []
    : pointer
        .slice(1)
        .split('/')
        .map((key) => key.replace(/~1/gu, '/').replace(/~0/gu, '~'));

/** Presentation schemas come from the exact installed native adapter, never the network. */
export function nativeEditorSchemas(config: LspConfig): ReadonlyMap<string, EditorSchema> {
  const require = createRequire(import.meta.url);
  const packageName =
    config.profile.adapterId === '@backstage/catalog-model@1.10.2'
      ? '@backstage/catalog-model'
      : 'backstage-catalog-model-older';
  const metadata = require(`${packageName}/package.json`) as { version: string };
  if (`@backstage/catalog-model@${metadata.version}` !== config.profile.adapterId)
    throw new Error('Pinned editor schema dependency is unavailable.');
  const directory = path.join(
    path.dirname(require.resolve(`${packageName}/package.json`)),
    'dist/schema',
  );
  const read = (name: string): SchemaNode => {
    const loaded: unknown = require(path.join(directory, `${name}.schema.json.cjs.js`));
    if (!object(loaded) || !object(loaded.default))
      throw new Error('Editor schema is unavailable.');
    return loaded.default;
  };
  const names = new Map<string, SchemaNode>();
  for (const name of ['Entity', 'EntityMeta', 'EntityEnvelope', 'shared/common']) {
    const schema = read(name);
    if (typeof schema.$id === 'string') names.set(schema.$id, schema);
  }
  const result = new Map<string, EditorSchema>();
  result.set('', { root: names.get('Entity')!, names, label: config.profile.adapterId });
  for (const kind of BUILTIN_KINDS) {
    const root = read(`kinds/${kind}.v1alpha1`);
    if (typeof root.$id === 'string') names.set(root.$id, root);
    result.set(kind, { root, names, label: config.profile.adapterId });
  }
  return result;
}

function reference(schema: EditorSchema, ref: string): SchemaNode | undefined {
  const [name, fragment] = ref.split('#');
  let current: unknown = name ? schema.names.get(name) : schema.root;
  if (fragment) {
    if (!fragment.startsWith('/')) return undefined;
    for (const key of parts(fragment)) {
      if (!object(current) || !Object.hasOwn(current, key)) return undefined;
      current = current[key];
    }
  }
  return object(current)
    ? current
    : current === false
      ? forbidden
      : current === true
        ? {}
        : undefined;
}

/** Conservative condition matching. Unknown keywords never select a conditional branch. */
function matches(node: SchemaNode, value: unknown, depth = 0): boolean | undefined {
  if (depth > 32) return undefined;
  let unknown = false;
  for (const [key, expected] of Object.entries(node)) {
    if (key === 'const' && JSON.stringify(value) !== JSON.stringify(expected)) return false;
    else if (
      key === 'enum' &&
      Array.isArray(expected) &&
      !expected.some((item) => JSON.stringify(item) === JSON.stringify(value))
    )
      return false;
    else if (key === 'type') {
      const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      const types = Array.isArray(expected) ? expected : [expected];
      if (
        !types.includes(actual) &&
        !(actual === 'number' && Number.isInteger(value) && types.includes('integer'))
      )
        return false;
    } else if (key === 'required' && Array.isArray(expected)) {
      if (
        !object(value) ||
        expected.some((name) => typeof name !== 'string' || !Object.hasOwn(value, name))
      )
        return false;
    } else if (key === 'properties' && object(expected)) {
      if (object(value))
        for (const [name, child] of Object.entries(expected)) {
          if (!Object.hasOwn(value, name)) continue;
          if (!object(child)) {
            unknown = true;
            continue;
          }
          const result = matches(child, value[name], depth + 1);
          if (result === false) return false;
          if (result === undefined) unknown = true;
        }
    } else if (key === 'allOf' && Array.isArray(expected)) {
      for (const child of expected) {
        const result = object(child) ? matches(child, value, depth + 1) : undefined;
        if (result === false) return false;
        if (result === undefined) unknown = true;
      }
    } else if (
      !['const', 'enum', 'title', 'description', '$comment', '$id', '$schema'].includes(key)
    )
      unknown = true;
  }
  return unknown ? undefined : true;
}

export interface ResolvedField {
  readonly node: SchemaNode;
  readonly schema: EditorSchema;
}
function expand(
  schema: EditorSchema,
  node: SchemaNode,
  value: unknown,
  output: ResolvedField[],
  seen: Set<SchemaNode>,
  depth: number,
): void {
  if (depth > 32 || seen.has(node) || output.length >= 256) return;
  seen.add(node);
  output.push({ node, schema });
  // Draft-07 ignores siblings of $ref.
  if (typeof node.$ref === 'string') {
    output.pop();
    const target = reference(schema, node.$ref);
    if (target) expand(schema, target, value, output, seen, depth + 1);
    return;
  }
  if (Array.isArray(node.allOf))
    for (const child of node.allOf)
      if (object(child)) expand(schema, child, value, output, seen, depth + 1);
  for (const key of ['oneOf', 'anyOf']) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    const selected = branches.filter((child) => object(child) && matches(child, value) === true);
    if (selected.length === 1 && object(selected[0]))
      expand(schema, selected[0], value, output, seen, depth + 1);
  }
  if (object(node.if)) {
    const selected = matches(node.if, value);
    const branch = selected === true ? node.then : selected === false ? node.else : undefined;
    if (object(branch)) expand(schema, branch, value, output, seen, depth + 1);
  }
}
export function resolveFields(
  schemas: readonly EditorSchema[],
  pointer: string,
  value: unknown,
): ResolvedField[] {
  let fields: ResolvedField[] = schemas.map((schema) => ({ node: schema.root, schema }));
  let current = value;
  for (const key of [...parts(pointer), undefined]) {
    const expanded: ResolvedField[] = [];
    for (const field of fields) expand(field.schema, field.node, current, expanded, new Set(), 0);
    if (key === undefined) return expanded;
    fields = expanded.flatMap(({ node, schema }) => {
      if (node.$bveForbidden) return [{ node, schema }];
      const children: unknown[] = [];
      if (Array.isArray(current))
        children.push(Array.isArray(node.items) ? node.items[Number(key)] : node.items);
      else {
        const declared = object(node.properties) && Object.hasOwn(node.properties, key);
        if (declared && object(node.properties)) children.push(node.properties[key]);
        if (object(node.patternProperties))
          for (const [pattern, child] of Object.entries(node.patternProperties)) {
            try {
              if (RE2JS.compile(pattern).matcher(key).find()) children.push(child);
            } catch {
              children.push(false);
            }
          }
        if (
          !declared &&
          !children.length &&
          (object(node.additionalProperties) || typeof node.additionalProperties === 'boolean')
        )
          children.push(node.additionalProperties);
      }
      return children.flatMap((child) =>
        object(child)
          ? [{ node: child, schema }]
          : child === false
            ? [{ node: forbidden, schema }]
            : [],
      );
    });
    current =
      current !== null && typeof current === 'object' && Object.hasOwn(current, key)
        ? (current as Record<string, unknown>)[key]
        : undefined;
  }
  return [];
}
export function fieldValues(
  fields: readonly ResolvedField[],
): { value: null | string | number | boolean; label: string }[] {
  const constraints = fields.flatMap(({ node }) =>
    Object.hasOwn(node, 'const') ? [[node.const]] : Array.isArray(node.enum) ? [node.enum] : [],
  );
  const candidates = fields.flatMap(({ node }) => [
    ...(Object.hasOwn(node, 'const') ? [{ value: node.const, label: 'Required value' }] : []),
    ...(Array.isArray(node.enum)
      ? node.enum.map((value: unknown) => ({ value, label: 'Allowed value' }))
      : []),
    ...(Object.hasOwn(node, 'default') ? [{ value: node.default, label: 'Default' }] : []),
    ...(Array.isArray(node.examples)
      ? node.examples.map((value: unknown) => ({ value, label: 'Example' }))
      : []),
    ...(node.type === 'boolean'
      ? [
          { value: true, label: 'Boolean' },
          { value: false, label: 'Boolean' },
        ]
      : []),
    ...(node.type === 'null' ? [{ value: null, label: 'Null' }] : []),
  ]);
  const result = new Map<string, { value: null | string | number | boolean; label: string }>();
  for (const candidate of candidates) {
    if (
      !primitive(candidate.value) ||
      !acceptsValue(fields, candidate.value) ||
      constraints.some(
        (values) =>
          !values.some((value) => JSON.stringify(value) === JSON.stringify(candidate.value)),
      )
    )
      continue;
    const key = JSON.stringify(candidate.value);
    if (!result.has(key))
      result.set(key, {
        value: candidate.value,
        label: constraints.length
          ? fields.some(({ node }) => Object.hasOwn(node, 'const'))
            ? 'Required value'
            : 'Allowed value'
          : candidate.label,
      });
    if (result.size >= 100) break;
  }
  return [...result.values()];
}
export function acceptsValue(fields: readonly ResolvedField[], value: unknown): boolean {
  for (const { node } of fields) {
    if (
      node.$bveForbidden ||
      node.not === true ||
      (object(node.not) && matches(node.not, value) === true)
    )
      return false;
    if (Object.hasOwn(node, 'const') && JSON.stringify(value) !== JSON.stringify(node.const))
      return false;
    if (
      Array.isArray(node.enum) &&
      !node.enum.some((item: unknown) => JSON.stringify(value) === JSON.stringify(item))
    )
      return false;
    if (node.type !== undefined) {
      const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      const types: unknown[] = Array.isArray(node.type) ? node.type : [node.type];
      if (
        !types.includes(actual) &&
        !(actual === 'number' && Number.isInteger(value) && types.includes('integer'))
      )
        return false;
    }
    if (typeof value === 'string') {
      const length = [...value].length;
      if (
        (typeof node.minLength === 'number' && length < node.minLength) ||
        (typeof node.maxLength === 'number' && length > node.maxLength)
      )
        return false;
      if (typeof node.pattern === 'string') {
        try {
          if (!RE2JS.compile(node.pattern).matcher(value).find()) return false;
        } catch {
          return false;
        }
      }
    }
    if (typeof value === 'number') {
      if (
        (typeof node.minimum === 'number' && value < node.minimum) ||
        (typeof node.maximum === 'number' && value > node.maximum) ||
        (typeof node.exclusiveMinimum === 'number' && value <= node.exclusiveMinimum) ||
        (typeof node.exclusiveMaximum === 'number' && value >= node.exclusiveMaximum)
      )
        return false;
    }
    for (const key of ['anyOf', 'oneOf'])
      if (Array.isArray(node[key])) {
        const branches = node[key] as unknown[];
        const results = branches.map((branch) =>
          object(branch)
            ? matches(branch, value)
            : branch === true
              ? true
              : branch === false
                ? false
                : undefined,
        );
        if (
          results.every((result) => result !== undefined) &&
          (key === 'oneOf' ? results.filter(Boolean).length !== 1 : !results.some(Boolean))
        )
          return false;
      }
  }
  return true;
}
export function fieldDescription(fields: readonly ResolvedField[]): string {
  const result = new Set<string>();
  for (const { node, schema } of fields) {
    if (typeof node.description === 'string') result.add(node.description.slice(0, 4096));
    if (node.$bveForbidden) result.add('This field is forbidden by the schema.');
    if (node.type !== undefined) result.add(`Type: ${JSON.stringify(node.type)}.`);
    if (Object.hasOwn(node, 'const')) result.add(`Required value: ${JSON.stringify(node.const)}.`);
    if (Array.isArray(node.enum))
      result.add(`Allowed values: ${JSON.stringify(node.enum).slice(0, 4096)}.`);
    for (const key of [
      'minLength',
      'maxLength',
      'minimum',
      'maximum',
      'minItems',
      'maxItems',
      'pattern',
    ])
      if (node[key] !== undefined) result.add(`${key}: ${JSON.stringify(node[key])}.`);
    if (Array.isArray(node.required)) result.add(`Required fields: ${node.required.join(', ')}.`);
    result.add(`Source: ${schema.label}.`);
  }
  return [...result].join('\n\n').slice(0, 16 * 1024);
}
