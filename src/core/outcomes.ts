import type { ValidationResult } from '../contracts/schemas.js';
import type { Immutable } from './json.js';

export interface DecisionEvidence {
  readonly mode: ValidationResult['mode'];
  readonly coverage: Immutable<ValidationResult['coverage']>;
  readonly findings: Immutable<ValidationResult['findings']>;
  readonly ruleStates: Immutable<ValidationResult['ruleStates']>;
  readonly interrupted: ValidationResult['resources']['interrupted'];
  readonly bypass?: Immutable<NonNullable<ValidationResult['bypass']>>;
}

/** One decision function serves construction and semantic contract validation. */
export function decideOutcome(
  evidence: DecisionEvidence,
): Pick<ValidationResult, 'outcome' | 'enforcement'> {
  const emergency =
    evidence.bypass?.type === 'emergency' &&
    evidence.bypass.entityScope === undefined &&
    evidence.coverage.some((entry) => entry.status === 'bypassed');
  if (emergency) return { outcome: 'bypassed', enforcement: 'allow' };
  const error =
    evidence.ruleStates.some(
      (state) => state.status === 'invalid_policy' || state.status === 'error',
    ) ||
    evidence.findings.some(
      (finding) => finding.category === 'configuration' || finding.category === 'execution',
    );
  const incomplete =
    evidence.interrupted !== 'none' ||
    !evidence.coverage.some((entry) => entry.required) ||
    evidence.coverage.some((entry) => entry.required && entry.status !== 'verified') ||
    evidence.ruleStates.some(
      (state) => state.required && (state.status === 'blocked' || state.status === 'incomplete'),
    );
  const blocking =
    evidence.findings.some((finding) => finding.enforcement === 'blocking') ||
    evidence.ruleStates.some((state) => state.required && state.status === 'failed');
  const outcome = error ? 'error' : incomplete ? 'incomplete' : 'completed';
  const enforcement =
    evidence.mode === 'ide' ? 'advisory' : outcome !== 'completed' || blocking ? 'block' : 'allow';
  return { outcome, enforcement };
}
