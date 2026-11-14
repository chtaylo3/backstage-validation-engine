# Phase 1: Desktop checks by hand

Read [the plan overview](README.md) and [Phase 1](phase-1-feasibility.md) first.

This procedure answers the desktop questions D1 to D5 of Phase 1 (evidence layer 4). The owner
runs it on a Windows desktop in the local, WSL, and Coder topologies, and on a Linux desktop in the
local and Coder topologies. Nobody runs it on macOS. The answers go into the
[feasibility record](feasibility-record.md).

The procedure uses a throwaway probe build of the extension. The probe adds five commands that
start a real sign-in, check reachability and secret storage, and start a loopback listener. Each
command writes one line per observation to the **Backstage OIDC Probe** output channel. A line holds
statuses, booleans, error codes, and the user entity reference. It never holds a token, an
authorization code, or a PKCE verifier.

Plan for about three hours. Write down each observation as you make it, in the
[observation sheet](#observation-sheet) at the end.

## What you need

- **Windows desktop:** Windows 11, the stable desktop VS Code 1.106.3 or later, WSL 2 with an
  Ubuntu distribution, Docker Desktop with WSL integration turned on for that distribution, and
  your usual browser.
- **Linux desktop:** a graphical session with a keyring (GNOME Keyring or KWallet), your usual
  browser, Docker, the VS Code system package (`.deb` or `.rpm`), and the VS Code archive
  (`.tar.gz`) from <https://code.visualstudio.com/Download>.
- **The repository:** a checkout of the branch that contains this document, with Node 24.22.1 and
  `npm ci` done. On Windows, put the checkout in the WSL file system for parts 1 to 3, and a second
  checkout on Windows for the Windows probe build.
- **Network:** access to the npm registry, Docker Hub, and GitHub Container Registry.

## Part 1: Build and install the probe

The probe is the product extension with the probe changes of `spike/oidc-phase-1/probe.patch`. Do
not use it for anything else, and remove it when you finish.

1. On Linux or in WSL, from the repository root:

   ```sh
   node spike/oidc-phase-1/run-probe.mjs --package-only
   ```

   The VSIX is `.artifacts/oidc-probe/linux-package/vsix/probe-backstage-validation-engine-0.1.0-linux-x64.vsix`.
   You need it for the Linux desktop, for the WSL topology, and for the Coder topology.

2. On Windows, in PowerShell, from the Windows checkout:

   ```powershell
   npm ci
   node spike/oidc-phase-1/run-probe.mjs --package-only
   ```

   The VSIX is `.artifacts\oidc-probe\win32-package\vsix\probe-backstage-validation-engine-0.1.0-win32-x64.vsix`.
   You need it for the Windows local topology. A hosted run of the probe workflow also uploads both
   VSIX files: artifact `oidc-probe-windows-2025` and artifact `oidc-probe-ubuntu-24.04`, folder
   `*-local/vsix/`.

3. Install the probe for the window you test:
   - **Local window:** `code --install-extension <the VSIX for this desktop> --force`.
   - **WSL or Coder window:** connect the window first, then open the Extensions view, select
     **...** > **Install from VSIX...**, and choose the Linux VSIX. VS Code installs it on the
     remote host.
   - Reload the window after each install (**Developer: Reload Window**).

The probe also starts the language server. These checks need no trusted configuration, so ignore
the message that asks you to set **Backstage Validation: Config Path**.

## Part 2: Start a Backstage that accepts the sign-in

Run this on the Linux desktop, or in WSL on Windows:

```sh
npm run backstage:test:up -- --target=1.56.3 --run=desk-1563
node test/integration/backstage/oidc/run.mjs --run=desk-1563 --serve
```

The second command prints five values. Keep them for the questions:

- `browserUrl`, for example `http://localhost:41234`. Open it in the browser of the desktop. You
  see the Backstage test application. On Windows, the browser reaches the WSL Docker port through
  `localhost`.
- `authorizationServer`, for example `http://localhost:41234/api/auth`.
- `clientId`: `https://client-document:8443/vscode-client.json`. Backstage fetches this document
  itself, inside its Compose network. Your browser and VS Code never fetch it.
- `redirectUri`: `vscode://chtaylo3.backstage-validation-engine/sign-in`.
- `guestUser`: `user:bve-demo/alice`. The guest sign-in signs you in as this user.

Backstage listens on the loopback address of the machine that runs Docker. A Coder workspace runs
in another container and cannot reach that address under the same URL. That limit is expected, and
D3 records it.

When you finish all questions:

```sh
node test/integration/backstage/oidc/run.mjs --run=desk-1563 --restore
npm run backstage:test:clean -- --run=desk-1563
```

## Part 3: Set up a Coder workspace

These server-side steps ran on a Linux host with Docker on 2026-11-14 with Coder v2.39.1. They
are not yet verified on Windows with Docker Desktop. On Windows, run them in the WSL Ubuntu shell
and write down any step that behaves differently.

1. Start the open-source Coder server in Docker:

   ```sh
   export CODER_DATA=$HOME/.config/coderv2-docker
   export DOCKER_GROUP=$(getent group docker | cut -d: -f3)
   mkdir -p "$CODER_DATA"
   docker run -d --name bve-coder \
     -p 127.0.0.1:7080:7080 \
     -e CODER_HTTP_ADDRESS=0.0.0.0:7080 \
     -e CODER_ACCESS_URL=http://host.docker.internal:7080 \
     --add-host host.docker.internal:host-gateway \
     -v "$CODER_DATA":/home/coder/.config \
     -v /var/run/docker.sock:/var/run/docker.sock \
     --group-add "$DOCKER_GROUP" \
     ghcr.io/coder/coder:latest
   curl -s http://127.0.0.1:7080/api/v2/buildinfo
   ```

   Write down the `version` that the last command prints. Create the data directory yourself, as
   shown: the server runs as user 1000 and cannot write to a directory that Docker creates for it.
   If `getent group docker` prints nothing, write that down and use `--group-add 0`.

2. Make the access URL resolve on the desktop. The workspace agent and the Coder Remote extension
   both use `http://host.docker.internal:7080`.
   - **Windows:** Docker Desktop adds `host.docker.internal` to the hosts file. Check with
     `ping host.docker.internal` in PowerShell.
   - **Linux:** add the line `127.0.0.1 host.docker.internal` to `/etc/hosts`.

3. Open `http://localhost:7080` in the browser and create the first user (the administrator).

4. Create the template and the workspace. Either use the web UI (**Templates** > **New Template** >
   **Docker** > **Create Template**, then **Create Workspace**), or run these commands. The
   `jetbrains_ides=[]` parameter is required with `--yes`: without it the plan of the Docker starter
   template fails with `value "" is not a valid list of strings`.

   ```sh
   docker exec -it bve-coder /opt/coder login http://localhost:7080
   docker exec bve-coder sh -c 'cd /tmp && /opt/coder templates init --id docker docker-template && /opt/coder templates push docker -d /tmp/docker-template --yes'
   docker exec bve-coder /opt/coder create bve-probe --template docker --parameter 'jetbrains_ides=[]' --yes
   docker exec bve-coder /opt/coder list
   ```

   The list shows `bve-probe` with status `Started` and healthy `true`.

5. Connect desktop VS Code. In the Coder dashboard, open the workspace and select **VS Code
   Desktop**. The browser asks to open VS Code. VS Code installs the Coder Remote extension
   (`coder.coder-remote`) if needed, and connects to the workspace through Remote-SSH. Write down
   every prompt that you see, and the versions of Coder Remote and Remote-SSH.

6. Install the Linux probe VSIX in the Coder window, as in [Part 1](#part-1-build-and-install-the-probe).

Remove Coder when you finish all questions:

```sh
docker exec bve-coder /opt/coder delete bve-probe --yes
docker rm -f bve-coder
docker image rm ghcr.io/coder/coder:latest codercom/example-base:ubuntu
sudo rm -rf "$HOME/.config/coderv2-docker"
```

## Part 4: The questions

Run each question in each topology of its list. For every run, fill one row of the
[observation sheet](#observation-sheet), and copy the probe report into it: run **Backstage OIDC
Probe: Copy Report** and paste. The report contains no secret. Do not copy the browser's address
bar or a `vscode://` link from the browser: those can contain the authorization code.

### D1: Does the browser hand the redirect to VS Code, and does the callback reach the extension?

Topologies: Windows local, Windows WSL, Windows Coder, Linux local (system package), Linux Coder.

1. Open a window in the topology: a local folder; or `code .` from the WSL shell; or the Coder
   workspace from the dashboard. Install the probe in it and reload.
2. Run **Backstage OIDC Probe: Start Sign-In**. Enter the `authorizationServer` from Part 2, and
   then the `clientId`.
3. The output channel shows a `sign-in started` line. Write down its
   `extensionHostReachesDiscovery` and `packagedRuntimeReachesDiscovery` values. The browser opens
   the Backstage sign-in page.
4. In the browser, select **Enter** for the guest, and then **Authorize** on the consent page.
5. Write down:
   - whether the browser asks to open VS Code, its exact text, and whether it offers to remember
     the choice;
   - whether VS Code asks **Allow 'Backstage Validation Engine' extension to open this URI?**,
     and its exact text. Select **Open**. Do not check **Do not ask me again** on the first run;
   - the `callback` line in the output channel: `stateMatches`, `pendingAttemptInThisWindow`,
     `exchange`, and `userinfo`.
6. Repeat steps 2 to 5 once, and this time check **Do not ask me again** in the VS Code prompt.
   Then repeat once more, and write down whether VS Code still asks.

In the Coder topology the `exchange` step is expected to fail, because the workspace cannot reach
the desktop's loopback address. The callback line is the answer to D1. Write down the exchange
error for D3.

### D2: With two windows of different topologies, which window receives the callback?

Topologies: Windows (a local window and a WSL window), Linux (a local window and a Coder window).

1. Open both windows. Install the probe in both.
2. In window A, run **Start Sign-In**. Before you select **Authorize** in the browser, click into
   window B, so that window B was active last.
3. Select **Authorize**. Write down which window logs a `callback` line, and its
   `pendingAttemptInThisWindow` value. Write down whether the other window logs anything.
4. Repeat with window A active last.
5. Repeat steps 2 to 4 with A and B swapped.

### D3: Do the extension host and the packaged runtime reach an HTTPS Backstage under the browser's URL?

Topologies: all five of D1.

1. Run **Backstage OIDC Probe: Check Reachability** with the discovery URL of the test application:
   `<authorizationServer>/.well-known/openid-configuration`. Write down `extensionHost` and
   `packagedRuntime`.
2. Run it again with the discovery URL of an HTTPS Backstage that your organization runs, under
   the URL that your browser uses for it. If you have none, write that down and skip to step 4.
3. If a request fails with an error code (for example `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`,
   `SELF_SIGNED_CERT_IN_CHAIN`, `ENOTFOUND`, `ECONNREFUSED`, or a timeout), apply the fix that your
   organization uses, and write down which fix changed which side:
   - for a private certificate authority, `NODE_EXTRA_CA_CERTS=<file>` for the remote side in
     `~/.vscode-server/server-env-setup` (WSL and Coder) or in the environment of VS Code (local);
   - for a proxy, `HTTPS_PROXY` in the same places, and the VS Code setting `http.proxy`.

   Reload the window after each change, and run the check again. The report shows whether
   `http.proxy`, `HTTPS_PROXY`, and `NODE_EXTRA_CA_CERTS` were set.

4. Write down whether the browser and the extension host used the same URL, and what an operator
   would have to configure so that they can.

### D4: On Linux, what happens with a system package, an archive, and no keyring?

Topology: Linux local.

1. **System package.** Install VS Code from the `.deb` or `.rpm`. Run D1 once and **Backstage OIDC
   Probe: Check Secret Storage** once. Also run `xdg-mime query default x-scheme-handler/vscode`
   in a terminal and write down the result.
2. **Archive.** Quit VS Code. Extract the `.tar.gz` and start `./code` from the extracted folder,
   with the probe installed in it. Run D1 and **Check Secret Storage**. Write down what the browser
   does with the redirect, and the `xdg-mime` result again.
3. **No keyring.** Quit VS Code. Stop the keyring daemon of your session (for GNOME,
   `pkill -f gnome-keyring-daemon`), start VS Code from the system package, and run **Check
   Secret Storage**. Write down every message that VS Code shows, and the lines about secret
   storage in **Developer: Show Logs...** > **Main**. Restart your session afterwards.

### D5: Does a forwarded loopback listener receive the redirect?

Topologies: Windows local, Windows WSL, Windows Coder, Linux local, Linux Coder.

1. Run **Backstage OIDC Probe: Start Loopback Listener**. The probe listens on a loopback port of
   the extension host for two minutes, asks VS Code for the external URI of that port, and opens it
   in the browser.
2. Write down the `externalUri` in the output channel, whether VS Code showed a port-forwarding
   notification, whether the browser page says that the probe received the request, and whether a
   `loopback request` line appears.

D5 does not use Backstage: the test configuration does not allow a loopback redirect URI.

## Part 5: Return the observations

1. Copy the [observation sheet](#observation-sheet) into a new file named
   `phase-1-desktop-observations.md`, and fill one row for each run.
2. Under the table, paste the probe report of each run, each under a heading that names the
   question, the desktop, and the topology.
3. Check that the file contains no `code=` value, no token, and no password. The probe reports
   contain none.
4. Give the file to the implementer of the feasibility record, or attach it to the pull request.
   The record is updated from it, and this procedure is corrected where you needed help.

Remove the probe from every VS Code installation and remote host, and run the clean-up commands of
Part 2 and Part 3.

## Observation sheet

| Question | Desktop and VS Code version | Topology | Browser prompt (text) | VS Code prompt (text) | Callback in window | `stateMatches` | Exchange or check result | Other observations |
| -------- | --------------------------- | -------- | --------------------- | --------------------- | ------------------ | -------------- | ------------------------ | ------------------ |
| D1       |                             |          |                       |                       |                    |                |                          |                    |
