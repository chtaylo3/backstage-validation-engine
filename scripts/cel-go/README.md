# Independent CEL comparison

This test-only program uses CEL-Go `v0.26.1`, commit `8e7beb65e9a70f501fd743c3b70b2a0a2fadac52`.
The module graph and checksums are pinned in `go.mod` and `go.sum`.
`LICENSE.upstream` retains the CEL-Go Apache-2.0 license.
The Go source in this directory uses the repository Apache-2.0 license.

CI downloads Go `1.26.11` for Linux amd64 from the official Go distribution.
The archive SHA-256 is `9849f4e04ee35303714e34fbc3ac8ab44ea3e448a95aa182f91e3b9b79c710ec`.
The runner checks the actual toolchain and CEL-Go versions.
The [Go archive index](https://go.dev/dl/) supplies the archive and its digest.
Go uses its BSD license, retained inside the downloaded toolchain.
Normal source tests need no Go executable or network connection.

Run `npm run test:cel-go` with the pinned `go` executable in `PATH`.
`GO_BINARY` can select that executable explicitly.
The runner writes `.artifacts/cel-comparison/report.json`.
An optional path argument to `scripts/compare-cel-go.mjs` selects another report destination.

Go's JSON decoder maps entity numbers to `float64`. CEL-Go maps those values to CEL doubles.
The comparator preserves every original expression. It does not generate expected answers.
The original 43-case corpus remains byte-for-byte frozen.
The versioned sidecar supplies 18 authored additions, exact BVE error codes, and fixed Go error stages.
An independent stage can be `parse`, `check`, `evaluation`, or `result_type`.
These stages describe different implementations of the reviewed failure contract.
The runner admits no unspecified error as a match.

One reviewed difference remains explicit: CEL-Go permits `timestamp(...).getFullYear()`.
BVE excludes the receiver method through its existing allowlist and returns `profile`.
The sidecar retains Go's `true` and BVE's `profile` separately.
The parent approved that disposition on 2026-11-11.
The parent also approved heterogeneous literal support before the worker configuration correction.
No timestamp-method parity or full CEL conformance is claimed.

`result_type` applies BVE's boolean-result admission rule to a successful Go value.
Go accepts `1 + 1` and returns integer `2`. The report retains that raw type and value.
The comparator does not describe this adapter verdict as a Go language error.
The CEL-Go license SHA-256 is `4cdb9af102dfbb0ca03d87d6f650a505df098646a4080f4665b389ad9c6caa02`.
The downloaded Go license SHA-256 is `911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad`.
The Go archive retains its BSD license and third-party notices.
