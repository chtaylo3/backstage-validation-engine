import type { SchemaArtifact } from '../../contracts/schemas.js';
import { ContractError } from '../../base/errors.js';
import type { Immutable } from '../../base/json.js';
import { CelError } from '../../runtime/cel/errors.js';
import { loadBackstageAdapter } from '../adapter.js';
import { createCustomKindRegistry } from '../custom-schemas.js';
import type { BackstageAdapter, BackstageAdapterId } from '../types.js';
import { MESSAGES } from './state.js';
import type { SourceRunState } from './state.js';

/**
 * Loads the pinned adapter, checks its settings, compiles custom kinds and checks that every
 * reference context forms an unambiguous native reference. Skipped once parsing was interrupted.
 * A failure other than a contract error makes the run unavailable with one adapter coverage row.
 */
export async function prepareSourceRun(
  state: SourceRunState,
  schemaArtifacts: readonly Immutable<SchemaArtifact>[] | undefined,
  load: (id: BackstageAdapterId) => Promise<BackstageAdapter> = loadBackstageAdapter,
): Promise<void> {
  const { budget, profile } = state;
  try {
    if (!state.unavailable) {
      budget.throwIfInterrupted();
      const adapter = await load(profile.adapterId);
      state.adapter = adapter;
      budget.throwIfInterrupted();
      adapter.validateSettings(profile.nativePolicies);
      state.customKinds = createCustomKindRegistry(profile, schemaArtifacts);
      budget.throwIfInterrupted();
      for (const pattern of state.referencePatterns) {
        try {
          adapter.resolveReference('context-check', {
            defaultKind: pattern.defaultKind,
            defaultNamespace: pattern.namespace === 'entity' ? 'default' : pattern.namespace,
          });
        } catch {
          throw new ContractError('invalid_contract', [
            {
              path: '/referenceContexts',
              message: 'reference context defaults must form an unambiguous native reference',
            },
          ]);
        }
      }
    }
  } catch (error) {
    if (error instanceof ContractError) throw error;
    state.unavailable = true;
    const code =
      error instanceof CelError
        ? error.code === 'request_timeout'
          ? 'timeout'
          : 'cancelled'
        : 'adapter_unavailable';
    state.blockedReason = MESSAGES[code];
    state.coverage.push({
      stage: 'compatibility',
      subject: 'adapter',
      required: true,
      status: code === 'adapter_unavailable' ? 'unavailable' : 'blocked',
      reason: state.blockedReason,
    });
    if (error instanceof CelError) state.interrupted = code === 'timeout' ? 'timeout' : 'cancelled';
  }
}
