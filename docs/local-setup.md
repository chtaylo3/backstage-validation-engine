# Test Backstage with a locally installed VS Code extension

This guide starts a Docker Backstage application and connects your VS Code extension through WSL Ubuntu.
It uses the tested Linux extension package and the local setup helper in this checkout.
These steps start a manual test session. They do not run the full release suite.

A VSIX is an installable VS Code extension package.
The helper creates a test file and trusted configuration without printing the catalog token.
The token is the credential that permits catalog reads.

The following files must exist before you start:

- `.artifacts/manual-vscode/prepare.mjs`
- `.artifacts/vscode/backstage-validation-engine-0.1.0-linux-x64.vsix`
- `test/integration/backstage/README.md`

The helper and extension package are local files under the Git-ignored `.artifacts` directory.
They already exist in this checkout. A fresh clone does not include them.
Use the active checkout at `/home/developer/code/backstage-validation-engine`.

## 1. Open Ubuntu in Windows Terminal

Use a terminal outside VS Code. Start Docker Desktop.
In the Ubuntu terminal, run:

```sh
cd /home/developer/code/backstage-validation-engine
source "$HOME/.nvm/nvm.sh"
nvm use
docker info --format '{{.OSType}} / {{.Architecture}}'
npm run build
```

Make sure that Docker reports Linux containers.
Make sure that Node reports version `24.22.1`.
Keep this terminal open for the later environment commands.

## 2. Start the Docker Backstage application

From the repository root in the Ubuntu terminal, run:

```sh
npm run backstage:test:up -- --target=1.56.3 --run=manual-vscode-demo
npm run backstage:test:status -- --run=manual-vscode-demo
```

Wait for the commands to finish.
The runner builds the images, loads the sample data, and waits for authenticated catalog reads.
The output includes `publicUrl`, such as `http://localhost:49123`.
You can open that address in your browser.
Use the printed port because Docker assigns a port for this run.

## 3. Prepare the local editor configuration

From the same Ubuntu terminal, run:

```sh
node .artifacts/manual-vscode/prepare.mjs \
  --run=manual-vscode-demo \
  --install-wsl-env
```

The helper creates these files:

```text
.artifacts/manual-vscode/workspace/catalog.yaml
.artifacts/manual-vscode/private/launcher.json
.artifacts/manual-vscode/private/environment.sh
```

The launcher configuration names the approved source file, test policy, schemas, and catalog connection.
It uses the application's published localhost address.
The private environment file supplies the catalog token.
Do not copy the token into workspace settings or a catalog document.

