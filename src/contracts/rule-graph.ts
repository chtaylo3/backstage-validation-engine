import type { PolicyBundle } from './schemas.js';
import type { Immutable } from '../base/json.js';
import { reject } from '../base/errors.js';

/** Validates one resolved bundle; inherited bundles must be resolved before calling. */
export function orderRules(
  rules: Immutable<PolicyBundle['rules']>,
  maxDepth = 64,
): readonly string[] {
  if (rules.length > 256 || !Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 64) {
    reject('limit', '/rules', 'rule count or graph depth exceeds the production profile');
  }
  const byId = new Map<string, (typeof rules)[number]>();
  for (const rule of rules) {
    if (byId.has(rule.id)) reject('invalid_policy', '/rules', 'duplicate rule ID');
    byId.set(rule.id, rule);
  }
  const visiting = new Set<string>();
  const depths = new Map<string, number>();
  const ordered: string[] = [];
  const visit = (id: string, pathDepth: number): number => {
    if (pathDepth > maxDepth) reject('limit', '/rules', 'rule graph depth exceeded');
    if (visiting.has(id)) reject('invalid_policy', '/rules', 'cyclic rule prerequisites');
    const known = depths.get(id);
    if (known !== undefined) return known;
    const rule = byId.get(id);
    if (!rule) reject('invalid_policy', '/rules', 'missing rule prerequisite');
    visiting.add(id);
    let depth = 1;
    for (const dependency of [...rule.requires].sort()) {
      depth = Math.max(depth, 1 + visit(dependency, pathDepth + 1));
    }
    if (depth > maxDepth) reject('limit', '/rules', 'rule graph depth exceeded');
    visiting.delete(id);
    depths.set(id, depth);
    ordered.push(id);
    return depth;
  };
  for (const id of [...byId.keys()].sort()) visit(id, 1);
  return Object.freeze(ordered);
}
