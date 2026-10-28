import type { JsonValue } from '../../contracts/schemas.js';
import { canonicalJson, deepFreeze } from '../../core/json.js';
import type { Immutable } from '../../core/json.js';
import { ContractError } from '../../core/errors.js';
import { CelError } from './errors.js';
import { CEL_LIMITS } from './limits.js';

/** Takes a JSON snapshot before queueing; never executes getters or toJSON. */
export function snapshotCelInput(expression: string, entity: unknown): Immutable<JsonValue> {
  if (typeof expression !== 'string') throw new CelError('input_type');
  if (expression.length > CEL_LIMITS.expressionChars) throw new CelError('input_limit');
  let serialized: string;
  try {
    serialized = canonicalJson(entity, {
      maxDepth: CEL_LIMITS.inputDepth,
      maxValues: CEL_LIMITS.inputNodes,
      maxBytes: CEL_LIMITS.inputBytes,
      maxStringChars: CEL_LIMITS.stringChars,
    });
  } catch (error) {
    if (error instanceof ContractError) {
      throw new CelError(error.code === 'limit' ? 'input_limit' : 'input_type');
    }
    throw error;
  }
  const snapshot = JSON.parse(serialized) as JsonValue;
  return deepFreeze(snapshot);
}
