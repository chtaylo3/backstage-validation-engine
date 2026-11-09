import { Composer, Lexer, Parser, isMap, isSeq, isScalar, isNode } from 'yaml';
import type { Document, CST } from 'yaml';
import type { ParsingBudget } from '../parsing/budget.js';
import { checkSyntax } from '../parsing/syntax.js';
import { childPointer, SourceLineIndex } from '../parsing/locations.js';
import type { Position, Range } from 'vscode-languageserver/node';

export interface EditorNode {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly keyStart?: number;
  readonly keyEnd?: number;
  readonly value: unknown;
  readonly container: 'map' | 'sequence' | undefined;
  readonly flow: boolean;
  readonly indent: number;
  readonly blocked: boolean;
}
export interface EditorDocument {
  readonly ordinal: number;
  readonly start: number;
  readonly end: number;
  readonly value: unknown;
  readonly nodes: ReadonlyMap<string, EditorNode>;
  readonly valid: boolean;
}
export interface EditorFile {
  readonly uri: string;
  readonly version: number | undefined;
  readonly digest: string;
  readonly text: string;
  readonly lines: SourceLineIndex;
  readonly documents: readonly EditorDocument[];
  readonly json: boolean;
}
export interface EditorTarget {
  readonly document: EditorDocument;
  readonly path: string;
  readonly key: boolean;
  readonly range: Range;
  readonly prefix: string;
  readonly colon: boolean;
  readonly flow: boolean;
}

/** Recovery ASTs are presentation data only. They never become validation subjects. */
export async function editorDocuments(
  text: string,
  budget: ParsingBudget,
): Promise<EditorDocument[]> {
  const output: EditorDocument[] = [];
  const lines = new SourceLineIndex(text);
  const consume = async (doc: Document.Parsed) => {
    if (doc.directives.yaml.version !== '1.2') return;
    const nodes = new Map<string, EditorNode>();
    let visits = 0;
    const walk = async (
      input: unknown,
      pointer: string,
      keyInput?: unknown,
      blocked = false,
      depth = 0,
    ): Promise<unknown> => {
      const node = isNode(input) ? input : null;
      const key = isNode(keyInput) ? keyInput : null;
      if (++visits > budget.limits.syntaxNodes || depth > budget.limits.depth)
        throw new Error('Editor AST exceeds limits.');
      await budget.tick();
      const start = node?.range?.[0] ?? key?.range?.[1] ?? doc.range[0];
      const end = node?.range?.[1] ?? start;
      const unsafe =
        blocked ||
        !!node?.anchor ||
        !!node?.tag ||
        (!!node && !isMap(node) && !isSeq(node) && !isScalar(node));
      let value: unknown;
      if (!unsafe && isMap(node)) {
        const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        const seen = new Set<string>();
        for (const pair of node.items) {
          if (!isScalar(pair.key) || typeof pair.key.value !== 'string') continue;
          if (seen.has(pair.key.value) || pair.key.value === '<<')
            throw new Error('Ambiguous editor mapping.');
          seen.add(pair.key.value);
          record[pair.key.value] = await walk(
            pair.value,
            childPointer(pointer, pair.key.value),
            pair.key,
            unsafe,
            depth + 1,
          );
        }
        value = record;
      } else if (!unsafe && isSeq(node)) {
        const items: unknown[] = [];
        for (const [index, item] of node.items.entries())
          items.push(await walk(item, childPointer(pointer, index), undefined, unsafe, depth + 1));
        value = items;
      } else if (
        !unsafe &&
        isScalar(node) &&
        (node.value === null || ['string', 'boolean', 'number'].includes(typeof node.value))
      )
        value = node.value;
      nodes.set(pointer, {
        path: pointer,
        start,
        end,
        value,
        ...(key?.range ? { keyStart: key.range[0], keyEnd: key.range[1] } : {}),
        container: isMap(node) ? 'map' : isSeq(node) ? 'sequence' : undefined,
        flow: !!((isMap(node) || isSeq(node)) && node.flow),
        indent: lines.position(key?.range?.[0] ?? start).character,
        blocked: unsafe,
      });
      return value;
    };
    const value = await walk(doc.contents, '');
    output.push({
      ordinal: output.length,
      start: doc.range[0],
      end: doc.range[2],
      value,
      nodes,
      valid: doc.errors.length === 0 && doc.warnings.length === 0,
    });
    await budget.tick();
  };
  const composer = new Composer({
    version: '1.2',
    schema: 'core',
    merge: false,
    customTags: [],
    resolveKnownTags: false,
    strict: true,
    intAsBigInt: true,
    uniqueKeys: false,
    prettyErrors: false,
    logLevel: 'silent',
  });
  const parser = new Parser();
  const token = async (item: CST.Token) => {
    if (item.type === 'document') {
      if (++budget.documents > budget.limits.documents)
        throw new Error('Too many editor documents.');
      await checkSyntax(item, budget);
    }
    for (const doc of composer.next(item)) await consume(doc);
  };
  for (const lexeme of new Lexer().lex(text)) {
    await budget.tick();
    if (++budget.tokens > budget.limits.tokens) throw new Error('Too many editor tokens.');
    for (const item of parser.next(lexeme)) await token(item);
  }
  for (const item of parser.end()) await token(item);
  for (const doc of composer.end(true, text.length)) await consume(doc);
  return output;
}

