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
  a profile for the probe, and install the probe only there. The CLI cannot install into a profile
  that does not exist yet (it answers `Profile 'BVE probe' not found.`), so open a window with the
  new profile first, which creates it, and close that window:

  **Where to run these commands.** On Windows, run them in **PowerShell**, not in a WSL shell: in a
  WSL shell, `code` is VS Code's WSL command, so `--install-extension` installs into the WSL host
  and `--list-extensions` lists the WSL host's extensions, which would confirm the install falsely.
  Give a VSIX path that Windows can read, for example a file under `$env:USERPROFILE\Downloads`
  (download the Windows VSIX in PowerShell, as in Part 1). On a Linux desktop, run them in a
  terminal of the desktop, outside any remote window.

  ```sh
  code --profile "BVE probe" --new-window <an empty folder>
  # close that window, then:
  code --profile "BVE probe" --install-extension <probe VSIX> --force
  code --profile "BVE probe" --list-extensions
  ```

  The last command lists `chtaylo3.backstage-validation-engine`. To check that the install went to
  the desktop profile and not to a remote host: in PowerShell, `Get-Command code` names a file in
  the Windows installation of VS Code (for example `...\Microsoft VS Code\bin\code.cmd`); and in a
  local (not remote) window of the probe profile, the Extensions view lists the probe under
  **Installed**, not under a heading such as **WSL: Ubuntu - Installed**.

  A new profile is empty, so it also lacks the remote extensions. Before the WSL and Coder
  topologies, install them into the probe profile, in the same place as above:

  ```sh
  code --profile "BVE probe" --install-extension ms-vscode-remote.remote-wsl
  code --profile "BVE probe" --install-extension ms-vscode-remote.remote-ssh
  code --profile "BVE probe" --install-extension coder.coder-remote
  ```

  (`remote-wsl` only on Windows.) Where the probe itself goes depends on the topology, because it is
  a workspace extension and runs where the workspace is:

  | Topology               | Install the probe in                   | How                                                                       |
  | ---------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
  | Windows local          | the probe profile on Windows           | the PowerShell commands above, with the Windows VSIX                      |
  | Windows WSL            | the WSL host                           | **Install from VSIX...** in a WSL window of the probe profile, Linux VSIX |
  | Windows or Linux Coder | the Coder workspace                    | **Install from VSIX...** in the Coder window, Linux VSIX                  |
  | Linux local            | the probe profile on the Linux desktop | the commands above in a desktop terminal, with the Linux VSIX             |

  For WSL and Coder, the desktop profile needs only the remote extensions, not the probe.

  What was run for real: on Linux (WSL, VS Code 1.145.2 and 1.106.3, a separate user data
  directory), `--install-extension` into a missing profile answered `Profile 'BVE probe' not
found.`, and on 1.145.2 opening a window with `--profile "BVE probe"` created the profile, after
  which the install listed the probe in that profile only. Not run: the PowerShell commands, the
  WSL-shell behavior, and the remote extensions in a new profile. Those follow VS Code's
  documentation of profiles and remote development; write down anything that differs.

  A separate profile keeps the probe out of your daily profile, and the same VS Code instance still
  receives the `vscode://` callback from the operating system (a separate `--user-data-dir` would
  not). In a remote window (WSL or Coder), extensions are installed on the remote host for every
  profile. The probe then replaces the product on that remote host, so reinstall your usual version
  there when you finish.

- **Only probe windows while you test.** VS Code gives the operating system's callback to the
  window that was active last, whatever its profile. A window of another profile, where the probe is
  not installed, can take the callback, and the probe never sees it. Before D1 and D2, close every
  window that is not in the probe profile. You can tell a window's profile from the profile name on
  the **Manage** (gear) icon in the activity bar. If VS Code shows a dialog about opening the link,
  or about an extension that is not installed, and no probe window logs a `callback` line, another
  profile's window took the callback: write that down, close it, and repeat the run.

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

Use the latest run: probe builds of runs after 43645632753 revoke their refresh token after the
sign-in check (see Part 2); earlier builds do not. Hosted artifacts expire after 14 days. After
that, ask the maintainer to run the probe workflow again: a push to the spike branch, or a re-run
of the latest probe run by someone with write access (`gh run rerun <run id>`). Or build the VSIX
yourself as below.