The helper also adds a marked block to `~/.vscode-server/server-env-setup`.
If that file already exists, the helper backs it up first.
The block supplies the token when the WSL VS Code server starts.
Microsoft documents this [environment setup mechanism](https://code.visualstudio.com/docs/remote/wsl#_advanced-environment-setup-script).

## 4. Restart the WSL VS Code server

Save your work. Close all VS Code windows connected to Ubuntu.
In the separate Ubuntu terminal, run:

```sh
pkill -u "$(id -u)" -f '[.]vscode-server/.*out/server-main[.]js' || true
```

This command stops your stable VS Code server in WSL if it is running.
It does not shut down Ubuntu or Docker.
Open the prepared folder:

```sh
code /home/developer/code/backstage-validation-engine/.artifacts/manual-vscode/workspace
```

Make sure that the new window shows `WSL: Ubuntu`.
If VS Code asks about workspace trust, trust this test folder.
The extension requires a trusted workspace.

## 5. Install the tested Linux extension

In that VS Code window, select Terminal > New Terminal.
Run this command in the integrated WSL terminal:

```sh
code --install-extension \
  /home/developer/code/backstage-validation-engine/.artifacts/vscode/backstage-validation-engine-0.1.0-linux-x64.vsix \
  --force
```

Open Extensions with `Ctrl+Shift+X`.
Make sure that Backstage Validation Engine appears under the WSL installation category.
Microsoft explains the [local and WSL extension categories](https://code.visualstudio.com/docs/remote/wsl#_managing-extensions).

In the integrated terminal, run this command without printing the token:

```sh
test -n "$BVE_MANUAL_CATALOG_TOKEN" && echo "Catalog token is available"
```

If there is no confirmation, repeat step 4 before you continue.
The token must reach the WSL extension process.
Exporting a token only in an integrated terminal does not configure an existing extension process.

## 6. Select the trusted configuration

Press `Ctrl+Shift+P`.
Run `Preferences: Open User Settings (JSON)`.
Add this property to the existing JSON object:

```json
{
  "backstageValidation.configPath": "/home/developer/code/backstage-validation-engine/.artifacts/manual-vscode/private/launcher.json"
}
```

Keep your other settings. Add a comma between properties where JSON requires one.
Do not put this property in workspace settings.
Run `Backstage Validation: Restart Language Server` from the Command Palette.

## 7. Test diagnostics and a quick fix

Open `catalog.yaml` in the prepared workspace.
The helper creates this initial document:

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: manual-proposal
  namespace: bve-demo
spec:
  type: service
  lifecycle: experimental
  owner: group:bve-demo/team-demo
```

Open the Problems panel with `Ctrl+Shift+M`.
Expect a `production-only` policy error.
Place the cursor on `experimental`.
Press `Ctrl+.`.
Select the offered fix that changes the value to `production`.
Make sure that the error clears.

The helper preserves an existing `catalog.yaml` when you run it again.
If you repeat this test, change the lifecycle to `experimental` first.

## 8. Test catalog completion and missing references

Change the owner line to:

```yaml
owner: group:bve-demo/te
```

Keep this line indented under `spec` in the complete document.
Place the cursor after `te`.
Press `Ctrl+Space`.
Expect a suggestion for:

```text
group:bve-demo/team-demo
```

Select the suggestion.
Then change the owner to:

```yaml
owner: group:bve-demo/team-next
```

Keep this line indented under `spec`.
Expect an `owner-exists` error because the baseline catalog does not contain that group.

## 9. Change the real catalog and observe the result

Keep `group:bve-demo/team-next` as the owner in VS Code.
In the external Ubuntu terminal, run:

```sh
cd /home/developer/code/backstage-validation-engine

npm run backstage:test:seed -- \
  --run=manual-vscode-demo \
  --data=test/integration/backstage/data/mutation.json
```

Wait for the command to finish.
In VS Code, run `Backstage Validation: Restart Language Server`.
Make sure that the `owner-exists` error for `team-next` clears.

Restore the baseline from the Ubuntu terminal:

```sh
npm run backstage:test:seed -- \
  --run=manual-vscode-demo \
  --data=test/integration/backstage/data/baseline.json
```

Wait for the command to finish.
Restart the language server again.
Make sure that the error returns.
Change the owner back to `group:bve-demo/team-demo` to clear it.

## 10. Stop the session when finished

In VS Code, run `Backstage Validation: Stop Language Server`.
To stop Docker while keeping its data, run this command from the repository root:

```sh
npm run backstage:test:down -- --run=manual-vscode-demo
```

To remove this run's containers and volumes, run:

```sh
npm run backstage:test:clean -- --run=manual-vscode-demo
```

The clean command deletes the run's sample catalog state.
It does not remove the manual workspace, private configuration, or WSL environment hook created in step 3.

## Troubleshooting

If validation does not start, run `Backstage Validation: Show Output` from the Command Palette.
A missing-credential error points to step 4.
A missing-configuration error points to step 6.

If the owner result does not change after a catalog mutation, wait for the seed command to finish.
Then restart the language server to request fresh catalog data.
Make sure that the owner line remains indented under `spec`.

The [environment guide](../test/integration/backstage/README.md) describes the shared runner, persistence, reset, and reports.
