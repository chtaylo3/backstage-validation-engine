import type { DeploymentProfile } from '../contracts/schemas.js';
import type { Immutable } from '../core/json.js';
import { reject } from '../core/errors.js';
import { BUILTIN_KINDS } from '../compatibility/types.js';

/** Canonical source names only; a trailing slash denotes a directory prefix. */
export function isAdmissionSource(value: string): boolean {
  try {
    const source = new URL(value);
    if (
      value.length > 4096 ||
      source.href !== value ||
      source.username ||
      source.password ||
      source.search ||
      source.hash
    )
      return false;
    if (!['file:', 'https:', 'http:'].includes(source.protocol)) return false;
    return !source.pathname.split('/').some((part) => {
      const decoded = decodeURIComponent(part);
      return decoded === '.' || decoded === '..' || /[/\\%\p{Cc}]/u.test(decoded);
    });
  } catch {
    return false;
  }
}

export function validateAdmissionProfile(profile: Immutable<DeploymentProfile>): void {
  for (const kinds of [
    profile.admission.allowedKinds,
    ...profile.admission.locations.map((rule) => rule.allowedKinds),
  ]) {
    if (new Set(kinds.map((kind) => kind.toLowerCase())).size !== kinds.length)
      reject('invalid_contract', '/admission', 'duplicate case-insensitive kind allowances');
  }
  const prefixes = new Set<string>();
  for (const rule of profile.admission.locations) {
    if (!isAdmissionSource(rule.sourcePrefix))
      reject(
        'invalid_contract',
        '/admission/locations',
        'source prefixes must be canonical file or HTTP URIs without credentials, queries or fragments',
      );
    if (prefixes.has(rule.sourcePrefix))
      reject('invalid_contract', '/admission/locations', 'duplicate source prefix');
    prefixes.add(rule.sourcePrefix);
  }
  const pairs = new Set<string>();
  const pins = new Map<string, string>();
  for (const declaration of profile.customKinds) {
    const kind = declaration.kind.toLowerCase();
    if (BUILTIN_KINDS.some((builtin) => builtin.toLowerCase() === kind))
      reject(
        'invalid_contract',
        '/customKinds',
        'custom schemas cannot replace stock kind validators',
      );
    const pair = JSON.stringify([declaration.apiVersion, kind]);
    if (pairs.has(pair))
      reject('invalid_contract', '/customKinds', 'duplicate custom kind/apiVersion pair');
    pairs.add(pair);
    const artifact = JSON.stringify([declaration.schema.id, declaration.schema.version]);
    if (pins.has(artifact) && pins.get(artifact) !== declaration.schema.digest)
      reject(
        'invalid_contract',
        '/customKinds',
        'one schema identity cannot have conflicting digests',
      );
    pins.set(artifact, declaration.schema.digest);
  }
}

/** Location rules add to central global allowances; entity annotations cannot select rules. */
export function admitsKind(
  profile: Immutable<DeploymentProfile>,
  sourceUri: string,
  kind: string,
): boolean {
  const matches = (kinds: readonly string[]) =>
    kinds.some((allowed) => allowed.toLowerCase() === kind.toLowerCase());
  return (
    matches(profile.admission.allowedKinds) ||
    (isAdmissionSource(sourceUri) &&
      profile.admission.locations.some(
        (rule) =>
          (sourceUri === rule.sourcePrefix ||
            (rule.sourcePrefix.endsWith('/') && sourceUri.startsWith(rule.sourcePrefix))) &&
          matches(rule.allowedKinds),
      ))
  );
}
