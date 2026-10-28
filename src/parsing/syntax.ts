import type { CST } from 'yaml';
import type { ParsingBudget } from './budget.js';
import { ParseFault } from './types.js';

/** Iterative preflight bounds recursion before the library composes an AST. */
export async function checkSyntax(document: CST.Document, budget: ParsingBudget): Promise<void> {
  const stack: { node: CST.Token; depth: number }[] = document.value
    ? [{ node: document.value, depth: 0 }]
    : [];
  while (stack.length) {
    const item = stack.pop()!;
    await budget.tick();
    if (++budget.syntaxNodes > budget.limits.syntaxNodes || item.depth > budget.limits.depth) {
      throw new ParseFault('resource_limit', item.node.offset);
    }
    const node = item.node;
    if (node.type === 'block-map' || node.type === 'block-seq' || node.type === 'flow-collection') {
      for (let index = node.items.length - 1; index >= 0; index--) {
        const child = node.items[index]!;
        if (child.value) stack.push({ node: child.value, depth: item.depth + 1 });
        if (child.key) stack.push({ node: child.key, depth: item.depth + 1 });
        if (stack.length + budget.syntaxNodes > budget.limits.syntaxNodes)
          throw new ParseFault('resource_limit', node.offset);
      }
    }
  }
}
