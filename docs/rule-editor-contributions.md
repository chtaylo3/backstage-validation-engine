# CEL and RE2 editor contributions

An editor artifact declares finite hints for an approved policy rule.
The trusted launcher supplies these artifacts in optional `editorArtifacts` configuration.
Existing launcher files do not need this property.
The policy contract remains `0.2`. Editor artifacts use the separate `bve-editor/1` format.

The host admits each artifact before a session starts.
Its digest covers the declaration, policy digest, and profile digest.
Each contribution also pins its rule digest, language profile, entity kind, API version, normalized stage, and JSON Pointer.
An authored entity cannot select an artifact, module, endpoint, credential, or execution profile.
Unknown properties, mismatched pins, duplicate identities, and oversized declarations fail configuration admission.

## Declaration format

The generated [artifact schema](../schemas/editor-artifact.schema.json) defines the public format.
The following example builds an artifact from an existing trusted configuration.
The selected rule must exist in `config.policy.rules`.
Its expression can use `entity.spec.owner.matches("^remote-")` and require an existing catalog rule.

```js
import { digestJson } from '@chtaylo3/backstage-validation-engine';

const rule = config.policy.rules.find((rule) => rule.id === 'owner-pattern');
const contents = {
  artifactVersion: 'bve-editor/1',
  id: 'organization/owner-hints',
  policyDigest: digestJson(config.policy),
  profileDigest: digestJson(config.profile),
  contributions: [
    {
      ruleId: rule.id,
      ruleDigest: digestJson(rule),
      languageProfile: 'bve-cel/1',
      subjectStage: 'normalized',
      kind: 'Component',
      apiVersion: 'backstage.io/v1alpha1',
      path: '/spec/owner',
      description: 'Approved remote team examples.',
      choices: ['remote-team', 'remote-platform'],
      examples: ['remote-example'],
      defaultValue: 'remote-team',
      repairs: true,
    },
  ],
};
config.editorArtifacts = [{ ...contents, digest: digestJson(contents) }];
```

For a schema rule, use `draft-07/re2js@2.9.0/schema-v1` as the language profile.
The schema artifact remains pinned by the schema rule itself.
CEL uses the existing boolean `bve-cel/1` profile.
RE2 operates through schema patterns and CEL `matches`. There is no standalone RE2 rule kind.

The optional `choices`, `examples`, and `defaultValue` properties accept JSON scalars.
They declare candidates, not an exhaustive set of allowed values.
Descriptions use plain text, including text that resembles HTML or Markdown.
Set `repairs` to `false` to supply hints without offering a repair command.

## Capabilities and ownership

| Function              | Provider requirement                                                             | Host requirement                                                                                 |
| --------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Field names           | An admitted declaration and an applicable rule on a qualified normalized subject | Map the pointer into the current authored document                                               |
| Value hints           | Finite declared scalars that pass candidate evaluation                           | Rank and quote prepared values through the `values` capability                                   |
| Hover                 | An admitted description with established applicability                           | Render plain text through `hover`                                                                |
| Repairs               | An enabled declaration, a currently failed target rule, and a passing candidate  | Admit `repairs` proposals, match host evidence, render one document, and issue a guarded command |
| Navigation and search | Existing reference contexts and search providers                                 | Preserve existing reference parsing, local resolution, and authority                             |

The built-in metadata adapter supplies the phase 2 capability records.
Its dependency manifest includes the approved editor artifact identities.
The `fields`, `values`, `hover`, and `repairs` calls pass the existing runtime admission boundary.
The host retains candidate evidence and matches a logical repair against that evidence.
A provider label cannot grant acceptance or edit authority.

Field insertions contain advisory placeholders until the user chooses a checked candidate or an explicit repair.
Existing native and schema hints keep their previous advisory labels.
They do not acquire CEL acceptance from a different candidate with the same field path.
Rule hints identify the checked rule and the number of remaining findings.

## Applicability and candidate checks

Required validation runs first and publishes its diagnostics before candidate work starts.
The editor uses the actual report's rule states and qualified normalized entities.
Only `passed` and `failed` states establish applicability.
Failed, blocked, unavailable, unknown, erroneous, and inapplicable prerequisites suppress the corresponding rule contribution.
They do not suppress required validation or its incomplete coverage.

The host renders each finite candidate into a hypothetical source snapshot.
It runs `validatePolicySources` again with the same policy, profile, original deadline, baseline, and authorized catalog context.
This repeats source qualification, normalization, selectors, prerequisite rules, reference collection, and dependent rules.
A new reference collects its own authorized facts with cache bypass.
The current reference's observation cannot prove the candidate reference exists.

