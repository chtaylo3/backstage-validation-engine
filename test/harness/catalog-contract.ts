import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchemaObject, ValidateFunction } from 'ajv';
import { parse } from 'yaml';
import type { ContractArtifact } from './contract-artifact.js';

export type CatalogOperation = 'byName' | 'byRefs' | 'byQuery';
export class CatalogContractError extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CatalogContractError('Expected an OpenAPI object');
  }
  return value as Record<string, unknown>;
}

/** Extract the JSON Schema 2020-12 fragments from the supported OpenAPI 3.1 operations. */
export function compileCatalogContract(artifact: ContractArtifact) {
  const document = object(parse(artifact.text, { maxAliasCount: 0 }) as unknown);
  if (typeof document.openapi !== 'string' || !/^3\.1\./.test(document.openapi)) {
    throw new CatalogContractError('Catalog harness requires OpenAPI 3.1');
  }
  const resolve = (value: unknown): Record<string, unknown> => {
    const candidate = object(value);
    if (candidate.$ref === undefined) return candidate;
    if (typeof candidate.$ref !== 'string' || !candidate.$ref.startsWith('#/components/')) {
      throw new CatalogContractError('Only local OpenAPI component references are supported');
    }
    let resolved: unknown = document;
    for (const segment of candidate.$ref.slice(2).split('/')) {
      resolved = object(resolved)[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
    }
    const result = object(resolved);
    if (result.$ref !== undefined)
      throw new CatalogContractError('Chained OpenAPI object references are unsupported');
    return result;
  };
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(object(value)).map(([key, child]) => {
        if (key === '$ref') {
          if (typeof child !== 'string' || !child.startsWith('#/components/schemas/')) {
            throw new CatalogContractError('Only local catalog schema references are supported');
          }
          return [key, child.replace('#/components/schemas/', '#/$defs/')];
        }
        return [key, rewrite(child)];
      }),
    );
  };
  const definitions = object(rewrite(object(document.components).schemas));
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictTypes: false,
    ownProperties: true,
  });
  const compiled = new Map<string, ValidateFunction>();
  const compile = (schema: unknown): ValidateFunction => {
    const key = JSON.stringify(schema);
    const existing = compiled.get(key);
    if (existing) return existing;
    const result = ajv.compile({
      ...object(rewrite(schema)),
      $defs: definitions,
    } as AnySchemaObject);
    compiled.set(key, result);
    return result;
  };
  const entity = compile({ $ref: '#/components/schemas/Entity' });
  const operations = {
    byName: resolve(
      object(object(document.paths)['/entities/by-name/{kind}/{namespace}/{name}']).get,
    ),
    byRefs: resolve(object(object(document.paths)['/entities/by-refs']).post),
    byQuery: resolve(object(object(document.paths)['/entities/by-query']).get),
  };
  const prepared = new Map<
    CatalogOperation,
    {
      path: readonly { name: string; required: boolean; validate: ValidateFunction }[];
      body: { required: boolean; validate: ValidateFunction } | undefined;
      responses: ReadonlyMap<string, ValidateFunction>;
    }
  >();
  for (const operation of ['byName', 'byRefs', 'byQuery'] as const) {
    const definition = operations[operation];
    const parameters = definition.parameters ?? [];
    if (!Array.isArray(parameters)) throw new CatalogContractError('Invalid OpenAPI parameters');
    const path = parameters.flatMap((raw: unknown) => {
      const parameter = resolve(raw);
      // Optional query features are explicitly rejected by the fake's HTTP layer.
      if (operation !== 'byQuery' && parameter.in === 'query' && parameter.required !== true)
        return [];
      if (
        !['path', 'query'].includes(parameter.in as string) ||
        typeof parameter.name !== 'string'
      ) {
        throw new CatalogContractError('Unsupported catalog operation parameter');
      }
      return [
        {
          name: parameter.name,
          required: parameter.required === true,
          validate: compile(parameter.schema),
        },
      ];
    });
    const body = definition.requestBody === undefined ? undefined : resolve(definition.requestBody);
    const bodySchema =
      body === undefined ? undefined : object(object(body.content)['application/json']).schema;
    const responses = new Map<string, ValidateFunction>();
    for (const [status, raw] of Object.entries(object(definition.responses))) {
      const response = resolve(raw);
      const schema = object(object(response.content)['application/json']).schema;
      responses.set(status, compile(schema));
    }
    if (!responses.has('200') || !responses.has('default'))
      throw new CatalogContractError('Required catalog responses are missing');
    prepared.set(operation, {
      path,
      body:
        body === undefined
          ? undefined
          : {
              required: body.required === true,
              validate: compile(bodySchema),
            },
      responses,
    });
  }
  return Object.freeze({
    assertEntity(value: unknown): void {
      if (!entity(value))
        throw new CatalogContractError('Catalog entity violates pinned OpenAPI schema');
    },
    assertRequest(
      operation: CatalogOperation,
      params: Readonly<Record<string, unknown>>,
      body: unknown,
    ): void {
      const definition = prepared.get(operation)!;
      for (const parameter of definition.path) {
        const value = params[parameter.name];
        if (
          (value === undefined && parameter.required) ||
          (value !== undefined && !parameter.validate(value))
        ) {
          throw new CatalogContractError('Catalog path parameter violates pinned OpenAPI schema');
        }
      }
      if (
        (body !== undefined && definition.body === undefined) ||
        (definition.body !== undefined &&
          (body !== undefined || definition.body.required) &&
          !definition.body.validate(body))
      ) {
        throw new CatalogContractError('Catalog request violates pinned OpenAPI schema');
      }
    },
    assertResponse(operation: CatalogOperation, status: number, value: unknown): void {
      const responses = prepared.get(operation)!.responses;
      const validate = responses.get(String(status)) ?? responses.get('default')!;
      if (!validate(value))
        throw new CatalogContractError('Catalog response violates pinned OpenAPI schema');
    },
  });
}
