# Contract examples

These JSON files demonstrate the production 0.2 wire format. Tests validate every
file against the emitted draft-07 resources and production semantic checks.
Authority references and receipts are synthetic documentation fixtures, not
credentials or verified authorization.

`validation-request.json` pins the adjacent source/data snapshots, policy bundle,
deployment profile, and activation manifest by content digest. The sample source
omits an owner. `result-rule-false.json` illustrates the corresponding violation;
the other results illustrate synthetic execution evidence and alternative
outcomes. They are not outputs from an implemented entity-validation engine.

| File                                | Expected outcome | Enforcement                     |
| ----------------------------------- | ---------------- | ------------------------------- |
| `result-passed.json`                | `completed`      | `allow`                         |
| `result-rule-false.json`            | `completed`      | `block`                         |
| `result-invalid-policy.json`        | `error`          | `block`                         |
| `result-unsupported-processor.json` | `incomplete`     | `block`                         |
| `result-catalog-unavailable.json`   | `incomplete`     | `block`                         |
| `result-timeout.json`               | `incomplete`     | `block`                         |
| `result-bypassed.json`              | `bypassed`       | `allow`, with emergency receipt |

Unsupported transformation blocks dependent stages and has no speculative
missing-owner finding. A bypassed result explicitly records unexecuted coverage.
The examples do not attest compatibility or authorize GitHub publication.