function unquote(text: string): string {
  return text.replace(/^["']/u, '').replace(/["']$/u, '');
}
export function editorTarget(file: EditorFile, position: Position): EditorTarget | undefined {
  const offset = position && file.lines.offset(position);
  if (offset === undefined) return undefined;
  const document = file.documents.find(
    (doc, index) =>
      offset >= doc.start && offset < (file.documents[index + 1]?.start ?? file.text.length + 1),
  );
  if (!document) return undefined;
  const text = file.text;
  // A partially typed block key is often recovered by YAML as part of the previous scalar.
  const lineStart = file.lines.offset({ line: position.line, character: 0 })!;
  const before = text.slice(lineStart, offset);
  const endOfLine = text.slice(offset).search(/[\r\n]/u);
  const lineEnd = endOfLine < 0 ? text.length : offset + endOfLine;
  const line = text.slice(lineStart, lineEnd);
  const partial = /^( *)([\w.-]*)$/u.exec(before);
  if (partial && !file.json && !line.includes(':') && !line.trimStart().startsWith('#')) {
    const indent = partial[1]!.length;
    const maps = [...document.nodes.values()]
      .filter((node) => {
        if (node.blocked || node.container !== 'map' || node.flow || node.start > offset)
          return false;
        const children = [...document.nodes.values()].filter(
          (item) =>
            item.path.slice(0, item.path.lastIndexOf('/')) === node.path &&
            item.keyStart !== undefined,
        );
        const expected = children.length
          ? Math.min(...children.map((item) => file.lines.position(item.keyStart!).character))
          : node.path === ''
            ? 0
            : node.indent + 2;
        if (expected !== indent) return false;
        return offset <= node.end || text.slice(node.end, lineStart).trim() === '';
      })
      .sort((a, b) => b.path.length - a.path.length);
    const map = maps[0];
    if (map)
      return {
        document,
        path: map.path,
        key: true,
        range: file.lines.range(lineStart + indent, lineEnd),
        prefix: partial[2]!,
        colon: false,
        flow: false,
      };
    const missingMap = [...document.nodes.values()]
      .filter(
        (node) =>
          !node.blocked &&
          node.value === null &&
          node.keyEnd !== undefined &&
          node.indent + 2 === indent &&
          node.end <= offset &&
          text.slice(node.end, lineStart).trim() === '',
      )
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (missingMap)
      return {
        document,
        path: missingMap.path,
        key: true,
        range: file.lines.range(lineStart + indent, lineEnd),
        prefix: partial[2]!,
        colon: false,
        flow: false,
      };
    if (!document.nodes.get('')?.container && indent === 0)
      return {
        document,
        path: '',
        key: true,
        range: file.lines.range(lineStart, lineEnd),
        prefix: partial[2]!,
        colon: false,
        flow: false,
      };
  }
  for (const node of [...document.nodes.values()].sort((a, b) => b.path.length - a.path.length)) {
    if (node.blocked) continue;
    if (
      node.keyStart !== undefined &&
      node.keyEnd !== undefined &&
      offset >= node.keyStart &&
      offset <= node.keyEnd
    ) {
      const parent = node.path.slice(0, node.path.lastIndexOf('/'));
      return {
        document,
        path: parent,
        key: true,
        range: file.lines.range(node.keyStart, node.keyEnd),
        prefix: unquote(text.slice(node.keyStart, offset)),
        colon: /^\s*:/u.test(text.slice(node.keyEnd, lineEnd)),
        flow: file.json || !!document.nodes.get(parent)?.flow,
      };
    }
    if (
      !node.container &&
      offset >= node.start &&
      offset <= node.end &&
      !/[\r\n]/u.test(text.slice(node.start, node.end))
    )
      return {
        document,
        path: node.path,
        key: false,
        range: file.lines.range(node.start, node.end),
        prefix: unquote(text.slice(node.start, offset)),
        colon: true,
        flow: file.json,
      };
    if (!node.container && node.value === null && node.keyEnd !== undefined) {
      const colon = text.indexOf(':', node.keyEnd);
      if (
        colon >= 0 &&
        colon < lineEnd &&
        offset > colon &&
        /^[ \t]*$/u.test(text.slice(colon + 1, offset)) &&
        !text.slice(offset, lineEnd).trim().startsWith('#')
      )
        return {
          document,
          path: node.path,
          key: false,
          range: file.lines.range(offset, offset),
          prefix: '',
          colon: true,
          flow: file.json,
        };
    }
    if (
      node.container === 'map' &&
      node.flow &&
      offset > node.start &&
      offset < node.end &&
      /[{,]\s*$/u.test(text.slice(node.start, offset))
    )
      return {
        document,
        path: node.path,
        key: true,
        range: file.lines.range(offset, offset),
        prefix: '',
        colon: false,
        flow: true,
      };
  }
  return undefined;
}
