import { Composer, Lexer, Parser } from 'yaml';
import type { CST, Document, YAMLError } from 'yaml';
import type { SourceSnapshot } from '../contracts/schemas.js';
import { parseContract } from '../contracts/validate.js';
import { deepFreeze } from '../base/json.js';
import type { Immutable } from '../base/json.js';
import { reject } from '../base/errors.js';
import { CelError } from '../runtime/cel/errors.js';
import { ParsingBudget } from './budget.js';
import { convertDocument } from './convert.js';
import { SourceLineIndex } from './locations.js';
import { checkSyntax } from './syntax.js';
import { PARSE_MESSAGES, ParseFault } from './types.js';
import type {
  ParseDiagnostic,
  ParsedSourceDocument,
  ParsedSourceFile,
  ParsingOptions,
  ParsingReport,
} from './types.js';

function libraryFault(error: YAMLError): ParseFault {
  const code =
    error.code === 'RESOURCE_EXHAUSTION'
      ? 'resource_limit'
      : error.code === 'TAG_RESOLVE_FAILED'
        ? 'unsupported_tag'
        : error.code === 'DUPLICATE_KEY'
          ? 'duplicate_key'
          : error.code === 'NON_STRING_KEY'
            ? 'invalid_key'
            : 'syntax';
  return new ParseFault(code, error.pos[0], error.pos[1]);
}

function terminalFault(error: unknown): ParseFault {
  if (error instanceof ParseFault) return error;
  if (error instanceof CelError && error.code === 'cancelled') return new ParseFault('cancelled');
  if (error instanceof CelError && error.code === 'request_timeout')
    return new ParseFault('timeout');
  return new ParseFault('parser_failure');
}

function category(code: ParseDiagnostic['code']): ParseDiagnostic['category'] {
  if (['resource_limit', 'cancelled', 'timeout'].includes(code)) return 'resource';
  return code === 'parser_failure' ? 'execution' : 'input';
}

type FileState = { -readonly [K in keyof ParsedSourceFile]: ParsedSourceFile[K] };

