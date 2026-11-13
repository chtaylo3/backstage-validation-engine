# Required deployment processing

BC-07 blocks dependent validation when a required processor is unavailable. The executable
deployment-processor inventory is empty (`SUPPORTED_DEPLOYMENT_PROCESSORS`). Declared processor IDs
and stage labels are metadata. The engine never treats them as module paths, commands, or network
endpoints. Future integrations need versioned approval, ordering rules, transformation history, and
acceptance evidence.

Any `profile.requiredProcessors` declaration blocks dependent work before source parsing,
substitution, native/custom validation, admission, overlay qualification, catalog collection or
policy execution. Unknown stage labels also block dependent work. They cannot select a permissive
path. Profiles allow at most 64 declarations with bounded IDs/stages and reject duplicate ID/stage
pairs. Configuration and pinned-context integrity checks still run.

Coverage records each unavailable processor as unsupported and downstream stages as blocked.
Available source files receive fixed dependency findings at their start. IDE severity is warning,
and CI enforcement is blocking. Missing owners, malformed YAML, schema/admission errors and catalog
absence are not evaluated speculatively.

Empty sources and empty policies retain blocked required coverage. Requests aggregate as
incomplete/exit 2. Cancellation and the original deadline remain explicit interruptions.

`executePolicyRules` applies the same gate to caller-supplied normalized subjects, before selectors
or CEL workers. All rules receive blocked states, including optional rules and rules with false
selectors. No selected rule is treated as verified empty work. `validatePolicySources`,
source/baseline preparation and the stdio LSP propagate this evidence without starting catalog
requests.

The [processor acceptance tests](../test/engine/backstage-processors.test.ts) exercise both model pins,
declared/unknown stages, empty input, rules-only execution, redaction, cancellation and both fake
API contracts. [Stdio tests](../test/lsp/lsp.test.ts) verify versioned dependency warnings and no
speculative parsing/HTTP. These tests complete the declared BC-07 blocking requirements. Executable
deployment integrations and real organization inventories remain separate integration work.

Local qualification on 2026-11-05: 21 processor checks and three added LSP checks passed. The full
`npm run check` passed all 617 tests and the required type/lint/format/schema/build checks with
loopback access.
