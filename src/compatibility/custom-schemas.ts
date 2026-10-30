import { Ajv } from 'ajv';
import type { AnySchema, ValidateFunction } from 'ajv';
import { RE2JS } from 're2js';
import type { DeploymentProfile, JsonValue, SchemaArtifact } from '../contracts/schemas.js';
import { SCHEMA_DIALECT } from '../contracts/schemas.js';
import { parseContract } from '../contracts/validate.js';
import { canonicalJson, deepFreeze } from '../core/json.js';
import type { Immutable } from '../core/json.js';
import { reject } from '../core/errors.js';
import { childPointer } from '../parsing/locations.js';

export const CUSTOM_SCHEMA_LIMITS = Object.freeze({
  artifacts: 64,
  artifactBytes: 64 * 1024,
  totalBytes: 256 * 1024,
  nodes: 1024,
  references: 256,
  referenceDepth: 32,
  expandedNodes: 8192,
  patternChars: 1024,
  cacheEntries: 64,
});

const cached = new Map<string, ValidateFunction>();
const artifactKey = (id: string, version: string) => JSON.stringify([id, version]);
const pairKey = (kind: string, apiVersion: string) =>
  JSON.stringify([kind.toLowerCase(), apiVersion]);
function fail(): never {
  return reject(
    'invalid_contract',
    '/schemaArtifacts',
    'custom schema is outside the supported synchronous draft-07 profile',
  );
}
const regex = Object.assign(
  (pattern: string) => {
    if (pattern.length > CUSTOM_SCHEMA_LIMITS.patternChars) fail();
    const compiled = RE2JS.compile(pattern);
    return { test: (value: string) => compiled.matcher(value).find() };
  },
  { code: 'RE2JS' },
);

/** Inspect schema positions only: defaults, examples and const/enum values remain ordinary data. */
function checkSchema(schema: Immutable<JsonValue>): void {
  const nodes = new Map<string, string[]>();
  const references: { from: string; to: string }[] = [];
  const visit = (value: Immutable<JsonValue>, path: string): void => {
    if (
      nodes.size >= CUSTOM_SCHEMA_LIMITS.nodes ||
      (typeof value !== 'boolean' && (!value || typeof value !== 'object' || Array.isArray(value)))
    )
      fail();
    const children: string[] = [];
    nodes.set(path, children);
    if (typeof value === 'boolean') return;
    const row = value as Readonly<Record<string, Immutable<JsonValue>>>;
    if (row.$schema !== undefined && row.$schema !== SCHEMA_DIALECT) fail();
    if (
      row.$async !== undefined ||
      row.$dynamicRef !== undefined ||
      row.$recursiveRef !== undefined ||
      row.format !== undefined ||
      (path && row.$id !== undefined)
    )
      fail();
    if (row.$ref !== undefined) {
      if (
        typeof row.$ref !== 'string' ||
        (row.$ref !== '#' && !row.$ref.startsWith('#/')) ||
        /%|~(?![01])/u.test(row.$ref)
      )
        fail();
      references.push({ from: path, to: row.$ref.slice(1) });
      if (references.length > CUSTOM_SCHEMA_LIMITS.references) fail();
    }
    const child = (item: Immutable<JsonValue>, pointer: string) => {
      children.push(pointer);
      visit(item, pointer);
    };
    for (const key of [
      'additionalProperties',
      'additionalItems',
      'contains',
      'propertyNames',
      'not',
      'if',
      'then',
      'else',
    ])
      if (row[key] !== undefined) child(row[key], childPointer(path, key));
    if (row.items !== undefined) {
      if (Array.isArray(row.items))
        (row.items as readonly Immutable<JsonValue>[]).forEach((item, index) =>
          child(item, childPointer(childPointer(path, 'items'), index)),
        );
      else child(row.items, childPointer(path, 'items'));
    }
    for (const key of ['properties', 'patternProperties', 'definitions', 'dependencies']) {
      const entries = row[key];
      if (entries === undefined) continue;
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) fail();
      for (const [name, item] of Object.entries(entries)) {
        if (key === 'dependencies' && Array.isArray(item)) continue;
        if (key === 'patternProperties') regex(name);
        child(item, childPointer(childPointer(path, key), name));
      }
    }
    for (const key of ['allOf', 'anyOf', 'oneOf']) {
      const entries = row[key];
      if (entries === undefined) continue;
      if (!Array.isArray(entries)) fail();
      (entries as readonly Immutable<JsonValue>[]).forEach((item, index) =>
        child(item, childPointer(childPointer(path, key), index)),
      );
    }
    if (row.pattern !== undefined) {
      if (typeof row.pattern !== 'string') fail();
      regex(row.pattern);
    }
  };
  visit(schema, '');
  for (const { from, to } of references) {
    if (!nodes.has(to)) fail();
    nodes.get(from)!.push(to);
  }
  const visiting = new Set<string>();
  const heights = new Map<string, number>();
  const costs = new Map<string, number>();
  const depth = (path: string): number => {
    if (visiting.has(path)) fail();
    const known = heights.get(path);
    if (known !== undefined) return known;
    visiting.add(path);
    let height = 1;
    let cost = 1;
    for (const child of nodes.get(path)!) {
      height = Math.max(height, 1 + depth(child));
      cost += costs.get(child)!;
      if (height > CUSTOM_SCHEMA_LIMITS.referenceDepth || cost > CUSTOM_SCHEMA_LIMITS.expandedNodes)
        fail();
    }
    visiting.delete(path);
    heights.set(path, height);
    costs.set(path, cost);
    return height;
  };
  depth('');
}

