import { Environment } from '@marcbachmann/cel-js';
import type { ASTNode, ParseResult } from '@marcbachmann/cel-js';
import { RE2JS } from 're2js';
import { CelError } from './errors.js';
import { snapshotCelInput } from './input.js';
import { CEL_LIMITS } from './limits.js';

const FUNCTIONS = new Set([
  'has',
  'int',
  'uint',
  'double',
  'string',
  'bool',
  'bytes',
  'size',
  'type',
  'dyn',
  'timestamp',
  'duration',
]);
const METHODS = new Set([
  'all',
  'exists',
  'exists_one',
  'map',
  'filter',
  'matches',
  'size',
  'contains',
  'startsWith',
  'endsWith',
]);

function walk(node: ASTNode, visit: (node: ASTNode) => void): void {
  visit(node);
  const child = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(child);
    } else if (value && typeof value === 'object' && 'op' in value && 'args' in value) {
      walk(value as ASTNode, visit);
    }
  };
  child(node.args);
}

/** Rename only AST-identified method tokens; never reserialize decimal literals. */
function routeRegex(expression: string, ast: ASTNode): string {
  const edits: number[] = [];
  walk(ast, (node) => {
    if (
      (node.op === 'id' && node.args.startsWith('bve_internal_')) ||
      ((node.op === 'call' || node.op === 'rcall') && node.args[0].startsWith('bve_internal_'))
    ) {
      throw new CelError('profile');
    }
    if (
      (node.op === 'call' && !FUNCTIONS.has(node.args[0])) ||
      (node.op === 'rcall' && !METHODS.has(node.args[0]))
    )
      throw new CelError('profile');
    if (node.op !== 'rcall' || node.args[0] !== 'matches') return;
    const [, receiver, args] = node.args;
    if (args.length !== 1 || !args[0]) throw new CelError('parse');
    const offset = receiver.end;
    const between = expression
      .slice(offset, args[0].start)
      .replace(/\/\/[^\n]*/g, (comment) => ' '.repeat(comment.length));
    const tokens = [...between.matchAll(/\.\s*(matches)\s*\(/g)];
    const token = tokens[0];
    if (tokens.length !== 1 || !token) throw new CelError('profile');
    edits.push(offset + token.index + token[0].indexOf('matches'));
  });
  for (const start of edits.sort((a, b) => b - a)) {
    expression = expression.slice(0, start) + 'bve_internal_matches' + expression.slice(start + 7);
  }
  return expression;
}

/** Worker-only interpreter. The supervisor supplies enforceable wall deadlines. */
export function createCelEvaluator(): (expression: string, entity: unknown) => boolean {
  const patterns = new Map<string, RE2JS>();
  const programs = new Map<string, ParseResult>();
  let fatalFailure: CelError | undefined;
  const throwIfFatal = (): void => {
    if (fatalFailure) throw fatalFailure;
  };
  const env = new Environment({
    limits: {
      maxAstNodes: CEL_LIMITS.astNodes,
      maxDepth: CEL_LIMITS.astDepth,
      maxListElements: CEL_LIMITS.literalEntries,
      maxMapEntries: CEL_LIMITS.literalEntries,
      maxCallArguments: CEL_LIMITS.callArguments,
    },
  })
    .registerVariable('entity', 'map')
    .registerFunction(
      'string.bve_internal_matches(string): bool',
      (text: string, pattern: string) => {
        if (pattern.length > CEL_LIMITS.patternChars) {
          fatalFailure = new CelError('regex_limit');
          throw fatalFailure;
        }
        let compiled = patterns.get(pattern);
        if (!compiled) {
          try {
            compiled = RE2JS.compile(pattern);
          } catch {
            throw new CelError('regex');
          }
          if (patterns.size >= CEL_LIMITS.cacheEntries) patterns.clear();
          patterns.set(pattern, compiled);
        }
        return compiled.matcher(text).find();
      },
      { async: false },
    );
  return (expression, entity) => {
    fatalFailure = undefined;
    const snapshot = snapshotCelInput(expression, entity);
    let program = programs.get(expression);
    if (!program) {
      try {
        const original = env.parse(expression);
        const routed = routeRegex(expression, original.ast);
        program = routed === expression ? original : env.parse(routed);
      } catch (error) {
        if (error instanceof CelError) throw error;
        throw new CelError('parse');
      }
      if (programs.size >= CEL_LIMITS.cacheEntries) programs.clear();
      programs.set(expression, program);
    }
    let result: unknown;
    try {
      result = program({ entity: snapshot });
    } catch (error) {
      throwIfFatal();
      if (error instanceof CelError) throw error;
      throw new CelError('evaluation');
    }
    // Ordinary CEL errors can be masked by language operators. Resource failures cannot.
    throwIfFatal();
    if (typeof result !== 'boolean') throw new CelError('result_type');
    return result;
  };
}
