# Move development work into the WSL filesystem

Status: migration plan. The following state describes the checkout when this plan was written.
[The session handoff](SESSION_HANDOFF.md) records the completed move and later access results.
This transition prepares the local baseline for [increment 6](../backstage-release-test-plan.md). The
procedure does not install the planned containers or change workflow triggers.

## 1. Current state and destination

The current machine runs Ubuntu 24.04.3 on WSL 2 with x64 architecture. The distribution name is
`Ubuntu`. The checkout is `/mnt/<drv>/code/backstage-validation-engine`. WSL accesses it through a
Windows filesystem mount reported as `9p` with `drvfs`. The user identifies the underlying Windows
partition as a Dev Drive.

The WSL home directory already uses ext4. Use `~/code/backstage-validation-engine` as
the proposed active path. The Windows VS Code interface connects to that directory through Remote
WSL. Git, Node and shell commands execute in Ubuntu.

There are two independent Git repositories:

| Repository                                | Current branch | Commit observed during planning            |
| ----------------------------------------- | -------------- | ------------------------------------------ |
| Main checkout                             | `master`       | `4a6110c70a82601246aeb16dedaf3f7952563563` |
| `plan/BackstageValidationEngine-planning` | `main`         | `b87c3cd081ffa8f5bdcb3799148dde9940107880` |

Both repositories currently have ordinary `.git` directories. Neither currently uses a linked
worktree. Before migration, make sure that each `.git` entry is still a directory. A linked worktree
needs a different procedure. The root repository ignores the nested planning repository.

## 2. What the Dev Drive changes

A Dev Drive optimizes selected Windows development workloads. It still exposes a Windows filesystem
to this checkout. Microsoft states that WSL access does not receive the same Dev Drive performance
benefits. ReFS also lacks support for WSL's Linux-permission metadata mount option.

Keep Linux source files and mounted test workspaces inside WSL ext4. This supplies Linux ownership,
permission and file notification behavior. Creating a symlink from the home directory to `/mnt/example-drive`
does not change the filesystem. Changing the shell alone does not change the filesystem either.

Keep the Dev Drive available for Windows projects, archives or a separate native Windows test
checkout. No partition reformat or drive removal is required. The first transition does not relocate
the entire WSL distribution. The physical location of its virtual disk is a separate storage
decision.

If storage placement on `I:` is required later, evaluate supported WSL virtual-disk relocation
separately. Make sure that the installed WSL version supports the destination. Back up the
distribution before any relocation. The project must still appear inside the mounted ext4 filesystem
afterward.

## 3. Preserve current work before copying

Stop editors, watchers and test processes that can write into either repository. For both
repositories, record status, HEAD, branches, remotes, staged changes, and unstaged changes. Capture
untracked file lists and identify authored files hidden by ignore rules. Record Git configuration
and any absolute local paths that need adjustment.

Preserve the current uncommitted planning work:

1. Preserve `docs/github-actions.md` and both new test planning documents.
2. Preserve `Docs/implementation-plan.md` in the nested planning repository.
3. Preserve the preexisting `Docs/planning_chat.md` edit without normalizing it.
4. Preserve the root `.agents/` directory and `skills-lock.json`.
5. Preserve required ignored local configuration without exposing its contents.

Create a restricted backup of both repositories before the copy. Include Git metadata, uncommitted
source and authored local files. Record file digests for comparison after the copy. Keep credential
files restricted and outside test-report uploads.

Do not rely on an ordinary clone from GitHub to preserve this state. A remote clone omits local
changes, untracked files, ignored files and local-only Git history. A shared linked worktree also
keeps a dependency on the old repository. Use an independent filesystem copy for this particular
transition.

## 4. Create an independent Linux copy

Create a new destination directory inside the WSL home filesystem. If the destination already
contains files, stop. Combining two working copies can overwrite local work. Use Linux `rsync` with
archive behavior and perform an itemized dry run first. Include both `.git` directories and the
nested planning repository.

Exclude only reviewed generated output and regenerable dependency directories. Typical root
exclusions are `node_modules`, `dist`, `.test-dist`, `coverage`, `.artifacts` and `.vscode-test`.
Compare exclusions with tracked and authored files before applying them. Do not exclude every
ignored path or the whole `plan` directory.

