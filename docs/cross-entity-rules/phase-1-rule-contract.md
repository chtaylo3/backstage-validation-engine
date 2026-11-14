# Phase 1: Rule contract

Read [the plan overview](README.md) first.

## Goal

Let a policy declare binding trees on CEL rules, and reject at admission every declaration that
breaks a bound. This phase changes no evaluation: a rule with bindings is admitted and then
reports unsupported coverage until Phase 3.

## Current state

- The `cel` rule in `src/contracts/schemas.ts` has `expression` and the shared `ruleBase` fields.
  The rule union is closed, so an unknown property fails `parseContract('policy-bundle', …)`.
- `DeploymentProfileSchema.celProfileId` is the literal `bve-cel/1`. The profile, not the rule,
  names the CEL profile.
- `profile.referenceContexts` declares the reference paths. Array fields use a `*` segment, for
  example `/spec/providesApis/*`. The default profile in `src/policy/profile.ts` does not declare
  `/spec/dependsOn/*`; a deployment that binds it must declare it.
- `verifyPolicyRelease` in `src/policy/releases.ts` already rejects a `catalog` rule whose
  `referencePath` is not a declared reference context. `parseLspConfig` in `src/lsp/config.ts`
  parses the policy without that check.
- Rule digests are `digestJson(rule)`. A rule without the new fields keeps its digest.

## Target design

### Rule fields

Add two optional properties to the `cel` rule.

`bindings` is an object of 1 to 8 named bindings. A name matches `^[a-z][A-Za-z0-9]{0,31}$`. Each
binding has:

| Property   | Type            | Meaning                                                                      |
| ---------- | --------------- | ---------------------------------------------------------------------------- |
| `path`     | string          | A path that equals a `profile.referenceContexts` path                        |
| `one`      | boolean         | Optional. `true` binds one item or nothing instead of a list                 |
| `fields`   | array of string | 0 to 16 JSON Pointers into the target entity that the rule may read          |
| `bindings` | object          | Optional. Bindings that follow from each target entity; the same shape again |

`forEachReference` is one binding without a name: `path`, `fields`, and optional `bindings`. It
selects the per-reference mode. `one` is not allowed on it.

### Admission checks

Add `src/contracts/rule-bindings.ts` with a pure function that checks one rule against a profile
and returns the compiled tree. `verifyPolicyRelease`, `parseLspConfig`, and the rule executor all
call it, so the checks cannot differ between the CLI and the language server. It rejects with
`invalid_policy` when:

1. The tree is deeper than 3 hops, counting `forEachReference` as the first hop of its subtree.
2. The rule declares more than 8 bindings in total, counting `forEachReference`.
3. A `path` is not a declared reference context.
4. A `fields` pointer is not an escaped JSON Pointer, is longer than 512 characters, or starts
   with `/relations` or `/status`. The catalog backend derives those two properties, and a
   proposed local entity does not have them.
5. A first-hop `path` has no `catalog` rule with `check: 'exists'` and the same `referencePath`
   among the rule's transitive `requires`. This makes a missing first-hop target a reported
   finding of the existence rule, and the binding rule is blocked by the existing prerequisite
   step.
6. The profile's `celProfileId` is `bve-cel/1` and any rule declares `bindings` or
   `forEachReference`.

### CEL profile

Widen `celProfileId` to the union of `bve-cel/1` and `bve-cel/2`. `bve-cel/2` has the same
language, limits, and functions as `bve-cel/1`. It adds the variables `refs` and `target`, which
Phase 3 defines. A selector reads `entity` only, in both profiles.

### Profile limits

Add an optional `bindingLimits` object to the deployment profile with `hops`, `bindingsPerRule`,
`targetsPerBinding`, and `entitiesPerRule`. Each value is a positive integer at most equal to the
engine ceiling in the [bounds table](README.md#bounds). An absent property means the ceiling.
Export the ceilings as `BINDING_LIMITS` from `src/contracts/rule-bindings.ts`.

### Evaluation until Phase 3

`evaluateExpressionRule` in `src/pipeline/rules/expression-rule.ts` records a rule that declares
either field as `incomplete` with unsupported coverage. It must not evaluate the expression with
`entity` alone, because that can pass a rule whose bindings were never resolved.

## Work order

1. Add the schema properties and regenerate the schemas with `npm run schemas:generate`.
2. Add `rule-bindings.ts` and its unit tests.
3. Call the check from release verification, the language server configuration, and
   `prepareRuleRun`.
4. Add the unsupported-coverage guard in the expression evaluator.
5. Update the public API snapshot for `BINDING_LIMITS` and the new types only.
6. Update `docs/contracts.md` and `docs/policy-cli.md`.

## Success criteria

1. Both example rules in the [plan overview](README.md#motivating-example) pass
   `parseContract('policy-bundle', …)` and release verification with a `bve-cel/2` profile that
   declares the two reference contexts and the two existence rules.
2. Each of the six admission checks has a test that fails for exactly that reason.
3. `digestJson` of every rule in the existing fixtures is unchanged, and every existing signed
   release fixture still verifies.
4. A policy without the new fields produces byte-identical pipeline characterization output.
5. A rule with bindings yields unsupported coverage and exit code 2 from the CLI, never a pass.
6. `npm run schemas:check` passes, and the schema diff contains only the additions named here.

## Test cases

- **Depth.** Three nested hops are admitted; four are rejected.
- **Count.** Eight bindings are admitted; nine are rejected, with and without `forEachReference`.
- **Names.** `Deps`, `1deps`, an empty name, and a 33-character name are rejected.
- **Paths.** An undeclared path is rejected at the first hop and at a nested hop.
- **Fields.** `/relations/0/targetRef`, `/status`, a pointer with `~2`, and 17 pointers are
  rejected. An empty `fields` array is admitted.
- **Existence prerequisite.** A missing prerequisite, a prerequisite on another path, and a
  transitive prerequisite (admitted) each have a case.
- **Profile.** A `bve-cel/1` profile with a binding rule is rejected by the CLI and by
  `parseLspConfig`.
- **Limits.** A profile limit above the ceiling, a zero, and a non-integer are rejected. A lower
  limit is admitted and the check uses it.
- **Parity.** One table of invalid policies runs through `verifyPolicyRelease` and
  `parseLspConfig` and expects the same rejection from both.

## Exit criteria

The phase is complete, and Phase 2 may start, when all of these hold:

1. The [shared exit criteria](README.md#exit-criteria-for-every-phase) are met.
2. `npm run schemas:check` passes on the regenerated schemas.
3. The public API snapshot differs only by the additions that this plan names.
4. No code path evaluates a rule that declares bindings; the unsupported guard is in place and
   tested.
