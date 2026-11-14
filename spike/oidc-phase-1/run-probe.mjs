#!/usr/bin/env node
// OIDC sign-in plan, Phase 1 feasibility probe. THROWAWAY: never merge into a product branch.
//
// Builds a probe VSIX from a temporary copy of this checkout with `probe.patch` applied, and runs
// the installed-editor cases that answer the VS Code questions of
// docs/oidc-sign-in/phase-1-feasibility.md. This checkout is never modified.
//
//   node spike/oidc-phase-1/run-probe.mjs --local                 V1, V3 (any desktop runner)
//   node spike/oidc-phase-1/run-probe.mjs --open-command          V5 (macOS: `open vscode://...`)
//   node spike/oidc-phase-1/run-probe.mjs --remote=host|published V2, V4 (Linux, SSH fixture)
//   node spike/oidc-phase-1/run-probe.mjs --package-only          only the probe VSIX (for runs by hand)
//   --versions=1.106.3,1.145.2 selects the editors (default: both pinned editors).
//   Run under `xvfb-run -a` on Linux.
//
// Observations (no secret: the probe uses synthetic values and records lengths and digests only):
//   .artifacts/oidc-probe/<platform>-<modes>/summary.json, and the raw case evidence beside it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const patch = fileURLToPath(new URL('probe.patch', import.meta.url));
const option = (name) =>
  process.argv.find((item) => item === `--${name}` || item.startsWith(`--${name}=`));
const value = (name) => option(name)?.split('=')[1];
const local = !!option('local');
const openCommand = !!option('open-command');
const remote = value('remote');
const keep = !!option('keep');
const packageOnly = !!option('package-only');
const versions = value('versions') ?? '1.106.3,1.145.2';
assert(
  local || openCommand || remote || packageOnly,
  'Select --local, --open-command, --remote=<network>, or --package-only.',
);
assert(!openCommand || process.platform === 'darwin', 'The open command check runs on macOS.');
assert(!remote || process.platform === 'linux', 'The SSH fixture runs on Linux.');
assert(
  !remote || ['host', 'published'].includes(remote),
  'Use --remote=host or --remote=published.',
);

function run(command, args, { cwd, env, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: 'inherit',
      shell: process.platform === 'win32' && command === 'npm',
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0 || allowFailure) resolve(code);
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}
function capture(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
    let text = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (text += chunk));
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve(text) : reject(new Error(command))));
  });
}
async function files(directory) {
  const rows = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...(await files(file)));
    else rows.push(file);
  }
  return rows;
}

const revision =
  process.env.GITHUB_SHA ?? (await capture('git', ['rev-parse', 'HEAD'], root)).trim();
// The packaged build records this revision, and the SSH fixture compares the two.
const env = { GITHUB_SHA: revision, CI: '' };
const work = await mkdtemp(path.join(tmpdir(), 'bve-oidc-probe-'));
const modes =
  [local && 'local', openCommand && 'open-command', remote && 'remote'].filter(Boolean).join('+') ||
  'package';
