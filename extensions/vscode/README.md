# Backstage Validation Engine

This extension validates Backstage catalog sources, completes field names, schema values and entity references,
and offers guarded schema repairs. Hover describes fields and their constraints.
Go to Definition opens a unique local entity target. Guarded fixes apply only when the source and document version still
match. This preview includes the engine, production dependencies, and Node 24 runtime. It needs no
global Node or npm installation.

Install the VSIX for your operating system and architecture from this repository's GitHub Actions
artifacts. A VSIX is an installable extension package. In User Settings, set
`backstageValidation.configPath` to an absolute path to a trusted launcher JSON file. Or launch VS
Code with `BVE_LSP_CONFIG` set to that path. Workspace and folder settings cannot select the
configuration. The extension runs only in trusted workspaces with local files.

The
[language server guide](https://github.com/chtaylo3/backstage-validation-engine/blob/master/docs/lsp.md)
describes the configuration format and development generators. Configuration supplies approved
sources, policy, profile, and activation artifacts. It can also name environment variables for
catalog credentials or an absolute credential-file path. The VSIX never stores credentials.
The server watches its fixed configuration and credential file and reloads changes without a restart.
You can also run Reload Trusted Configuration. Environment credentials belong to the launching process.

Use Backstage Validation: Restart Language Server, Stop Language Server, and Show Output from the
Command Palette. The extension synchronizes configured files as buffers. Its file watchers refresh
approved saved files. Diagnostics, reference completion, and policy quick fixes use standard VS Code
features. Each fix must pass the server's source and version checks.

Use Search Entity References to find workspace and catalog identities. Enter a prefix such as
`group:default/te`. Accepted selections rank future eligible suggestions through bounded local history.
For discovery configuration, schema suggestions, repair limits and JetBrains setup, see
[editor features](https://github.com/chtaylo3/backstage-validation-engine/blob/master/docs/editor-features.md).

If the server disconnects unexpectedly, validation stops. Correct the cause, then use Restart
Language Server to recover. This behavior prevents automatic crash loops. If cleanup fails, the
extension retains the client handle for another Stop or Restart command. If the SDK already cleaned
up a failed initialization, the extension can recover without an editor reload.

This preview covers the implemented native model and API pins and the declared reference and fix
inventory. It does not establish Marketplace publication, JetBrains integration, production policy
authority, or qualification against a real Backstage backend.
