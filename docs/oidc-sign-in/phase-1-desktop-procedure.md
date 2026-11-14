# Phase 1: Desktop checks by hand

Read [the plan overview](README.md) and [Phase 1](phase-1-feasibility.md) first.

This procedure answers the desktop questions D1 to D5 of Phase 1 (evidence layer 4). The owner
runs it on a Windows desktop in the local, WSL, and Coder topologies, and on a Linux desktop in the
local and Coder topologies. Nobody runs it on macOS. The answers go into the
[feasibility record](feasibility-record.md).

The procedure uses a throwaway probe build of the extension. The probe adds five commands that
start a real sign-in, check reachability and secret storage, and start a loopback listener. Each
command writes one line per observation to the **Backstage OIDC Probe** output channel. A line holds
statuses, booleans, error codes, URLs that you typed, and the user entity reference. It never holds
a token, an authorization code, or a PKCE verifier.

**Use the spike branch.** The probe exists only on the branch `spike/oidc-phase-1-probe`
(`spike/oidc-phase-1/probe.patch` and `spike/oidc-phase-1/run-probe.mjs`). Check out that branch
for this procedure. Nothing of the probe is merged.

Plan for about three hours. Write down each observation as you make it, in the
[observation sheet](#observation-sheet) at the end.

## What you need

- **Windows desktop:** Windows 11, the stable desktop VS Code 1.106.3 or later, WSL 2 with an
  Ubuntu distribution, Docker Desktop with WSL integration turned on for that distribution, and
  your usual browser.
- **Linux desktop:** a graphical session with a keyring (GNOME Keyring or KWallet), your usual
  browser, Docker, the VS Code system package (`.deb` or `.rpm`), and the VS Code archive
  (`.tar.gz`) from <https://code.visualstudio.com/Download>.
- **The repository** at the branch `spike/oidc-phase-1-probe`, with Node 24.22.1 and `npm ci` done.
  On Windows, put the checkout in the WSL file system.
- **Network:** access to GitHub, the npm registry, Docker Hub, and GitHub Container Registry.

### Before you start: keep your own setup safe

- **A separate VS Code profile.** The probe is a build of the product extension with the same
  identifier, so installing it replaces the product in whatever profile you install it into. Create
  a profile for the probe, and install the probe only there:

  ```sh
  code --profile "BVE probe" --install-extension <probe VSIX> --force
  code --profile "BVE probe" <folder>
  ```

  A separate profile keeps the probe out of your daily profile, and the same VS Code instance still
  receives the `vscode://` callback from the operating system (a separate `--user-data-dir` would
  not). In a remote window (WSL or Coder), extensions are installed on the remote host for every
  profile. The probe then replaces the product on that remote host, so reinstall your usual version
  there when you finish.

- **Docker images.** Steps marked **Docker warning** build or pull images with fixed tags. Building
  or pulling a tag replaces the image that had that tag before, and on Docker with the containerd
  image store the old image can be deleted. Record your images first, so that clean-up removes only
  what this procedure created:

  ```sh
  docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}}' | sort > ~/bve-images-before.txt
  ```

## Part 1: Get the probe

Prefer the probe VSIX that a hosted run of the spike branch built:

```sh
gh run list --repo chtaylo3/backstage-validation-engine --branch spike/oidc-phase-1-probe --workflow oidc-phase-1-probe.yml
gh run download <run id> --repo chtaylo3/backstage-validation-engine --name oidc-probe-windows-2025 --dir bve-probe-windows
gh run download <run id> --repo chtaylo3/backstage-validation-engine --name oidc-probe-ubuntu-24.04 --dir bve-probe-linux
```

- The Windows VSIX is `bve-probe-windows/win32-local/vsix/probe-backstage-validation-engine-0.1.0-win32-x64.vsix`.
  You need it for the Windows local topology.
- The Linux VSIX is `bve-probe-linux/linux-local/vsix/probe-backstage-validation-engine-0.1.0-linux-x64.vsix`.
  You need it for the Linux desktop, for the WSL topology, and for the Coder topology.

If you cannot download them, build them from the spike branch: on Linux or in WSL,
`node spike/oidc-phase-1/run-probe.mjs --package-only` writes
`.artifacts/oidc-probe/linux-package/vsix/`; in PowerShell on a Windows checkout of the branch, the
same command writes `.artifacts\oidc-probe\win32-package\vsix\`. The build copies the checkout to a
temporary folder and does not change it.

Install the probe for the window you test:

- **Local window:** `code --profile "BVE probe" --install-extension <the VSIX for this desktop> --force`.
- **WSL or Coder window:** open the window in the probe profile and connect it first. Then open the
  Extensions view, select **...** > **Install from VSIX...**, and choose the Linux VSIX. VS Code
  installs it on the remote host.
- Reload the window after each install (**Developer: Reload Window**).

The probe also starts the language server. These checks need no trusted configuration, so ignore
the message that asks you to set **Backstage Validation: Config Path**.

## Part 2: A Backstage that accepts the sign-in

**Option A: your own Backstage.** If you run Backstage 1.53.0 or later with the New Frontend System
and `@backstage/plugin-auth`, you can skip the local build. Configure it as
[the record's operator section](feasibility-record.md#what-an-operator-configures) shows, and host
the [client metadata document](feasibility-record.md#the-client-metadata-document) on an HTTPS URL
that your Backstage backend trusts. Use that URL as the client ID, and
`<your Backstage URL>/api/auth` as the authorization server, in the questions below.

**Option B: the test application.** **Docker warning:** `backstage:test:up` builds and tags the
images `bve-backstage:1.56.3` and `bve-backstage-test:local`, replacing any images with those tags,
plus images tagged for this run. Run this on the Linux desktop, or in WSL on Windows:

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

The test application listens on the loopback address of the machine that runs Docker. A Coder
workspace runs in another container and cannot reach that address under the same URL. That limit is
expected, and D3 records it.

When you finish all questions:

```sh
node test/integration/backstage/oidc/run.mjs --run=desk-1563 --restore
npm run backstage:test:clean -- --run=desk-1563
```

The clean command removes the run's containers, volumes, network, and run-tagged images. It does
not remove `bve-backstage:1.56.3` or `bve-backstage-test:local`. Compare with
`~/bve-images-before.txt` and remove them only if they were not there before.

## Part 3: Set up a Coder workspace

These server-side steps ran on a Linux host with Docker on 2026-11-14 with Coder v2.39.1. They
are not verified on Windows with Docker Desktop. On Windows, run them in the WSL Ubuntu shell and
write down any step that behaves differently.

1. **Docker warning:** this pulls `ghcr.io/coder/coder:latest`, and step 4 pulls
   `codercom/example-base:ubuntu`. Check first whether you already have them:
   `grep -E 'coder/coder|example-base' ~/bve-images-before.txt`. Then start the open-source Coder
   server in Docker:

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
   If `$HOME/.config/coderv2-docker` already exists, use another directory, so that clean-up does
   not delete your data. If `getent group docker` prints nothing, write that down and use
   `--group-add 0`.

2. Make the access URL resolve on the desktop. The workspace agent and the Coder Remote extension
   both use `http://host.docker.internal:7080`.
   - **Windows:** Docker Desktop adds `host.docker.internal` to the hosts file. Check with
     `ping host.docker.internal` in PowerShell.
   - **Linux:** if `getent hosts host.docker.internal` prints nothing, add the line
     `127.0.0.1 host.docker.internal` to `/etc/hosts`, and write down that you added it.

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
   (`coder.coder-remote`) if needed, and connects to the workspace through Remote-SSH. If the window
   opens in your daily profile, switch it to the probe profile (**Profiles: Switch Profile**). Write
   down every prompt that you see, and the versions of Coder Remote and Remote-SSH.

6. Install the Linux probe VSIX in the Coder window, as in [Part 1](#part-1-get-the-probe).

Remove Coder when you finish all questions:

```sh
docker exec bve-coder /opt/coder delete bve-probe --yes
docker rm -f bve-coder
sudo rm -rf "$CODER_DATA"
```

Remove `ghcr.io/coder/coder:latest` and `codercom/example-base:ubuntu` only if they are not in
`~/bve-images-before.txt`. If you added `host.docker.internal` to `/etc/hosts` in step 2, remove
that line again.

## Part 4: The questions

Run each question in each topology of its list, always in the probe profile. For every run, fill
one row of the [observation sheet](#observation-sheet), and copy the probe report into it: run
**Backstage OIDC Probe: Copy Report** and paste.

Do not copy the browser's address bar or a `vscode://` link from the browser, and do not take
screenshots of the address bar or of the VS Code dialog **Allow 'Backstage Validation Engine'
extension to open this URI?**: those can show the authorization code. Write the dialog's text by
hand.

### D1: Does the browser hand the redirect to VS Code, and does the callback reach the extension?

Topologies: Windows local, Windows WSL, Windows Coder, Linux local (system package), Linux Coder.

1. Open a window in the topology, in the probe profile: a local folder; or `code --profile "BVE
probe" .` from the WSL shell; or the Coder workspace from the dashboard. Install the probe in it
   and reload.
2. Run **Backstage OIDC Probe: Start Sign-In**. Enter the authorization server from Part 2, and
   then the client ID.
3. The output channel shows a `sign-in started` line. Write down its
   `extensionHostReachesDiscovery` and `packagedRuntimeReachesDiscovery` values. The browser opens
   the Backstage sign-in page.
4. In the browser, sign in (with the test application, select **Enter** for the guest), and then
   select **Authorize** on the consent page.
5. Write down:
   - whether the browser asks to open VS Code, its exact text, and whether it offers to remember
     the choice;
   - whether VS Code asks **Allow 'Backstage Validation Engine' extension to open this URI?**,
     and its exact text. Select **Open**. Do not check **Do not ask me again** on the first run;
   - the `callback` line in the output channel: `stateMatches`, `pendingAttemptInThisWindow`,
     `exchange`, and `userinfo`.
6. Repeat steps 2 to 5 once, and this time check **Do not ask me again** in the VS Code prompt.
   Then repeat once more, and write down whether VS Code still asks.

In the Coder topology with the test application, the `exchange` step is expected to fail, because
the workspace cannot reach the desktop's loopback address. The callback line is the answer to D1.
Write down the exchange error for D3.

### D2: With two windows of different topologies, which window receives the callback?

Topologies: Windows (a local window and a WSL window), Linux (a local window and a Coder window).

1. Open both windows in the probe profile. Install the probe in both.
2. In window A, run **Start Sign-In**. Before you select **Authorize** in the browser, click into
   window B, so that window B was active last.
3. Select **Authorize**. Write down which window logs a `callback` line, and its
   `pendingAttemptInThisWindow` value. Write down whether the other window logs anything.
4. Repeat with window A active last.
5. Repeat steps 2 to 4 with A and B swapped.

### D3: Do the extension host and the packaged runtime reach an HTTPS Backstage under the browser's URL?

Topologies: all five of D1.

1. Run **Backstage OIDC Probe: Check Reachability** with the discovery URL of the Backstage of
   Part 2: `<authorization server>/.well-known/openid-configuration`. Write down `extensionHost`
   and `packagedRuntime`.
2. Run it again with the discovery URL of an HTTPS Backstage that your organization runs, under
   the URL that your browser uses for it. If you have none, write that down and skip to step 4.
3. If a request fails with an error code (for example `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`,
   `SELF_SIGNED_CERT_IN_CHAIN`, `ENOTFOUND`, `ECONNREFUSED`, or a timeout), apply the fix that your
   organization uses, and write down which fix changed which side:
   - for a private certificate authority, `NODE_EXTRA_CA_CERTS=<file>` for the remote side in
     `~/.vscode-server/server-env-setup` (WSL and Coder) or in the environment of VS Code (local);
   - for a proxy, `HTTPS_PROXY` in the same places, and the VS Code setting `http.proxy`.

   Reload the window after each change, and run the check again. The report shows whether
   `http.proxy`, `HTTPS_PROXY`, and `NODE_EXTRA_CA_CERTS` were set. Undo these changes when you
   finish, if they are not part of your normal setup.

4. Write down whether the browser and the extension host used the same URL, and what an operator
   would have to configure so that they can.

The D3 report contains the URLs that you typed. If they name internal hosts, redact them before
you return the report (see [Part 5](#part-5-return-the-observations)).

### D4: On Linux, what happens with a system package, an archive, and no keyring?

Topology: Linux local. Use a separate folder for each part.

1. **System package.** Install VS Code from the `.deb` or `.rpm`. Run D1 once and **Backstage OIDC
   Probe: Check Secret Storage** once, both in the probe profile. Run
   `xdg-mime query default x-scheme-handler/vscode` in a terminal and write down the result.
2. **Archive, without the system package.** The system package registers the `vscode` scheme and
   shares your profile, so the archive test only means something without it.
   1. Uninstall the system package (`sudo apt remove code` or `sudo dnf remove code`).
   2. Check the precondition: `xdg-mime query default x-scheme-handler/vscode` must print nothing,
      or a file that no longer exists. Write down what it prints.
   3. Extract the `.tar.gz`, and create the folder `data` inside the extracted folder. With that
      folder, VS Code runs in portable mode and keeps its own profile and extensions there.
   4. Install the probe into it: `./bin/code --install-extension <Linux probe VSIX> --force`, run
      from the extracted folder.
   5. Start `./code` from the extracted folder. Run D1 and **Check Secret Storage**. Write down what
      the browser does with the redirect, and the `xdg-mime` result again.
   6. Reinstall the system package afterwards.
3. **No keyring.** A desktop session starts a keyring service on demand through D-Bus, so stopping
   the daemon is not enough. Start VS Code on a private D-Bus bus that cannot start any service:
   1. Save this as `~/bve-no-keyring-bus.conf`:

      ```xml
      <!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
        "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
      <busconfig>
        <type>session</type>
        <listen>unix:tmpdir=/tmp</listen>
        <auth>EXTERNAL</auth>
        <policy context="default">
          <allow send_destination="*" eavesdrop="true"/>
          <allow eavesdrop="true"/>
          <allow own="*"/>
        </policy>
      </busconfig>
      ```

   2. Check the precondition. This must print no line with `secrets` or `kwallet`:

      ```sh
      dbus-run-session --config-file="$HOME/bve-no-keyring-bus.conf" -- sh -c 'dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.ListActivatableNames; dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.ListNames' | grep -i -E 'secrets|kwallet'
      ```

   3. Quit every VS Code window. Then start VS Code on that bus, in the probe profile:

      ```sh
      dbus-run-session --config-file="$HOME/bve-no-keyring-bus.conf" -- code --profile "BVE probe" --new-window <folder>
      ```

   4. Run **Check Secret Storage**. Write down every message that VS Code shows, the report line,
      and the lines about secret storage in **Developer: Show Logs...** > **Main**. Quit VS Code
      afterwards; your normal session is unchanged.

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
3. **Redact before you share.** The repository is public. Replace every internal URL, host name,
   IP address, user name, and organization name with a placeholder such as
   `https://backstage.internal.example` or `<internal host>`, in the reports and in your notes.
   Keep the error codes and statuses. Check that the file contains no `code=` value, no token, no
   password, and no screenshot.
4. Give the file to the implementer of the feasibility record. Attach it to a pull request only
   after the redaction. The record is updated from it, and this procedure is corrected where you
   needed help.

Then clean up:

- Remove the probe from the probe profile, or delete the profile (**Profiles: Delete Profile**).
  On every remote host where you installed it (WSL, Coder), uninstall it and reinstall your usual
  version of the extension.
- Run the clean-up steps of Part 2 and Part 3, including the image comparison and the `/etc/hosts`
  line.

## Observation sheet

| Question | Desktop and VS Code version | Topology | Browser prompt (text) | VS Code prompt (text) | Callback in window | `stateMatches` | Exchange or check result | Other observations |
| -------- | --------------------------- | -------- | --------------------- | --------------------- | ------------------ | -------------- | ------------------------ | ------------------ |
| D1       |                             |          |                       |                       |                    |                |                          |                    |
