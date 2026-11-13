# Phase 5: Clock and runtime injection

Read [the shared rules](README.md) first.

## Goal

Remove ambient time and the process-wide CEL runtime from engine logic. Time and the runtime are
passed in through the context objects that already exist, with defaults that keep today's behavior.

## Current state

- `Date.now()` and `performance.now()` are called directly at about 70 sites in 24 files. Only
  `src/lsp/catalog-refresh.ts` (`RefreshClock`), `src/lsp/completion.ts`, and `src/lsp/fixes.ts`
  accept a clock, each with its own shape.
- Expiry decisions therefore need real waiting in tests, for example catalog cache lifetimes, fix
  lifetimes, rule contribution lifetimes, and fact expiry in catalog rules.
- `getSharedCelRuntime()` is a module-level singleton. `src/lsp/editor.ts` calls it directly for
  selector evaluation instead of using a runtime that its owner supplies.
  `executePolicyRules` falls back to it when the caller passes no runtime.

## Target design

### Clock (`src/base/clock.ts`)

```ts
export interface Clock {
  /** Epoch milliseconds; comparable with contract deadlines. */
  wall(): number;
  /** Monotonic milliseconds; for measuring elapsed time. */
  monotonic(): number;
}
export const systemClock: Clock;
```

Thread an optional `clock` through the existing options or context object of each component, with
`systemClock` as the default. Do not add a module-level mutable clock and do not add a global
setter.

| Area                                   | Change                                                         |
| -------------------------------------- | -------------------------------------------------------------- |
| `runtime/request-budget.ts`            | Admission and expiry checks read the clock                     |
| `runtime/failure-evidence.ts`          | `FailureTimer` reads the clock                                 |
| `pipeline/*`                           | `validatePolicySources` options carry the clock to reference   |
|                                        | pinning, catalog fact expiry, and `createVerifiedPolicyResult` |
| `providers/catalog.ts`, `transport.ts` | Provider options carry the clock; cache lifetimes read it      |
| `capabilities/session.ts`              | Deadline checks and close budget read the clock                |
| `host/rule-contributions.ts`           | Lifetime checks read the clock                                 |
| `lsp/*`                                | One `Clock` replaces the three local shapes; `RefreshClock`    |
|                                        | extends `Clock` and keeps `random` and `schedule`              |
| `policy/releases.ts`, `cli/main.ts`    | Keep their explicit `now` parameters; the CLI passes one clock |

### Sites that keep real time

Some sites measure real elapsed CPU or supervise real timers. They keep direct calls and are named
in an allowlist with a one-line reason each:

- `src/base/clock.ts` (the implementation).
- `src/runtime/cel/pool.ts` (worker supervision with real timers).
- `src/parsing/budget.ts` and the yield loop in `src/compatibility/adapter.ts` (cooperative
  yielding by real elapsed time).
- `src/providers/async.ts`, only if its gate is tied to real `setTimeout` delays.

Real `setTimeout` timers stay real everywhere. A manual clock makes the **decisions** that read
time deterministic; it does not replace the scheduler.

### Lint rule

Add an ESLint rule (`no-restricted-properties` or `no-restricted-syntax`) for `src/**/*.ts` that
bans `Date.now` and `performance.now`, with file overrides for the allowlist above. The allowlist
has at most five files.

### CEL runtime

- `EditorService` receives a `CelRuntime` from its owner. The stdio composition root
  (`src/lsp/stdio.ts`) passes the shared runtime down through the existing resource path. Find the
  path that built-in validation already uses and follow it.
- Only these files may import `getSharedCelRuntime` or `closeSharedCelRuntime`: `src/index.ts`,
  `src/cli/main.ts`, `src/lsp/stdio.ts`, `src/runtime/cel/index.ts`, and the single pipeline module
  that provides the documented default for `executePolicyRules`. Add this as a rule in the import
  policy script.
- The public behavior of `executePolicyRules` and `validatePolicySources` without a `runtime`
  option does not change.

### Test helper

Add `test/harness/manual-clock.ts`: a `Clock` with `advance(ms)` and `set(wallMs)`; wall and
monotonic time advance together.