function compile(artifact: Immutable<SchemaArtifact>): ValidateFunction {
  const existing = cached.get(artifact.digest);
  if (existing) {
    cached.delete(artifact.digest);
    cached.set(artifact.digest, existing);
    return existing;
  }
  let validate: ValidateFunction;
  try {
    checkSchema(artifact.schema);
    const ajv = new Ajv({
      strict: true,
      strictTypes: false,
      strictTuples: false,
      strictRequired: false,
      allowUnionTypes: true,
      ownProperties: true,
      allErrors: false,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
      inlineRefs: false,
      logger: false,
      code: { regExp: regex },
    });
    validate = ajv.compile(artifact.schema as AnySchema);
  } catch {
    fail();
  }
  if (cached.size >= CUSTOM_SCHEMA_LIMITS.cacheEntries) cached.delete(cached.keys().next().value!);
  cached.set(artifact.digest, validate);
  return validate;
}

/** Only trusted host artifacts, matched by ID/version/content digest; no resolver or network loader. */
export function createCustomKindRegistry(
  profile: Immutable<DeploymentProfile>,
  input: readonly Immutable<SchemaArtifact>[] = [],
) {
  if (input.length > CUSTOM_SCHEMA_LIMITS.artifacts)
    reject('limit', '/schemaArtifacts', 'too many schema artifacts');
  canonicalJson(input, { maxBytes: CUSTOM_SCHEMA_LIMITS.totalBytes });
  const artifacts = input.map((artifact) => parseContract('schema-artifact', artifact));
  const byId = new Map<string, Immutable<SchemaArtifact>>();
  const validators = new Map<string, ValidateFunction>();
  for (const artifact of artifacts) {
    const key = artifactKey(artifact.id, artifact.version);
    if (byId.has(key))
      reject('invalid_contract', '/schemaArtifacts', 'duplicate schema artifact identity');
    byId.set(key, artifact);
    validators.set(key, compile(artifact));
  }
  const declarations = new Map(
    profile.customKinds.map((declaration) => {
      const key = artifactKey(declaration.schema.id, declaration.schema.version);
      const artifact = byId.get(key);
      if (artifact && artifact.digest !== declaration.schema.digest)
        reject('integrity', '/customKinds', 'schema artifact does not match the profile pin');
      const validator = validators.get(key);
      return [
        pairKey(declaration.kind, declaration.apiVersion),
        {
          schema: declaration.schema,
          validate: validator
            ? (value: Immutable<JsonValue>): string | undefined => {
                if (validator(value)) return undefined;
                const issue = validator.errors?.[0];
                const path = issue?.instancePath ?? '';
                const missing: unknown = issue?.params.missingProperty;
                return issue?.keyword === 'required' && typeof missing === 'string'
                  ? childPointer(path, missing)
                  : path;
              }
            : undefined,
        },
      ] as const;
    }),
  );
  const kinds = new Set(profile.customKinds.map((row) => row.kind.toLowerCase()));
  return {
    artifacts: deepFreeze(artifacts),
    hasKind: (kind: string) => kinds.has(kind.toLowerCase()),
    get: (kind: string, apiVersion: string) => declarations.get(pairKey(kind, apiVersion)),
  };
}