const out = path.join(root, '.artifacts/oidc-probe', `${process.platform}-${modes}`);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const summary = {
  probe: 'oidc-sign-in phase 1 (throwaway)',
  revision,
  platform: process.platform,
  arch: process.arch,
  runner: process.env.ImageOS ?? null,
  runnerImage: process.env.ImageVersion ?? null,
  versions: versions.split(','),
  runs: [],
  cases: [],
  observations: [],
  fourthPipe: [],
  failures: [],
};
let failure;
try {
  const listed = (
    await capture('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root)
  )
    .split('\0')
    .filter(Boolean);
  for (const file of listed) {
    const source = path.join(root, file);
    if (!(await stat(source).catch(() => undefined))?.isFile()) continue;
    await mkdir(path.dirname(path.join(work, file)), { recursive: true });
    await cp(source, path.join(work, file));
  }
  // The SSH fixture mounts the copy into its container, so a link out of the copy would not resolve.
  if (remote)
    await cp(path.join(root, 'node_modules'), path.join(work, 'node_modules'), {
      recursive: true,
      verbatimSymlinks: true,
    });
  else await symlink(path.join(root, 'node_modules'), path.join(work, 'node_modules'), 'junction');
  if (await stat(path.join(root, '.vscode-test')).catch(() => undefined))
    await symlink(path.join(root, '.vscode-test'), path.join(work, '.vscode-test'), 'junction');
  await run('git', ['apply', '--whitespace=nowarn', patch], { cwd: work });
  await run('npm', ['run', 'extension:package'], { cwd: work, env });
  // The probe VSIX for runs by hand (docs/oidc-sign-in/phase-1-desktop-procedure.md).
  await mkdir(path.join(out, 'vsix'), { recursive: true });
  for (const name of await readdir(path.join(work, '.artifacts/vscode')))
    if (name.endsWith('.vsix'))
      await cp(path.join(work, '.artifacts/vscode', name), path.join(out, 'vsix', 'probe-' + name));

  const editor = async (name, extra, cases) => {
    const code = await run(process.execPath, ['scripts/test-extension.mjs', `--case=${cases}`], {
      cwd: work,
      env: { ...env, BVE_VSCODE_VERSIONS: versions, ...extra },
      allowFailure: true,
    });
    await cp(path.join(work, '.artifacts/vscode/editor-focused'), path.join(out, name), {
      recursive: true,
    }).catch(() => undefined);
    summary.runs.push({ name, exitCode: code });
  };
  if (local)
    await editor(
      'local',
      {},
      'startup,restart,shutdown,server-crash,probe-pipe,probe-uri,probe-secret,open-url',
    );
  if (openCommand)
    await editor('open-command', { BVE_PROBE_OPEN_MODE: 'open-command' }, 'probe-uri');
  if (remote) {
    const code = await run(
      process.execPath,
      ['scripts/test-extension-remote.mjs', '--mode=ssh-remote', `--ssh-network=${remote}`],
      { cwd: work, env, allowFailure: true },
    );
    await cp(path.join(work, '.artifacts/vscode/remote-results'), path.join(out, 'remote'), {
      recursive: true,
    }).catch(() => undefined);
    summary.runs.push({ name: 'remote', exitCode: code });
    // The remote case records V2 and V4 without failing; the probe run fails here instead.
    for (const version of versions.split(',')) {
      const file = path.join(
        out,
        'remote/ssh-remote',
        version,
        'session-0/probe-remote-observation.json',
      );
      const value = JSON.parse(await readFile(file, 'utf8').catch(() => 'null'));
      const check = (name, ok) => {
        if (!ok) summary.failures.push(`${version}: ${name}`);
      };
      check('remote observation written', !!value && !value.missing);
      check('V2: the link reaches the remote handler once', value?.V2?.deliveries === 1);
      check('V4: the local window stored the value', value?.V4?.localWindowStore?.stored === true);
      check(
        'V4: the remote window sees the change event',
        value?.V4?.changeEventInRemoteWindow === true,
      );
      check(
        'V4: the remote window reads the stored value',
        value?.V4?.valueMatchesLocalWrite === true,
      );
    }
  }
} catch (error) {
  failure = error;
  summary.error = String(error?.message ?? error);
} finally {
  for (const file of await files(out)) {
    const name = path.basename(file);
    const relative = path.relative(out, file).split(path.sep).join('/');
    if (name === 'progress.json') {
      const progress = JSON.parse(await readFile(file, 'utf8').catch(() => 'null'));
      if (progress)
        summary.cases.push({
          at: relative,
          status: progress.status,
          phase: progress.phase,
          error: progress.error?.split('\n')[0] ?? null,
        });
    } else if (/^probe-.*observation\.json$/u.test(name))
      summary.observations.push({ at: relative, ...JSON.parse(await readFile(file, 'utf8')) });
    else if (/^probe-fd3-\d+\.json$/u.test(name))
      summary.fourthPipe.push({ at: relative, ...JSON.parse(await readFile(file, 'utf8')) });
  }
  await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('BVE_PROBE_SUMMARY ' + JSON.stringify(summary));
  if (!keep) await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (failure || summary.failures.length || summary.runs.some((row) => row.exitCode !== 0))
  process.exitCode = 1;