The target rule must report `passed` for the candidate.
A selector change that produces `not_applicable` does not meet this requirement.
Required coverage must remain verified, and the candidate cannot introduce a new finding or execution failure.
Existing unrelated findings can remain. Their presence prevents a claim of complete policy compliance.

Host evidence records original and hypothetical source digests, original and candidate data digests, policy/profile digests, authority context, and dependency generation.
It also records the actual checked rule states, coverage, remaining findings, and expiry.
The session and request owners enforce activation, session generation, document lifetime, source versions, and the original deadline.
Those ownership checks remain necessary even when digests match.

CEL execution, including `matches`, retains the existing supervised workers and matching profile.
Schema RE2 patterns retain the existing bounded schema validator and their separate matching profile.
CEL `matches` uses substring matching. A whole-value match requires explicit anchors.
The CEL pattern limit remains 512 UTF-16 code units. The schema pattern limit remains 1024.
Unsupported syntax fails through the declared engine. There is no JavaScript regular expression fallback.
Predicates do not enumerate values, and the editor does not infer a unique repair from a pattern.

## Bounds and invalidation

| Resource                                      | Bound                                                        |
| --------------------------------------------- | ------------------------------------------------------------ |
| Approved artifacts per launcher configuration | 16                                                           |
| Declarations per artifact                     | 32                                                           |
| Choices and examples per declaration          | 16 each                                                      |
| Declaration visits per preparation            | 1024                                                         |
| Prepared contributions per generation         | 64                                                           |
| Candidate pipeline evaluations per generation | 16, sequential                                               |
| Supervised CEL workers per process            | 2 shared slots                                               |
| Outstanding CEL jobs per process              | 64 shared jobs                                               |
| Candidate proof lifetime                      | At most 30 seconds and actual original/candidate fact expiry |
| Catalog dependency inventory                  | 1000 total distinct source and candidate references          |

Preparation retains the original validation deadline and cancellation signal.
It yields between declaration batches. It creates no interpreter pool per document.
Completion and hover read prepared metadata. They do not parse sources or execute CEL.
Queue pressure or candidate failure leaves required diagnostics intact.
When a bound is reached, later optional candidates remain absent.

Candidate catalog reads add separate refresh interest without replacing the authoritative source inventory.
Candidate-only additions, removals, or changes therefore trigger preparation again without source edits.
Catalog failures cannot replace a successful source inventory.
Recoverable candidate failures retain interest and use the bounded outage backoff.
An unavailable response's short TTL does not become a successful claim expiry.
Actual successful source or candidate fact expiry still caps that backoff.
Explicit authority denial revokes offered claims, and successful recovery rearms that revocation.
Backstage can represent a permission-filtered entity as missing in the approved view.
The editor does not claim that this proves global deletion.

Proof expiry includes each fact's provider expiry and its approved positive freshness bound.
Zero maximum age means cache bypass. It uses the existing positive 30-second refresh bound rather than a zero lifetime.
Early source repair tokens use the same conservative freshness rule while optional work remains active.
Wall-clock rollback and elapsed monotonic time cannot extend an installed rule contribution's lifetime.

Source edits, close/reopen, policy/profile reload, credential changes, dependency generations, and session retirement invalidate the owning metadata and repair state.
Protocol admission also checks freshness before edit dispatch.
The existing client acknowledgement rule still applies after an edit dispatch begins.
An obsolete background reply cannot install metadata into a replacement generation.

## Supported edits and limits

Repairs support one scalar replacement or one property insertion into an unambiguous authored map.
The host retains JSON/YAML quoting, comments, CRLF, and UTF-16 ranges.
Structured includes retain the actual payload file and range.
Aliased scalar targets, ambiguous include mappings, unsupported operations, and multi-file edits do not produce repairs.
The target must be open. The editor does not edit a closed file or create a resource.

The user must select a repair explicitly.
`FixRegistry` issues opaque, single-use commands with document versions, digests, generation, and expiry guards.
Client rejection consumes the selected token. A later selection can obtain a new current token.
Successful edits pass through the normal document-change validation path.

The [implementation record](lsp-editor-improvements-implementation-record.md) identifies executed qualification and its exact candidate.
Phase 5 remains deferred. This feature does not add JetBrains qualification, a Trust automation redesign, long release workloads, or publication.
