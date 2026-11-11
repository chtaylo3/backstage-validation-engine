import { childPointer } from '../parsing/locations.js';
import type { JsonValue } from '../contracts/schemas.js';
import type { Immutable } from '../core/json.js';
import {
  acceptsValue,
  fieldDescription,
  fieldValues,
  object,
  primitive,
  resolveFields,
  forbidden,
} from './schema-metadata.js';
import type { EditorSchema, ResolvedField } from './schema-metadata.js';
import type { CapabilityInputs, CapabilityOutputs } from './schemas.js';
import { builtinCapabilitySession } from './session.js';

/** Bounded placeholder generation. A placeholder never claims policy acceptance. */
export function initialSchemaValue(
  fields: readonly ResolvedField[],
  depth = 0,
  remaining = { nodes: 32 },
): JsonValue {
  if (--remaining.nodes < 0) return null;
  const required = fields.find(({ node }) => Object.hasOwn(node, 'const'))?.node.const;
  if (primitive(required)) return required;
  if (depth > 4) return null;
  if (fields.some(({ node }) => node.type === 'object' || object(node.properties))) {
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    const names = new Set(
      fields.flatMap(({ node }) =>
        Array.isArray(node.required)
          ? node.required.filter((name): name is string => typeof name === 'string')
          : [],
      ),
    );
    for (const name of [...names].slice(0, 16)) {
      const children = fields.flatMap(({ node, schema }) =>
        object(node.properties) && object(node.properties[name])
          ? [{ node: node.properties[name], schema }]
          : [],
      );
      if (remaining.nodes <= 0) break;
      output[name] = initialSchemaValue(children, depth + 1, remaining);
    }
    return output;
  }
  if (fields.some(({ node }) => node.type === 'array')) return [];
  if (fields.some(({ node }) => node.type === 'number' || node.type === 'integer')) return 0;
  if (fields.some(({ node }) => node.type === 'boolean')) return false;
  if (fields.some(({ node }) => node.type === 'null')) return null;
  return '';
}
type MetadataInput = Immutable<CapabilityInputs['hover']>;
function context(input: MetadataInput) {
  const schemas: EditorSchema[] = input.schemas.map((schema) => ({
    root: object(schema.root) ? schema.root : schema.root === false ? forbidden : {},
    names: new Map(
      Object.entries(schema.definitions).flatMap(([name, value]) =>
        object(value) ? [[name, value] as const] : [],
      ),
    ),
    label: schema.label,
    ...(schema.artifactDigest ? { artifactIdentity: schema.artifactDigest } : {}),
    ...(schema.ruleId ? { ruleId: schema.ruleId } : {}),
  }));
  const subject = input.subject.state === 'present' ? input.subject.value : undefined;
  return {
    fields: resolveFields(schemas, input.path, subject),
    at: (path: string) => resolveFields(schemas, path, subject),
  };
}
function sources(fields: readonly ResolvedField[]): string[] {
  return [...new Set(fields.map(({ schema }) => schema.artifactIdentity ?? schema.label))].slice(
    0,
    128,
  );
}
export function fieldConstraints(
  fields: readonly ResolvedField[],
): CapabilityOutputs['fields']['fields'][number]['constraints'] {
  return fields.slice(0, 256).map(({ node, schema }) => {
    const value: CapabilityOutputs['fields']['fields'][number]['constraints'][number] = {
      source: {
        label: schema.label,
        ...(schema.artifactIdentity ? { artifactDigest: schema.artifactIdentity } : {}),
        ...(schema.ruleId ? { ruleId: schema.ruleId } : {}),
      },
      forbidden: node.$bveForbidden === true,
      partial: false,
    };
    const supported = new Set([
      'type',
      'const',
      'enum',
      'default',
      'examples',
      'required',
      'description',
      'title',
      '$comment',
      '$id',
      '$schema',
      '$ref',
      'properties',
      'items',
      'additionalProperties',
      '$bveForbidden',
    ]);
    value.partial = Object.keys(node).some((key) => !supported.has(key));
    if (typeof node.type === 'string') value.types = [node.type];
    else if (Array.isArray(node.type))
      value.types = node.type
        .filter((type): type is string => typeof type === 'string')
        .slice(0, 8);
    for (const [key, target] of [
      ['const', 'constant'],
      ['default', 'defaultValue'],
    ] as const)
      if (Object.hasOwn(node, key)) value[target] = node[key] as JsonValue;
    for (const [key, target] of [
      ['enum', 'allowedValues'],
      ['examples', 'examples'],
    ] as const) {
      if (Array.isArray(node[key])) {
        value[target] = node[key].slice(0, 100) as JsonValue[];
        if (node[key].length > 100) value.partial = true;
      }
    }
    if (Array.isArray(node.required))
      value.requiredFields = node.required
        .filter((key): key is string => typeof key === 'string')
        .slice(0, 1000);
    for (const key of [
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
    ] as const)
      if (typeof node[key] === 'number') value[key] = node[key];
    if (typeof node.pattern === 'string') {
      if (node.pattern.length <= 1024) value.pattern = node.pattern;
      else value.partial = true;
    }
    return value;
  });
}
export function schemaFieldMetadata(
  input: Immutable<CapabilityInputs['fields']>,
): CapabilityOutputs['fields'] {
  const c = context(input);
  const required = new Set(
    c.fields.flatMap(({ node }) =>
      Array.isArray(node.required)
        ? node.required.filter((name): name is string => typeof name === 'string')
        : [],
    ),
  );
  const keys = new Map<string, boolean>();
  for (const { node } of c.fields)
    if (object(node.properties))
      for (const name of Object.keys(node.properties)) {
        if (
          !name.startsWith(input.prefix) ||
          (input.existing.includes(name) && name !== input.prefix)
        )
          continue;
        if (!c.at(childPointer(input.path, name)).some(({ node }) => node.$bveForbidden))
          keys.set(name, required.has(name));
      }
  return {
    fields: [...keys]
      .sort(([a, ar], [b, br]) => Number(br) - Number(ar) || a.localeCompare(b))
      .slice(0, 100)
      .map(([name, required]) => {
        const path = childPointer(input.path, name),
          children = c.at(path);
        return {
          name,
          path,
          required,
          description: fieldDescription(children),
          initialValue: initialSchemaValue(children),
          subjectStage: input.subjectStage,
          scope: { ...input.scope },
          constraints: fieldConstraints(children),
          types: [
            ...new Set(
              children.flatMap(({ node }) =>
                typeof node.type === 'string'
                  ? [node.type]
                  : Array.isArray(node.type)
                    ? node.type.filter((type): type is string => typeof type === 'string')
                    : [],
              ),
            ),
          ].slice(0, 8),
          sources: sources(children),
        };
      }),
  };
}
export function schemaValueSuggestions(
  input: Immutable<CapabilityInputs['values']>,
): CapabilityOutputs['values'] {
  const { fields } = context(input);
  const values = input.kinds
    ? input.kinds
        .filter((kind) => acceptsValue(fields, kind))
        .map((value) => ({ value, label: 'Entity kind' }))
    : fieldValues(fields);
  const checked = new Map<
    string,
    { label: string; classification: 'default' | 'example' | 'suggestion' }
  >();
  for (const { schema, node } of fields) {
    if (!schema.label.startsWith('Editor rule ') || !Array.isArray(node.$bveEditorCandidates))
      continue;
    for (const candidate of node.$bveEditorCandidates) {
      if (
        !object(candidate) ||
        typeof candidate.label !== 'string' ||
        !['default', 'example', 'suggestion'].includes(String(candidate.classification))
      )
        continue;
      checked.set(JSON.stringify(candidate.value), {
        label: candidate.label,
        classification: candidate.classification as 'default' | 'example' | 'suggestion',
      });
    }
  }
  return {
    candidates: values.slice(0, 100).map(({ value, label }) => ({
      value,
      label: checked.get(JSON.stringify(value))?.label ?? label,
      classification:
        checked.get(JSON.stringify(value))?.classification ??
        (label === 'Required value'
          ? 'required'
          : label === 'Allowed value'
            ? 'allowed'
            : label === 'Default'
              ? 'default'
              : label === 'Example'
                ? 'example'
                : 'suggestion'),
      sources: sources(fields),
    })),
  };
}
export function schemaRepairProposals(
  input: Immutable<CapabilityInputs['repairs']>,
): CapabilityOutputs['repairs'] {
  const { fields } = context(input);
  const choices: { value: JsonValue; label: string }[] = fieldValues(fields);
  if (input.current.state === 'absent' && fields.length && !choices.length && input.required)
    choices.push({ value: initialSchemaValue(fields), label: 'Placeholder; complete this field' });
  return {
    proposals: choices
      .slice(0, 16)
      .filter(
        (choice) =>
          input.current.state !== 'present' ||
          JSON.stringify(input.current.value) !== JSON.stringify(choice.value),
      )
      .map(({ value, label }) => ({
        findingId: input.findingId,
        subjectId: input.subjectId,
        path: input.path,
        operation: input.current.state === 'present' ? 'setValue' : 'insertProperty',
        value,
        label,
      })),
  };
}
export function builtinMetadataSession(dependencies: readonly string[]) {
  return builtinCapabilitySession(
    'bve.builtin.schema-metadata',
    {
      fields: schemaFieldMetadata,
      values: schemaValueSuggestions,
      hover: (input) => ({ text: fieldDescription(context(input).fields) }),
      references: (input) => {
        const match = /^(?:([^:/]+):)?(?:([^/]+)\/)?([^/]+)$/u.exec(input.value);
        const identity = match
          ? `${match[1] ?? input.defaultKind}:${match[2] ?? input.namespace}/${match[3]}`.toLowerCase()
          : undefined;
        return {
          references:
            identity && /^[a-z][a-z0-9]{0,62}:[a-z0-9_.-]{1,63}\/[a-z0-9_.-]{1,63}$/u.test(identity)
              ? [{ identity, path: input.path }]
              : [],
        };
      },
      repairs: schemaRepairProposals,
    },
    {
      dependencies,
      languageProfiles: [
        'host-contract/0.2',
        'draft-07/bve/1',
        're2js@2.9.0/schema-v1',
        'bve-cel/1',
      ],
    },
  );
}
