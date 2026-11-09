# Contract examples

These JSON files show the production 0.2 wire format, the data exchanged between components. Tests
compare every file with the generated draft-07 schemas and production semantic checks. Authority
references and receipts are synthetic examples. They are not credentials or verified authorization.

`validation-request.json` pins the adjacent source and data snapshots, policy bundle, deployment
profile, and activation manifest by content digest. The sample source omits an owner.
`result-rule-false.json` shows the corresponding violation. The other results show synthetic
execution evidence and alternative outcomes. They are illustrative results, not captured engine
output.

| File                                | Expected outcome | Enforcement                     |
| ----------------------------------- | ---------------- | ------------------------------- |
| `result-passed.json`                | `completed`      | `allow`                         |
| `result-rule-false.json`            | `completed`      | `block`                         |
| `result-invalid-policy.json`        | `error`          | `block`                         |
| `result-unsupported-processor.json` | `incomplete`     | `block`                         |
| `result-catalog-unavailable.json`   | `incomplete`     | `block`                         |
| `result-timeout.json`               | `incomplete`     | `block`                         |
| `result-bypassed.json`              | `bypassed`       | `allow`, with emergency receipt |

If a required transformation is unsupported, dependent stages stop without a speculative
missing-owner finding. A bypassed result records which work did not run. The examples do not prove
compatibility or authorize GitHub publication.

`schema-artifact.json` supplies a pinned draft-07 Widget schema. The runnable
`npm run example:custom` example admits that kind and runs native normalization, custom validation,
and CEL policy. With `-- --invalid`, it produces a completed schema violation and exit 1. Schema
artifacts come from trusted launcher or context input. Entity content cannot replace their profile
pins.
