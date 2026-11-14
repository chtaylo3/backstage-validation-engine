# Phase 4: Editor candidates

Read [the plan overview](README.md) first. This plan uses rule evaluation from Phase 3.

## Goal

When a policy author opts in, reference completion tests each candidate against the rule and
demotes and labels the candidates that would fail it. Completion never waits for the check and
never hides a candidate.

## Current state

- `CompletionService` in `src/lsp/completion.ts` answers reference completion. It ranks qualified
  workspace identities first, waits at most 50 ms for a catalog identity search, and lets that
  search continue for up to 500 ms. A remote search needs a two-character prefix.
- Every completion list is marked incomplete, so the editor asks again on the next keystroke.
  Items carry `detail` (`Workspace source` or `Catalog (fresh)`) and a positional `sortText`.
- The server declares `resolveProvider: false` in `src/lsp/handlers/lifecycle.ts`.
- `prepareRuleContributions` in `src/host/rule-contributions.ts` checks declared scalar choices by
  running the whole pipeline on a hypothetical source. It runs at most 16 candidates per
  generation, one after another, and does not support array appends.
- Editor artifacts (`bve-editor/1`, `src/capabilities/editor-artifacts.ts`) are approved in the
  trusted launcher configuration. Each contribution pins its rule digest and accepts the language
  profiles `bve-cel/1` and `draft-07/re2js@2.9.0/schema-v1`.
- `CatalogRefresh` records hypothetical reads as candidate interest without replacing the source
  inventory.
- A standard LSP server cannot replace a completion list that the editor already shows.

## Target design

### Opt-in

Extend the editor artifact contribution:

- Accept the language profile `bve-cel/2`.
- Add the optional property `referenceCandidates: true`. With it, `path` must equal a first-hop
  binding path of the rule or its `forEachReference` path. `choices`, `examples`, and
  `defaultValue` are not allowed, and `repairs` must be `false`.

Without an approved contribution, completion at that path behaves as it does today.

### Single-rule candidate check

Add a check that answers one question: would the rule still pass if this candidate were the
reference at the completion slot? It does not run the pipeline.

1. **Base.** Take the subject's resolved tree and variables from the latest validation report in
   which the subject normalized. Remove the reference at the completion slot, because it holds
   the text that the user is typing. Without such a report, the candidate stays unchecked.
2. **Candidate subtree.** Resolve the candidate's own nested bindings with the collection rounds
   of Phase 2, through the refresh's candidate-interest path. A workspace candidate resolves
   without a network request.
3. **Evaluation.** In the aggregate mode, evaluate the expression with the candidate added to the
   list. In the per-reference mode, evaluate it with the candidate as `target`. Use the shared
   CEL workers and the existing queue limits.
4. **Result.** `would_fail` when the expression is `false`. `unchecked` for every other outcome:
   an unreadable target, a resource limit, an evaluation error, a lost deadline, or a superseded
   generation. A `true` result adds no label, because a single-rule check does not prove that the
   candidate satisfies the policy.

Check at most 32 candidates per completion request, in rank order. Cache each result by subject,
rule digest, the digest of the base variables, candidate reference, and dependency generation.
A result expires after 30 seconds or at the earliest expiry of the entries it read, whichever
comes first. The base digest excludes the slot under edit, so typing further characters keeps
the cached results.

### Presentation

- A `would_fail` candidate sorts after every other candidate and has the detail
  `Would fail rule RULE_ID`, where `RULE_ID` is the rule's identifier.
- An unchecked candidate keeps its existing position and detail.
- Completion returns within its existing 50 ms wait with the results that are cached at that
  moment. It never waits for a check.

### Preparation after validation

When a validation generation completes, for each open document with an opted-in rule:

1. Retain the base variables of each subject, so that a later check resolves only the candidate.
2. Check the qualified workspace identities that are valid candidates for the slot's kind, up to
   32 per subject and path. These need no catalog request.

Preparation uses the validation's original deadline and yields between checks. It never delays
publishing diagnostics.

### Resolve

Set `resolveProvider: true`. Each checkable item carries an opaque `data` token that names the
generation, slot, and candidate. On `completionItem/resolve`, the server:

1. Returns the item unchanged for an unknown, expired, or superseded token.
2. Otherwise waits at most 250 ms for that candidate's check, which it moves to the front of the
   queue.
3. Sets `detail` and `documentation` from the result. It changes no other property; in
   particular it does not change `insertText`, `textEdit`, `sortText`, or `filterText`.

## Work order

1. Extend the editor artifact schema and its admission. Regenerate the schemas.
2. Implement the single-rule check and its cache, with unit tests on an injected clock.
3. Add preparation after validation.
4. Apply results in `CompletionService` and add the resolve handler.
5. Add stdio tests, then one installed-editor case.
6. Update `docs/rule-editor-contributions.md`, `docs/editor-features.md`, and `docs/lsp.md`.

## Success criteria

1. With two cross-zone dependencies present, a third cross-zone candidate sorts last with the
   `Would fail rule` detail, and a same-zone candidate keeps its position.
2. With one cross-zone dependency present, a cross-zone candidate has no label.
3. The first completion response for a new prefix returns within the existing 50 ms wait in a
   test with a held catalog response.
4. No candidate is removed from a completion list by this feature.
5. Typing a further character reuses cached results and starts no check for a candidate that is
   already cached.
6. Resolve sets the label for a highlighted item when the check completes within 250 ms, and
   leaves the item unchanged otherwise.
7. A rule without an approved `referenceCandidates` contribution causes no candidate lookups.
8. Required diagnostics are published before preparation starts, and a failed check never
   changes a diagnostic.

## Test cases

- **Counting rule.** Zero, one, and two existing cross-zone dependencies, each with a same-zone
  and a cross-zone candidate.
- **Per-reference rule.** A cross-zone candidate is `would_fail` regardless of the others.
- **Slot exclusion.** The partially typed reference does not count as a dependency.
- **Unchecked outcomes.** Candidate System unavailable; candidate without `spec.system` and no
  `has()` guard; 33rd candidate; check superseded by an edit to another line.
- **Cache.** Prefix `pa` then `pay` reuses results; a remote change to a candidate's System
  discards them through the dependency generation.
- **Expiry.** A result is not applied after 30 seconds on the injected clock.
- **Workspace candidates.** Prepared after validation with no catalog request.
- **Resolve.** Known token with a finished check, with a check that finishes inside 250 ms, and
  with one that does not; unknown token; token from a previous generation.
- **No opt-in.** The same policy without the contribution makes the catalog requests it makes
  today and no others.
- **Installed editor.** One case in `extensions/vscode/test/cases/` opens a Component with two
  cross-zone dependencies, requests completion twice at a new `dependsOn` entry, and asserts the
  order and detail of the second list.

## Exit criteria

The phase is complete, and Phase 5 may start, when all of these hold:

1. The [shared exit criteria](README.md#exit-criteria-for-every-phase) are met.
2. The client coverage thresholds hold without change.
3. The new installed-editor case passes in GitHub CI on Ubuntu, Windows, and macOS, on both
   pinned VS Code versions. This suite does not run in a local agent session, so the phase stays
   open until the CI run is recorded.
4. The measured time of the first completion response is recorded in the report.
