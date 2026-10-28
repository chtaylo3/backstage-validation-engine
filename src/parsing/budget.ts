import { setImmediate as yieldTurn } from 'node:timers/promises';
import { RequestBudget } from '../runtime/request-budget.js';
import type { ParsingLimits, ParsingOptions } from './types.js';
import { PARSING_LIMITS, ParseFault } from './types.js';

/** Cooperative work gate shared by lexing, syntax guards, and JSON expansion. */
export class ParsingBudget {
  readonly limits: ParsingLimits;
  syntaxNodes = 0;
  tokens = 0;
  values = 0;
  bytes = 0;
  documents = 0;
  private steps = 0;
  private lastYield = performance.now();
  private readonly request: RequestBudget;

  constructor(options: ParsingOptions) {
    const limits = { ...PARSING_LIMITS, ...options.limits };
    for (const key of Object.keys(limits) as (keyof ParsingLimits)[]) {
      const value = limits[key];
      if (!Number.isSafeInteger(value) || value < 1 || value > PARSING_LIMITS[key]) {
        throw new RangeError('Parsing configuration may only lower admission ceilings');
      }
    }
    this.limits = Object.freeze(limits);
    this.request = new RequestBudget(options.deadlineAt, options.signal);
  }

  async tick(): Promise<void> {
    this.request.throwIfInterrupted();
    if (++this.steps % 128 === 0 || performance.now() - this.lastYield >= 8) {
      await yieldTurn();
      this.lastYield = performance.now();
      this.request.throwIfInterrupted();
    }
  }

  check(): void {
    this.request.throwIfInterrupted();
  }

  addBytes(bytes: number, documentBytes: number, offset: number): number {
    this.bytes += bytes;
    const total = documentBytes + bytes;
    if (this.bytes > this.limits.expandedBytes || total > this.limits.documentBytes) {
      throw new ParseFault('resource_limit', offset);
    }
    return total;
  }

  dispose(): void {
    this.request.dispose();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
