import type {
  Coverage,
  DeploymentProfile,
  Finding,
  ValidationRequest,
  ValidationResult,
} from '../../contracts/schemas.js';
import { compileReferenceContexts } from '../../contracts/reference-contexts.js';
import type { ReferencePattern } from '../../contracts/reference-contexts.js';
import type { Immutable } from '../../base/json.js';
import { createFindingId } from '../../core/results.js';
import type { Interruption } from '../../core/stage-report.js';
import { locateParsedPath, parseSourceSnapshot, parsingFindings } from '../../parsing/index.js';
import type { ParsedSourceDocument, ParsingReport } from '../../parsing/index.js';
import type { RequestBudget } from '../../runtime/request-budget.js';
import type { createCustomKindRegistry } from '../custom-schemas.js';
import type { ReferenceCounter } from '../references.js';
import { SnapshotSourceResolver, SUBSTITUTION_MESSAGES } from '../substitutions.js';
import type { SourceResolutionError } from '../substitutions.js';
import type {
  BackstageAdapter,
  BackstageSourceReference,
  CompatibleSourceEntity,
  SourceIdentityClaim,
} from '../types.js';

export const MESSAGES = Object.freeze({
  invalid_envelope: 'Entity does not satisfy the selected native Backstage envelope schema.',
  invalid_kind: 'Entity does not satisfy the selected native Backstage kind schema.',
  invalid_policy_value: 'Entity does not satisfy the configured native Backstage policy.',
  unsupported_kind: 'Kind is outside the implemented native adapter surface.',
  unsupported_api_version: 'API version is not recognized by the selected native kind validator.',
  unsupported_processor: 'Required deployment processor is unavailable.',
  cancelled: 'Native validation cancelled.',
  timeout: 'Validation request deadline exceeded during native validation.',
  adapter_unavailable: 'Pinned native adapter is unavailable.',
  invalid_reference: 'Reference does not satisfy the configured native reference context.',
  invalid_reference_shape: 'Reference field does not have the configured scalar/array structure.',
  invalid_identity: 'Entity identity cannot be represented by an unambiguous native reference.',
  disallowed_kind: 'Entity kind is not allowed by the configured global or source admission rules.',
  invalid_custom_kind: 'Entity does not satisfy the pinned custom kind schema.',
  unsupported_custom_schema: 'The schema artifact required by this custom kind is unavailable.',
  ...SUBSTITUTION_MESSAGES,
});
export type SourceMessageCode = keyof typeof MESSAGES;
export type CustomKindRegistry = ReturnType<typeof createCustomKindRegistry>;
export type CustomSchema = DeploymentProfile['customKinds'][number]['schema'];

/**
 * The accumulator of one source validation run. Stages append to the ordered arrays and own no
 * copies of them. The status fields are assigned, not merged: the last writer wins.
 */
export interface SourceRunState {
  readonly run: Immutable<ValidationRequest>;
  readonly profile: Immutable<DeploymentProfile>;
  readonly budget: RequestBudget;
  readonly parsed: ParsingReport;
  readonly resolver: SnapshotSourceResolver;
  readonly referencePatterns: readonly ReferencePattern[];
  readonly referenceCounter: ReferenceCounter;
  readonly findings: Immutable<Finding>[];
  readonly coverage: Immutable<Coverage>[];
  readonly entities: CompatibleSourceEntity[];
  readonly references: BackstageSourceReference[];
  readonly sourceClaims: SourceIdentityClaim[];
  readonly artifacts: ValidationResult['artifacts'];
  /** Grows during iteration when a Location entity discovers included documents. */
  readonly documents: ParsedSourceDocument[];
  interrupted: Interruption;
  /** Once set, every later document receives one blocked row with the latest `blockedReason`. */
  unavailable: boolean;
  blockedReason: string;
  unresolvedIncludes: boolean;
  adapter: BackstageAdapter | undefined;
  customKinds: CustomKindRegistry | undefined;
}

