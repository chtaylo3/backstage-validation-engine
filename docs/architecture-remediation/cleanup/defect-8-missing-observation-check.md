# Defect 8: A rejection in reference preparation appears unreachable

Read [the cleanup rules](README.md) first.

## Defect

`observeTargets` in `src/pipeline/reference-data.ts` builds one observation per referenced target.
A target that is neither blocked nor received rejects with `integrity`, "catalog observation is
missing". During Phase 2 this branch was reported as unreachable: every target is blocked, or
answered by the proposed catalog, or sent to the provider, and `lookupCatalog` either blocks all
of the sent targets on failure or checks that the provider answered exactly them.

An unreachable integrity check is a defect either way:

- If it really cannot run, it is dead code that claims to defend something. No test covers it,
  and its message can never be seen.
- If it can run, it is an untested rejection in the path that decides which catalog data the rules
  may trust.

One path looks reachable and has to be settled. `lookupCatalog` checks that the provider returned
as many entries as were requested and that every entry's key was requested. It does not check that
the keys are distinct. A provider that answers two requested targets with two entries for the same
key passes both checks and leaves one target unanswered.

## Fix

1. **Settle reachability first.** Determine, with a test, whether a provider response with a
   duplicated key reaches `observeTargets`. The data-snapshot contract may already reject
   duplicate keys when `lookupCatalog` parses the response; if so, the duplicate never arrives.
   Check the other inputs the same way: a provider that returns an entry for a target that the
   proposed catalog already answered, and one that returns fewer or more entries than requested.
2. **Reject the bad response where it is detected.** If a duplicated key can pass `lookupCatalog`,
   add an explicit check there that every requested target was answered exactly once, with the
   existing rejection for a mismatched observation set (`integrity`, "catalog observation set
   differs from request"). A wrong provider response is then reported as what it is, at the point
   where the response is validated.
3. **Turn the remaining check into a stated invariant.** After step 2, `observeTargets` cannot meet
   an unanswered target. Keep the guard, because the type system needs the narrowing and the code
   decides which data is trusted, and mark it as an invariant: a comment that says why it cannot
   happen and which check in `lookupCatalog` guarantees it. Keep the `integrity` rejection and its
   message.
4. If step 1 shows the branch was already unreachable, skip step 2, apply step 3, and say so in
   the report with the evidence.

## What changes for callers

- If the duplicate path is reachable today: a provider response with a duplicated key is rejected
  with "catalog observation set differs from request", where it was rejected with "catalog
  observation is missing". Both are `integrity` errors that fail the run.
- Otherwise: nothing at run time.

## Success criteria

1. The report states, with a test as evidence, whether each of these provider responses reaches
   `observeTargets` today: a duplicated key, an entry for an already-answered target, too few
   entries, and too many entries.
2. After the fix, every one of those responses is rejected in `lookupCatalog` with an `integrity`
   error, and a test covers each.
3. `observeTargets` keeps its guard, and the guard carries a comment that names the check that
   makes it unreachable.
4. A well-formed provider response produces the same observations as before:
   `test/fixtures/pipeline-golden.json` is byte-identical.
5. The new tests below fail before the fix where marked, and pass after it.
6. The full gate passes.

## Test cases

Add to a file in `test/engine/`, using a stub `CatalogProvider` and the manual clock. No test
waits on a timer.

1. **Duplicated key** (fails before the fix if the path is reachable): two eligible targets, and a
   provider that returns two entries with the first target's key. Expect an `integrity` rejection
   whose issue message is "catalog observation set differs from request".
2. **Too few entries** and **too many entries**: both reject with the same message. These pass
   before and after.
3. **Entry for a target that was not requested**: rejects with "catalog observation authority
   differs from request", as today.
4. **Entry for a target the proposed catalog answered**: the provider is not asked for that target;
   if it returns it anyway, the response is rejected.
5. **Well-formed response**: two eligible targets answered once each give two observations in
   target order.
6. **Provider failure**: a lookup that throws blocks every eligible target as `provider_failure`
   and never reaches the invariant.
7. **Mixed targets**: one target blocked by an incomplete source, one answered by the proposed
   catalog, and one answered by the provider give three observations of the three kinds.

## Out of scope

Changing the provider contract, the data-snapshot contract, or any rejection message other than
the one named above.
