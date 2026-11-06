import type { PolicyBundle } from '../contracts/schemas.js';
import { parseContract } from '../contracts/validate.js';
import { canonicalJson, deepFreeze, digestJson } from '../core/json.js';
import type { Immutable } from '../core/json.js';
import { reject } from '../core/errors.js';
import { orderRules } from './rule-graph.js';

export const POLICY_BUNDLE_LIMITS = Object.freeze({
  bundles: 64,
  depth: 16,
  bytes: 2 * 1024 * 1024,
});

/** Resolve content-addressed inheritance with no rule replacement, including mandatory downgrades. */
export function resolvePolicyBundles(
  rootDigest: string,
  input: readonly Immutable<PolicyBundle>[],
  mandatoryDigests: readonly string[],
) {
  if (!input.length || input.length > POLICY_BUNDLE_LIMITS.bundles)
    reject('limit', '/bundles', 'bundle inventory exceeds the supported bounds');
  canonicalJson(input, { maxBytes: POLICY_BUNDLE_LIMITS.bytes });
  const bundles = new Map<string, Immutable<PolicyBundle>>();
  for (const row of input) {
    const bundle = parseContract('policy-bundle', row);
    const digest = digestJson(bundle);
    if (bundles.has(digest)) reject('invalid_policy', '/bundles', 'duplicate bundle digest');
    bundles.set(digest, bundle);
  }
  const root = bundles.get(rootDigest);
  if (!root) reject('integrity', '/rootDigest', 'root bundle is absent');
  const active = new Set<string>();
  const heights = new Map<string, number>();
  const closure = new Set<string>();
  const rules = new Map<string, Immutable<PolicyBundle['rules'][number]>>();
  const schemas = new Map<string, Immutable<PolicyBundle['schemas'][number]>>();
  const visit = (digest: string, depth: number): number => {
    if (depth > POLICY_BUNDLE_LIMITS.depth)
      reject('limit', '/extends', 'inheritance depth exceeded');
    if (active.has(digest)) reject('invalid_policy', '/extends', 'cyclic policy inheritance');
    const previous = heights.get(digest);
    if (previous !== undefined) return previous;
    const bundle = bundles.get(digest);
    if (!bundle) reject('integrity', '/extends', 'inherited bundle is absent');
    if (bundle.plugins.length)
      reject('invalid_policy', '/plugins', 'no executable plugins are supported');
    active.add(digest);
    let height = 1;
    for (const parent of [...bundle.extends].sort())
      height = Math.max(height, 1 + visit(parent, depth + 1));
    if (height > POLICY_BUNDLE_LIMITS.depth)
      reject('limit', '/extends', 'inheritance depth exceeded');
    for (const rule of bundle.rules) {
      const existing = rules.get(rule.id);
      if (existing && canonicalJson(existing) !== canonicalJson(rule))
        reject('invalid_policy', '/rules', 'inherited rule cannot be replaced or weakened');
      rules.set(rule.id, rule);
    }
    for (const pin of bundle.schemas) {
      const key = JSON.stringify([pin.id, pin.version]);
      const existing = schemas.get(key);
      if (existing && existing.digest !== pin.digest)
        reject('integrity', '/schemas', 'conflicting schema pins');
      schemas.set(key, pin);
    }
    active.delete(digest);
    closure.add(digest);
    heights.set(digest, height);
    return height;
  };
  visit(rootDigest, 1);
  if (mandatoryDigests.some((digest) => !closure.has(digest)))
    reject(
      'invalid_policy',
      '/extends',
      'a host-required baseline is absent from policy inheritance',
    );
  if (closure.size !== bundles.size)
    reject(
      'invalid_policy',
      '/bundles',
      'release includes bundles outside the root inheritance closure',
    );
  const ordered = orderRules([...rules.values()]);
  const policy = parseContract('policy-bundle', {
    ...root,
    extends: [],
    rules: ordered.map((id) => rules.get(id)!),
    schemas: [...schemas.values()].sort((a, b) => {
      const left = JSON.stringify([a.id, a.version]);
      const right = JSON.stringify([b.id, b.version]);
      return left < right ? -1 : left > right ? 1 : 0;
    }),
    plugins: [],
  });
  return deepFreeze({ policy, closureDigests: [...closure].sort() });
}
