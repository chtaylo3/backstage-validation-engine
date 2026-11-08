# Backstage Validation Engine

Validates Backstage catalog sources, completes declared entity references, and
offers guarded scalar policy fixes. This preview contains the engine, production
dependencies and Node 24 runtime. No global Node or npm installation is needed.

Install the VSIX for your operating system and architecture from this repository's
GitHub Actions artifacts. In **User Settings**, set `backstageValidation.configPath`
to an absolute trusted launcher JSON file. Alternatively launch VS Code with
`BVE_LSP_CONFIG` pointing to that file. Workspace/folder settings cannot select
the configuration. The extension runs only in trusted local-file workspaces.

The configuration format and development generators are documented in the
[language server guide](https://github.com/chtaylo3/backstage-validation-engine/blob/master/docs/lsp.md).
Configuration supplies approved sources, policy/profile/activation and optional
catalog credentials through named environment variables. Credentials are never
stored in the VSIX. Host configuration and credential changes require restart.

Use **Backstage Validation: Restart Language Server**, **Stop Language Server**
and **Show Output** from the Command Palette. Configured files synchronize as
buffers; approved saved files refresh through the language client's watchers.
Diagnostics, reference completion and policy quick fixes use standard VS Code
language features. A fix must still pass the server's source/version checks.

If the server disconnects unexpectedly, validation stays stopped. Use **Restart
Language Server** to recover after correcting the cause. This prevents automatic
crash loops. Failed cleanup retains the client handle for a subsequent Stop or
Restart; an initialization failure that the SDK has already reaped can recover
without reloading the editor.

Preview scope: the implemented native model/API pins and declared reference/fix
inventory. No Marketplace publication, JetBrains integration, production policy
authority or real Backstage backend qualification is implied by this package.