/** Parses only the supplied immutable snapshot. No readers, network, or filesystem access. */
export async function parseSourceSnapshot(
  source: Immutable<SourceSnapshot>,
  options: ParsingOptions,
): Promise<ParsingReport> {
  if (options.mode !== 'ci' && options.mode !== 'ide') throw new RangeError('Unknown parsing mode');
  using budget = new ParsingBudget(options);
  const snapshot = parseContract('source-snapshot', source);
  const selection = options.uris === undefined ? undefined : new Set(options.uris);
  if (
    selection &&
    (selection.size !== options.uris?.length ||
      [...selection].some((uri) => !snapshot.files.some((file) => file.uri === uri)))
  ) {
    reject('invalid_contract', '/uris', 'source selection contains duplicate or unavailable files');
  }
  const selected = snapshot.files
    .filter((file) => !selection || selection.has(file.uri))
    .toSorted((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
  const files = selected.map((file): FileState => ({
    uri: file.uri,
    sourceDigest: file.digest,
    ...(file.version === undefined ? {} : { version: file.version }),
    status: 'blocked',
    documentsScanned: 0,
    emptyDocuments: 0,
  }));
  const documents: ParsedSourceDocument[] = [];
  const diagnostics: ParseDiagnostic[] = [];
  let interrupted: ParsingReport['interrupted'] = 'none';
  let selectedBytes = 0;

  for (let fileIndex = 0; fileIndex < selected.length; fileIndex++) {
    const file = selected[fileIndex]!;
    const state = files[fileIndex]!;
    const lines = new SourceLineIndex(file.text);
    const fileDocuments: ParsedSourceDocument[] = [];
    let seenCst = 0;
    let diagnosticOrdinal = 0;
    const emit = (fault: ParseFault, ordinal: number, terminal = false): void => {
      if (diagnostics.length >= budget.limits.diagnostics) {
        if (!terminal) throw new ParseFault('resource_limit', fault.start, fault.end, fault.path);
        diagnostics.pop();
      }
      diagnostics.push({
        code: fault.code,
        message: PARSE_MESSAGES[fault.code],
        category: category(fault.code),
        location: {
          uri: file.uri,
          document: ordinal,
          path: fault.path,
          range: lines.range(fault.start, fault.end),
        },
        relatedLocations: fault.relatedLocations,
      });
    };
    const consume = async (doc: Document.Parsed): Promise<void> => {
      const ordinal = state.documentsScanned++;
      diagnosticOrdinal = ordinal;
      budget.check();
      const errors = [...doc.errors, ...doc.warnings].toSorted((a, b) => a.pos[0] - b.pos[0]);
      if (doc.directives.yaml.version !== '1.2') {
        emit(new ParseFault('unsupported_version', doc.range[0], doc.range[0]), ordinal);
        state.status = 'invalid';
        return;
      }
      if (errors.length) {
        for (const error of errors) {
          const fault = libraryFault(error);
          if (fault.code === 'resource_limit') throw fault;
          emit(fault, ordinal);
        }
        state.status = 'invalid';
        return;
      }
      try {
        const parsed = await convertDocument(doc, file, ordinal, lines, budget);
        if (parsed) fileDocuments.push(parsed);
        else state.emptyDocuments++;
      } catch (error) {
        if (!(error instanceof ParseFault) || category(error.code) !== 'input') throw error;
        emit(error, ordinal);
        state.status = 'invalid';
      }
    };
    try {
      await budget.tick();
      const bytes = Buffer.byteLength(file.text, 'utf8');
      selectedBytes += bytes;
      if (
        selected.length > budget.limits.files ||
        bytes > budget.limits.fileBytes ||
        selectedBytes > budget.limits.requestBytes
      )
        throw new ParseFault('resource_limit');
      state.status = 'parsed';
      const composer = new Composer({
        version: '1.2',
        schema: 'core',
        merge: false,
        customTags: [],
        resolveKnownTags: false,
        strict: true,
        intAsBigInt: true,
        keepSourceTokens: true,
        prettyErrors: false,
        logLevel: 'silent',
        // Duplicate detection uses our linear Set pass, avoiding quadratic composition.
        uniqueKeys: false,
      });
      const parser = new Parser();
      const token = async (item: CST.Token): Promise<void> => {
        if (item.type === 'document') {
          diagnosticOrdinal = seenCst++;
          if (++budget.documents > budget.limits.documents)
            throw new ParseFault('resource_limit', item.offset);
          await checkSyntax(item, budget);
        }
        for (const doc of composer.next(item)) await consume(doc);
      };
      for (const lexeme of new Lexer().lex(file.text)) {
        diagnosticOrdinal = seenCst;
        await budget.tick();
        if (++budget.tokens > budget.limits.tokens)
          throw new ParseFault('resource_limit', parser.offset);
        for (const item of parser.next(lexeme)) await token(item);
      }
      for (const item of parser.end()) await token(item);
      if (seenCst === 0 && ++budget.documents > budget.limits.documents)
        throw new ParseFault('resource_limit');
      for (const doc of composer.end(true, file.text.length)) await consume(doc);
      budget.check();
    } catch (error) {
      const fault = terminalFault(error);
      emit(fault, diagnosticOrdinal, true);
      state.status = 'incomplete';
      if (fault.code === 'timeout') interrupted = 'timeout';
      else if (fault.code === 'cancelled') interrupted = 'cancelled';
      else if (fault.code === 'resource_limit') interrupted = 'resource_limit';
      if (options.mode === 'ide') documents.push(...fileDocuments);
      break;
    }
    if (state.status === 'parsed' || options.mode === 'ide') documents.push(...fileDocuments);
  }
  // Empty selections still observe cancellation/deadline and cannot manufacture a pass.
  if (selected.length === 0) {
    try {
      budget.check();
    } catch (error) {
      interrupted = terminalFault(error).code === 'cancelled' ? 'cancelled' : 'timeout';
    }
  }
  return deepFreeze({
    sourceDigest: snapshot.digest,
    mode: options.mode,
    files,
    documents,
    diagnostics,
    interrupted,
    coverage: files.length
      ? files.map((file) => ({
          stage: 'parse' as const,
          subject: file.uri,
          required: true,
          status:
            file.status === 'parsed' || file.status === 'invalid'
              ? ('verified' as const)
              : ('blocked' as const),
          ...(file.status === 'incomplete' || file.status === 'blocked'
            ? { reason: 'Source parsing did not complete.' }
            : {}),
        }))
      : [
          {
            stage: 'parse' as const,
            subject: 'snapshot',
            required: true,
            status: interrupted === 'none' ? ('verified' as const) : ('blocked' as const),
          },
        ],
  });
}
