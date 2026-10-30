import type { Coverage, Finding, JsonValue, ValidationResult } from '../contracts/schemas.js';
import type { Immutable } from '../core/json.js';

export type SourceLocation = Finding['location'];
export type SourceRange = SourceLocation['range'];

export const PARSING_LIMITS = Object.freeze({
  files: 1000,
  fileBytes: 1024 * 1024,
  requestBytes: 16 * 1024 * 1024,
  documents: 1000,
  depth: 64,
  syntaxNodes: 100_000,
  tokens: 200_000,
  expandedValues: 100_000,
  aliases: 50,
  documentBytes: 1024 * 1024,
  expandedBytes: 16 * 1024 * 1024,
  diagnostics: 1000,
});
export type ParsingLimits = { readonly [K in keyof typeof PARSING_LIMITS]: number };

export const PARSE_MESSAGES = Object.freeze({
  syntax: 'Invalid YAML syntax.',
  duplicate_key: 'Duplicate mapping key.',
  merge_key: 'Merge keys are outside the supported YAML profile.',
  invalid_key: 'Mapping keys must be strings.',
  unsupported_tag: 'YAML tag is outside the supported JSON profile.',
  unsupported_version: 'Only YAML 1.2 is supported.',
  unsafe_number: 'Numbers must be finite and integral values must be safe JSON integers.',
  non_json_value: 'Value is outside the supported JSON profile.',
  alias_missing: 'Alias has no preceding anchor in this document.',
  alias_cycle: 'Cyclic aliases cannot be represented as JSON.',
  resource_limit: 'Parsing exceeds the configured resource limits.',
  cancelled: 'Source parsing cancelled.',
  timeout: 'Validation request deadline exceeded during parsing.',
  parser_failure: 'Source parser could not complete.',
});
export type ParseCode = keyof typeof PARSE_MESSAGES;

export interface ParseDiagnostic {
  readonly code: ParseCode;
  readonly message: string;
  readonly category: 'input' | 'resource' | 'execution';
  readonly location: Immutable<SourceLocation>;
  readonly relatedLocations: readonly Immutable<SourceLocation>[];
}

export interface NodeSourceSpan {
  readonly value: Immutable<SourceRange>;
  readonly key?: Immutable<SourceRange>;
  readonly origin: 'authored' | 'alias';
  readonly relatedLocations: readonly Immutable<SourceLocation>[];
  /** Resolved fields retain the included file's actual path, digest and editor version. */
  readonly source?: {
    readonly uri: string;
    readonly document: number;
    readonly path: string;
    readonly sourceDigest: string;
    readonly version?: number;
  };
}

export interface ParsedSourceDocument {
  readonly uri: string;
  readonly sourceDigest: string;
  readonly version?: number;
  readonly document: number;
  readonly range: Immutable<SourceRange>;
  readonly value: Immutable<JsonValue>;
  readonly locations: Readonly<Record<string, NodeSourceSpan>>;
}

export interface ParsedSourceFile {
  readonly uri: string;
  readonly sourceDigest: string;
  readonly version?: number;
  readonly status: 'parsed' | 'invalid' | 'incomplete' | 'blocked';
  readonly documentsScanned: number;
  readonly emptyDocuments: number;
}

export interface ParsingReport {
  readonly sourceDigest: string;
  readonly mode: 'ci' | 'ide';
  readonly files: readonly ParsedSourceFile[];
  readonly documents: readonly ParsedSourceDocument[];
  readonly diagnostics: readonly ParseDiagnostic[];
  readonly coverage: readonly Immutable<Coverage>[];
  readonly interrupted: ValidationResult['resources']['interrupted'];
}

export interface ParsingOptions {
  readonly mode: 'ci' | 'ide';
  readonly deadlineAt: number;
  readonly signal?: AbortSignal;
  /** Discovery belongs to the caller. Omit to parse all supplied snapshot files. */
  readonly uris?: readonly string[];
  /** Trusted process/profile configuration may lower these ceilings. */
  readonly limits?: Partial<ParsingLimits>;
}

export class ParseFault extends Error {
  override readonly name = 'ParseFault';
  constructor(
    readonly code: ParseCode,
    readonly start = 0,
    readonly end = start,
    readonly path = '',
    readonly relatedLocations: readonly Immutable<SourceLocation>[] = [],
  ) {
    super(PARSE_MESSAGES[code]);
  }
}
