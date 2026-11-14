# Phase 6: Catalog queries for plugins

Read [the plan overview](README.md) first. This plan uses the brokered catalog access from
Phase 2.

## Goal

Let a plugin ask the catalog a question that is not a lookup by reference, for example "which
Systems are in zone A", with an answer that is either complete or reported as incomplete.

## Current state

- `CatalogProvider.lookup` reads entities by reference. Its observations are pinned and can
  prove presence or absence.
- `CatalogProvider.suggest` searches identities by kind, namespace, and name prefix, with at most
  4 pages of 100 and 200 results. Its documentation states that a result is never a validation
  observation or a proof of absence.
- The data snapshot contract has `present`, `missing`, and `unavailable` entries keyed by entity.
  It has no entry for a query result.
- `CatalogRefresh` tracks references and advisory search queries, and revalidates open documents
  when their observations change or expire.
- A Backstage catalog can hide an entity from a principal. A query result then omits it without
  saying so.

## Target design

### Query interface

Add `catalog.query(request)` to the plugin check input. A request has a `kind`, an optional
`namespace`, and a `filter` of at most 4 exact-match field conditions (field path and string
value). It names the `fields` to return, with the pointer rules of the cross-entity rules plan
and at most 16 pointers.

The answer is `{ complete: true, entities }`, or the call fails. There is no partial answer.

### Completeness

The host pages through the result until the backend reports the end. It fails the call, and the
rule becomes `incomplete` with a resource limit, when the result passes any of these bounds:

| Bound                      | Ceiling                    |
| -------------------------- | -------------------------- |
| Entities per query         | 1,000                      |
| Pages per query            | 10                         |
| Queries per plugin call    | 4                          |
| Queries per request        | 16                         |
| Response bytes per request | 8 MiB, shared with lookups |

A query that the backend cannot answer, or that fails authorization, makes the rule `incomplete`
with `dependency_unavailable`.

### Pinning

Add a query entry to the data snapshot: the canonical request, the ordered entity references,
the projected fields, the provenance, and the expiry. The entry's key is the digest of the
canonical request and the connection. The rule result expires with the entry. A request reuses
one entry for identical queries.

### Proposed entities

A query result reflects the proposed catalog. The host adds proposed local entities that match
the filter, replaces backend entities that a proposed entity supersedes, and removes entities
that the proposal deletes. A blocked proposed fact that could match fails the query.

### Refresh

In the language server, a pinned query joins the refresh inventory. A change in the query's
result set or projected fields advances the dependency generation and revalidates the open
documents that used it. At most 16 validation queries are tracked per session.

### Permission limits

`docs/distributions.md` states the limit plainly: a query sees what the configured principal may
read. A total computed from a query is a total over the visible entities.

## Open design points

Resolve these with the owner before implementation starts, and record the answers here:

1. Whether the supported Backstage versions page a filtered query in a stable order, so that
   "the backend reports the end" is reliable under concurrent catalog changes.
2. Whether exact-match conditions are enough for the first customers, or whether a presence
   condition ("field exists") is needed.
3. Whether the catalog credential that customers use in CI can run filtered queries.

## Work order

1. Resolve the open design points against the two pinned Backstage versions in the release test
   applications.
2. Add the query entry to the data snapshot contract. Regenerate the schemas.
3. Add `query` to the catalog provider, with paging and bounds.
4. Add the proposed-catalog merge.
5. Add the brokered call for plugins and the refresh tracking.
6. Add tests against both fake API contracts, then update `docs/catalog-provider.md`.

## Success criteria

1. A fixture plugin that enforces "no zone has more than N Systems" passes and fails the expected
   fixtures through the CLI and a stdio session.
2. Every bound has a test at the ceiling (admitted) and one past it (rule `incomplete`).
3. No test observes a query answer with fewer entities than the fake catalog holds, unless the
   call failed.
4. A proposed local System that matches the filter is counted; a deleted one is not.
5. The pinned data snapshot contains the query entry, and its digest binds the rule result.
6. A remote change to the result set revalidates an open document without a source edit.
7. A policy without query-using plugins makes no query.

## Test cases

- **Paging.** 1, 2, and 10 pages; an 11th page; an entity added between pages.
- **Bounds.** 1,000 and 1,001 entities; 4 and 5 queries in one call; 16 and 17 in one request.
- **Failures.** Authorization failure, timeout, malformed page, rate limit.
- **Proposed merge.** Added, replaced, deleted, and blocked proposed entities.
- **Reuse.** Two identical queries in one request cause one backend query.
- **Expiry.** A query entry that expires before rule completion makes the rule `incomplete`.
- **Refresh.** Result set change, projected field change, and no change.
- **Both API contracts.** Every case runs against the two pinned fake API contracts.

## Exit criteria

The phase is complete, and Phase 7 may start, when all of these hold:

1. The [shared exit criteria](README.md#exit-criteria-for-every-phase) are met.
2. The three open design points have recorded answers, and the design matches them.
3. The Backstage release qualification passes for both pinned versions with one query case
   added. This suite needs containers; record the run identifier.
4. If an open design point shows that complete answers are not achievable, the phase ends with a
   written decision to stop, and Phase 7 proceeds without queries.