/** The stage that is running for one document; the error mapping reads `phase`. */
export type SourcePhase = 'substitution' | 'native' | 'references' | 'locations';
export interface DocumentProgress {
  phase: SourcePhase;
  /** The authored document until substitution resolves it, then the resolved document. */
  document: ParsedSourceDocument;
  claim: SourceIdentityClaim;
  readonly subject: string;
  readonly claimIndex: number;
  readonly adapter: BackstageAdapter;
  readonly customKinds: CustomKindRegistry;
}

/** Parses the selected sources and starts the run accumulator from the parsing report. */
export async function openSourceRun(
  run: Immutable<ValidationRequest>,
  profile: Immutable<DeploymentProfile>,
  budget: RequestBudget,
  uris: readonly string[] | undefined,
): Promise<SourceRunState> {
  const referencePatterns = compileReferenceContexts(profile.referenceContexts);
  const parsed = await parseSourceSnapshot(run.source, {
    mode: run.execution.mode,
    deadlineAt: run.execution.deadlineAt,
    signal: budget.signal,
    ...(uris === undefined ? {} : { uris }),
    limits: {
      files: profile.limits.entities,
      documents: profile.limits.entities,
      fileBytes: profile.limits.fileBytes,
      requestBytes: profile.limits.requestBytes,
      documentBytes: profile.limits.expandedEntityBytes,
    },
  });
  const state: SourceRunState = {
    run,
    profile,
    budget,
    parsed,
    resolver: new SnapshotSourceResolver(run.source, profile, run.execution.mode, budget, parsed),
    referencePatterns,
    referenceCounter: { visits: 0, occurrences: 0 },
    findings: [...parsingFindings(run, parsed)],
    coverage: [...parsed.coverage],
    entities: [],
    references: [],
    sourceClaims: [],
    artifacts: [],
    documents: [...parsed.documents],
    interrupted: parsed.interrupted,
    unavailable: parsed.interrupted !== 'none',
    blockedReason:
      parsed.interrupted === 'resource_limit'
        ? MESSAGES.resource_limit
        : parsed.interrupted === 'timeout'
          ? MESSAGES.timeout
          : parsed.interrupted === 'cancelled'
            ? MESSAGES.cancelled
            : MESSAGES.unsupported_processor,
    unresolvedIncludes: false,
    adapter: undefined,
    customKinds: undefined,
  };
  for (const file of parsed.files) {
    if (file.status !== 'parsed')
      state.coverage.push({
        stage: 'compatibility',
        subject: file.uri,
        required: file.status !== 'invalid',
        status: 'blocked',
        reason:
          file.status === 'invalid'
            ? 'Invalid parsed documents were excluded.'
            : 'Parsing did not complete.',
      });
  }
  return state;
}

/**
 * Appends a source finding. A dependency finding is a warning in the IDE; every source finding
 * blocks CI. `override` supplies the resolution error's own location and related locations.
 */
export function sourceFinding(
  state: SourceRunState,
  document: ParsedSourceDocument,
  code: SourceMessageCode,
  path: string,
  category: Finding['category'],
  stage: string = code,
  override?: SourceResolutionError,
): void {
  const { run, profile } = state;
  const ruleId = `backstage/${stage}`;
  const location = override?.location ?? locateParsedPath(document, path);
  let authoredPath = path;
  while (!document.locations[authoredPath] && authoredPath)
    authoredPath = authoredPath.slice(0, authoredPath.lastIndexOf('/'));
  state.findings.push({
    id: createFindingId({
      ruleId,
      ruleVersion: profile.adapterId,
      subjectId: JSON.stringify([document.uri, document.document]),
      path,
      policyDigest: run.policy.digest,
      profileDigest: run.profile.digest,
    }),
    ruleId,
    ruleVersion: profile.adapterId,
    subjectId: JSON.stringify([document.uri, document.document]),
    message: MESSAGES[code],
    category,
    severity: category === 'dependency' && run.execution.mode === 'ide' ? 'warning' : 'error',
    enforcement: run.execution.mode === 'ci' ? 'blocking' : 'advisory',
    location,
    relatedLocations: [
      ...(override?.relatedLocations ?? document.locations[authoredPath]?.relatedLocations ?? []),
    ],
    edits: [],
  });
}
