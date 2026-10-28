import type { Immutable } from '../core/json.js';
import { deepFreeze } from '../core/json.js';
import type { NodeSourceSpan, ParsedSourceDocument, SourceLocation, SourceRange } from './types.js';

/** Indexes authored UTF-16 offsets once; handles LF, CRLF, CR, and EOF. */
export class SourceLineIndex {
  private readonly starts = [0];
  private readonly ends: number[] = [];
  private readonly length: number;

  constructor(text: string) {
    this.length = text.length;
    for (let index = 0; index < text.length; index++) {
      if (text[index] === '\r' || text[index] === '\n') {
        this.ends.push(index);
        if (text[index] === '\r' && text[index + 1] === '\n') index++;
        this.starts.push(index + 1);
      }
    }
    this.ends.push(text.length);
  }

  position(offset: number): SourceRange['start'] {
    if (!Number.isFinite(offset)) throw new RangeError('Source offset must be finite');
    const bounded = Math.min(this.length, Math.max(0, Math.trunc(offset)));
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.starts[middle]! <= bounded) low = middle;
      else high = middle - 1;
    }
    return { line: low, character: Math.min(bounded, this.ends[low]!) - this.starts[low]! };
  }

  range(start: number, end: number): SourceRange {
    return { start: this.position(start), end: this.position(Math.max(start, end)) };
  }
}

export function childPointer(parent: string, key: string | number): string {
  return `${parent}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

/** Looks up a field, falling back to its nearest authored ancestor when absent. */
export function locateParsedPath(
  document: ParsedSourceDocument,
  pointer: string,
  kind: 'key' | 'value' = 'value',
): Immutable<SourceLocation> {
  if ((pointer !== '' && !pointer.startsWith('/')) || /~(?![01])/u.test(pointer)) {
    throw new RangeError('Source path must be a JSON Pointer');
  }
  let path = pointer;
  let span: NodeSourceSpan | undefined = document.locations[path];
  while (!span && path) {
    path = path.slice(0, path.lastIndexOf('/'));
    span = document.locations[path];
  }
  return deepFreeze({
    uri: document.uri,
    document: document.document,
    path: pointer,
    range:
      kind === 'key'
        ? (span?.key ?? span?.value ?? document.range)
        : (span?.value ?? document.range),
  });
}
