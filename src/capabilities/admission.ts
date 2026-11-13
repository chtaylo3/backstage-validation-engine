import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import { contractSchemas } from '../contracts/schemas.js';
import { parseContract } from '../contracts/validate.js';
import { canonicalJson, deepFreeze } from '../base/json.js';
import type { Immutable } from '../base/json.js';
import {
  CAPABILITY_LIMITS,
  CapabilityManifestSchema,
  ContextBindingSchema,
  HostHandshakeSchema,
  PluginHandshakeSchema,
  capabilitySchemas,
  inputSchemas,
  outputSchemas,
  requestSchemas,
  resultSchemas,
} from './schemas.js';
import type {
  BoundRequest,
  CapabilityId,
  CapabilityInputs,
  CapabilityManifest,
  CapabilityOutputs,
  CapabilityResult,
  ContextBinding,
  HostHandshake,
  PluginHandshake,
} from './schemas.js';

export type CapabilityErrorCode =
  | 'invalid_record'
  | 'resource_limit'
  | 'not_approved'
  | 'unsupported'
  | 'binding'
  | 'closed'
  | 'cancelled'
  | 'deadline'
  | 'cleanup';
export class CapabilityError extends Error {
  override readonly name = 'CapabilityError';
  constructor(
    readonly code: CapabilityErrorCode,
    readonly phase: 'admission' | 'reply' | undefined = undefined,
  ) {
    super(`Capability operation failed: ${code}.`);
  }
}
const ajv = new Ajv({ strict: true, ownProperties: true });
for (const definition of Object.values(contractSchemas)) ajv.addSchema(definition);
for (const definition of Object.values(capabilitySchemas)) ajv.addSchema(definition);
const validators = new Map<string, ValidateFunction>();
function parse<T>(
  id: string,
  input: unknown,
  bytes = CAPABILITY_LIMITS.metadataBytes,
): Immutable<T> {
  let safe: unknown;
  try {
    safe = JSON.parse(canonicalJson(input, { maxBytes: bytes, maxDepth: 64, maxValues: 100_000 }));
  } catch {
    throw new CapabilityError('resource_limit');
  }
  let validate = validators.get(id);
  if (!validate) {
    validate = ajv.getSchema(id);
    if (!validate) throw new CapabilityError('unsupported');
    validators.set(id, validate);
  }
  if (!validate(safe)) throw new CapabilityError('invalid_record');
  return deepFreeze(safe as T);
}
export const parseManifest = (input: unknown) =>
  parse<CapabilityManifest>(CapabilityManifestSchema.$id!, input);
export const parseBinding = (input: unknown) =>
  parse<ContextBinding>(ContextBindingSchema.$id!, input);
export const parseHostHandshake = (input: unknown) =>
  parse<HostHandshake>(HostHandshakeSchema.$id!, input);
export const parsePluginHandshake = (input: unknown) =>
  parse<PluginHandshake>(PluginHandshakeSchema.$id!, input);
function checkMetadataSchemas(input: Immutable<CapabilityInputs['hover']>): void {
  const visit = (node: unknown, depth: number): void => {
    if (depth > 32) throw new CapabilityError('resource_limit');
    if (typeof node === 'boolean') return;
    if (!node || typeof node !== 'object' || Array.isArray(node))
      throw new CapabilityError('invalid_record');
    const value = node as Readonly<Record<string, unknown>>;
    if (
      value.pattern !== undefined &&
      (typeof value.pattern !== 'string' || value.pattern.length > 1024)
    )
      throw new CapabilityError('resource_limit');
    for (const keyword of ['properties', 'patternProperties', 'definitions', '$defs']) {
      const entries = value[keyword];
      if (entries && typeof entries === 'object' && !Array.isArray(entries))
        for (const [key, child] of Object.entries(entries)) {
          if (keyword === 'patternProperties' && key.length > 1024)
            throw new CapabilityError('resource_limit');
          visit(child, depth + 1);
        }
    }
    for (const keyword of [
      'additionalProperties',
      'additionalItems',
      'if',
      'then',
      'else',
      'not',
      'contains',
      'propertyNames',
    ])
      if (value[keyword] !== undefined) visit(value[keyword], depth + 1);
    for (const keyword of ['allOf', 'anyOf', 'oneOf'])
      if (Array.isArray(value[keyword]))
        for (const child of value[keyword]) visit(child, depth + 1);
    if (Array.isArray(value.items)) for (const child of value.items) visit(child, depth + 1);
    else if (value.items !== undefined) visit(value.items, depth + 1);
  };
  for (const presentation of input.schemas) {
    visit(presentation.root, 0);
    for (const definition of Object.values(presentation.definitions)) visit(definition, 0);
  }
}
export function parseCapabilityInput<K extends CapabilityId>(
  id: K,
  input: unknown,
): Immutable<CapabilityInputs[K]> {
  const result = parse<CapabilityInputs[K]>(
    inputSchemas[id].$id!,
    input,
    id === 'validation' ? CAPABILITY_LIMITS.bytes : CAPABILITY_LIMITS.metadataBytes,
  );
  if (['fields', 'values', 'hover', 'repairs'].includes(id))
    checkMetadataSchemas(result as Immutable<CapabilityInputs['hover']>);
  return result;
}
export function parseCapabilityOutput<K extends CapabilityId>(
  id: K,
  input: unknown,
): Immutable<CapabilityOutputs[K]> {
  const output = parse<CapabilityOutputs[K]>(
    outputSchemas[id].$id!,
    input,
    id === 'validation' ? CAPABILITY_LIMITS.bytes : CAPABILITY_LIMITS.metadataBytes,
  );
  if (id === 'search') {
    const report = output as Immutable<CapabilityOutputs['search']>;
    if (report.expiresAt < report.fetchedAt) throw new CapabilityError('invalid_record');
  }
  if (id === 'validation') {
    const report = output as Immutable<CapabilityOutputs['validation']>;
    parseContract('data-snapshot', report.materializedData);
    if (report.evaluationDataDigest !== report.materializedData.digest)
      throw new CapabilityError('binding');
  }
  if (id === 'fields') {
    const fields = (output as Immutable<CapabilityOutputs['fields']>).fields;
    if (new Set(fields.map((field) => field.path)).size !== fields.length)
      throw new CapabilityError('invalid_record');
  }
  if (id === 'source-discovery') {
    const sources = (output as Immutable<CapabilityOutputs['source-discovery']>).sources;
    if (new Set(sources.map((source) => source.uri)).size !== sources.length)
      throw new CapabilityError('invalid_record');
  }
  return output;
}
export function parseCapabilityRequest<K extends CapabilityId>(
  id: K,
  input: unknown,
): Immutable<BoundRequest<K>> {
  const request = parse<BoundRequest<K>>(
    requestSchemas[id].$id!,
    input,
    id === 'validation' ? CAPABILITY_LIMITS.bytes : CAPABILITY_LIMITS.metadataBytes,
  );
  if (['fields', 'values', 'hover', 'repairs'].includes(id))
    checkMetadataSchemas(request.input as Immutable<CapabilityInputs['hover']>);
  return request;
}
export function parseCapabilityResult<K extends CapabilityId>(
  id: K,
  input: unknown,
): Immutable<CapabilityResult<K>> {
  const result = parse<CapabilityResult<K>>(
    resultSchemas[id].$id!,
    input,
    id === 'validation' ? CAPABILITY_LIMITS.bytes : CAPABILITY_LIMITS.metadataBytes,
  );
  if (result.status === 'ready') parseCapabilityOutput(id, result.value);
  return result;
}
