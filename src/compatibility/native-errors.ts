import type { JsonValue } from '../contracts/schemas.js';
import { isRecord } from '../base/json.js';
import type { Immutable } from '../base/json.js';
import { childPointer } from '../parsing/locations.js';
import type { NativeStage } from './types.js';

/** Extracts only a source path from known native error prefixes; never exposes text. */
export function nativeErrorPath(
  error: unknown,
  stage: NativeStage,
  entity: Immutable<JsonValue>,
): string {
  if (!(error instanceof Error)) return '';
  const message = error.message;
  if (stage === 'group_default_parent') return '/spec/parent';
  if (stage === 'default_namespace') return '/metadata/namespace';
  if (
    stage === 'no_foreign_root_fields' &&
    entity &&
    typeof entity === 'object' &&
    !Array.isArray(entity)
  ) {
    const key = Object.keys(entity).find((name) => message === `Unknown field ${name}`);
    return key === undefined ? '' : childPointer('', key);
  }
  if (stage === 'field_format') {
    for (const field of ['apiVersion', 'kind', 'metadata.name', 'metadata.namespace']) {
      if (
        message.startsWith(`"${field}" is not valid;`) ||
        message.startsWith(`${field} must have a value`)
      )
        return `/${field.replaceAll('.', '/')}`;
    }
    const indexed = /^"(tags|links)\.(\d+)(?:\.(url|title|icon))?" is not valid;/u.exec(message);
    if (indexed)
      return `/metadata/${indexed[1]}/${indexed[2]}${indexed[3] ? `/${indexed[3]}` : ''}`;
    // Dynamic key names may contain punctuation; exact candidate matching avoids splitting them.
    if (isRecord(entity) && 'metadata' in entity) {
      const metadata = entity.metadata;
      if (isRecord(metadata)) {
        for (const collection of ['labels', 'annotations']) {
          const entries = metadata[collection];
          if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
            const matches = Object.keys(entries).filter(
              (name) =>
                message.startsWith(`"${collection}.${name}" is not valid;`) ||
                message.startsWith(`${collection}.${name} must have a value`),
            );
            if (matches.length === 1) return childPointer(`/metadata/${collection}`, matches[0]!);
            if (matches.length > 1) return `/metadata/${collection}`;
          }
        }
      }
    }
    return '/metadata';
  }
  const prefix = message.startsWith('Malformed envelope, ') ? message.slice(20) : message;
  const match = /^(<root>|\/\S*) (?:must|should) /u.exec(prefix);
  if (!match) return '';
  let path = match[1] === '<root>' ? '' : match[1]!;
  if (/~(?![01])/u.test(path)) return '';
  const missing = /^(?:<root>|\/\S*) must have required property '([A-Za-z][A-Za-z0-9]*)'/u.exec(
    prefix,
  );
  if (missing) path = childPointer(path, missing[1]!);
  return path;
}