If you cannot download them, build them from the spike branch: on Linux or in WSL,
`node spike/oidc-phase-1/run-probe.mjs --package-only` writes
`.artifacts/oidc-probe/linux-package/vsix/`; in PowerShell on a Windows checkout of the branch, the
same command writes `.artifacts\oidc-probe\win32-package\vsix\`. The build copies the checkout to a
temporary folder and does not change it.

Install the probe for the window you test:

- **Local window:** `code --profile "BVE probe" --install-extension <the VSIX for this desktop> --force`,
  after the profile exists, in PowerShell on Windows or a desktop terminal on Linux (see
  [before you start](#before-you-start-keep-your-own-setup-safe), which also lists where the probe
  goes for each topology).
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

Each sign-in creates a refresh session on your Backstage. The probe revokes its refresh token right
after the check, and its report shows `revokeRefreshToken` with status 200; a probe without that
field is an older build. From the auth backend source (not tested): Backstage keeps at most one
refresh session per user for the same client, so the next sign-in replaces it, and an unused
session ends after `auth.experimentalRefreshToken.tokenLifetime` (30 days by default). To remove one
earlier, an administrator deletes the rows of the `offline_sessions` table of the auth database
whose `oidc_client_id` is the probe's client ID.

**Option B: the test application.** **Docker warning:** `backstage:test:up` builds and tags the
images `bve-backstage:1.56.3` and `bve-backstage-test:local`, replacing any images with those tags,
plus images tagged for this run. The build also pulls its base images, if they are missing:
`node:24.22.1-bookworm-slim` and `mcr.microsoft.com/playwright:v1.64.1-noble`, both at pinned
digests (several GB together). They stay after the clean-up. Run this on the Linux desktop, or in
WSL on Windows:

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
not remove `bve-backstage:1.56.3`, `bve-backstage-test:local`, or the two base images. Compare with
`~/bve-images-before.txt` and remove them only if they were not there before. The test application
keeps its refresh sessions in its own database, which the clean command deletes.

## Part 3: Set up a Coder workspace

The desktop and the workspace reach the Coder server under different names, and that differs
between Docker Desktop (Windows) and Docker Engine (a Linux desktop):

- The access URL is `http://localhost:7080`. The desktop browser and the Coder Remote extension use
  it as it is.
- The workspace agent runs in a container of the Docker starter template. That template replaces
  `localhost` in the access URL with `host.docker.internal`, and maps that name to `host-gateway`
  (`examples/templates/docker/main.tf` of Coder v2.39.1, lines 182 to 186).
- **Docker Desktop (Windows):** `host-gateway` is Docker Desktop's host address, which reaches ports
  that are published on the host's loopback address. A port published on `127.0.0.1` is enough, and
  no other interface is opened. This was shown on 2026-11-14 in WSL 2 against Docker Desktop's
  engine, with a test container on a loopback-published port (not with Coder itself): another
  container reached it through `host.docker.internal`, and Windows reached it through `localhost`.
  On that desktop, `host.docker.internal` resolved to the host's network address, where nothing
  listened. That is why the desktop uses `localhost`, not `host.docker.internal`.
- **Docker Engine (a Linux desktop):** `host-gateway` is the address of the `docker0` bridge, and a
  container normally cannot reach a port that is published only on `127.0.0.1`. Publish the port on
  the bridge address as well. That address is reachable from this machine and from its containers,
  not from other machines, unless your machine routes or forwards it; it stays open until you remove
  the container. This was not run: the implementer had no Docker Engine desktop. Use the checks in
  step 2 to confirm it.