## Work order

1. Add `Clock`, `systemClock`, and the manual clock helper with tests.
2. Convert `runtime/` and `pipeline/`, then `providers/`, `capabilities/`, `host/`, and `lsp/`.
   Run the affected tests after each directory.
3. Inject the runtime into `EditorService` and add the importer rule.
4. Add the lint rule and resolve every violation.
5. Add the deterministic tests below.
6. Run the verification gate.

## Success criteria

1. `npm run lint` enforces the ban. `grep -rnE "Date\.now\(|performance\.now\(" src` matches only
   the allowlisted files.
2. No module-level mutable clock exists. The default is always `systemClock`, supplied at the
   parameter.
3. `src/lsp/editor.ts` and `src/lsp/editor/` do not import `getSharedCelRuntime`. The importer
   rule passes in `npm run architecture:check`.
4. The public API baseline changes only by additions: `Clock`, `systemClock`, and optional `clock`
   fields. List every addition in the report.
5. No existing test changes its assertions. Constructor or option updates in tests are allowed
   only where a signature changed, and each is listed in the report.
6. Every new deterministic test runs without `setTimeout`-based waiting.
7. The verification gate passes with zero skipped tests, and `npm test` wall time does not rise
   by more than 5%.

## Test cases

### New: `test/clock.test.ts`

1. `systemClock.wall()` tracks `Date.now()` and `monotonic()` never decreases.
2. The manual clock advances wall and monotonic time together; `set` moves wall time only forward
   or backward as documented; negative `advance` throws.

### New: `test/clock-injection.test.ts`

All cases use the manual clock and no waiting.

1. `RequestBudget`: a deadline more than the request ceiling ahead rejects with
   `deadline_out_of_range`; a deadline equal to now aborts with `request_timeout`; advancing past
   the deadline makes `interrupted` true and `throwIfInterrupted` throw.
2. `FailureTimer`: `elapsedMs` equals the advanced monotonic time; remaining time against a
   deadline is computed from wall time and bounded.
3. Catalog rule facts: `expiresAt` one millisecond in the future is available; equal to now is
   unavailable; in the past is unavailable.
4. Catalog provider cache: a present entry is served before its lifetime ends and refetched after;
   the same for an absent entry; an entry with `fetchedAt` in the future is rejected.
5. Reference preparation pins `pinnedAt` from the clock.
6. `createVerifiedPolicyResult` records `completedAt` from the clock.
7. Rule contributions: metadata expires exactly at the lifetime boundary.
8. Fix registry: a fix expires at its lifetime and at its data expiry, whichever is earlier.
9. Editor rule lifetime: `rulePreparationExpired` flips at the boundary; a backward wall-clock
   step does not extend the lifetime (the monotonic guard).
10. Capability session: admission and reply deadlines fire at the boundary.

### New: `test/editor-runtime-injection.test.ts`

1. An `EditorService` built with a stub runtime evaluates selectors through the stub.
2. During that test the shared runtime is never created (assert through the runtime statistics or
   by spying on the pool constructor in a child process).

### Extended: `test/architecture-boundaries.test.ts`

1. A file outside the allowlist that imports `getSharedCelRuntime` is rejected.
2. A type-only import of `CelRuntime` is accepted anywhere at or above `runtime`.

### Existing suites that must stay green

All. The most timing-sensitive are `cel-runtime.test.ts`, `catalog-provider.test.ts`,
`lsp-catalog-refresh.test.ts`, `lsp-session-resources.test.ts`, and `lsp-request-context.test.ts`.

## Risks

- **Two time sources in one decision.** A component that compares an injected wall time with a
  value produced by a real-time site would misbehave under a manual clock. Convert each decision as
  a unit and keep contract deadlines in wall time.
- **Worker boundary.** The CEL worker receives deadlines as numbers. Do not send a clock across the
  thread boundary.
- **Signature churn.** Prefer optional fields on existing option objects over new positional
  parameters.

## Out of scope

Rewriting existing timing tests to use the manual clock. List good candidates in the report.
