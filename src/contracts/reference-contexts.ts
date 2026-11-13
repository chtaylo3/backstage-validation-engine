import type { DeploymentProfile } from './schemas.js';
import type { Immutable } from '../base/json.js';
import { reject } from '../base/errors.js';

export const REFERENCE_LIMITS = Object.freeze({
  contexts: 256,
  depth: 64,
  occurrences: 1000,
  visits: 100_000,
});
export interface ReferencePattern {
  readonly path: string;
  readonly segments: readonly string[];
  readonly defaultKind: string;
  readonly namespace: string;
}
export const isArrayIndex = (segment: string): boolean =>
  /^(0|[1-9]\d*)$/.test(segment) && Number.isSafeInteger(Number(segment));

/** Array wildcards only; overlapping contexts cannot assign competing defaults to one field. */
export function compileReferenceContexts(
  contexts: Immutable<DeploymentProfile['referenceContexts']>,
): readonly ReferencePattern[] {
  if (contexts.length > REFERENCE_LIMITS.contexts)
    reject('limit', '/referenceContexts', 'reference context count exceeds ceiling');
  const patterns = contexts.map((context): ReferencePattern => {
    if (
      !context.path.startsWith('/') ||
      context.path.length > 4096 ||
      /~(?![01])/u.test(context.path)
    ) {
      reject(
        'invalid_contract',
        '/referenceContexts',
        'reference context must be an escaped JSON Pointer pattern',
      );
    }
    const segments = context.path
      .slice(1)
      .split('/')
      .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
    if (segments.length > REFERENCE_LIMITS.depth)
      reject('limit', '/referenceContexts', 'reference path depth exceeds ceiling');
    return Object.freeze({ ...context, segments: Object.freeze(segments) });
  });
  for (let index = 0; index < patterns.length; index++) {
    const current = patterns[index]!;
    for (const other of patterns.slice(0, index)) {
      if (
        current.segments
          .slice(0, Math.min(current.segments.length, other.segments.length))
          .every((segment, offset) => {
            const previous = other.segments[offset]!;
            return (
              segment === previous ||
              (segment === '*' && isArrayIndex(previous)) ||
              (previous === '*' && isArrayIndex(segment))
            );
          })
      )
        reject('invalid_contract', '/referenceContexts', 'reference contexts overlap');
    }
  }
  return Object.freeze(patterns);
}