1. **Docker warning:** this pulls `ghcr.io/coder/coder:latest`, and step 4 pulls
   `codercom/example-base:ubuntu`. Check first whether you already have them:
   `grep -E 'coder/coder|example-base' ~/bve-images-before.txt`. Then start the open-source Coder
   server in Docker. In the WSL shell on Windows, or on the Linux desktop:

   ```sh
   export CODER_DATA=$HOME/.config/bve-coder-data
   export DOCKER_GROUP=$(getent group docker | cut -d: -f3)
   mkdir -p "$CODER_DATA"
   # Docker Desktop (Windows): the loopback address only.
   export CODER_PUBLISH="-p 127.0.0.1:7080:7080"
   # Docker Engine (Linux desktop): also the docker0 bridge address. Use this line instead:
   # export CODER_PUBLISH="-p 127.0.0.1:7080:7080 -p $(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}'):7080:7080"
   docker run -d --name bve-coder $CODER_PUBLISH \
     -e CODER_HTTP_ADDRESS=0.0.0.0:7080 \
     -e CODER_ACCESS_URL=http://localhost:7080 \
     -v "$CODER_DATA":/home/coder/.config \
     -v /var/run/docker.sock:/var/run/docker.sock \
     --group-add "$DOCKER_GROUP" \
     ghcr.io/coder/coder:latest
   ```

   `CODER_HTTP_ADDRESS=0.0.0.0` is the address inside the container; the host publishes only the
   addresses of `CODER_PUBLISH`. Create the data directory yourself, as shown: the server runs as
   user 1000 and cannot write to a directory that Docker creates for it. If the directory already
   exists, choose another name, so that clean-up does not delete your data. If
   `getent group docker` prints nothing, write that down and use `--group-add 0`.

