import { loadContractArtifact } from './contract-artifact.js';
import type { ContractArtifact } from './contract-artifact.js';
import type { FixtureTarget } from './version-matrix.js';

export interface RunningFixture {
  close(): Promise<void>;
}

export interface FixtureMatrix<T extends RunningFixture> {
  readonly fixtures: readonly { readonly target: FixtureTarget; readonly fixture: T }[];
  /** Idempotent; attempts all cleanups even if one fails. */
  close(): Promise<void>;
}

function errors(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
}

/**
 * Verifies every artifact before starting anything, then starts targets concurrently.
 * Factories own cleanup of resources acquired before they return a fixture handle.
 */
export async function startFixtureMatrix<T extends RunningFixture>(
  targets: readonly FixtureTarget[],
  artifactRoot: string,
  start: (artifact: ContractArtifact) => Promise<T>,
): Promise<FixtureMatrix<T>> {
  if (targets.length === 0) throw new Error('Cannot start an empty fixture matrix');
  if (new Set(targets.map((target) => target.minorLine)).size !== targets.length) {
    throw new Error('Fixture matrix must have exactly one target per supported minor');
  }
  const loaded = await Promise.allSettled(
    targets.map((target) => loadContractArtifact(target, artifactRoot)),
  );
  const loadErrors = errors(loaded);
  if (loadErrors.length) throw new AggregateError(loadErrors, 'Fixture contract loading failed');
  const artifacts = loaded.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  const started = await Promise.allSettled(
    artifacts.map(async (artifact) => {
      const fixture = await start(artifact);
      return Object.freeze({ target: artifact.target, fixture });
    }),
  );
  const fixtures = started.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  const startErrors = errors(started);
  const closeAll = async (): Promise<void> => {
    const failures = errors(
      await Promise.allSettled(fixtures.map(async ({ fixture }) => fixture.close())),
    );
    if (failures.length) throw new AggregateError(failures, 'Fixture cleanup failed');
  };
  if (startErrors.length) {
    const cleanup = await Promise.allSettled([closeAll()]);
    throw new AggregateError([...startErrors, ...errors(cleanup)], 'Fixture startup failed');
  }
  let closing: Promise<void> | undefined;
  return Object.freeze({
    fixtures: Object.freeze(fixtures),
    close: () => (closing ??= closeAll()),
  });
}
