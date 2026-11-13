# Defect 7: An oversized watched-files notification always refreshes

Read [the cleanup rules](README.md) first.

## Defect

`admitWatchedFiles` in `src/lsp/handlers/documents.ts` decides whether a
`workspace/didChangeWatchedFiles` notification refreshes the approved files. For up to 1000
changes it tests each one and refreshes only when at least one is admitted. For more than 1000
changes it does not look at any of them: it always refreshes and records an empty, truncated
observation.

The shortcut exists to bound work on a large notification. Its cost is a full disk re-capture and
re-validation after any large burst of file events, including bursts in which nothing relevant
changed.

The shortcut is not needed to bound the work. The admission test is cheap in principle. A change
is admitted when its URI is canonical, its type is 1, 2, or 3, and one of these holds:

- it is an approved file;
- it lies under a discovery root, or is an ancestor directory of one;
- it is a directory that contains an approved file.

None of these needs glob matching: a URI that matches a discovery glob is already under a
discovery root. The current code is slow only because it evaluates the glob test first and scans
the approved-file list linearly for each change. The message itself is bounded by the 8 MiB frame
limit in `src/lsp/framing.ts`.

## Fix

1. **Build a prepared matcher.** Add a function that takes the trusted configuration and returns a
   predicate over one change. It precomputes a set of the approved file URIs, a set of every
   ancestor directory URI of an approved file, and the list of discovery roots. The predicate
   applies the cheap tests first (type, set lookups, root prefixes) and the canonical-URI test last.
   Cache the matcher per configuration object.
2. **Prove it equals the current predicate.** Before using it, add the equivalence test described
   below, with the current expression copied into the test as the reference.
3. **Use it for notifications of every size.**
   - Up to 1000 changes: as today. Every change is tested, the admitted URIs are collected up to 32
     URIs and 64 KiB, and `truncated` is reported.
   - More than 1000 changes: scan with the matcher and stop at the first admitted change. If one
     is admitted, refresh and record the same observation as today (`uris: []`,
     `truncated: true`). If the whole list is scanned and none is admitted, do not refresh and
     record no observation, exactly like a small notification with no admitted change.
   - Keep a hard bound. If the scan passes 50,000 changes without a decision, stop and refresh, as
     today. Name the constant and document it.
4. Keep `admitWatchedFiles` a pure function with its current signature and return type.

## What changes for callers

- A notification with more than 1000 changes, none of which is admitted, no longer triggers a
  refresh.
- A notification with more than 1000 changes and at least one admitted change behaves as before.
- Notifications of up to 1000 changes behave as before.

## Success criteria

1. For every input in the equivalence test, the prepared matcher returns the same result as the
   current predicate.
2. A notification of 1001 or more changes with no admitted change returns `{ refresh: false }`.
3. A notification of 1001 or more changes with one admitted change, at the start, in the middle,
   or at the end, returns `{ refresh: true, uris: [], truncated: true }`.
4. A notification with more than 50,000 changes and no admitted change among the first 50,000
   returns `{ refresh: true, uris: [], truncated: true }`.
5. The oversized path calls no glob matcher. A test proves it by counting calls.
6. Every existing assertion about notifications of up to 1000 changes passes unchanged. The
   existing assertion for 1001 changes is updated only if its changes are not admitted; list it.
7. `test/fixtures/lsp-lifecycle.json` and `test/fixtures/lsp-handlers.json` are byte-identical,
   unless a lifecycle probe sends an oversized notification with no admitted change. If one does,
   show the changed cells and explain them.
8. The new tests below fail before the fix where marked, and pass after it.
9. The full gate passes.

## Test cases

Add to `test/lsp/lsp-handlers.test.ts`. No test measures elapsed time.

1. **Equivalence** (write first; passes before and after): for several configurations (files only,
   discovery only, both, nested roots, a root equal to the workspace root) and a generated set of
   at least 2,000 URIs per configuration, the prepared matcher equals the current predicate. The
   URIs must include approved files, files under and outside roots, ancestor directories with and
   without a trailing slash, sibling paths that share a string prefix with a root but are not under
   it, non-canonical URIs, percent-encoded paths, and each change type from 0 to 4.
2. **Oversized, none admitted** (fails before the fix): 1,001 and 20,000 changes outside every
   root give `{ refresh: false }`.
3. **Oversized, one admitted**: an admitted change at the first, middle, and last position gives
   `{ refresh: true, uris: [], truncated: true }`.
4. **Scan bound**: 50,001 non-admitted changes give a refresh; exactly 50,000 non-admitted changes
   give no refresh.
5. **No glob matching on the oversized path**: with a counting stub in place of the glob matcher,
   an oversized notification under a discovery root causes zero calls.
6. **Small notifications are unchanged**: the existing cases for the 32-URI and 64 KiB limits and
   for truncation still pass.
7. **Handler effect**: through the fake connection, an oversized notification with no admitted
   change does not invalidate the disk generation, schedules no validation, and records no
   filesystem observation. One with an admitted change does all three, as today.
8. **Matcher cache**: two notifications under one configuration build the matcher once; a
   configuration reload builds a new one.

## Out of scope

Changing the 1000-change threshold for collecting URIs, the observation limits, or the rule for
which changes are admitted.