2. Check that the desktop reaches the server, and write down the `version`:
   - **Windows, in PowerShell:** `Invoke-RestMethod http://localhost:7080/api/v2/buildinfo`
   - **Linux desktop, in a shell:** `curl -fsS http://localhost:7080/api/v2/buildinfo`

   If this fails, run `docker logs bve-coder` and `docker ps --filter name=bve-coder`, write down
   what they show, and stop here: the rest of Part 3 needs this address.

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

   The list shows `bve-probe` with status `Started` and healthy `true`. Then check the
   workspace's own view of the server:

   ```sh
   docker exec "$(docker ps --filter name=bve-probe --format '{{.Names}}' | head -1)" \
     curl -fsS http://host.docker.internal:7080/api/v2/buildinfo
   ```

   If `coder list` shows the workspace unhealthy or this request fails: on Docker Engine, check
   that you used the second `CODER_PUBLISH` line, and that no firewall blocks the `docker0`
   interface (`sudo ufw status`); on Docker Desktop, write down the Docker Desktop version and the
   output. If `curl` is missing in the workspace image, write that down; `coder list` is then the
   check.

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
# Set the variable again: a new shell does not have it. Use the name you chose in step 1.
CODER_DATA="$HOME/.config/bve-coder-data"
ls -ld "$CODER_DATA" && sudo rm -rf -- "${CODER_DATA:?CODER_DATA is empty}"
```

The `${CODER_DATA:?...}` form stops the command if the variable is empty, and `ls -ld` shows
first what will be removed.

Coder Remote also wrote to your desktop. From its source (`coder/vscode-coder` v1.18.0; not run):

- **SSH configuration.** It adds a block to `~/.ssh/config` (Windows:
  `%USERPROFILE%\.ssh\config`) that starts with a line `# --- START CODER` and ends with the
  matching `# --- END CODER` line: either `# --- START CODER VSCODE <host> ---`, or
  `# --- START CODER INCLUDE CODER-REMOTE ---` with an `Include` line. Delete only the
  `VSCODE` block whose host is the Coder host of this procedure, for example `localhost`. Delete
  the `INCLUDE` block only if you did not use Coder Remote before this procedure, because every
  Coder deployment shares it. Leave every other `CODER` block. The
  `Include` form also generated files in `coder.coder-remote/ssh/` in the platform data directory
  (Windows: `%APPDATA%\coder.coder-remote\ssh\`; Linux:
  `${XDG_DATA_HOME:-$HOME/.local/share}/coder.coder-remote/ssh/`); delete the files whose name ends
  in `--<host>.conf`, where `<host>` is the Coder host name, for example `localhost`.
- **The `coder` binary and the session.** It keeps them per deployment in its global storage, in
  `coder.coder-remote/<host>/` (`bin/` for the binary, and the files `session`, `session_token`, and
  `url`). The global storage is under VS Code's user data: Windows `%APPDATA%\Code\User\`, Linux
  `~/.config/Code/User/`, in `globalStorage/` for the default profile and, for another profile,
  possibly in `profiles/<profile id>/globalStorage/` (not verified). Delete the
  `coder.coder-remote/<host>/` folder that you find, or the whole `coder.coder-remote` folder if you
  did not use Coder Remote before. Deleting the probe profile also removes its own folder.

Remove `ghcr.io/coder/coder:latest` and `codercom/example-base:ubuntu` only if they are not in
`~/bve-images-before.txt`. If an earlier version of this procedure made you add
`host.docker.internal` to `/etc/hosts`, remove that line again.

## Part 4: The questions

Run each question in each topology of its list, always in the probe profile. For every run, fill
one row of the [observation sheet](#observation-sheet), and copy the probe report into it: run
**Backstage OIDC Probe: Copy Report** and paste.

Do not copy the browser's address bar or a `vscode://` link from the browser, and do not take
screenshots of the address bar or of the VS Code dialog **Allow 'Backstage Validation Engine'
extension to open this URI?**: those can show the authorization code. Write the dialog's text by
hand, and write `<link>` in place of any link that it shows.

### D1: Does the browser hand the redirect to VS Code, and does the callback reach the extension?

Topologies: Windows local, Windows WSL, Windows Coder, Linux local (system package), Linux Coder.

1. Close every window that is not in the probe profile. Open a window in the topology, in the
   probe profile: a local folder; or `code --profile "BVE probe" .` from the WSL shell; or the
   Coder workspace from the dashboard. Install the probe in it and reload.
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
     and its exact text, with `<link>` in place of the link. Select **Open**. Do not check **Do not
     ask me again** on the first run;
   - the `callback` line in the output channel: `stateMatches`, `pendingAttemptInThisWindow`,
     `exchange`, and `userinfo`.
6. Repeat steps 2 to 5 once, and this time check **Do not ask me again** in the VS Code prompt.
   Then repeat once more, and write down whether VS Code still asks.

In the Coder topology with the test application, the `exchange` step is expected to fail, because
the workspace cannot reach the desktop's loopback address. The callback line is the answer to D1.
Write down the exchange error for D3.

### D2: With two windows of different topologies, which window receives the callback?

Topologies: Windows (a local window and a WSL window), Linux (a local window and a Coder window).

1. Close every window that is not in the probe profile. Open both windows in the probe profile.
   Install the probe in both.
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

   3. Quit every VS Code window, so that `code` starts a new editor instead of handing the folder to
      a running one on your normal bus. Then start VS Code on that bus, in the probe profile. With
      `--wait`, `dbus-run-session` keeps the private bus until you close the window; without it,
      the bus ends at once and the editor runs with no D-Bus at all:

      ```sh
      dbus-run-session --config-file="$HOME/bve-no-keyring-bus.conf" -- code --wait --profile "BVE probe" --new-window <folder>
      ```

   4. Check the editor's own bus: in that window, open a terminal (**Terminal: Create New
      Terminal**), which inherits the editor's environment, and run the two `dbus-send` commands of
      step 2 there. The first lists only `org.freedesktop.DBus`. If it lists more, or fails, write
      that down and stop.
   5. Run **Check Secret Storage**. Write down every message that VS Code shows, the report line,
      and the lines about secret storage in **Developer: Show Logs...** > **Main**. Close the window
      afterwards; your normal session is unchanged.

   This sequence was run on 2026-11-14 in WSL 2 under Xvfb with VS Code 1.145.2 from the archive:
   with `--wait`, the editor's bus answered with only `org.freedesktop.DBus`; without `--wait`,
   `dbus-run-session` had already ended a few seconds after the start. It was not run on a Linux
   desktop.

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
- Run the clean-up steps of Part 2 and Part 3, including the image comparison.

## Observation sheet

| Question | Desktop and VS Code version | Topology | Browser prompt (text) | VS Code prompt (text) | Callback in window | `stateMatches` | Exchange or check result | Other observations |
| -------- | --------------------------- | -------- | --------------------- | --------------------- | ------------------ | -------------- | ------------------------ | ------------------ |
| D1       |                             |          |                       |                       |                    |                |                          |                    |
