# Phase 3: Plugin suggestions

Read [the plan overview](README.md) first. This plan uses the plugin workers from Phase 2.

## Goal

Let a compiled plugin supply value suggestions for a field in the editor, as advisory candidates
that pass the existing admission and never delay typing.

## Current state

- The `values` capability (`ValueSuggestionProvider`) returns at most 100 typed candidates with
  provenance and a classification. `CapabilitySession` admits every reply and checks it against
  the request.
- `EditorService` reads prepared metadata. Completion and hover do not parse sources, run CEL, or
  call a provider that can block.
- Editor artifacts in the trusted launcher configuration approve hints per rule and path. Their
  contribution names a `languageProfile`.
- Rule contributions are prepared after validation, with the validation's original deadline, and
  are discarded on source edits, reloads, and dependency generations.

## Target design

### Plugin interface

A plugin's `suggestions` maps a name to an asynchronous function. Its input has the normalized
`entity`, the target `path`, the typed `prefix`, the optional `refs` of a declared binding tree,
the brokered `catalog`, and `signal`. It returns at most 100 candidates. A candidate has a JSON
scalar `value`, an optional `label` of 128 characters at most, and a `classification` of
`suggestion`, `example`, or `default`.

### Opt-in

Extend the editor artifact contribution with the language profile `bve-plugin/1` and the property
`pluginSuggestions: { plugin, name }`, where `plugin` is `{ id, version, digest }`. Admission
rejects a contribution whose plugin the registry does not contain with the same digest. The
contribution keeps `kind`, `apiVersion`, `subjectStage`, `path`, and `description`. `choices`,
`examples`, and `defaultValue` are not allowed with it.

### Preparation

After each validation generation, for each open document and each approved contribution whose
kind and API version match a qualified subject, the host calls the plugin once with an empty
prefix, in the plugin workers, with the validation's original deadline. It admits the reply
through the `values` capability admission and stores the candidates as prepared metadata for
that subject and path. At most 16 plugin suggestion calls run per generation, one after another.

Completion filters the prepared candidates by the typed prefix. It does not call the plugin.

### Presentation and limits

- A plugin candidate has the detail `Plugin PLUGIN_ID`, where `PLUGIN_ID` is the plugin's
  identifier. It carries no claim that a rule accepts it.
- Plugin candidates rank after workspace and schema candidates of the same classification.
- A failed, late, or rejected plugin call leaves the field with its other suggestions.
- Prepared candidates are discarded on the events that discard rule contributions, and after 30
  seconds.

## Work order

1. Extend the plugin definition and the worker protocol with `suggestions`.
2. Extend the editor artifact schema and admission. Regenerate the schemas.
3. Add preparation and storage in the editor state.
4. Apply the candidates in completion.
5. Add stdio tests and update `docs/editor-features.md` and `docs/rule-editor-contributions.md`.

## Success criteria

1. A fixture plugin's candidates appear in completion at the approved path, with the plugin
   detail, filtered by the typed prefix.
2. Completion at that path makes no plugin call; a test with a plugin that never answers still
   returns the other suggestions within the existing completion wait.
3. Without an approved contribution, the plugin's `suggestions` function is never called.
4. A reply that fails `values` admission produces no candidate and no diagnostic.
5. Diagnostics are published before preparation starts, and are identical with and without the
   plugin.

## Test cases

- **Candidates.** String, number, boolean, and null values; quoting follows the existing value
  rendering for YAML and JSON.
- **Limits.** 100 candidates admitted; 101 reject the reply; a 129-character label rejects it.
- **Budget.** The 17th contribution of a generation is not prepared.
- **Failure.** Throwing, looping, and crashing plugins; other suggestions remain.
- **Invalidation.** A source edit, a reload, a dependency generation, and 30 seconds on the
  injected clock each discard the candidates.
- **Approval.** Unknown plugin, wrong digest, and a contribution that also declares `choices`
  are rejected at configuration admission.
- **Bindings.** A suggestion function receives the subject's resolved `refs`.

## Exit criteria

The phase is complete, and Phase 4 may start, when all of these hold:

1. The [shared exit criteria](README.md#exit-criteria-for-every-phase) are met.
2. The client coverage thresholds hold without change.
3. The report records the completion response time with a plugin that never answers.