Run the reviewed copy without deletion options. Preserve file bytes, symlinks and the
staged/unstaged distinction. Do not run formatters, checkout commands or line-ending conversions
during copying. Keep the original Dev Drive checkout intact throughout the transition.

Compare both destination repositories with their source snapshots. Match HEAD commits, local refs,
remotes, staged diffs and unstaged diffs. Match the contents of untracked and preserved ignored
files. File timestamps alone do not prove a successful copy.

Inspect copied Git configuration for old absolute paths and machine-specific hooks. Use
repository-local Linux configuration and respect the committed `.gitattributes`. Reconcile
executable modes with the Git index while preserving intentional edits. Do not apply recursive
executable permissions or change global Git configuration.

## 5. Reopen development tools and recreate generated state

Enable Docker Desktop integration for the existing `Ubuntu` WSL distribution. Use the WSL 2 backend
with Linux containers. Keep Docker Desktop as the Docker engine for this baseline. Do not add a
competing Docker daemon inside Ubuntu.

From an Ubuntu terminal, open the new checkout with `code .`. Make sure that VS Code displays a WSL
connection and that its terminal starts in the right location, such as
`~/code/backstage-validation-engine`. An optional Dev Container can be added when the shared test
image exists.

Open the new checkout as the agent workspace and update its writable workspace root. At planning
time, the agent session pointed at `/mnt/<drv>/code/backstage-validation-engine`. Changing a terminal
directory does not update every editor or agent permission root. Do not continue edits through an
old workspace after cutover.

Recreate root dependencies using the pinned Node version and `npm ci` in Linux. Rebuild generated
outputs rather than copying old native dependencies. Make sure that local launchers, bookmarks,
environment files, and tasks use the new absolute paths. Keep the nested planning repository
accessible from the same relative path.

Future increment 6 tests use the same shared application and test images as Actions. The automated
editor runs inside the Linux test container with Xvfb. The developer's Windows VS Code interface is
a separate interactive client. Retain the existing native Windows tests for Windows-specific client
behavior.

## 6. Acceptance and cutover

Before declaring the new checkout active, complete these checks:

1. Make sure that the destination resolves to ext4 rather than a Windows mount.
2. Match all preserved source bytes and Git state in both repositories.
3. Make sure that required local skills and configuration remain available.
4. Recreate dependencies and pass the normal project checks from the new path.
5. Exercise file creation, rename, deletion and watcher notifications inside Linux.
6. Prove Docker can mount a temporary Linux directory and observe a changed file.
7. Make sure that generated reports are writable and removable by the Linux user.
8. Reopen the editor and agent and make sure that both use the new workspace.

The Backstage release suite is not available yet. Its full local and hosted acceptance remains part
of increment 6. Migration checks do not claim that the planned application tests passed.

After these checks pass, use the ext4 checkout as the active development copy. Keep the Dev Drive
copy unchanged as a fallback until the transition is accepted. Do not maintain automatic
bidirectional synchronization between the two checkouts. For a separate Windows test copy, exchange
committed changes through Git.

If a migration check fails, resume work from the intact original copy. If new edits exist in the
Linux copy, preserve those edits before any rollback. Do not delete either checkout as part of this
plan.

## 7. Sources

Microsoft documents
[Dev Drive behavior with WSL](https://learn.microsoft.com/en-us/windows/dev-drive/#does-dev-drive-work-with-wsl-project-files).
It also documents
[storage across Windows and Linux filesystems](https://learn.microsoft.com/en-us/windows/wsl/filesystems).
These sources distinguish Windows storage benefits from Linux filesystem behavior.

Docker documents
[WSL filesystem and file notification recommendations](https://docs.docker.com/desktop/features/wsl/best-practices/).
Its [WSL integration guide](https://docs.docker.com/desktop/features/wsl/) describes the Docker
Desktop connection to an Ubuntu distribution. VS Code documents
[development through Remote WSL](https://code.visualstudio.com/docs/remote/wsl).
