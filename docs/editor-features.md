# Editor features

The language server supplies field and value completion, hover, local definitions, and guarded schema and declared rule repairs.
VS Code also supplies catalog search and persistent selection history.
Trusted launcher configuration selects schemas, policy authority, sources, and credentials.

The [rule and editor capability plan](plugin-capabilities-plan.md) specifies CEL, RE2, and plugin requirements.
It defines the interfaces and conformance requirements for each function.
Built-in providers now use the versioned [capability interfaces](capability-interfaces.md). Arbitrary executable plugin loading remains unavailable.
The [five-phase editor plan](lsp-editor-improvements-plan.md) defines implementation order and acceptance criteria.
Phase 2 implements capability interfaces and adapts built-in providers. Its qualification and parent acceptance appear in the [phase record](lsp-editor-improvements-implementation-record.md).
Phase 3 adds live catalog refresh. Phase 4 implements [declared CEL/RE2 contributions](rule-editor-contributions.md), with qualification and acceptance recorded separately.

## Completion and documentation

Field suggestions use the selected kind and exact native adapter version.
Required fields rank first. Existing fields do not appear as new insertions.
YAML insertions preserve indentation. JSON insertions include quoted keys and separators.
Object fields can insert a bounded structure with required children. Empty strings are placeholders for the author to complete.

Values come from `const`, `enum`, defaults, examples, and boolean or null types.
Each item identifies whether it is required, allowed, a default, or an example.
Defaults never change a document without an explicit selection.
Known type, length, range, pattern, and allowed-value constraints filter candidates.
Patterns use bounded RE2 matching.
Custom kinds require the exact kind, API version, and artifact pin.
Schema policies contribute according to their selectors and validated prerequisites.
Bundled references resolve locally. Conditional branches contribute hints when the editor can identify the branch.
This authoring aid does not solve every draft-07 composition. Validation remains authoritative.

Partial keys, empty values, and recoverable unfinished documents retain suggestions.
Recovery trees never become validation subjects. Syntax diagnostics remain visible until repair.
Aliases, anchored or tagged nodes, block scalar edits, ambiguous mappings, and opaque text payloads do not receive speculative edits.
Prepared metadata obeys resource limits, generations, versions, content checks, and the original request deadline.
Completion requests do not parse files or read disk.
Qualified structured includes use the parent schema and actual payload ranges. Different parent contexts sharing one payload disable schema edits there.

Hover displays descriptions, types, known constraints, and schema or policy sources as plain text.
Go to Definition resolves declared references to one local entity. Kind and namespace defaults follow the configured reference context.
Ambiguous local definitions produce no target.

## Repairs and search

Schema failures can offer explicit value choices. Required fields can offer a schema value or a labeled placeholder.
Placeholders need completion and do not claim that validation will pass.
Repairs preserve comments and use the existing guarded command path.
The server rechecks the workspace generation, source contents, versions, expiry, and edit limits before dispatch.
Repairs affect one open document. Standard client-edit limitations after dispatch still apply.

In VS Code, run `Backstage Validation: Search Entity References` and enter a prefix such as `group:default/te`.
The server returns workspace results before fresh catalog results. VS Code can reorder filtered picker rows.
Remote search requires two name characters.
Search retains the existing trusted connection, authorization, freshness, cancellation, limits, and local identity masks.
Selection replaces the captured editor selection if the document still matches.
With no editor, selection copies the reference. A changed document receives no insertion.

Accepted selections rank future eligible values. History cannot add an ineligible value or bypass visibility checks.
VS Code stores at most 128 selections locally, scoped to the workspace, trusted configuration, and authority context.
Other clients use the server's bounded session history.

Catalog dependencies now refresh while an approved document remains unchanged.
Adding, removing, renaming, or modifying a team triggers fresh evaluation at the existing document version.
Polling targets 30 seconds. Earlier observation expiry or `catalog.maxAgeMs` shortens this interval.
A 250 ms scheduling floor bounds short intervals. `maxAgeMs: 0` bypasses caches and retains the default observation cadence.
Each tick invalidates remote choices and repair tokens before a new validation request reads the catalog.
That request retains one original budget for body reads, recent identity queries, and evaluation.

Completion and search receive refreshed choices on the next matching client request.
The server does not replace a standard completion popup or an already open VS Code search picker automatically.
It tracks up to 1000 actual body or missing-reference dependencies and 32 recent query scopes.
Query interest expires after two minutes without user requests. Background reads do not extend that interest.
Identity searches never substitute for full entity observations.
Local sources, conflicts, invalid replacements, and deletion masks retain precedence.

Explicit denied reads and remote failures retain unavailable or incomplete findings.
An authorized-view missing result cannot distinguish global deletion from permission-filtered absence when the backend returns the same response.
Permission or credential revision changes replace the entire approved session and its caches.
Polling uses bounded failure backoff. No Backstage event stream is assumed or implemented.
The [phase record](lsp-editor-improvements-implementation-record.md) separates local qualification from parent acceptance.

