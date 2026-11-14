# Phase 2: Reference collection

Read [the plan overview](README.md) first. This plan uses the compiled binding trees from Phase 1.

## Goal

Resolve every binding tree of the policy during reference preparation, in at most three rounds of
catalog lookups, and pin every resolved entity in the request's data snapshot.

## Current state

- `runReferenceDataPreparation` in `src/pipeline/reference-data.ts` collects in one round. It
  takes the targets from the references that the source stage extracted, classifies them against
  the proposed catalog, looks up the rest with one `provider.lookup` call, and pins the entries.
- A `present` data entry already carries the entity body in `value`, for a backend observation
  and for a proposed local entity (`proposedCatalogEntry` in `src/pipeline/proposed-catalog.ts`).
- A proposed local entity takes precedence over the backend. `bindCatalogReferences` in
  `src/pipeline/catalog-bindings.ts` rejects a backend observation that bypasses a proposed fact.
- `validatePolicySources` in `src/pipeline/policy-sources.ts` passes the paths of the `catalog`
  rules as `referencePaths`.
- In the language server, `CatalogRefresh` in `src/lsp/catalog-refresh.ts` wraps
  `provider.lookup` and records every looked-up reference in its inventory, with a ceiling of
  1,000 references.
- `extractEntityReferences` in `src/compatibility/references.js` extracts references from a
  parsed source document. A backend entity has no source document.

## Target design

### Collection rounds

Extend the collection with a binding plan: the set of distinct path chains that the policy's
binding trees declare, compiled once per policy.

1. **Round 1** is the existing round. Its reference paths are the union of the `catalog` rule
   paths and the first-hop binding paths.
2. **Round 2** takes each `present` entity that round 1 resolved through a binding with nested
   bindings. It extracts the references at each nested path from the entity body, classifies them
   against the proposed catalog, and looks up the rest.
3. **Round 3** repeats this for the entities that round 2 resolved.

Every round uses the original request deadline and cancellation signal. A reference that an
earlier round resolved is not looked up again. The data snapshot is pinned once, after the last
round, with every entry.

### Extraction from a target entity

Add a function in `src/compatibility/references.ts` that extracts references from a normalized
entity body without a source document. It uses the same reference contexts, default kind, and
namespace rule as source extraction; the namespace `entity` means the namespace of the target
entity. It reports no source location. It counts toward the existing reference visit and
occurrence limits.

### Proposed-catalog precedence

Precedence applies at every hop. When a target of any round is a proposed local entity, the
collection uses the proposed fact and does not ask the backend. A blocked proposed fact (for
example competing claims) blocks the target with its existing reason.

### Bounds

- A parent entity with more targets than `targetsPerBinding` at one binding, and a subject whose
  tree resolves more entities than `entitiesPerRule`, record a resource limit for that rule and
  subject. Collection continues for other rules and subjects.
- A request whose distinct targets exceed 1,000 fails collection with a resource limit, as the
  provider's `input_limit` does today.

### Resolved trees

`bindCatalogReferences` returns, next to the existing per-path facts, one resolved tree per
subject and rule. Each node holds the target reference, its status (`present`, `missing`,
`unavailable`, or `blocked`), its expiry, the source location of the reference when the parent is
a source entity, and the child nodes. The function verifies every observation against the pinned
entry with the existing `verifyObservation` step. It stores no entity body in the tree; Phase 3
reads bodies from the pinned data.

### Language server

The refresh inventory must contain the targets of every round, so that a remote change to a
second-hop entity revalidates the open documents that reached it. The wrapped provider already
records looked-up references; confirm this with a test and change nothing else in the refresh.

## Work order

1. Compile the binding plan from the policy and add its unit tests.
2. Add entity-body extraction and its unit tests.
3. Add rounds 2 and 3 to the collection.
4. Extend `bindCatalogReferences` with resolved trees.
5. Add the pipeline, CLI, and language server tests.
6. Update `docs/source-references.md` and `docs/catalog-provider.md`.

## Success criteria

1. For the [motivating example](README.md#motivating-example), the pinned data snapshot contains
   the Component's System, each dependency, and each dependency's System.
2. A policy without bindings makes the same catalog requests as before, in the same order, and
   produces a byte-identical data snapshot.
3. A proposed local entity is used at hops 1, 2, and 3 without a backend request for it.
4. Every resolved node has a verified pinned entry; a mismatch rejects with `integrity`.
5. No round starts after the request deadline, and cancellation stops between rounds.
6. A remote change to a second-hop entity triggers revalidation of the open document without a
   source edit.

## Test cases

- **Two hops and three hops.** A fake catalog serves a chain; assert the exact lookup batches.
- **Shared targets.** Two dependencies in the same System cause one lookup of that System.
- **Cycle.** A depends on B and B depends on A; collection terminates and each is looked up once.
- **Missing at each hop.** A missing first-hop, second-hop, and third-hop target each produce a
  node with status `missing` and no further lookups below it.
- **Unavailable at each hop.** A provider failure in round 2 marks the affected nodes
  `unavailable` and leaves round 1 results intact.
- **Proposed precedence.** A dependency and a dependency's System in the workspace are resolved
  locally; a workspace entity with competing claims blocks its node.
- **Bounds.** 64 and 65 targets at one binding; 256 and 257 entities for one rule; 1,000 and
  1,001 distinct targets in one request.
- **Deadline.** A round that would start after the deadline does not start; the report records a
  timeout.
- **Namespace rule.** A target in namespace `payments` with an unqualified `spec.system` resolves
  to a System in `payments`.
- **Refresh.** After a two-hop validation, the refresh inventory lists the second-hop reference.

## Exit criteria

The phase is complete, and Phase 3 may start, when all of these hold:

1. The [shared exit criteria](README.md#exit-criteria-for-every-phase) are met.
2. A recorded request trace shows that a policy without bindings makes the same catalog requests
   as before the phase.
3. The rule run receives a resolved tree for every subject and binding rule.
4. The Phase 1 unsupported guard is still in place: a rule with bindings does not evaluate.
