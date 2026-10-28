import type { SourceSnapshot } from '../contracts/schemas.js';
import type { Immutable } from '../core/json.js';
import type { ParsingOptions, ParsingReport } from './types.js';

/** Loads the syntax library on the parsing path; other adapters share the light API. */
export async function parseSourceSnapshot(
  source: Immutable<SourceSnapshot>,
  options: ParsingOptions,
): Promise<ParsingReport> {
  const parser = await import('./parser.js');
  return parser.parseSourceSnapshot(source, options);
}
export { parsingFindings } from './findings.js';
export { locateParsedPath, SourceLineIndex } from './locations.js';
export { PARSING_LIMITS } from './types.js';
export type {
  ParsingLimits,
  ParsingOptions,
  ParsingReport,
  ParseDiagnostic,
  ParseCode,
  ParsedSourceDocument,
  ParsedSourceFile,
  NodeSourceSpan,
  SourceLocation,
  SourceRange,
} from './types.js';