## File discovery

Exact approval remains the default. To discover files, add trusted roots and patterns:

```json
{
  "filesystem": {
    "files": ["file:///workspace/catalog-info.yaml"],
    "entrypoints": ["file:///workspace/catalog-info.yaml"],
    "discovery": {
      "roots": ["file:///workspace/services/"],
      "include": ["**/catalog-info.yaml", "**/catalog-info.yml"],
      "exclude": ["**/fixtures/**"]
    }
  }
}
```

This fragment belongs in an otherwise valid launcher configuration.
Roots must stay under the pinned source root. Paths and patterns cannot escape it.
Discovery examines at most 10,000 entries, 32 directory levels, and 1,000 selected files.
Dependency, Git, build, and test-output directories are excluded.
Discovery does not follow symbolic links. Reads retain containment, regular-file, UTF-8, mutation, and byte checks.
Discovered files become entrypoints. Explicit payload files retain their existing treatment.
Save and watcher events capture additions, changes, and deletions. Open buffers take precedence.
VS Code synchronizes text files under the filesystem root. The server accepts only approved files.
Changing the root, filesystem mode, or a snapshot-only source inventory requires a client reconnect.
Reload fails closed for those scope changes.

## Configuration and credentials

The stdio host watches its fixed configuration path and optional credential file.
It reloads changes without replacing the server process.
VS Code also provides `Backstage Validation: Reload Trusted Configuration`.
Requests cannot select another path. Reload rebuilds catalog resources and discards old caches and suggestions.
Open buffers remain under the new approved scope. Invalid configuration stops validation and suggestions until repaired.

The trusted `catalog` object accepts exactly one of `tokenEnv` or `tokenFile`.
For file credentials, set `tokenFile` to an absolute path.
The file must contain one UTF-8 token with an optional trailing newline and be a regular file of at most 16 KiB.
The provider reads it for each credential request. The watcher rebuilds resources after rotation to discard caches.
Environment credentials remain supported. Changing another process's environment does not change a running server's environment.

The credential reader checks the path entry and opened handle before it admits token bytes.
It rejects a symbolic link and a replacement during capture. Atomic replacement between requests remains supported.
The path-entry check also applies on systems without `O_NOFOLLOW`.
Node documents that flag as unavailable on Windows in its [file open constants](https://nodejs.org/docs/latest-v24.x/api/fs.html#file-open-constants).
Platform qualification records whether the actual symbolic-link control ran or the operating system denied link creation.

Approved local schemas and policy artifacts remain usable without catalog access.
Remote failures retain local suggestions and existing incomplete results for required catalog checks.

## JetBrains setup

Generate an importable [LSP4IJ custom template](https://github.com/redhat-developer/lsp4ij/blob/main/docs/UserDefinedLanguageServerTemplate.md):

```sh
npm run jetbrains:template -- /absolute/host.json /tmp/bve-jetbrains
```

Install LSP4IJ in the JetBrains editor. Add a user-defined language server and select `Import from custom template`.
Select the generated directory. Enable it only for the project covered by the trusted configuration.
The template uses absolute Node, server, and configuration paths. It does not install packages or invoke a shell.
Shared features depend on the client's declared capabilities. The search picker and persistent history are VS Code features.

Template generation and shared LSP behavior have automated tests.
Installed JetBrains products, plugin versions, and operating systems still need interactive qualification.
Marketplace publication and exact-candidate release qualification remain separate release actions.
The user deferred JetBrains qualification, native Trust automation improvements, and longer release workloads to phase 5.

## Completed native VS Code qualification

The ownership refactor completed phases 0 through 9 and merged in PR #2.
Its tested head passed 989 source tests, 989 packaged tests, and 88 installed cases on each native operating system.
Quick qualification also passed 36 desktop cases and 12 real SSH, dev-container, and Windows WSL2 sessions.
The [separation record](lsp-separation-implementation-record.md#hosted-qualification-and-merge) supplies the exact revision, digests, run links, and retained macOS rerun evidence.
These results do not complete the deferred release work above.

## H5 installed observation scope

The focused installed matrix tests configuration faults, native watcher handling, explicit reload, search completion, discovery, credential rotation, and diagnostic severity.
The host observation flag remains disabled by default. Its bounded filesystem projection supports ordered watcher observations without exposing file contents or credentials.
The [LSP guide](lsp.md#host-observation-of-admitted-filesystem-events) defines that projection and its limits.

Native search tests cover selected text, cancellation, stale selection, and clipboard fallback with no active editor.
A fresh extension-host activation tests persisted selection history through actual completion ranking between two eligible references.
Server search results carry their own ordering. VS Code can reorder filtered QuickPick rows independently.
The focused evidence does not qualify native QuickPick display order as persisted history ranking.
Long workloads, abrupt transport loss, native Workspace Trust activation reliability, and JetBrains qualification remain deferred.
