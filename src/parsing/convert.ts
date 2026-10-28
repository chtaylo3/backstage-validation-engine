import { isAlias, isMap, isScalar, isSeq } from 'yaml';
import type { Document, Node } from 'yaml';
import type { JsonValue, SourceFile } from '../contracts/schemas.js';
import type { Immutable } from '../core/json.js';
import { deepFreeze } from '../core/json.js';
import type { ParsingBudget } from './budget.js';
import { childPointer } from './locations.js';
import type { SourceLineIndex } from './locations.js';
import type { NodeSourceSpan, ParsedSourceDocument, SourceLocation, SourceRange } from './types.js';
import { ParseFault } from './types.js';

const JSON_TAGS = new Set(
  ['str', 'int', 'float', 'bool', 'null', 'map', 'seq'].map((name) => `tag:yaml.org,2002:${name}`),
);

/** Converts directly from bounded AST nodes; never invokes YAML toJS hooks. */
export async function convertDocument(
  doc: Document.Parsed,
  file: Immutable<SourceFile>,
  ordinal: number,
  lines: SourceLineIndex,
  budget: ParsingBudget,
): Promise<ParsedSourceDocument | undefined> {
  const root = doc.contents;
  if (
    !root ||
    (isScalar(root) && root.value === null && root.source === '' && root.range[0] === root.range[1])
  )
    return undefined;
  const locations: Record<string, NodeSourceSpan> = {};
  const authoredPaths = new Map<Node, string>();
  const ancestors = new Set<Node>();
  let aliases = 0;
  let bytes = 0;
  const add = (text: string, offset: number): void => {
    bytes = budget.addBytes(Buffer.byteLength(text, 'utf8'), bytes, offset);
  };
  const nodeRange = (node: Node): SourceRange =>
    lines.range(node.range?.[0] ?? doc.range[0], node.range?.[1] ?? doc.range[1]);
  const location = (path: string, range: SourceRange): SourceLocation => ({
    uri: file.uri,
    document: ordinal,
    path,
    range,
  });
  function fail(
    code: ConstructorParameters<typeof ParseFault>[0],
    node: Node,
    path: string,
  ): never {
    throw new ParseFault(code, node.range?.[0] ?? 0, node.range?.[1] ?? 0, path);
  }
  const visit = async (
    node: Node | null,
    path: string,
    depth: number,
    aliasUse?: SourceRange,
  ): Promise<JsonValue> => {
    await budget.tick();
    const offset = node?.range?.[0] ?? doc.range[0];
    if (depth > budget.limits.depth) throw new ParseFault('resource_limit', offset, offset, path);
    if (node?.tag && !JSON_TAGS.has(node.tag)) fail('unsupported_tag', node, path);
    if (isAlias(node)) {
      if (++aliases > budget.limits.aliases) fail('resource_limit', node, path);
      const target = node.resolve(doc);
      if (!target) fail('alias_missing', node, path);
      if (ancestors.has(target)) fail('alias_cycle', node, path);
      return visit(target, path, depth, aliasUse ?? nodeRange(node));
    }
    if (++budget.values > budget.limits.expandedValues)
      throw new ParseFault('resource_limit', offset, offset, path);
    if (node && !aliasUse) authoredPaths.set(node, path);
    const span: NodeSourceSpan = {
      value: aliasUse ?? (node ? nodeRange(node) : lines.range(offset, offset)),
      origin: aliasUse ? 'alias' : 'authored',
      relatedLocations:
        aliasUse && node ? [location(authoredPaths.get(node) ?? path, nodeRange(node))] : [],
    };
    locations[path] = span;
    if (node === null || isScalar(node)) {
      let value: unknown = node === null ? null : node.value;
      if (typeof value === 'bigint') {
        if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER))
          fail('unsafe_number', node!, path);
        value = Number(value);
      }
      if (
        typeof value === 'number' &&
        (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      )
        fail('unsafe_number', node!, path);
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value))
        fail('non_json_value', node!, path);
      const scalar = value as string | number | boolean | null;
      add(JSON.stringify(scalar), offset);
      return scalar;
    }
    if (ancestors.has(node)) fail('alias_cycle', node, path);
    ancestors.add(node);
    try {
      if (isSeq(node)) {
        add('[', offset);
        const result: JsonValue[] = [];
        for (let index = 0; index < node.items.length; index++) {
          if (index) add(',', offset);
          result.push(
            await visit(
              node.items[index] as Node | null,
              childPointer(path, index),
              depth + 1,
              aliasUse,
            ),
          );
        }
        add(']', offset);
        return result;
      }
      if (!isMap(node)) fail('non_json_value', node, path);
      add('{', offset);
      const result: Record<string, JsonValue> = {};
      const keys = new Map<string, SourceLocation>();
      for (const pair of node.items) {
        const key = pair.key;
        if (!isScalar(key) || typeof key.value !== 'string')
          fail('invalid_key', key && typeof key === 'object' ? (key as Node) : node, path);
        const childPath = childPointer(path, key.value);
        if (key.value === '<<') fail('merge_key', key, childPath);
        const previous = keys.get(key.value);
        if (previous)
          throw new ParseFault(
            'duplicate_key',
            key.range?.[0] ?? offset,
            key.range?.[1] ?? offset,
            childPath,
            [previous],
          );
        if (keys.size) add(',', offset);
        keys.set(key.value, location(childPath, nodeRange(key)));
        add(`${JSON.stringify(key.value)}:`, offset);
        const value = await visit(pair.value as Node | null, childPath, depth + 1, aliasUse);
        if (!aliasUse) locations[childPath] = { ...locations[childPath]!, key: nodeRange(key) };
        // __proto__, constructor and similar names remain ordinary authored keys.
        Object.defineProperty(result, key.value, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      add('}', offset);
      return result;
    } finally {
      ancestors.delete(node);
    }
  };
  const value = await visit(root, '', 0);
  return deepFreeze({
    uri: file.uri,
    sourceDigest: file.digest,
    ...(file.version === undefined ? {} : { version: file.version }),
    document: ordinal,
    range: nodeRange(root),
    value,
    locations,
  });
}
