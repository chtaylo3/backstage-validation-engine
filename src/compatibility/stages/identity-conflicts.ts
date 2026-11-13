import { createFindingId } from '../../core/results.js';
import type { SourceIdentityClaim } from '../types.js';
import type { SourceRunState } from './state.js';

/** At most this many competing-claim findings; beyond it the run is resource limited. */
const CONFLICT_FINDINGS = 64;
/** At most this many other claims are related to each competing-claim finding. */
const RELATED_CLAIMS = 16;

/**
 * Reports source documents that claim one catalog identity and withholds every conflicted entity,
 * and every entity discovered through a conflicted Location, from the accepted results.
 */
export function resolveIdentityConflicts(state: SourceRunState) {
  const { run, profile, sourceClaims } = state;
  const byIdentity = new Map<string, SourceIdentityClaim[]>();
  for (const claim of sourceClaims)
    if (claim.entityRef) {
      const group = byIdentity.get(claim.entityRef) ?? [];
      group.push(claim);
      byIdentity.set(claim.entityRef, group);
    }
  const conflicts = new Set<string>();
  let conflictFindings = 0;
  for (const [entityRef, group] of byIdentity)
    if (group.length > 1) {
      conflicts.add(entityRef);
      for (const claim of group) {
        if (++conflictFindings > CONFLICT_FINDINGS) {
          state.interrupted = 'resource_limit';
          break;
        }
        const ruleId = 'backstage/overlay/competing_claims';
        const subjectId = JSON.stringify([claim.uri, claim.document]);
        state.findings.push({
          id: createFindingId({
            ruleId,
            ruleVersion: profile.adapterId,
            subjectId,
            path: '/metadata',
            policyDigest: run.policy.digest,
            profileDigest: run.profile.digest,
          }),
          ruleId,
          ruleVersion: profile.adapterId,
          subjectId,
          message: 'Multiple proposed source documents claim the same catalog identity.',
          category: 'compatibility',
          severity: 'error',
          enforcement: run.execution.mode === 'ci' ? 'blocking' : 'advisory',
          location: claim.location,
          relatedLocations: [
            ...claim.relatedLocations,
            ...group
              .slice(0, RELATED_CLAIMS + 1)
              .filter((other) => other !== claim)
              .slice(0, RELATED_CLAIMS)
              .map((other) => other.location),
          ],
          edits: [],
        });
      }
    }
  state.coverage.push({
    stage: 'overlay',
    subject: 'source-identities',
    required: true,
    status: state.interrupted === 'none' ? 'verified' : 'blocked',
  });
  const conflictedLocations = new Set(
    sourceClaims
      .filter((claim) => claim.entityRef?.startsWith('location:') && conflicts.has(claim.entityRef))
      .map((claim) => JSON.stringify([claim.uri, claim.document])),
  );
  const entities = state.entities.filter(
    (entity) =>
      !conflicts.has(entity.entityRef) &&
      !entity.document.locations['']?.relatedLocations.some((location) =>
        conflictedLocations.has(JSON.stringify([location.uri, location.document])),
      ),
  );
  const acceptedRefs = new Set(entities.map((entity) => entity.entityRef));
  return {
    entities,
    references: state.references.filter((reference) => acceptedRefs.has(reference.sourceEntityRef)),
    artifacts: state.artifacts.filter((artifact) => acceptedRefs.has(artifact.entityRef)),
  };
}
