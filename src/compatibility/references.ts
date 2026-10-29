import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { JsonValue } from '../contracts/schemas.js';
import type { Immutable } from '../core/json.js';
import { childPointer, locateParsedPath } from '../parsing/locations.js';
import type { ParsedSourceDocument } from '../parsing/types.js';
import { isArrayIndex, REFERENCE_LIMITS } from '../policy/reference-contexts.js';
import type { ReferencePattern } from '../policy/reference-contexts.js';
import type { RequestBudget } from '../runtime/request-budget.js';
import { BackstageRuntimeError } from './types.js';
import type { BackstageAdapter, BackstageSourceReference } from './types.js';

export interface ReferenceIssue {
  readonly code: 'invalid_reference' | 'invalid_reference_shape';
  readonly path: string;
}
export interface ReferenceCounter {
  visits: number;
  occurrences: number;
}

export async function extractEntityReferences(
  document: ParsedSourceDocument,
  normalized: Immutable<JsonValue>,
  sourceEntityRef: string,
  patterns: readonly ReferencePattern[],
  adapter: BackstageAdapter,
  budget: RequestBudget,
  counter: ReferenceCounter,
): Promise<{ references: BackstageSourceReference[]; issues: ReferenceIssue[] }> {
  const references: BackstageSourceReference[] = [];
  const issues: ReferenceIssue[] = [];
  const namespace = adapter.resolveReference(sourceEntityRef).namespace;
  const step = async () => {
    budget.throwIfInterrupted();
    if (++counter.visits > REFERENCE_LIMITS.visits)
      throw new BackstageRuntimeError('resource_limit');
    if (counter.visits % 128 === 0) {
      await yieldTurn();
      budget.throwIfInterrupted();
    }
  };
  const issue = (code: ReferenceIssue['code'], path: string) => {
    if (++counter.occurrences > REFERENCE_LIMITS.occurrences)
      throw new BackstageRuntimeError('resource_limit');
    issues.push({ code, path });
  };
  for (const pattern of patterns) {
    const stack: { value: Immutable<JsonValue>; path: string; offset: number }[] = [
      { value: normalized, path: '', offset: 0 },
    ];
    while (stack.length) {
      await step();
      const current = stack.pop()!;
      const segment = pattern.segments[current.offset];
      if (segment === undefined) {
        if (++counter.occurrences > REFERENCE_LIMITS.occurrences)
          throw new BackstageRuntimeError('resource_limit');
        if (typeof current.value !== 'string') {
          issues.push({ code: 'invalid_reference', path: current.path });
          continue;
        }
        let targetRef: string;
        try {
          targetRef = adapter.resolveReference(current.value, {
            defaultKind: pattern.defaultKind,
            defaultNamespace: pattern.namespace === 'entity' ? namespace : pattern.namespace,
          }).entityRef;
        } catch {
          issues.push({ code: 'invalid_reference', path: current.path });
          continue;
        }
        let authoredPath = current.path;
        while (!document.locations[authoredPath] && authoredPath)
          authoredPath = authoredPath.slice(0, authoredPath.lastIndexOf('/'));
        references.push({
          sourceEntityRef,
          targetRef,
          value: current.value,
          contextPath: pattern.path,
          sourceDigest: document.sourceDigest,
          ...(document.version === undefined ? {} : { version: document.version }),
          location: locateParsedPath(document, current.path),
          relatedLocations: document.locations[authoredPath]?.relatedLocations ?? [],
        });
        continue;
      }
      if (segment === '*') {
        if (!Array.isArray(current.value)) {
          issue('invalid_reference_shape', current.path);
          continue;
        }
        if (current.value.length > REFERENCE_LIMITS.occurrences - counter.occurrences)
          throw new BackstageRuntimeError('resource_limit');
        for (let index = current.value.length - 1; index >= 0; index--)
          stack.push({
            value: (current.value as readonly Immutable<JsonValue>[])[index]!,
            path: childPointer(current.path, index),
            offset: current.offset + 1,
          });
      } else if (current.value !== null && typeof current.value === 'object') {
        if (Array.isArray(current.value) && !isArrayIndex(segment)) {
          issue('invalid_reference_shape', current.path);
          continue;
        }
        if (Object.hasOwn(current.value, segment))
          stack.push({
            value: (current.value as Readonly<Record<string, Immutable<JsonValue>>>)[segment]!,
            path: childPointer(current.path, segment),
            offset: current.offset + 1,
          });
      } else issue('invalid_reference_shape', current.path);
    }
  }
  budget.throwIfInterrupted();
  return { references, issues };
}
