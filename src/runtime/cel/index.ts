import { ManagedCelPool } from './pool.js';
import type { CelRuntime } from './pool.js';

let shared: ManagedCelPool | undefined;

/** One lazily started interpreter pool shared by every adapter in this process. */
export function getSharedCelRuntime(): CelRuntime {
  shared ??= new ManagedCelPool();
  return shared;
}

/** Application shutdown owns the pool; individual requests never close it. */
export async function closeSharedCelRuntime(): Promise<void> {
  const runtime = shared;
  if (!runtime) return;
  await runtime.close();
  if (shared === runtime) shared = undefined;
}

export { CelError } from './errors.js';
export type { CelErrorCode } from './errors.js';
export { CEL_LIMITS, CEL_PROFILE } from './limits.js';
export type { CelRuntime, CelRuntimeStats } from './pool.js';
